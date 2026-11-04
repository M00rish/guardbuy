// Pure stock-in-transit lifecycle checks. No database, secrets or external provider calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deliveries, incomingFor, canAppendReceipt, createReceiveDelivery } from "../app/lib/inventory/deliveries";
import { canManageDelivery, createManageDelivery } from "../app/lib/inventory/delivery-management";
import { inDeliveryView } from "../app/lib/inventory/delivery-view";
import { AuditEventSchema, type AuditEntry, type AuditEvent } from "../app/lib/policy/schema";
import { canStartAttempt, type Attempt } from "../app/lib/payments/attempts";
import { skipReason, spending } from "../app/lib/agent/restock.server";

function fixture({ lead = 5 as number | undefined, rail = "payout", paid = true } = {}) {
  const log: AuditEntry[] = []; let now = Date.parse("2026-11-04T12:00:00Z"), stock = 2, writes = 0;
  const add = (event: AuditEvent, at = new Date(now).toISOString()) => { const entry = { shop: "incoming.test", seq: log.length, at, event: AuditEventSchema.parse(event), prevHash: "", hash: "" }; log.push(entry); return entry; };
  add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", unitPriceCents: 100, quantity: 40, payeeEmail: "supplier@example.test", reasoning: "restock", supplierLeadTimeDays: lead } });
  add({ type: "decision", proposalSeq: 0, decision: { verdict: "auto", totalCents: 4000, checks: [], ruleSetHash: "hash" } });
  if (rail === "payout") { add({ type: "payout", decisionSeq: 1, payoutBatchId: "batch", amountCents: 4000, status: "SUCCESS" }); if (paid) add({ type: "payout_status", payoutSeq: 2, status: "SUCCESS", confirmedByTransactionSearch: false }); }
  else add({ type: "order_captured", decisionSeq: 1, orderId: "ORDER", captureId: "CAPTURE", amountCents: 4000, status: paid ? "COMPLETED" : "PENDING", confirmedByGetOrder: false });
  let tail = Promise.resolve();
  const lock = async <T>(_shop: string, fn: () => Promise<T>) => { const before = tail; let release!: () => void; tail = new Promise<void>((r) => { release = r; }); await before; try { return await fn(); } finally { release(); } };
  const manage = createManageDelivery({ read: async () => log, lock, now: () => now, append: async (_shop, event) => { if (!canManageDelivery(log, event)) return false; add(event); return true; } });
  const receive = createReceiveDelivery({ read: async () => log, lock, now: () => now, append: async (_shop, event) => { assert.ok(canAppendReceipt(log, event)); add(event); }, resolveItem: async () => "gid://shopify/InventoryItem/9", adjust: async (event) => { writes++; stock += event.quantity; return "received"; } });
  const row = () => deliveries(log, new Date(now))[0];
  const change = () => ({ decisionSeq: 1, updateId: randomUUID(), expectedRevision: row().revision });
  const close = () => ({ ...change(), intent: "close" as const, reason: "supplier_cancelled" as const, confirmed: true });
  const receipt = (quantity: number) => ({ decisionSeq: 1, receiptId: randomUUID(), quantity, expectedReceived: row().received, locationId: "gid://shopify/Location/5" });
  return { log, add, row, change, close, receipt, manage, receive, now: () => new Date(now), advance: (days: number) => { now += days * 86_400_000; }, stock: () => stock, writes: () => writes };
}
let count = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); count++; console.log(`PASS ${name}`); }
await check("Supplier estimate starts at settlement and lasts beyond the old three-day interval", () => {
  const f = fixture(); assert.equal(f.row().expectedAt, "2026-11-09T23:59:59.999Z"); f.advance(4);
  assert.equal(f.row().overdue, false); assert.equal(incomingFor(f.log, "123"), 40); assert.match(skipReason({ variantId: "123", sku: "coffee" }, f.log, f.now())!, /awaiting delivery/);
  f.advance(10); assert.equal(f.row().overdue, true); assert.equal(incomingFor(f.log, "123"), 40); assert.match(skipReason({ variantId: "123", sku: "coffee" }, f.log, f.now())!, /overdue/);
  assert.equal(inDeliveryView(f.row(), "attention"), true);
});
await check("Missing legacy lead time stays unknown rather than inventing an arrival", () => {
  const f = fixture(); const proposal = f.log[0].event; assert.equal(proposal.type, "proposal"); if (proposal.type === "proposal") delete proposal.proposal.supplierLeadTimeDays;
  f.advance(100); assert.equal(f.row().expectedAt, null); assert.equal(f.row().overdue, false); assert.equal(incomingFor(f.log, "123"), 40);
});
await check("Batch acceptance and pending capture do not start a supplier delivery clock", async () => {
  for (const rail of ["payout", "order"]) {
    const f = fixture({ paid: false, rail }); assert.equal(f.row().expectedAt, null); assert.equal(f.row().payment, "pending");
    await assert.rejects(f.manage("incoming.test", "staff", f.close()), /Resolve payment/);
    await assert.rejects(f.manage("incoming.test", "staff", { ...f.change(), intent: "estimate", date: "2026-11-20" }), /Resolve payment/);
  }
});
await check("A late settlement anchors its own date and a zero-day term uses that UTC day", () => {
  const f = fixture({ paid: false, lead: 0 }); f.advance(10); f.add({ type: "payout_status", payoutSeq: 2, status: "SUCCESS", confirmedByTransactionSearch: false });
  assert.equal(f.row().expectedAt, "2026-11-14T23:59:59.999Z"); assert.equal(f.row().overdue, false);
});
await check("Merchant delay changes only the estimate; incoming quantity and money stay unchanged", async () => {
  const f = fixture(); f.advance(10); const before = spending(f.log, f.now());
  await f.manage("incoming.test", "shopify-staff:1", { ...f.change(), intent: "estimate", date: "2026-11-20" });
  assert.equal(f.row().expectedAt, "2026-11-20T23:59:59.999Z"); assert.equal(f.row().estimateSource, "merchant"); assert.equal(f.row().overdue, false);
  assert.equal(incomingFor(f.log, "123"), 40); assert.equal(f.stock(), 2); assert.equal(f.writes(), 0); assert.deepEqual(spending(f.log, f.now()), before);
});
await check("Invalid/past dates and unconfirmed closure cannot change a delivery", async () => {
  const f = fixture(); const before = f.log.length;
  for (const date of ["", "2026-02-31", "2026-11-03", "2026-11-20T00:00:00Z"]) await assert.rejects(f.manage("incoming.test", "staff", { ...f.change(), intent: "estimate", date }), /valid expected/);
  await assert.rejects(f.manage("incoming.test", "staff", { ...f.close(), confirmed: false }), /Confirm with/); assert.equal(f.log.length, before);
});
await check("Early and partial receipts replace incoming units with physical stock; full receipt releases hold immediately", async () => {
  const f = fixture(); await f.receive("incoming.test", "staff", f.receipt(10)); assert.equal(incomingFor(f.log, "123"), 30); assert.equal(f.stock(), 12);
  assert.match(skipReason({ variantId: "123", sku: "coffee" }, f.log, f.now())!, /30 units/);
  await f.receive("incoming.test", "staff", f.receipt(30)); assert.equal(incomingFor(f.log, "123"), 0); assert.equal(f.stock(), 42);
  assert.equal(skipReason({ variantId: "123", sku: "coffee" }, f.log, f.now()), null); assert.equal(inDeliveryView(f.row(), "received"), true);
});
await check("Closing only the undelivered remainder preserves received goods and spending", async () => {
  const f = fixture(); await f.receive("incoming.test", "staff", f.receipt(10)); const before = spending(f.log, f.now()); const input = f.close();
  await f.manage("incoming.test", "staff", input); await f.manage("incoming.test", "staff", input);
  assert.equal(f.row().received, 10); assert.equal(f.row().closed, 30); assert.equal(f.row().remaining, 0); assert.equal(f.stock(), 12); assert.equal(f.writes(), 1);
  assert.equal(f.log.filter((e) => e.event.type === "delivery_remainder_closed").length, 1); assert.deepEqual(spending(f.log, f.now()), before);
  assert.equal(inDeliveryView(f.row(), "closed"), true); assert.equal(inDeliveryView(f.row(), "received"), false);
  assert.equal(skipReason({ variantId: "123", sku: "coffee" }, f.log, f.now()), null);
  await assert.rejects(f.receive("incoming.test", "staff", f.receipt(1)), /exceeds/);
});
await check("Stale tabs and changed same-ID updates cannot close or reschedule a changed delivery", async () => {
  const f = fixture(); const input = f.close(); await f.receive("incoming.test", "staff", f.receipt(10));
  await assert.rejects(f.manage("incoming.test", "staff", input), /changed in another tab/);
  const update = { ...f.change(), intent: "estimate" as const, date: "2026-11-20" };
  await f.manage("incoming.test", "staff", update);
  await assert.rejects(f.manage("incoming.test", "staff", { ...update, date: "2026-11-21" }), /different details/);
});
await check("Pending receipt cannot be closed, delayed or released by a returned payment", async () => {
  const f = fixture(); const input = f.receipt(10);
  f.add({ type: "receipt_started", ...input, variantId: "123", inventoryItemId: "gid://shopify/InventoryItem/9", receivedBy: "staff" });
  f.add({ type: "payout_status", payoutSeq: 2, status: "RETURNED", confirmedByTransactionSearch: true });
  await assert.rejects(f.manage("incoming.test", "staff", f.close()), /pending receipt/);
  assert.equal(incomingFor(f.log, "123"), 40);
});
await check("Partial refunds retain goods and allow physical receipt without inferring cancelled quantities", async () => {
  const f = fixture({ rail: "order" }); f.add({ type: "order_status", decisionSeq: 1, orderId: "ORDER", status: "PARTIALLY_REFUNDED", refundedCents: 1000 });
  assert.equal(f.row().partialRefund, true); assert.equal(incomingFor(f.log, "123"), 40);
  await f.receive("incoming.test", "staff", f.receipt(10)); assert.equal(incomingFor(f.log, "123"), 30); assert.equal(f.row().received, 10);
  assert.match(skipReason({ variantId: "123", sku: "coffee" }, f.log, f.now())!, /awaiting delivery/);
  f.add({ type: "order_status", decisionSeq: 1, orderId: "ORDER", status: "REFUNDED", refundedCents: 4000 });
  assert.equal(incomingFor(f.log, "123"), 0); assert.equal(f.row().received, 10); assert.equal(f.stock(), 12);
});
await check("Terminal failed/cancelled/returned payments do not invent incoming or erase received goods", () => {
  for (const status of ["FAILED", "RETURNED", "REFUNDED", "CANCELED", "CANCELLED"]) {
    const f = fixture(); f.add({ type: "payout_status", payoutSeq: 2, status, confirmedByTransactionSearch: true });
    assert.equal(f.row().payment, "failed"); assert.equal(incomingFor(f.log, "123"), 0);
  }
});
await check("Payment reservation guard refuses replacement payment while incoming remains, even overdue", () => {
  const f = fixture({ rail: "order" }); f.advance(40);
  const p = f.add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", unitPriceCents: 100, quantity: 40, payeeEmail: "supplier@example.test", reasoning: "replacement" } });
  const d = f.add({ type: "decision", proposalSeq: p.seq, decision: { verdict: "auto", totalCents: 4000, checks: [], ruleSetHash: "hash" } });
  const attempt: Attempt = { type: "payment_attempt", decisionSeq: d.seq, attemptId: "new", requestId: "new", operation: "payout", route: "payout", amountCents: 4000, currency: "USD", payeeEmail: "supplier@example.test", fundingKey: "test", retryUntil: "2026-12-01T00:00:00Z", body: {} };
  assert.equal(canStartAttempt(f.log, attempt), false);
});
console.log(`${count} incoming-stock lifecycle checks passed; no external calls.`);
