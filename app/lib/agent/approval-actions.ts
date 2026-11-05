import type { AuditEntry, AuditEvent } from "../policy/schema";
import { approvalStates, waitingForApproval } from "./approval-state";
import { PaymentPending, purchaseReservations } from "../payments/attempts";

export class ApprovalRefused extends Error {}
export type ApprovalResult = { paid: boolean; message: string };
type Ports = {
  read: (shop: string) => Promise<AuditEntry[]>;
  appendWhen: (shop: string, event: AuditEvent, when: (log: AuditEntry[]) => boolean) => Promise<AuditEntry | null>;
  lock: <T>(shop: string, seq: number, fn: () => Promise<T>) => Promise<T>;
  execute: (shop: string, seq: number) => Promise<AuditEntry>;
  failureReason?: (error: unknown) => string | undefined;
};

export function createApprovalActions(ports: Ports) {
  const state = (log: AuditEntry[], seq: number) => approvalStates(log).find((s) => s.decisionSeq === seq);
  async function pay(shop: string, seq: number): Promise<ApprovalResult> {
    try {
      const payout = await ports.execute(shop, seq);
      return { paid: true, message: `Approved; payout submitted (log entry #${payout.seq}). Check confirmation in Activity before receiving goods.` };
    } catch (error) {
      const log = await ports.read(shop);
      if (error instanceof PaymentPending || purchaseReservations(log).has(seq)) return { paid: false, message: new PaymentPending().message };
      // The executor persists every provider write first. No reservation/result means no
      // unfinished request; record the failed action without hiding the approved purchase.
      const reason = ports.failureReason?.(error) ?? "Payment was not submitted successfully. Review the current rules, supplier and PayPal account before retrying.";
      await ports.appendWhen(shop, { type: "payment_failed", decisionSeq: seq, reason, definitive: true }, (current) => state(current, seq)?.status === "payment_failed");
      return { paid: false, message: `Approved, but unpaid. ${reason}` };
    }
  }
  return {
    approve: (shop: string, seq: number, actor: string) => ports.lock(shop, seq, async () => {
      const approved = await ports.appendWhen(shop, { type: "approved", decisionSeq: seq, approvedBy: actor, paymentProtocol: "durable-v1" }, (log) => waitingForApproval(log, seq));
      if (!approved) throw new ApprovalRefused("This purchase is not waiting for approval. Refresh its status.");
      return pay(shop, seq);
    }),
    retry: (shop: string, seq: number, actor: string) => ports.lock(shop, seq, async () => {
      // A fresh staff action is recorded atomically before trying the same decision again.
      const retry = await ports.appendWhen(shop, { type: "approved", decisionSeq: seq, approvedBy: actor, paymentProtocol: "durable-v1" }, (log) => !!state(log, seq)?.canRetry);
      if (!retry) throw new ApprovalRefused("This purchase cannot be retried. Refresh its original payment status; expired approvals require a fresh proposal.");
      return pay(shop, seq);
    }),
    reject: (shop: string, seq: number, actor: string, reason?: string) => ports.lock(shop, seq, async () => {
      const rejected = await ports.appendWhen(shop, { type: "rejected", decisionSeq: seq, rejectedBy: actor, reason: reason?.slice(0, 500) || undefined }, (log) => {
        const s = state(log, seq);
        return s?.status === "waiting" || !!s?.canCancel;
      });
      if (!rejected) throw new ApprovalRefused("A payment or another action already reserved this purchase. Refresh its status.");
      return { paid: false, message: "Unpaid purchase cancelled. The cancellation is recorded in Activity." };
    }),
  };
}
