import type { AuditEntry } from "../policy/schema";
import { attemptStates, purchaseReservations, unknownPaymentDecisions, untrackedApproval, settledPaymentFailure } from "../payments/attempts";

export const APPROVAL_TTL_MS = 48 * 60 * 60_000;
export const approvalExpired = (at: string, now = new Date()) => now.getTime() - Date.parse(at) >= APPROVAL_TTL_MS;
export type ApprovalStatus = "waiting" | "paypal_pending" | "payment_unknown" | "payment_pending" | "payment_failed";

/** Approval is a staff decision; a provider response is separate evidence of payment. */
export function approvalStates(log: AuditEntry[], now = new Date()) {
  const reservations = purchaseReservations(log);
  const unknown = unknownPaymentDecisions(log);
  const attempts = attemptStates(log);
  return log.flatMap((d) => {
    if (d.event.type !== "decision" || d.event.decision.verdict === "block") return [];
    const source = log.find((e) => e.seq === (d.event.type === "decision" ? d.event.proposalSeq : -1));
    if (source?.event.type !== "proposal" || source.event.scenario) return [];
    const events = log.filter((e) => "decisionSeq" in e.event && e.event.decisionSeq === d.seq);
    if (events.some((e) => e.event.type === "rejected")) return [];
    const approved = events.some((e) => e.event.type === "approved");
    const result = events.some((e) => e.event.type === "payout" || e.event.type === "order_captured");
    const order = events.filter((e) => e.event.type === "order_created").at(-1);
    const open = order?.event.type === "order_created" && !events.some((e) => e.event.type === "order_closed" && order.event.type === "order_created" && e.event.orderId === order.event.orderId);
    const failed = attempts.some((s) => s.attempt.decisionSeq === d.seq && s.state === "failed");
    const failure = events.filter((e) => e.event.type === "payment_failed" && e.event.definitive).at(-1)?.event;
    const providerFailure = settledPaymentFailure(log, d.seq);
    let status: ApprovalStatus;
    if (unknown.has(d.seq)) status = "payment_unknown";
    else if (result) {
      if (reservations.has(d.seq)) status = "payment_pending";
      else if (providerFailure) status = "payment_failed";
      else return [];
    } else if (open) status = "paypal_pending";
    else if (approved || d.event.decision.verdict === "approval" && (failed || failure)) status = "payment_failed";
    else if (d.event.decision.verdict === "approval" && !approvalExpired(d.at, now)) status = "waiting";
    else return [];
    // Only an in-app approval can authorize retrying a definitively unsubmitted Payout.
    // Unknown outcomes are handled exclusively by same-key resumption.
    const manualReview = untrackedApproval(log, d.seq);
    return [{ decisionSeq: d.seq, status, approved, canResume: status === "payment_unknown" && !manualReview, canRetry: status === "payment_failed" && !result && approved && !approvalExpired(d.at, now),
      canCancel: status === "payment_failed" && !result, expired: approvalExpired(d.at, now),
      reason: manualReview ? "This older approval has no saved payment request. Reconcile it with PayPal manually before making a replacement purchase." : providerFailure ? `PayPal reports ${providerFailure.toLowerCase()}. Review the provider evidence in Activity before arranging a replacement payment.` : failure?.type === "payment_failed" ? failure.reason : failed ? "The payment request was rejected or stopped before submission." : approved && status === "payment_failed" ? "Approval was recorded, but no payment submission was recorded." : undefined }];
  });
}

export function waitingForApproval(log: AuditEntry[], decisionSeq: number) {
  return approvalStates(log).some((s) => s.decisionSeq === decisionSeq && s.status === "waiting");
}
