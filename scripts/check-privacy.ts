// Real local Postgres + actual production HTTP build. Fake secrets; no Shopify/PayPal/AI I/O.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { completeCustomerRequest, purgeShopRequest } from "./lib/privacy-operator";
import { privacyContact } from "../app/lib/privacy/contact.server";

const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (database.hostname !== "127.0.0.1" || database.pathname !== "/guardbuy_ism42_test" || process.env.DIRECT_URL !== database.href) throw new Error("Use matching DATABASE_URL and DIRECT_URL for local guardbuy_ism42_test only.");
const owner = new PrismaClient();
await owner.$executeRawUnsafe("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbuy_privacy_test') THEN CREATE ROLE guardbuy_privacy_test LOGIN PASSWORD 'offline-only'; END IF; END $$;");
await owner.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO guardbuy_privacy_test');
await owner.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guardbuy_privacy_test');
await owner.$executeRawUnsafe('REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEntry", "PrivacyRequest", "PrivacyBlock" FROM guardbuy_privacy_test');
const appURL = new URL(database); appURL.username = "guardbuy_privacy_test"; appURL.password = "offline-only";
const app = new PrismaClient({ datasourceUrl: appURL.href });
Object.assign(globalThis, { prismaGlobal: app });
const { appendAudit, verifyChain } = await import("../app/lib/audit/log.server");
const { receivePrivacyRequest } = await import("../app/lib/privacy/requests.server");
const { privacyShopHash } = await import("../app/lib/privacy/state.server");
const { recordSalesOnce } = await import("../app/lib/inventory/sales.server");
const { enqueueRestock } = await import("../app/lib/jobs/restock-queue.server");
const { verifyPayment } = await import("../app/lib/audit/verify.server");
const { publicDashboard } = await import("../app/lib/demo/dashboard.server");
const shop = `test-privacy-${randomUUID()}.myshopify.com`, other = `test-privacy-${randomUUID()}.myshopify.com`;
const port = Number(process.env.GUARDBUY_PRIVACY_TEST_PORT ?? 4382);
const secret = "offline-shopify-secret";
const env = { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: appURL.href, SHOPIFY_API_KEY: "00000000000000000000000000000000", SHOPIFY_API_SECRET: secret, SHOPIFY_APP_URL: `http://localhost:${port}`, GUARDBUY_RESTOCK_WORKER: "off", GUARDBUY_PAYMENTS_DISABLED: "1", PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com", GUARDBUY_PAYPAL_STORES: "{}", GUARDBUY_PUBLIC_DEMO_ENABLED: "false", GUARDBUY_PRIVACY_CONTACT: "mailto:privacy@example.test" };
const server = spawn(process.execPath, ["node_modules/@react-router/serve/bin.js", "./build/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; server.stdout.on("data", (d) => { output += d; }); server.stderr.on("data", (d) => { output += d; });
const results: { name: string; passed: boolean; facts?: unknown }[] = [];
const record = (name: string, facts?: unknown) => { results.push({ name, passed: true, facts }); console.log(`PASS ${name}`); };
const base = `http://127.0.0.1:${port}`;
const requestPayload = { shop_domain: shop, customer: { id: 12345, email: "customer-private@example.test", phone: "+15555550123" }, orders_requested: [654321], data_request: { id: 6789 } };
async function deliver(topic: string, eventId: string, valid = true, payload = requestPayload) {
  const body = JSON.stringify(payload);
  return fetch(`${base}/webhooks/privacy`, { method: "POST", headers: { "content-type": "application/json", "x-shopify-topic": topic, "x-shopify-shop-domain": shop, "x-shopify-webhook-id": eventId, "x-shopify-event-id": eventId, "x-shopify-api-version": "2026-10", "x-shopify-hmac-sha256": valid ? createHmac("sha256", secret).update(body).digest("base64") : "invalid-signature" }, body });
}
async function seed(target: string) {
  await owner.session.create({ data: { id: `offline_${target}`, shop: target, state: "offline", isOnline: false, accessToken: "fake", firstName: "Merchant", email: "staff-private@example.test" } });
  await owner.supplier.create({ data: { shop: target, id: "supplier", name: "Test supplier", paypalEmail: "supplier-private@example.test" } });
  await owner.managedProduct.create({ data: { shop: target, variantId: "123", title: "Test coffee", managed: true } });
  await owner.productSupplier.create({ data: { shop: target, variantId: "123", supplierId: "supplier", unitPriceCents: 100, usualQuantity: 1, leadTimeDays: 1, note: "demo note" } });
  await owner.shopSettings.create({ data: { shop: target, shareVerifyDetails: true } });
  await owner.dailySales.create({ data: { shop: target, variantId: "123", day: new Date("2026-11-01"), units: 3 } });
  await owner.salesBackfill.create({ data: { shop: target, completedAt: new Date() } });
  await enqueueRestock(target, "456");
  const p = await appendAudit(target, { type: "proposal", proposal: { sku: "COFFEE", supplierId: "supplier", quantity: 1, unitPriceCents: 100, payeeEmail: "supplier-private@example.test", reasoning: "test" } });
  const d = await appendAudit(target, { type: "decision", proposalSeq: p.seq, decision: { verdict: "auto", totalCents: 100, checks: [], ruleSetHash: "test" } });
  const paid = await appendAudit(target, { type: "payout", decisionSeq: d.seq, payoutBatchId: target === shop ? "PRIVACYBATCH123" : "OTHERBATCH123", status: "PENDING", amountCents: 100 });
  await appendAudit(target, { type: "payout_status", payoutSeq: paid.seq, status: "SUCCESS", confirmedByTransactionSearch: true });
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`HTTP build exited: ${output}`);
    try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, `HTTP build did not start: ${output}`);
  await assert.rejects(receivePrivacyRequest({ shop, topic: "ORDERS_CREATE", eventId: randomUUID() }), (e: Response) => e.status === 400);
  record("Non-privacy topics are refused before inbox writes");
  const page = await fetch(`${base}/privacy`); const html = await page.text();
  assert.equal(page.status, 200); assert.ok(!page.headers.get("location"));
  for (const text of ["GuardBuy privacy policy", "Shopper data", "Google Gemini", "OpenRouter", "90-day cutoff", "no automatic 90-day deletion", "not a merchant agreement", "mailto:privacy@example.test"]) assert.ok(html.includes(text), text);
  record("Public production privacy page returns 200 without login and discloses actual retention/AI limits");
  for (const unsafe of ["javascript:alert(1)", "data:text/html,unsafe", "https://user:secret@example.test", "mailto:x@example.test?body=private", "http://example.test", "mailto:x@example.test%0ABcc:evil.test"]) assert.equal(privacyContact(unsafe), null);
  assert.equal(privacyContact("https://support.example.test/privacy"), "https://support.example.test/privacy");
  record("Privacy contact accepts public HTTPS/mailto and refuses unsafe or credential-bearing destinations");
  assert.equal((await deliver("customers/data_request", randomUUID(), false)).status, 401);
  assert.equal(await owner.privacyRequest.count({ where: { shop } }), 0);
  record("Invalid Shopify HMAC returns 401 and persists no request");
  assert.equal((await deliver("shop/redact", randomUUID(), true, { ...requestPayload, shop_domain: other })).status, 400);
  assert.equal(await owner.privacyBlock.count(), 0);
  record("Signed body/header shop mismatch is refused before any suppression");
  const event = randomUUID();
  const responses = await Promise.all([deliver("customers/data_request", event), deliver("customers/data_request", event)]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  const receipt = await owner.privacyRequest.findFirstOrThrow({ where: { shop, topic: "CUSTOMERS_DATA_REQUEST" } });
  assert.equal(await owner.privacyRequest.count({ where: { shop, topic: "CUSTOMERS_DATA_REQUEST" } }), 1);
  assert.equal(receipt.requestId, "6789"); assert.equal(receipt.status, "pending"); assert.equal(receipt.dueAt.getTime() - receipt.receivedAt.getTime() >= 29 * 86_400_000, true);
  const saved = JSON.stringify(receipt);
  for (const privateValue of ["customer-private", "+15555550123", "12345", "654321", "untrusted-payload"]) assert.ok(!saved.includes(privateValue));
  await deliver("customers/data_request", event);
  assert.equal((await owner.privacyRequest.findUniqueOrThrow({ where: { id: receipt.id } })).dueAt.getTime(), receipt.dueAt.getTime());
  record("Signed request after uninstall is durable/deduplicated, uses verified shop, strips customer payload and preserves deadline", { receiptId: receipt.id, status: receipt.status, dueAt: receipt.dueAt });
  await owner.$executeRawUnsafe('REVOKE INSERT ON "PrivacyRequest" FROM guardbuy_privacy_test');
  const failEvent = randomUUID();
  try { assert.equal((await deliver("customers/redact", failEvent)).status, 500); }
  finally { await owner.$executeRawUnsafe('GRANT INSERT ON "PrivacyRequest" TO guardbuy_privacy_test'); }
  assert.equal(await owner.privacyRequest.count({ where: { eventId: failEvent } }), 0);
  assert.equal((await deliver("customers/redact", failEvent)).status, 200);
  record("Inbox persistence failure is not acknowledged; retry succeeds after database access is restored");
  await seed(shop); await seed(other);
  assert.ok((await verifyPayment("PRIVACYBATCH123")).found);
  process.env.GUARDBUY_PUBLIC_DEMO_ENABLED = "true"; process.env.GUARDBUY_DEMO_STORE = shop; process.env.PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
  let calls = 0;
  const admin = { graphql: async (query: string) => { calls++; return Response.json({ data: query.includes("ordersCount") ? { ordersCount: { count: 3, precision: "EXACT" } } : { nodes: [] } }); } };
  await publicDashboard(admin as never, shop);
  const callsBeforeBlock = calls;
  const redactEvent = randomUUID(); assert.equal((await deliver("shop/redact", redactEvent)).status, 200);
  const shopRequest = await owner.privacyRequest.findFirstOrThrow({ where: { shop, topic: "SHOP_REDACT" } });
  assert.equal(shopRequest.status, "pending"); assert.equal(await owner.session.count({ where: { shop } }), 0); assert.equal(await owner.restockJob.count({ where: { shop } }), 0); assert.equal(await owner.shopSettings.count({ where: { shop } }), 0);
  assert.equal(await owner.auditEntry.count({ where: { shop } }), 4); assert.ok((await verifyChain(shop)).valid);
  record("Shop-redact atomically revokes sessions/sharing/jobs and keeps audit evidence pending owner fulfillment");
  assert.deepEqual(await verifyPayment("PRIVACYBATCH123"), { found: false });
  await assert.rejects(publicDashboard(admin as never, shop), (e: Response) => e.status === 404); assert.equal(calls, callsBeforeBlock);
  const publicProof = await fetch(`${base}/verify?id=PRIVACYBATCH123`); assert.ok(!(await publicProof.text()).includes("Test supplier"));
  record("Suppressed shop disappears from public Verify and cached dashboard without new provider reads");
  assert.equal(await recordSalesOnce(shop, randomUUID(), "ORDERS_CREATE", new Date(), [{ variantId: 123, units: 5 }]), false);
  assert.equal(await enqueueRestock(shop, "456"), null);
  await assert.rejects(app.supplier.update({ where: { shop_id: { shop, id: "supplier" } }, data: { name: "late update" } }), /suppressed/);
  await assert.rejects(app.session.create({ data: { id: randomUUID(), shop, state: "late", isOnline: false, accessToken: "fake" } }), /suppressed/);
  record("Late sales/jobs and stale supplier/session writes cannot recreate suppressed shop data");
  await assert.rejects(app.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`; await tx.auditEntry.deleteMany({ where: { shop } }); }), /permission denied/);
  await assert.rejects(app.privacyBlock.deleteMany({ where: { shopHash: privacyShopHash(shop) } }), /permission denied/);
  await assert.rejects(app.privacyRequest.update({ where: { id: shopRequest.id }, data: { status: "completed" } }), /permission denied/);
  record("Restricted app role cannot erase audit, lift privacy suppression or mark requests complete");
  await assert.rejects(purgeShopRequest(owner, shopRequest.id, other, "test-review"), /does not match/);
  await owner.paymentLock.create({ data: { shop: "test-privacy-active-lease", holder: "fixture", lockedUntil: new Date(Date.now() + 60_000) } });
  try { await assert.rejects(purgeShopRequest(owner, shopRequest.id, shop, "test-review"), /in flight/); }
  finally { await owner.paymentLock.delete({ where: { shop: "test-privacy-active-lease" } }); }
  record("Owner erasure refuses wrong-shop confirmation and active leases");
  const attempt = { type: "payment_attempt" as const, operation: "payout" as const, route: "payout" as const, decisionSeq: 99, attemptId: "unknown-privacy-payment", requestId: "unknown-privacy-payment", fundingKey: "test", amountCents: 100, currency: "USD" as const, payeeEmail: "supplier@example.test", body: {}, retryUntil: new Date(Date.now() + 3600_000).toISOString() };
  await appendAudit(shop, attempt);
  await assert.rejects(purgeShopRequest(owner, shopRequest.id, shop, "test-review"), /Unresolved payment/);
  assert.equal(await owner.auditEntry.count({ where: { shop } }), 5);
  // This fixture never sends a payment. A positive failed outcome is permitted only as synthetic test evidence.
  await appendAudit(shop, { type: "payment_outcome", decisionSeq: 99, attemptId: attempt.attemptId, status: "failed" });
  record("Owner erasure preserves uncertain payment evidence until resolved; reconciliation can still append");
  const result = await purgeShopRequest(owner, shopRequest.id, shop, "fixture-review-external-copies-checked");
  assert.equal(result.deletedAuditEntries, 6); assert.equal(await owner.auditEntry.count({ where: { shop } }), 0);
  for (const model of [owner.session, owner.supplier, owner.productSupplier, owner.managedProduct, owner.dailySales, owner.processedWebhook, owner.salesBackfill, owner.shopSettings, owner.restockJob]) {
    assert.equal(await (model.count as unknown as (arg: { where: { shop: string } }) => Promise<number>)({ where: { shop } }), 0);
  }
  assert.equal(await owner.auditEntry.count({ where: { shop: other } }), 4);
  const completed = await owner.privacyRequest.findUniqueOrThrow({ where: { id: shopRequest.id } });
  assert.equal(completed.status, "completed"); assert.equal(completed.shop, null); assert.equal(completed.requestId, null); assert.ok(completed.referenceHash); assert.ok((await owner.privacyBlock.findUniqueOrThrow({ where: { shopHash: privacyShopHash(shop) } })).purgedAt);
  record("Owner-only whole-shop erasure deletes all primary records, preserves another shop and clears receipt references", result);
  assert.ok((await purgeShopRequest(owner, shopRequest.id, shop, "fixture-review")).alreadyCompleted);
  assert.equal((await deliver("shop/redact", redactEvent)).status, 200);
  assert.equal((await owner.privacyRequest.findUniqueOrThrow({ where: { id: shopRequest.id } })).shop, null);
  await assert.rejects(appendAudit(shop, { type: "agent_state", on: true, by: "late-worker" }), /erased/);
  await assert.rejects(app.auditEntry.create({ data: { shop, seq: 0, at: new Date(), type: "agent_state", event: { type: "agent_state", on: true, by: "late-worker" }, prevHash: "0".repeat(64), hash: "a".repeat(64) } }), /cannot be recreated/);
  record("Erasure is idempotent; duplicate delivery and raw late audit inserts cannot recreate the chain");
  await completeCustomerRequest(owner, receipt.id, "fixture-customer-response-sent");
  const customerDone = await owner.privacyRequest.findUniqueOrThrow({ where: { id: receipt.id } }); assert.equal(customerDone.shop, null); assert.equal(customerDone.status, "completed");
  await assert.rejects(completeCustomerRequest(owner, shopRequest.id, "wrong-command"), /whole-shop/);
  const customerDelete = await owner.privacyRequest.findFirstOrThrow({ where: { shop, topic: "CUSTOMERS_REDACT" } });
  await owner.privacyRequest.update({ where: { id: customerDelete.id }, data: { status: "legal_hold" } });
  await assert.rejects(completeCustomerRequest(owner, customerDelete.id, "not-fulfilled"), /legal hold/);
  record("Customer completion requires operator workflow; shop deletion cannot be bypassed and legal holds stay open");
  const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/privacy-requests.ts", "list"], { env: { ...process.env, DIRECT_URL: database.href }, encoding: "utf8" });
  assert.equal(cli.status, 0); assert.ok(cli.stdout.includes(customerDelete.id)); assert.ok(!cli.stdout.includes("customer-private"));
  record("Offline operator inbox lists outstanding deadlines without customer payloads");
  const { pruneOldSales, pruneProcessedWebhooks } = await import("../app/lib/inventory/sales.server");
  await owner.dailySales.create({ data: { shop: other, variantId: "old", day: new Date(Date.now() - 100 * 86_400_000), units: 1 } });
  const oldWebhook = randomUUID(); await owner.processedWebhook.create({ data: { shop: other, topic: "TEST", eventId: oldWebhook, receivedAt: new Date(Date.now() - 8 * 86_400_000) } });
  await pruneOldSales(other); await pruneProcessedWebhooks();
  assert.equal(await owner.dailySales.count({ where: { shop: other, variantId: "old" } }), 0);
  assert.equal(await owner.processedWebhook.count({ where: { eventId: oldWebhook } }), 0);
  record("Explicit sales/webhook maintenance applies the 90-day and seven-day cutoffs");
  await owner.privacyRequest.update({ where: { id: receipt.id }, data: { completedAt: new Date(Date.now() - 100 * 86_400_000) } });
  const prune = spawnSync(process.execPath, ["--import", "tsx", "scripts/privacy-requests.ts", "prune-receipts"], { env: { ...process.env, DIRECT_URL: database.href }, encoding: "utf8" });
  assert.equal(prune.status, 0); assert.equal(await owner.privacyRequest.findUnique({ where: { id: receipt.id } }), null);
  assert.ok(await owner.privacyRequest.findUnique({ where: { id: customerDelete.id } }));
  assert.ok(await owner.privacyBlock.findUnique({ where: { shopHash: privacyShopHash(shop) } }));
  record("Receipt pruning removes old completed metadata and preserves open requests/suppression");
  assert.ok(!output.includes("customer-private@example.test"));
  record("HTTP server logs contain no raw test customer email");
  console.log(`${results.length} privacy checks passed; real HTTP build and Postgres, no external provider calls.`);
} finally {
  server.kill("SIGTERM");
  if (server.exitCode === null) await new Promise<void>((r) => server.once("exit", () => r()));
  await writeFile(process.env.GUARDBUY_PRIVACY_EVIDENCE_PATH ?? "node_modules/.cache/privacy-results.json", JSON.stringify({ at: new Date().toISOString(), productionBuildHTTP: true, realPostgres: true, simulatedCredentialsOnly: true, results }, null, 2));
  await writeFile(process.env.GUARDBUY_PRIVACY_SERVER_LOG ?? "node_modules/.cache/privacy-server.log", output);
  // Cleanup only these random throwaway shops. Erasure/suppression is intentionally bypassed only by the test owner.
  await owner.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`; await tx.auditEntry.deleteMany({ where: { shop: { in: [shop, other] } } }); });
  for (const target of [shop, other]) {
    await owner.restockJob.deleteMany({ where: { shop: target } }); await owner.session.deleteMany({ where: { shop: target } }); await owner.shopSettings.deleteMany({ where: { shop: target } });
    await owner.productSupplier.deleteMany({ where: { shop: target } }); await owner.supplier.deleteMany({ where: { shop: target } }); await owner.managedProduct.deleteMany({ where: { shop: target } });
    await owner.dailySales.deleteMany({ where: { shop: target } }); await owner.salesBackfill.deleteMany({ where: { shop: target } }); await owner.processedWebhook.deleteMany({ where: { shop: target } });
    await owner.privacyRequest.deleteMany({ where: { shopHash: privacyShopHash(target) } }); await owner.privacyBlock.deleteMany({ where: { shopHash: privacyShopHash(target) } });
  }
  await app.$disconnect(); await owner.$disconnect();
}
