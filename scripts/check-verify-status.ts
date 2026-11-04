// Exercise the actual public proof service with an in-memory database-read adapter. No network.
import assert from "node:assert/strict";
import { AuditEventSchema, type AuditEvent } from "../app/lib/policy/schema";
const rows: { seq: number; shop: string; at: Date; event: AuditEvent; prevHash: string; hash: string }[] = [];
let payment = 0;
Object.assign(globalThis, { prismaGlobal: {
  auditEntry: { findFirst: async () => rows[payment], findMany: async () => rows },
  shopSettings: { findUnique: async () => null },
} });
const { entryHash } = await import("../app/lib/audit/log.server");
const { verifyPayment } = await import("../app/lib/audit/verify.server");
function add(event: AuditEvent) {
  const entry = { seq: rows.length, shop: "proof.test", at: new Date(), event: AuditEventSchema.parse(event), prevHash: rows.at(-1)?.hash ?? "0".repeat(64), hash: "" };
  entry.hash = entryHash(entry.prevHash, { seq: entry.seq, shop: entry.shop, at: entry.at.toISOString(), event: entry.event }); rows.push(entry); return entry.seq;
}
add({ type: "proposal", proposal: { sku: "private-sku", supplierId: "private-supplier", quantity: 10, unitPriceCents: 100, payeeEmail: "private@example.test", reasoning: "private reasoning" } });
add({ type: "decision", proposalSeq: 0, decision: { verdict: "auto", checks: [], totalCents: 1000, ruleSetHash: "hash" } });
payment = add({ type: "payout", decisionSeq: 1, amountCents: 1000, payoutBatchId: "BATCH1234", status: "SUCCESS" });
for (const [status, label] of [["INITIAL", "Payment pending"], ["SUCCESS", "Paid"], ["RETURNED", "Returned"], ["REFUNDED", "Refunded"], ["FAILED", "Failed"]]) {
  if (status !== "INITIAL") add({ type: "payout_status", payoutSeq: payment, status, confirmedByTransactionSearch: false });
  const proof = await verifyPayment("BATCH1234"); assert.ok(proof.found);
  assert.equal(proof.paymentStatus, label); assert.equal(proof.details, null); assert.ok(proof.chain.valid);
  assert.ok(!proof.steps.some((s) => s.step.startsWith("Paid via")));
  assert.ok(!JSON.stringify(proof).includes("private@example.test"));
}
payment = add({ type: "order_captured", decisionSeq: 1, amountCents: 1000, orderId: "ORDER1234", captureId: "CAPTURE123", status: "PENDING", confirmedByGetOrder: false });
add({ type: "order_status", decisionSeq: 1, orderId: "ORDER1234", status: "REFUNDED", refundedCents: 1000 });
const proof = await verifyPayment("ORDER1234"); assert.ok(proof.found); assert.equal(proof.paymentStatus, "Refunded");
assert.ok(proof.steps.some((s) => s.note === "REFUNDED"));
console.log("PASS actual public Verify service: pending batch acceptance, settlement, returned/refunded/failed states, capture refund evidence, hash integrity and default privacy.");
