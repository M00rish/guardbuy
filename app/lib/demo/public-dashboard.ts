import { unresolvedPayments } from "../payments/attempts";
import type { AuditEntry } from "../policy/schema";

/** No fallback: public visibility is an explicit opt-in for one sandbox store. */
export function demoEnabled(shop: string, config: { enabled?: string; shop?: string; paypalBase?: string }) {
  return config.enabled === "true" && !!config.shop && shop === config.shop
    && (config.paypalBase ?? "https://api-m.sandbox.paypal.com") === "https://api-m.sandbox.paypal.com";
}

const PAYOUT_SUCCESS = new Set(["SUCCESS"]);
const FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "DECLINED", "CANCELED", "CANCELLED"]);
export type PublicPayment = { status: "successful" | "pending" | "failed" | "refunded"; amountCents: number };
const payment = (status: string, amountCents: number, success: Set<string>): PublicPayment => ({
  status: status.includes("REFUND") || status === "RETURNED" || status === "REVERSED" ? "refunded" : success.has(status) ? "successful" : FAILED.has(status) ? "failed" : "pending",
  amountCents,
});

/** Construct a fresh allowlisted view. Never expose raw audit events, errors, or AI text. */
export function publicAudit(log: AuditEntry[]) {
  const proposals = new Set(log.filter((e) => e.event.type === "proposal" && !e.event.scenario).map((e) => e.seq));
  const decisions = new Set(log.filter((e) => e.event.type === "decision" && proposals.has(e.event.proposalSeq)).map((e) => e.seq));
  const payments: PublicPayment[] = unresolvedPayments(log).filter((s) => decisions.has(s.attempt.decisionSeq)).map((s) => ({ status: "pending", amountCents: s.attempt.amountCents }));
  const timeline: { at: string; text: string }[] = [];
  const counts = { proposals: proposals.size, automatic: 0, review: 0, blocked: 0 };
  for (const entry of log) {
    const ev = entry.event;
    let text: string | undefined;
    if (ev.type === "proposal_failed" && !ev.scenario) text = "AI could not complete a restock proposal. Merchant review needed.";
    if (ev.type === "proposal" && proposals.has(entry.seq)) text = "AI proposed a supplier restock.";
    if (ev.type === "decision" && decisions.has(entry.seq)) {
      if (ev.decision.verdict === "auto") { counts.automatic++; text = "Policy checks allowed automatic payment."; }
      if (ev.decision.verdict === "approval") { counts.review++; text = "Policy checks required merchant review."; }
      if (ev.decision.verdict === "block") { counts.blocked++; text = "Policy checks blocked this restock."; }
    }
    if ("decisionSeq" in ev && decisions.has(ev.decisionSeq)) {
      if (ev.type === "payment_outcome") text = ev.status === "unknown" ? "Supplier payment awaits PayPal confirmation; original purchase remains reserved." : "PayPal rejected a supplier payment request.";
      if (ev.type === "receipt_received") text = `Merchant received ${ev.quantity} units; Shopify inventory updated.`;
      if (ev.type === "receipt_started") text = "Merchant started recording a delivery receipt.";
      if (ev.type === "receipt_rejected") text = "Delivery receipt was rejected; inventory was not confirmed updated.";
      if (ev.type === "approved") text = "Merchant approved a restock.";
      if (ev.type === "rejected") text = "Merchant declined a restock.";
      if (ev.type === "payment_failed") text = "Supplier payment attempt failed. Merchant review needed.";
      if (ev.type === "order_created") text = "Supplier payment awaits merchant approval in PayPal.";
      if (ev.type === "payout") {
        const update = [...log].reverse().find((e) => e.event.type === "payout_status" && e.event.payoutSeq === entry.seq)?.event;
        // Initial payout status is a batch status, not proof of item success.
        payments.push(payment(update?.type === "payout_status" ? update.status : "PENDING", ev.amountCents, PAYOUT_SUCCESS));
        text = "Supplier payout submitted to PayPal sandbox.";
      }
      if (ev.type === "order_captured") {
        const update = [...log].reverse().find((e) => e.event.type === "order_status" && e.event.orderId === ev.orderId)?.event;
        payments.push(payment(update?.type === "order_status" ? update.status : ev.status, ev.amountCents, new Set(["COMPLETED"])));
        text = "Supplier payment capture recorded in PayPal sandbox.";
      }
      if (ev.type === "order_status") text = `Supplier payment status updated: ${payment(ev.status, 0, new Set(["COMPLETED"])).status}.`;
    }
    if (ev.type === "payout_status") {
      const original = log.find((e) => e.seq === ev.payoutSeq)?.event;
      if (original?.type === "payout" && decisions.has(original.decisionSeq)) {
        text = `Supplier payout status updated: ${payment(ev.status, 0, PAYOUT_SUCCESS).status}.`;
      }
    }
    if (text) timeline.push({ at: entry.at, text });
  }
  return {
    decisions: counts,
    payments: {
      total: payments.length,
      successful: payments.filter((p) => p.status === "successful").length,
      pending: payments.filter((p) => p.status === "pending").length,
      failed: payments.filter((p) => p.status === "failed").length,
      refunded: payments.filter((p) => p.status === "refunded").length,
    },
    timeline: timeline.slice(-30).reverse(),
  };
}
