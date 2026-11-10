import { APPROVAL_LABEL, PAYMENT_LABEL, providerStatusLabel } from "../wording";
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
    if (ev.type === "proposal_failed" && !ev.scenario) text = "Purchase proposal failed; merchant review is needed.";
    if (ev.type === "proposal" && proposals.has(entry.seq)) text = "Purchase proposed by the AI.";
    if (ev.type === "decision" && decisions.has(entry.seq)) {
      if (ev.decision.verdict === "auto") { counts.automatic++; text = "Purchase allowed by the rules."; }
      if (ev.decision.verdict === "approval") { counts.review++; text = "Purchase needs approval."; }
      if (ev.decision.verdict === "block") { counts.blocked++; text = "Purchase blocked by the rules."; }
    }
    if ("decisionSeq" in ev && decisions.has(ev.decisionSeq)) {
      if (ev.type === "payment_outcome") text = ev.status === "unknown" ? `${PAYMENT_LABEL.unknown}; the original purchase remains reserved.` : "Payment request rejected by PayPal.";
      if (ev.type === "receipt_received") text = `Stock received: ${ev.quantity} ${ev.quantity === 1 ? "unit" : "units"}; Shopify stock updated.`;
      if (ev.type === "receipt_started") text = "Stock receipt started by the merchant.";
      if (ev.type === "receipt_rejected") text = "Stock receipt rejected; the stock update is not confirmed.";
      if (ev.type === "approved") text = "Purchase approved by the merchant.";
      if (ev.type === "rejected") text = "Purchase declined by the merchant.";
      if (ev.type === "payment_failed") text = `${ev.definitive ? PAYMENT_LABEL.failed : PAYMENT_LABEL.unknown}; merchant review is needed.`;
      if (ev.type === "order_created") text = `${APPROVAL_LABEL.paypal_pending}.`;
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
      if (ev.type === "order_status") text = `Payment status updated: ${providerStatusLabel(ev.status).toLowerCase()}.`;
    }
    if (ev.type === "payout_status") {
      const original = log.find((e) => e.seq === ev.payoutSeq)?.event;
      if (original?.type === "payout" && decisions.has(original.decisionSeq)) {
        text = `Payment status updated: ${providerStatusLabel(ev.status).toLowerCase()}.`;
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
