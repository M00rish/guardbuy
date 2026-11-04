// Disposable Postgres and the actual management/receipt services. Shopify adjustments are simulated.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { AuditEventSchema, type AuditEvent } from "../app/lib/policy/schema";
for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[key] ?? "invalid:");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/guardbuy_ism15_test") throw new Error(`${key} must select local guardbuy_ism15_test`);
}
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain, entryHash } = await import("../app/lib/audit/log.server");
const { manageDelivery } = await import("../app/lib/inventory/delivery-management.server");
const { receiver } = await import("../app/lib/inventory/receive.server");
const { deliveries, incomingFor } = await import("../app/lib/inventory/deliveries");
const { checkStock } = await import("../app/lib/inventory/trigger.server");
const { privacyShopHash } = await import("../app/lib/privacy/state.server");
const { spending, skipReason } = await import("../app/lib/agent/restock.server");
const shops: string[] = [];
const results: { name: string; passed: boolean; facts: unknown }[] = [];
let stock = 0, adjustmentCalls = 0, loseResponse = false;
const adjusted = new Set<string>();
const admin = { graphql: async (query: string, args: { variables: { key: string; input: { referenceDocumentUri: string; changes: { delta: number }[] } } }) => {
  if (query.includes("query ReceiptLocations")) return Response.json({ data: {
    productVariant: { inventoryItem: { id: "gid://shopify/InventoryItem/9", tracked: true,
      inventoryLevels: { nodes: [{ location: { id: "gid://shopify/Location/5", name: "Test warehouse" } }] } } },
  } });
  assert.ok(query.includes("mutation ReceiveSupplierDelivery")); adjustmentCalls++;
  const { key, input } = args.variables;
  if (!adjusted.has(key)) { adjusted.add(key); stock += input.changes[0].delta; }
  if (loseResponse) { loseResponse = false; throw new Error("simulated response loss"); }
  return Response.json({ data: { inventoryAdjustQuantities: { userErrors: [], inventoryAdjustmentGroup: { referenceDocumentUri: input.referenceDocumentUri } } } });
} };
const receive = receiver(admin as never);
async function fixture(rail = "payout", paid = true) {
  const shop = `test-ism15-${randomUUID()}.test`; shops.push(shop);
  await db.supplier.create({ data: { shop, id: "supplier", name: "Test supplier", paypalEmail: "supplier@example.test" } });
  await db.productSupplier.create({ data: { shop, variantId: "123", supplierId: "supplier", unitPriceCents: 100, usualQuantity: 10, leadTimeDays: 5 } });
  const at = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await db.dailySales.create({ data: { shop, variantId: "123", day: new Date(at.slice(0, 10)), units: 30 } });
  let seq = 0, previous = "0".repeat(64);
  const add = async (event: AuditEvent) => {
    const parsed = AuditEventSchema.parse(event); const hash = entryHash(previous, { seq, shop, at, event: parsed });
    await db.auditEntry.create({ data: { shop, seq, at: new Date(at), type: parsed.type, event: parsed as object, prevHash: previous, hash } }); previous = hash; seq++;
  };
  await add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", unitPriceCents: 100, quantity: 40, supplierLeadTimeDays: 5, payeeEmail: "supplier@example.test", reasoning: "test fixture" } });
  await add({ type: "decision", proposalSeq: 0, decision: { verdict: "auto", totalCents: 4000, checks: [], ruleSetHash: "test" } });
  if (rail === "payout") {
    await add({ type: "payout", decisionSeq: 1, payoutBatchId: "BATCH", amountCents: 4000, status: "PENDING" });
    if (paid) await add({ type: "payout_status", payoutSeq: 2, status: "SUCCESS", confirmedByTransactionSearch: true });
  } else await add({ type: "order_captured", decisionSeq: 1, orderId: "ORDER", captureId: "CAPTURE", amountCents: 4000, status: paid ? "COMPLETED" : "PENDING", confirmedByGetOrder: false });
  return shop;
}
async function row(shop: string) { return deliveries(await auditEntries(shop))[0]; }
async function change(shop: string) { return { decisionSeq: 1, updateId: randomUUID(), expectedRevision: (await row(shop)).revision }; }
async function close(shop: string) { return { ...await change(shop), intent: "close" as const, reason: "supplier_cancelled" as const, confirmed: true }; }
async function receipt(shop: string, quantity: number) { return { decisionSeq: 1, receiptId: randomUUID(), quantity, expectedReceived: (await row(shop)).received, locationId: "gid://shopify/Location/5" }; }
async function record(name: string, shop: string) {
  const log = await auditEntries(shop); const chain = await verifyChain(shop); assert.ok(chain.valid);
  results.push({ name, passed: true, facts: { delivery: deliveries(log)[0], chain, stock, adjustmentCalls, audit: log } }); console.log(`PASS ${name}`);
}
try {
  const old = await fixture(); assert.ok((await row(old)).overdue); assert.equal(incomingFor(await auditEntries(old), "123"), 40);
  assert.match(skipReason({ variantId: "123", sku: "coffee" }, await auditEntries(old))!, /awaiting delivery/);
  const check = await checkStock(old, { variantId: "123", sku: "coffee", available: 0, createdAt: new Date(Date.now() - 10 * 86_400_000) });
  assert.equal(check.incoming, 40); assert.equal(check.available, 0); assert.equal(check.daysOfCover, 0); assert.ok(check.projectedDaysOfCover! > 7); assert.equal(check.needsRestock, false);
  results.push({ name: "Actual stock check counts incoming coverage without inflating physical inventory", passed: true, facts: { check } }); console.log("PASS Actual stock check counts incoming coverage without inflating physical inventory");
  const arrival = (await row(old)).expectedAt;
  await db.productSupplier.update({ where: { shop_variantId_supplierId: { shop: old, variantId: "123", supplierId: "supplier" } }, data: { leadTimeDays: 20 } });
  assert.equal((await row(old)).expectedAt, arrival);
  await record("Ten-day-old shipment stays incoming and its estimate ignores later supplier edits", old);
  const future = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
  const update = { ...await change(old), intent: "estimate" as const, date: future };
  await manageDelivery(old, "shopify-staff:test", update); await manageDelivery(old, "shopify-staff:test", update);
  assert.equal((await row(old)).overdue, false); assert.equal((await row(old)).estimateSource, "merchant"); assert.equal(adjustmentCalls, 0);
  assert.equal((await auditEntries(old)).filter((e) => e.event.type === "delivery_estimate_updated").length, 1);
  await record("Actual manager updates estimate once, retains all incoming units and writes no inventory", old);
  const stale = await close(old); const partial = await receipt(old, 10);
  await receive(old, "shopify-staff:test", partial);
  await assert.rejects(manageDelivery(old, "shopify-staff:test", stale), /changed in another tab/);
  assert.equal((await row(old)).received, 10); assert.equal(incomingFor(await auditEntries(old), "123"), 30); assert.equal(stock, 10);
  await record("Actual receipt adds ten units once; stale close cannot release the remaining thirty", old);
  const before = spending(await auditEntries(old)); const finish = await close(old); const beforeStock = stock;
  await manageDelivery(old, "shopify-staff:test", finish); await manageDelivery(old, "shopify-staff:test", finish);
  assert.equal((await row(old)).closed, 30); assert.equal((await row(old)).remaining, 0); assert.equal(stock, beforeStock); assert.deepEqual(spending(await auditEntries(old)), before);
  assert.equal(skipReason({ variantId: "123", sku: "coffee" }, await auditEntries(old)), null);
  assert.equal((await checkStock(old, { variantId: "123", sku: "coffee", available: stock, createdAt: new Date(Date.now() - 10 * 86_400_000) })).needsRestock, true);
  await record("Closing the confirmed remainder is idempotent, releases only incoming stock and changes no spending", old);
  const race = await fixture(); const closing = await close(race); const receiving = await receipt(race, 10); const startStock = stock;
  const raceResults = await Promise.allSettled([manageDelivery(race, "staff:a", closing), receive(race, "staff:b", receiving)]);
  assert.equal(raceResults.filter((r) => r.status === "fulfilled").length, 1);
  const raced = await row(race); assert.ok(raced.closed === 40 && raced.received === 0 || raced.received === 10 && raced.closed === 0);
  assert.equal(stock - startStock, raced.received);
  await record("Concurrent close versus receipt has one winner under actual database coordination", race);
  const uncertain = await fixture(); const uncertainReceipt = await receipt(uncertain, 10); loseResponse = true;
  await assert.rejects(receive(uncertain, "staff", uncertainReceipt), /not confirmed/);
  assert.ok((await row(uncertain)).pending);
  await assert.rejects(manageDelivery(uncertain, "staff", await close(uncertain)), /pending receipt/);
  const afterLost = stock; await receive(uncertain, "staff", uncertainReceipt); assert.equal(stock, afterLost); assert.equal((await row(uncertain)).received, 10);
  await record("Lost Shopify receipt response blocks closure; original-key retry never adds stock twice", uncertain);
  const refund = await fixture("order"); await appendAudit(refund, { type: "order_status", decisionSeq: 1, orderId: "ORDER", status: "PARTIALLY_REFUNDED", refundedCents: 1000 });
  assert.equal(incomingFor(await auditEntries(refund), "123"), 40); await receive(refund, "staff", await receipt(refund, 10));
  assert.equal(incomingFor(await auditEntries(refund), "123"), 30);
  await appendAudit(refund, { type: "order_status", decisionSeq: 1, orderId: "ORDER", status: "REFUNDED", refundedCents: 4000 });
  assert.equal(incomingFor(await auditEntries(refund), "123"), 0); assert.equal((await row(refund)).received, 10);
  await record("Partial refund retains shipment; full refund releases incoming without removing received goods", refund);
  const pending = await fixture("payout", false);
  await assert.rejects(manageDelivery(pending, "staff", await close(pending)), /Resolve payment/); await assert.rejects(receive(pending, "staff", await receipt(pending, 10)), /Confirm successful payment/);
  await record("Unconfirmed payment cannot be received or closed through the actual services", pending);
  const blocked = await fixture(); await db.privacyBlock.create({ data: { shopHash: privacyShopHash(blocked) } }); const calls = adjustmentCalls;
  await assert.rejects(manageDelivery(blocked, "staff", await close(blocked)), (e: Response) => e.status === 410);
  await assert.rejects(receive(blocked, "staff", await receipt(blocked, 10)), (e: Response) => e.status === 410);
  assert.equal(adjustmentCalls, calls);
  await record("Privacy suppression prevents both delivery management and new receipt adjustments", blocked);
  const empty = `test-ism15-empty-${randomUUID()}.test`; shops.push(empty);
  await assert.rejects(manageDelivery(empty, "staff", { ...finish, updateId: randomUUID() }), /outstanding delivery/);
  assert.equal(await db.auditEntry.count({ where: { shop: empty } }), 0);
  await record("Shop-scoped management never loads a decision from another shop", old);
  console.log(`${results.length} incoming-stock database scenarios passed; actual services and Postgres, simulated Shopify inventory only.`);
} finally {
  await writeFile(process.env.GUARDBUY_INCOMING_EVIDENCE_PATH ?? "node_modules/.cache/incoming-stock-results.json", JSON.stringify({ at: new Date().toISOString(), realPostgres: true, actualManagementAndReceiptServices: true, simulatedShopifyInventory: true, results }, null, 2));
  for (const shop of shops) {
    await db.privacyBlock.deleteMany({ where: { shopHash: privacyShopHash(shop) } });
    await db.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`; await tx.auditEntry.deleteMany({ where: { shop } }); });
    await db.paymentLock.deleteMany({ where: { shop } }); await db.dailySales.deleteMany({ where: { shop } }); await db.productSupplier.deleteMany({ where: { shop } }); await db.supplier.deleteMany({ where: { shop } });
  }
  await db.$disconnect();
}
