// Offline merchant/public lifecycle and budget checks; no provider calls or database writes.
import assert from "node:assert/strict";
import { paymentStatus, budgetSummary } from "../app/lib/payments/status";
import { toFeed } from "../app/lib/audit/feed.server";
import { productStatus } from "../app/lib/merchant/dashboard.server";
import { AuditEventSchema, type AuditEntry, type AuditEvent } from "../app/lib/policy/schema";
import { spending } from "../app/lib/agent/restock.server";
const log: AuditEntry[] = [];
const add = (event: AuditEvent) => { const e = { seq: log.length, shop: "status.test", at: new Date().toISOString(), event: AuditEventSchema.parse(event), hash: "hash", prevHash: "" }; log.push(e); return e; };
add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", unitPriceCents: 100, quantity: 10, payeeEmail: "supplier@example.test", reasoning: "test" } });
add({ type: "decision", proposalSeq: 0, decision: { verdict: "auto", totalCents: 1000, checks: [], ruleSetHash: "rules" } });
const pay = add({ type: "payout", decisionSeq: 1, amountCents: 1000, payoutBatchId: "BATCH1234", status: "SUCCESS" });
assert.equal(paymentStatus(log, pay).label, "Payment pending", "batch success is not recipient settlement");
assert.equal(toFeed(log).find((e) => e.seq === pay.seq)?.kind, "paypal");
assert.match(productStatus(log, { variantId: "123", sku: "coffee", managed: true, cover: 1 }, null, true).label, /pending/);
assert.equal(spending(log).pendingCents, 1000);
for (const [status, label] of [["SUCCESS", "Paid"], ["RETURNED", "Returned"], ["REFUNDED", "Refunded"], ["FAILED", "Payment failed"]]) {
  add({ type: "payout_status", payoutSeq: pay.seq, status, confirmedByTransactionSearch: false });
  assert.equal(paymentStatus(log, pay).label, label);
  const feed = toFeed(log).find((e) => e.seq === pay.seq)!;
  assert.ok(feed.title.startsWith(label));
  assert.equal(feed.kind === "paid", status === "SUCCESS");
}
const capture = add({ type: "order_captured", decisionSeq: 1, orderId: "ORDER1234", captureId: "CAPTURE123", amountCents: 1000, status: "PENDING", confirmedByGetOrder: false });
assert.equal(paymentStatus(log, capture).settled, false);
assert.equal(toFeed(log).find((e) => e.seq === capture.seq)?.kind, "paypal");
for (const [status, label] of [["COMPLETED", "Paid"], ["PARTIALLY_REFUNDED", "Partially refunded"], ["REFUNDED", "Refunded"], ["DENIED", "Payment failed"]]) {
  add({ type: "order_status", decisionSeq: 1, orderId: "ORDER1234", status, refundedCents: 0 });
  assert.equal(paymentStatus(log, capture).label, label);
}
assert.deepEqual(budgetSummary(2000, 3000, 10000), { spent: 2000, reserved: 3000, committed: 5000, remaining: 5000, over: 0 });
assert.equal(budgetSummary(9000, 3000, 10000).remaining, 0);
assert.equal(budgetSummary(9000, 3000, 10000).over, 2000);
assert.equal(budgetSummary(0, 1000, 10000).remaining, 9000);
assert.equal(toFeed([{ ...pay, event: { type: "payment_failed", decisionSeq: 1, reason: "Lost response" } }])[0].title, "Payment awaiting confirmation for purchase #1.");
console.log("PASS payment lifecycle: batch acceptance, recipient settlement, pending capture, returns/refunds/failure, Activity categories, Home status and committed budget including over-cap commitments.");

// Wording must not turn incomplete/unknown evidence into a confirmed failure or payment.
const uncertain: AuditEntry = { ...pay, seq: 900, event: { type: "payment_failed", decisionSeq: 1, reason: "private provider response" } };
const { publicAudit } = await import("../app/lib/demo/public-dashboard");
const publicTimeline = publicAudit([...log, uncertain]).timeline;
assert.ok(publicTimeline.some(e => e.text === "Payment awaiting confirmation; merchant review is needed."));
assert.ok(!JSON.stringify(publicTimeline).includes("private provider response"));
const originalLog = JSON.stringify(log);
const feed = toFeed(log, undefined, { product: () => "Coffee", supplier: () => "Atlas" });
assert.equal(JSON.stringify(log), originalLog, "wording never rewrites stored audit events");
assert.ok(feed.every(e => e.title.endsWith(".")), "event summaries use a consistent sentence ending");
const payoutUpdate = feed.find(e => e.kind === "status" && e.detail?.includes("BATCH1234"));
assert.ok(payoutUpdate, "payment identifiers remain available in expanded details");
assert.ok(!payoutUpdate.title.includes("BATCH1234"), "technical IDs do not clutter summaries");
const missingReferences = toFeed([{ ...pay, seq: 999, event: { type: "approved", decisionSeq: 9999, approvedBy: "shopify-staff:private-actor" } }]);
assert.equal(missingReferences[0].title, "Purchase #9999 approved by a staff member.");
assert.ok(!JSON.stringify(missingReferences).includes("undefined"));
const futureEvent = toFeed([{ ...pay, event: { type: "future_event", secret: "never render raw payload" } } as unknown as AuditEntry]);
assert.equal(futureEvent[0].title, "Activity recorded.");
assert.ok(!JSON.stringify(futureEvent).includes("never render raw payload"));
const { APPROVAL_LABEL, PAYMENT_LABEL, providerStatusLabel } = await import("../app/lib/wording");
assert.notEqual(APPROVAL_LABEL.waiting as string, PAYMENT_LABEL.paid);
assert.notEqual(APPROVAL_LABEL.paypal_pending as string, PAYMENT_LABEL.pending);
assert.equal(APPROVAL_LABEL.payment_pending, paymentStatus([], pay).label);
assert.equal(providerStatusLabel("UNRECOGNIZED_PROVIDER_STATE"), PAYMENT_LABEL.pending);
assert.equal(providerStatusLabel("PARTIALLY_REFUNDED"), "Partially refunded");
console.log("PASS wording safety: unknown outcomes, public redaction, legacy references, future-event fallback, preserved records and shared status labels.");
