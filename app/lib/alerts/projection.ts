import { approvalStates } from "../agent/approval-state";
import { settledPaymentFailure } from "../payments/attempts";
import type { AuditEntry } from "../policy/schema";

export type Attention = {
  subject: string;
  state: string;
  kind: string;
  decisionSeq?: number;
};
export function attention(log: AuditEntry[], now = new Date()): Attention[] {
  const purchases = approvalStates(log, now).flatMap((s): Attention[] => {
    const relevant = log.filter(
      (e) =>
        ("decisionSeq" in e.event &&
          e.event.decisionSeq === s.decisionSeq &&
          !e.event.type.startsWith("receipt_") &&
          !e.event.type.startsWith("delivery_")) ||
        (e.event.type === "payout_status" &&
          (() => {
            const payoutSeq = e.event.payoutSeq;
            return log.some(
              (p) =>
                p.seq === payoutSeq &&
                p.event.type === "payout" &&
                p.event.decisionSeq === s.decisionSeq,
            );
          })()),
    );
    const latest = relevant.at(-1) ?? log.find((e) => e.seq === s.decisionSeq)!;
    // A recorded request can briefly be in flight; don't alarm on a normal short API round trip.
    const phaseStart =
      s.status === "payment_unknown"
        ? (relevant.filter((e) => e.event.type === "payment_attempt").at(-1) ??
          relevant.find(
            (e) =>
              e.event.type === "payment_failed" || e.event.type === "approved",
          ) ??
          latest)
        : s.status === "payment_pending"
          ? (relevant.find(
              (e) =>
                e.event.type === "payout" || e.event.type === "order_captured",
            ) ?? latest)
          : latest;
    const age = now.getTime() - Date.parse(phaseStart.at);
    if (
      (s.status === "payment_unknown" && age < 10_000) ||
      (s.status === "payment_pending" && age < 15 * 60_000)
    )
      return [];
    if (s.status === "payment_failed" && age > 7 * 86_400_000) return [];
    const definitive =
      settledPaymentFailure(log, s.decisionSeq) ||
      relevant.some(
        (e) =>
          (e.event.type === "payment_failed" && e.event.definitive) ||
          (e.event.type === "payment_outcome" && e.event.status === "failed"),
      );
    const kind =
      s.status === "payment_failed"
        ? definitive
          ? "failed"
          : "unpaid"
        : s.status;
    return [
      {
        subject: `purchase:${s.decisionSeq}`,
        kind,
        decisionSeq: s.decisionSeq,
        state: `${kind}:${relevant.filter((e) => e.event.type === "payment_attempt").at(-1)?.seq ?? "initial"}`,
      },
    ];
  });
  // Only the newest restock result per item matters; a later successful proposal resolves it.
  const items = new Map<string, AuditEntry>();
  for (const e of log) {
    if (e.event.type === "proposal_failed" && !e.event.scenario)
      items.set(e.event.variantId ?? e.event.sku, e);
    if (e.event.type === "proposal" && !e.event.scenario)
      items.set(e.event.proposal.variantId ?? e.event.proposal.sku, e);
  }
  for (const e of items.values())
    if (
      e.event.type === "proposal_failed" &&
      now.getTime() - Date.parse(e.at) < 7 * 86_400_000
    )
      purchases.push({
        subject: `restock:${e.seq}`,
        kind: "restock",
        state: `restock:${e.seq}`,
      });
  return purchases;
}

export const ALERT_TEXT: Record<string, string> = {
  waiting:
    "Purchase waiting for your approval. Review it in GuardBuy; approvals happen only in the app.",
  paypal_pending:
    "Purchase waiting for approval in PayPal. Open GuardBuy to review the original purchase.",
  payment_unknown:
    "Awaiting PayPal confirmation. The original payment remains reserved. Do not create a replacement payment; check or resume the original in GuardBuy.",
  payment_pending:
    "Payment submitted; PayPal confirmation is still pending. The original payment remains reserved. Check its current status in GuardBuy before taking further action.",
  failed:
    "Payment failed or was returned. Review the provider evidence and current recovery options in GuardBuy before arranging any replacement.",
  unpaid:
    "Approved purchase needs payment attention. Approval was recorded, but payment is not confirmed. Review the original purchase in GuardBuy.",
  restock:
    "A restock could not be prepared. Open GuardBuy Activity to review it.",
  integrity:
    "GuardBuy audit-log verification failed. Open Activity and investigate before approving purchases.",
};

export function purchaseParam(url: string) {
  const value = new URL(url).searchParams.get("purchase");
  return value !== null && /^(0|[1-9]\d{0,8})$/.test(value)
    ? Number(value)
    : null;
}
export function purchaseEntries(log: AuditEntry[], decisionSeq: number) {
  const seqs = new Set([decisionSeq]);
  for (const e of log) {
    if (e.seq === decisionSeq && e.event.type === "decision")
      seqs.add(e.event.proposalSeq);
    if ("decisionSeq" in e.event && e.event.decisionSeq === decisionSeq)
      seqs.add(e.seq);
    if (e.event.type === "payout_status" && seqs.has(e.event.payoutSeq))
      seqs.add(e.seq);
  }
  return seqs;
}
