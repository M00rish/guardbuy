// Isolated PostgreSQL only. Shopify reads are stubbed; no payments, models or inventory writes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[key] ?? "invalid:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/guardbuy_ism141_test");
}
Object.assign(process.env, { NODE_ENV: "test", GUARDBUY_PAYMENTS_DISABLED: "1" });
const { default: db } = await import("../app/db.server");
const { appendAudit, appendAuditWhen, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { restockBlock, restockCooldown } = await import("../app/lib/agent/restock-cooldown");
const { resetRestockBlock, resetRestockCooldown } = await import("../app/lib/merchant/reset-restock-cooldown.server");
const { skipReason, runRestock, defaultRuleSet, signRuleSet } = await import("../app/lib/agent/restock.server");
const { rejectPurchase } = await import("../app/lib/agent/approvals.server");
const { enqueueRestock, claimRestockJob, retryRestockJob } = await import("../app/lib/jobs/restock-queue.server");
const { toFeed } = await import("../app/lib/audit/feed.server");
const { deleteAuditEntries, disconnectOwner } = await import("./lib/audit-admin");
const shop = `cooldown-${randomUUID()}.test`;
const product = { variantId: "123", sku: "COFFEE", title: "Test coffee" };
const admin = { graphql: async (_q: string, options: { variables: { id: string } }) => {
  assert.equal(options.variables.id, "gid://shopify/ProductVariant/123");
  return Response.json({ data: { productVariant: { id: options.variables.id, inventoryItem: { id: "gid://shopify/InventoryItem/777", tracked: true } } } });
} } as unknown as AdminApiContext;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected external call"); };
try {
  await db.managedProduct.create({ data: { shop, ...product, managed: true } });
  await signRuleSet(shop, defaultRuleSet(shop), "staff");
  await db.supplier.create({ data: { shop, id: "supplier", name: "Test supplier", paypalEmail: "supplier@example.test" } });
  await db.productSupplier.create({ data: { shop, variantId: "123", supplierId: "supplier", unitPriceCents: 100, usualQuantity: 2, leadTimeDays: 3 } });
  const job = (await enqueueRestock(shop, "777"))!;
  const proposal = async () => {
    const p = await appendAudit(shop, { type: "proposal", restockJobId: `${job.id}:1`, proposal: { variantId: "123", sku: "COFFEE", supplierId: "supplier", quantity: 2, unitPriceCents: 100, reasoning: "Test only" } });
    return appendAudit(shop, { type: "decision", proposalSeq: p.seq, decision: { verdict: "approval", totalCents: 200, checks: [], ruleSetHash: "test" } });
  };
  const d = await proposal();
  await db.restockJob.update({ where: { id: job.id }, data: { completedGeneration: 1 } });
  await rejectPurchase(shop, d.seq, "shopify-staff:test");
  let log = await auditEntries(shop);
  const hold = restockCooldown(product, log)!;
  assert.equal(hold.decisionSeq, d.seq);
  const skipped = await runRestock(shop, { ...product, available: 1, perDay: 2, daysOfCover: .5, needsRestock: true });
  assert.equal(skipped.outcome, "skipped");
  assert.equal("retryAt" in skipped, false, "a decline has no timed retry: it waits for an explicit reset");
  assert.match(skipReason(product, log)!, /paused until you reset the cooldown/);
  assert.equal(restockCooldown({ ...product, variantId: "999" }, log), null, "shared SKU does not hold another variant");
  const aged = log.map(e => ({ ...e, at: new Date(0).toISOString() }));
  assert.equal(restockCooldown(product, aged)?.decisionSeq, d.seq, "a decline does not expire with age");
  assert.equal((await db.restockJob.findUniqueOrThrow({ where: { id: job.id } })).generation, 1, "a decline does not schedule a timed recheck");
  // A later stock change wakes the job, and a worker claims it before the merchant resets.
  await enqueueRestock(shop, "777");
  const claimed = await claimRestockJob();
  assert.equal(claimed?.id, job.id);
  await retryRestockJob(claimed!, 60_000);
  const before = log.length;
  assert.equal((await resetRestockCooldown(admin, shop, "staff", "123", hold.rejectedSeq + 99)).ok, false, "stale rejection refused");
  assert.equal((await auditEntries(shop)).length, before);
  const results = await Promise.all([resetRestockCooldown(admin, shop, "staff", "123", hold.rejectedSeq), resetRestockCooldown(admin, shop, "staff", "123", hold.rejectedSeq)]);
  assert.equal(results.filter(r => r.ok).length, 1, "concurrent resets record only one release");
  log = await auditEntries(shop);
  assert.equal(restockCooldown(product, log), null);
  assert.equal(skipReason(product, log), null, "reset permits a fresh proposal");
  const queued = await db.restockJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.ok(queued.generation > 1, "reset queues a fresh check");
  assert.ok(queued.availableAt <= new Date(), "reset wakes the queued job immediately");
  assert.equal(await retryRestockJob(claimed!, 60_000), false, "stale worker cannot overwrite reset with another delay");
  assert.equal((await verifyChain(shop)).valid, true);
  assert.equal(log.filter(e => e.event.type === "restock_cooldown_reset").length, 1);
  assert.equal(log.filter(e => ["approved", "payment_attempt", "payout"].includes(e.event.type)).length, 0, "reset does not approve or pay the old purchase");
  const d2 = await proposal();
  await rejectPurchase(shop, d2.seq, "staff");
  const newer = restockCooldown(product, await auditEntries(shop))!;
  assert.equal(newer.decisionSeq, d2.seq, "old reset cannot clear a later decline");
  assert.equal((await resetRestockCooldown(admin, shop, "staff", "123", hold.rejectedSeq)).ok, false);
  // A blocked proposal gets the same audited early release as a declined one, with no timer.
  const blocked = await appendAudit(shop, { type: "proposal", restockJobId: `${job.id}:3`, proposal: { variantId: "123", sku: "COFFEE", supplierId: "supplier", quantity: 2, unitPriceCents: 100, reasoning: "Test only" } });
  const blockDecision = await appendAudit(shop, { type: "decision", proposalSeq: blocked.seq, decision: { verdict: "block", totalCents: 200, checks: [{ rule: "weeklySpendCap", outcome: "block", detail: "Test cap" }], ruleSetHash: "test" } });
  let blockedLog = await auditEntries(shop);
  const block = restockBlock(product, blockedLog)!;
  assert.equal(block.decisionSeq, blockDecision.seq);
  assert.equal(block.proposalSeq, blocked.seq);
  assert.match(skipReason(product, blockedLog)!, /was blocked; lift the block to recheck/);
  const agedBlock = blockedLog.map(e => ({ ...e, at: new Date(0).toISOString() }));
  assert.equal(restockBlock(product, agedBlock)?.decisionSeq, blockDecision.seq, "a block does not expire with age");
  assert.equal((await resetRestockBlock(admin, shop, "staff", "123", block.decisionSeq + 99)).ok, false, "stale block refused");
  const lifts = await Promise.all([resetRestockBlock(admin, shop, "staff", "123", block.decisionSeq), resetRestockBlock(admin, shop, "staff", "123", block.decisionSeq)]);
  assert.equal(lifts.filter(r => r.ok).length, 1, "concurrent lifts record only one release");
  blockedLog = await auditEntries(shop);
  assert.equal(restockBlock(product, blockedLog), null);
  assert.equal(skipReason(product, blockedLog), null, "lift permits a fresh proposal");
  assert.equal(blockedLog.filter(e => e.event.type === "restock_block_reset").length, 1);
  assert.equal(blockedLog.filter(e => ["approved", "payment_attempt", "payout"].includes(e.event.type)).length, 0, "lift does not approve or pay the blocked purchase");
  assert.match(toFeed(blockedLog, "staff").find(e => e.title.includes("block"))?.title ?? "", /lifted by you/);
  assert.equal((await verifyChain(shop)).valid, true);
  await db.managedProduct.update({ where: { shop_variantId: { shop, variantId: "123" } }, data: { managed: false } });
  assert.equal((await resetRestockCooldown(admin, shop, "staff", "123", newer.rejectedSeq)).ok, false, "disabled product cannot reset");
  const count = (await auditEntries(shop)).length;
  await assert.rejects(appendAuditWhen(shop, { type: "agent_state", on: false, by: "test" }, undefined, undefined, undefined, async () => { throw Error("queue unavailable"); }), /queue unavailable/);
  assert.equal((await auditEntries(shop)).length, count, "failed queue commit rolls back audit event too");
  // Paid/in-flight reservations still block, even with an earlier reset in the history.
  const paidLog = [...log, { ...log.at(-1)!, seq: 999, event: { type: "payout" as const, decisionSeq: d.seq, payoutBatchId: "test", status: "PENDING", amountCents: 200 } }];
  assert.match(skipReason(product, paidLog)!, /PayPal confirmation|already open/);
  assert.match(toFeed(log, "staff").find(e => e.title.includes("cooldown"))?.title ?? "", /reset by you/);
  console.log("PASS holds: declines and blocks persist without a timer, product isolation, atomic audited resets, concurrent/stale requests, delayed-job wake, stale-worker fencing, later declines and payment reservations.");
} finally {
  globalThis.fetch = originalFetch;
  await db.restockJob.deleteMany({ where: { shop } });
  await db.productSupplier.deleteMany({ where: { shop } });
  await db.supplier.deleteMany({ where: { shop } });
  await db.managedProduct.deleteMany({ where: { shop } });
  await db.paymentLock.deleteMany({ where: { shop: { contains: shop } } });
  await deleteAuditEntries({ shop });
  await db.$disconnect();
  await disconnectOwner();
}
