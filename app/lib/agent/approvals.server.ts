import { enqueueRestockInTransaction } from "../jobs/restock-queue.server";
import { appendAuditWhen, auditEntries } from "../audit/log.server";
import type { RuleCheck } from "../policy/schema";
import { offersForVariant, supplierNames } from "../suppliers/directory.server";
import {
  createApprovalOrder,
  ExecutionRefused,
  executePurchase,
  openOrder,
} from "./execute.server";
import { approvalStates, type ApprovalStatus } from "./approval-state";
import { createApprovalActions } from "./approval-actions";
import { withPaymentLock } from "./payment-lock.server";
import { PaymentRejected } from "../payments/attempts";
import { acceptedUnitPrice, APPROVAL_TTL_MS } from "./restock.server";

// The approval queue: purchases the policy engine sent to a person ("approval" verdict).
// Cards lead with facts GuardBuy computed itself (price vs the price you accepted, quantity vs usual, who gets
// paid, which rules asked for approval). The AI's explanation comes last and is labelled as such,
// because a dishonest supplier's note can steer what the AI writes.

export type ApprovalCard = {
  decisionSeq: number;
  proposedAt: string;
  expiresAt: string; // approvals are valid for 48 hours
  status: ApprovalStatus;
  canRetry: boolean;
  canResume: boolean;
  canCancel: boolean;
  expired: boolean;
  paymentReason?: string;
  sku: string;
  quantity: number;
  supplierId: string;
  supplierName: string;
  payeeEmail: string | null;
  unitPriceCents: number;
  totalCents: number;
  acceptedUnitPriceCents: number | null; // the price the merchant accepted; null if the supplier is no longer linked
  usualQuantity: number | null;
  needsApprovalBecause: RuleCheck[]; // the checks that asked for a person
  otherChecks: RuleCheck[];
  aiExplanation: string; // written by the AI: unverified
  paypalApproveUrl?: string;
};

export async function approvalQueue(shop: string): Promise<ApprovalCard[]> {
  const log = await auditEntries(shop);
  const names = await supplierNames(shop);
  const cards: ApprovalCard[] = [];

  for (const state of approvalStates(log)) {
    const d = log.find((e) => e.seq === state.decisionSeq)!;
    if (d.event.type !== "decision") continue;
    const p = log.find(
      (e) => e.seq === (d.event.type === "decision" ? d.event.proposalSeq : -1),
    );
    if (p?.event.type !== "proposal") continue;
    const { proposal } = p.event;
    const { decision } = d.event;

    const offer = proposal.variantId
      ? (await offersForVariant(shop, proposal.variantId)).find(
          (o) => o.supplierId === proposal.supplierId,
        )
      : undefined;
    const order = openOrder(log, d.seq);

    cards.push({
      decisionSeq: d.seq,
      proposedAt: p.at,
      expiresAt: new Date(Date.parse(d.at) + APPROVAL_TTL_MS).toISOString(),
      status: state.status,
      canRetry: state.canRetry,
      canResume: state.canResume,
      canCancel: state.canCancel,
      expired: state.expired,
      paymentReason: state.reason,
      sku: proposal.sku,
      quantity: proposal.quantity,
      supplierId: proposal.supplierId,
      supplierName: names.get(proposal.supplierId) ?? proposal.supplierId,
      payeeEmail: proposal.payeeEmail ?? null,
      unitPriceCents: proposal.unitPriceCents,
      totalCents: decision.totalCents,
      acceptedUnitPriceCents: offer
        ? acceptedUnitPrice(proposal, log, offer, d.seq)
        : null,
      usualQuantity: offer?.usualQuantity ?? null,
      needsApprovalBecause: decision.checks.filter(
        (c) => c.outcome === "approval",
      ),
      otherChecks: decision.checks.filter((c) => c.outcome !== "approval"),
      aiExplanation: proposal.reasoning,
      paypalApproveUrl:
        order?.event.type === "order_created"
          ? order.event.approveUrl
          : undefined,
    });
  }
  return cards.reverse(); // newest first
}

// Shared across workers and restarts. Conditional audit appends remain authoritative if a
// worker outlives its lease; the executor independently reserves the route under its funding lock.
const oncePerDecision = <T>(shop: string, seq: number, fn: () => Promise<T>) =>
  withPaymentLock(`approval:${shop}:${seq}`, fn);
const actions = createApprovalActions({
  read: auditEntries,
  appendWhen: (shop, event, when) => {
    if (event.type !== "rejected") return appendAuditWhen(shop, event, when);
    let jobId: string | undefined;
    return appendAuditWhen(
      shop,
      event,
      (log) => {
        if (!when(log)) return false;
        const decision = log.find((e) => e.seq === event.decisionSeq)?.event;
        const proposal =
          decision?.type === "decision"
            ? log.find((e) => e.seq === decision.proposalSeq)?.event
            : undefined;
        jobId =
          proposal?.type === "proposal" && !proposal.scenario
            ? proposal.restockJobId?.split(":")[0]
            : undefined;
        return true;
      },
      undefined,
      undefined,
      async (tx) => {
        if (!jobId) return;
        const job = await tx.restockJob.findFirst({
          where: { id: jobId, shop },
        });
        if (job)
          await enqueueRestockInTransaction(tx, shop, job.inventoryItemId);
      },
    );
  },
  lock: oncePerDecision,
  execute: executePurchase,
  failureReason: (error) =>
    error instanceof ExecutionRefused || error instanceof PaymentRejected
      ? error.message
      : undefined,
});
export const approvePurchase = actions.approve;
export const retryPurchase = actions.retry;
export const rejectPurchase = async (
  ...args: Parameters<typeof actions.reject>
) => {
  const result = await actions.reject(...args);
  return {
    ...result,
    message: `${result.message} Automatic restocking for this product is paused for 24 hours. Reset its cooldown from Home or product settings to recheck sooner.`,
  };
};
export type { ApprovalResult } from "./approval-actions";

/** Creates (or returns) the PayPal order, so the merchant approves and pays in PayPal itself. */
export function approveInPayPal(
  shop: string,
  decisionSeq: number,
  returnUrl: string,
): Promise<{ approveUrl: string }> {
  return oncePerDecision(shop, decisionSeq, async () => {
    const state = approvalStates(await auditEntries(shop)).find(
      (s) => s.decisionSeq === decisionSeq,
    );
    if (state?.status !== "waiting" && state?.status !== "paypal_pending")
      throw new ExecutionRefused(
        "This purchase is not waiting for approval. Refresh its status.",
      );
    const order = await createApprovalOrder(shop, decisionSeq, returnUrl);
    if (order.event.type !== "order_created")
      throw new Error("Unexpected log entry");
    return { approveUrl: order.event.approveUrl };
  });
}
