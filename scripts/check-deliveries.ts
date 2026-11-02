// Offline receipt protocol checks: no secrets, database, Shopify, or payments.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canAppendReceipt, createReceiveDelivery, deliveries, incomingFor } from "../app/lib/inventory/deliveries";
import { AuditEventSchema, type AuditEntry, type AuditEvent } from "../app/lib/policy/schema";

function fixture() {
  const logs = new Map<string, AuditEntry[]>();
  let now = Date.parse("2026-11-02T12:00:00Z"), inventory = 8, attempts = 0, failCompletion = false, reject = false, loseResponse = false;
  const applied = new Set<string>();
  const add = (shop: string, event: AuditEvent) => {
    const log = logs.get(shop) ?? []; logs.set(shop, log);
    log.push({ shop, event: AuditEventSchema.parse(event), seq: log.length, at: new Date(now).toISOString(), hash: "", prevHash: "" });
  };
  add("a", { type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", unitPriceCents: 100, quantity: 40, reasoning: "restock" } });
  add("a", { type: "decision", proposalSeq: 0, decision: { verdict: "approval", totalCents: 4000, checks: [], ruleSetHash: "hash" } });
  add("a", { type: "payout", decisionSeq: 1, payoutBatchId: "batch", status: "SUCCESS", amountCents: 4000 });
  const input = (quantity = 10, expectedReceived = 0) => ({ decisionSeq: 1, receiptId: randomUUID(), quantity, expectedReceived, locationId: "gid://shopify/Location/5" });
  let tail = Promise.resolve();
  const receive = createReceiveDelivery({
    read: async (shop) => logs.get(shop) ?? [],
    append: async (shop, event) => { if (!canAppendReceipt(logs.get(shop) ?? [], event)) throw Error("Atomic receipt condition rejected"); if (event.type === "receipt_received" && failCompletion) { failCompletion = false; throw Error("db failed"); } add(shop, event); },
    lock: async (_shop, fn) => { const previous = tail; let release!: () => void; tail = new Promise<void>((r) => { release = r; }); await previous; try { return await fn(); } finally { release(); } },
    resolveItem: async (_variant, location) => { if (location !== "gid://shopify/Location/5") throw Error("bad location"); return "gid://shopify/InventoryItem/9"; },
    adjust: async (event) => {
      attempts++;
      if (reject) return "rejected";
      if (!applied.has(event.receiptId)) { inventory += event.quantity; applied.add(event.receiptId); }
      if (loseResponse) { loseResponse = false; throw Error("response lost after application"); }
      return "received";
    }, now: () => now,
  });
  return { receive, input, add, log: () => logs.get("a")!, inventory: () => inventory, attempts: () => attempts, paid: () => add("a", { type: "payout_status", payoutSeq: 2, status: "SUCCESS", confirmedByTransactionSearch: false }), failCompletion: () => { failCompletion = true; }, loseResponse: () => { loseResponse = true; }, reject: () => { reject = true; }, expire: () => { now += 24 * 60 * 60_000; } };
}
const f = fixture();
assert.equal(deliveries(f.log())[0].payment, "pending", "batch success is not payment confirmation");
await assert.rejects(f.receive("a", "staff", f.input()), /Confirm successful payment/);
f.paid();
assert.equal(incomingFor(f.log(), "123"), 40);
const partial = f.input();
await Promise.all([f.receive("a", "staff", partial), f.receive("a", "staff", partial)]);
assert.equal(f.inventory(), 18);
assert.equal(f.attempts(), 1, "same completed receipt bypasses Shopify entirely");
assert.equal(deliveries(f.log())[0].received, 10);
assert.equal(incomingFor(f.log(), "123"), 30);
await assert.rejects(f.receive("a", "staff", f.input(31, 10)), /exceeds/);
await assert.rejects(f.receive("a", "staff", f.input(10, 0)), /Another receipt/);
await assert.rejects(f.receive("b", "staff", f.input()), /No supplier delivery/);
await assert.rejects(f.receive("a", "staff", { ...partial, quantity: 11 }), /different details/);
const concurrent = await Promise.allSettled([f.receive("a", "staff", f.input(5, 10)), f.receive("a", "staff", f.input(5, 10))]);
assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1, "stale tabs cannot create two receipts");
assert.equal(f.inventory(), 23);
await f.receive("a", "staff", f.input(25, 15));
assert.equal(incomingFor(f.log(), "123"), 0);
assert.equal(f.inventory(), 48);
await assert.rejects(f.receive("a", "staff", f.input(1, 40)), /exceeds/);

for (const failure of ["db", "network"] as const) {
  const g = fixture(); g.paid();
  const receipt = g.input();
  if (failure === "db") g.failCompletion(); else g.loseResponse();
  await assert.rejects(g.receive("a", "staff", receipt));
  assert.equal(g.inventory(), 18);
  assert.ok(deliveries(g.log())[0].pending);
  await assert.rejects(g.receive("a", "staff", g.input()), /Resolve the pending/);
  await g.receive("a", "staff", receipt);
  assert.equal(g.inventory(), 18, "replay uses original idempotency key after ambiguous outcome");
  assert.equal(deliveries(g.log())[0].received, 10);
}
const expired = fixture(); expired.paid(); expired.loseResponse();
const receipt = expired.input();
await assert.rejects(expired.receive("a", "staff", receipt));
expired.expire();
await assert.rejects(expired.receive("a", "staff", receipt), /manual reconciliation/);
assert.equal(expired.attempts(), 1, "expired keys are never replayed");
const rejected = fixture(); rejected.paid(); rejected.reject();
await assert.rejects(rejected.receive("a", "staff", rejected.input()), /Shopify rejected/);
assert.equal(rejected.inventory(), 8);
assert.equal(deliveries(rejected.log())[0].pending, undefined);
const returned = fixture(); returned.paid();
await returned.receive("a", "staff", returned.input());
returned.add("a", { type: "payout_status", payoutSeq: 2, status: "RETURNED", confirmedByTransactionSearch: true });
assert.equal(deliveries(returned.log())[0].received, 10, "refund never removes physical receipts");
assert.equal(incomingFor(returned.log(), "123"), 0);
await assert.rejects(returned.receive("a", "staff", returned.input(10, 10)), /Confirm successful payment/);
const { skipReason } = await import("../app/lib/agent/restock.server");
const future = new Date("2026-11-10T12:00:00Z");
const open = fixture(); open.paid();
assert.match(skipReason({ variantId: "123", sku: "coffee" }, open.log(), future) ?? "", /awaiting delivery/, "outstanding orders do not expire after three days");
assert.equal(skipReason({ variantId: "123", sku: "coffee" }, f.log(), future), null, "fully received orders allow future restocking");
assert.equal(skipReason({ variantId: "456", sku: "coffee" }, open.log(), future), null, "another variant sharing the SKU is not blocked");
console.log("Delivery checks passed: partial/full receipts, duplicate and stale submissions, shop isolation, payment gates, over-receipt, API/DB crash recovery, rejection and expired-key safety.");
