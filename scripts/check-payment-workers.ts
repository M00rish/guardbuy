// Real Postgres + separate Node processes + localhost fake PayPal. Never loads .env.
// Requires migrated local guardbuy_ism43_test database. No live credentials or payments.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import type { PayPalOrder } from "../app/lib/agent/execute.server";

for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[name] ?? "invalid:");
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/guardbuy_ism43_test") throw new Error(`${name} must select local guardbuy_ism43_test`);
}
const directory = path.resolve("node_modules/.cache/ism43-workers");
await mkdir(directory, { recursive: true });
const entry = path.join(directory, "worker.mjs");
const adapter = path.resolve("scripts/lib/payment-worker-adapters.ts");
await build({ entryPoints: ["scripts/lib/payment-worker.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{ name: "local-external-adapters", setup(b) { b.onResolve({ filter: /(?:toolkit|proposer|shopify)\.server$/ }, () => ({ path: adapter })); } }],
});

type Batch = { id: string; key: string; body: { items: { receiver: string; amount: { value: string; currency: string } }[] } };
let batches = new Map<string, Batch>(), orders = new Map<string, PayPalOrder>(), orderKeys = new Map<string, string>();
let paymentRequests: string[] = [], captures = 0, proposals = 0, stockReads = 0, balanceCents = 1000000;
let holdBalance = false, balanceHeld: (() => void) | undefined, releaseBalance: Promise<void> = Promise.resolve();
let holdPayout = false, payoutHeld: (() => void) | undefined, releasePayout: Promise<void> = Promise.resolve();
let holdOrder = false, orderHeld: (() => void) | undefined, releaseOrder: Promise<void> = Promise.resolve();
let available = 1;
const server = createServer(async (req, res) => {
  const send = (value: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/v1/oauth2/token") return send({ access_token: "offline-token", expires_in: 3600 });
    if (url.pathname === "/v1/reporting/balances") {
      if (holdBalance) { holdBalance = false; balanceHeld?.(); await releaseBalance; }
      return send({ as_of_time: new Date(Date.now() - 3600_000).toISOString(), balances: [{ currency: "USD", available_balance: { value: (balanceCents / 100).toFixed(2) } }] });
    }
    if (url.pathname === "/test/stock") { stockReads++; return send({ available }); }
    let raw = ""; if (req.method === "POST") for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === "/test/propose") { proposals++; return send({ sku: body.check.sku, supplierId: "atlas-roasters", quantity: 10, unitPriceCents: 100, reasoning: "Restock low inventory", model: "local-test" }); }
    const key = String(req.headers["paypal-request-id"] ?? "");
    if (url.pathname === "/v1/payments/payouts" && req.method === "POST") {
      assert.ok(key); assert.equal(body.sender_batch_header.sender_batch_id, key); assert.equal(body.items[0].receiver, "supplier@example.test");
      paymentRequests.push(key);
      let batch = batches.get(key);
      if (batch) {
        assert.deepEqual(body, batch.body, "same request key must keep the exact request body");
        return send({ name: "VALIDATION_ERROR", details: [{ issue: "DUPLICATE_BATCH_HEADER" }], links: [{ href: `${base}/v1/payments/payouts/${batch.id}` }] }, 400);
      }
      batch = { id: `BATCH${batches.size + 1}`, key, body }; batches.set(key, batch);
      if (holdPayout) { holdPayout = false; payoutHeld?.(); await releasePayout; }
      return send({ batch_header: { payout_batch_id: batch.id, batch_status: "PENDING" } });
    }
    if (url.pathname.startsWith("/v1/payments/payouts/")) {
      const batch = [...batches.values()].find((b) => url.pathname.endsWith("/" + b.id))!;
      return send({ batch_header: { payout_batch_id: batch.id, batch_status: "PENDING", sender_batch_header: { sender_batch_id: batch.key } }, items: [{ payout_item: batch.body.items[0] }] });
    }
    if (url.pathname === "/v2/checkout/orders" && req.method === "POST") {
      const id = orderKeys.get(key) ?? `ORDER${orders.size + 1}`; orderKeys.set(key, id);
      orders.set(id, { id, status: "APPROVED", payer: { payer_id: "TESTPAYER" }, purchase_units: body.purchase_units });
      if (holdOrder) { holdOrder = false; orderHeld?.(); await releaseOrder; }
      return send({ id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    if (url.pathname.startsWith("/v2/checkout/orders/")) {
      const id = url.pathname.split("/")[4], order = orders.get(id)!;
      if (req.method === "POST" && url.pathname.endsWith("/capture")) {
        paymentRequests.push(key);
        if (order.status !== "COMPLETED") {
          captures++; order.status = "COMPLETED";
          order.purchase_units![0].payments = { captures: [{ id: `CAPTURE${captures}`, status: "COMPLETED", amount: order.purchase_units![0].amount! }] };
        }
      }
      return send(order);
    }
    send({ error: "Unexpected local provider request", path: url.pathname }, 404);
  } catch (error) { send({ error: (error as Error).message }, 500); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.NODE_ENV = "test";
process.env.GUARDBUY_PAYPAL_TEST_API = "1";
process.env.PAYPAL_API_BASE = base; process.env.PAYPAL_CLIENT_ID = "offline-worker-test"; process.env.PAYPAL_CLIENT_SECRET = "fake";
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { defaultRuleSet, signRuleSet } = await import("../app/lib/agent/restock.server");
const { hashOf } = await import("../app/lib/policy/hash");
const { fundingKey } = await import("../app/lib/payments/attempts.server");
const { attemptStates, purchaseReservations } = await import("../app/lib/payments/attempts");
const queue = await import("../app/lib/jobs/restock-queue.server");
const workers = new Set<ReturnType<typeof spawn>>(), shops: string[] = [];
type WorkerResult = { ok?: boolean; result?: unknown; error?: { name: string; message: string }; killed?: boolean };
async function worker(action: string, shop: string, decisionSeq = 0, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [entry, JSON.stringify({ action, shop, decisionSeq })], { env: { ...process.env, NODE_ENV: "test", GUARDBUY_PAYPAL_STORES: JSON.stringify(Object.fromEntries(shops.map((s) => [s, { clientId: "offline-worker-test", payerIds: ["TESTPAYER"] }]))), ...extraEnv }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  workers.add(child); let output = "", ready!: () => void, answer: WorkerResult | undefined;
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
  const started = new Promise<void>((resolve) => { ready = resolve; });
  child.stdout!.on("data", (d) => { output += d; }); child.stderr!.on("data", (d) => { output += d; });
  child.on("message", (m: { ready?: boolean } & WorkerResult) => { if (m.ready) ready(); else answer = m; });
  const done = new Promise<WorkerResult>((resolve, reject) => child.on("exit", (code, signal) => {
    clearTimeout(deadline);
    workers.delete(child);
    if (signal === "SIGKILL") return resolve({ killed: true });
    if (code !== 0 || !answer) return reject(new Error(`Worker exited ${code}: ${output}`));
    resolve(answer);
  }));
  await Promise.race([started, done.then(() => { throw new Error("Worker exited before ready"); })]);
  return { child, start: () => child.send("start"), done };
}
async function fixture(approval = false, floor = 100000, decision = true) {
  const shop = `test-ism43-${randomUUID()}.test`; shops.push(shop);
  const old = new Date(Date.now() - 40 * 86400_000);
  await db.supplier.create({ data: { shop, id: "atlas-roasters", name: "Atlas Roasters", paypalEmail: "supplier@example.test", createdAt: old, emailChangedAt: old } });
  await db.managedProduct.create({ data: { shop, variantId: "123", sku: "coffee", title: "Coffee", managed: true } });
  await db.productSupplier.create({ data: { shop, variantId: "123", supplierId: "atlas-roasters", unitPriceCents: 100, acceptedUnitPriceCents: 100, usualQuantity: 10, leadTimeDays: 4 } });
  await db.session.create({ data: { id: `offline_${shop}`, shop, state: "test", isOnline: false, accessToken: "fake" } });
  await db.salesBackfill.create({ data: { shop, completedAt: new Date() } });
  await db.dailySales.create({ data: { shop, variantId: "123", day: new Date(new Date().toISOString().slice(0, 10)), units: 60 } });
  const rules = { ...defaultRuleSet(shop), cashFloorCents: floor, approvalAboveCents: approval ? 500 : 50000 };
  await signRuleSet(shop, rules, "shopify-staff:test");
  let seq = 0;
  if (decision) {
    const p = await appendAudit(shop, { type: "proposal", proposal: { sku: "coffee", variantId: "123", supplierId: "atlas-roasters", quantity: 10, unitPriceCents: 100, payeeEmail: "supplier@example.test", reasoning: "worker test" } });
    seq = (await appendAudit(shop, { type: "decision", proposalSeq: p.seq, decision: { verdict: approval ? "approval" : "auto", totalCents: 1000, checks: [], ruleSetHash: hashOf(rules) } })).seq;
  }
  return { shop, seq };
}
const results: { name: string; passed: boolean; facts: unknown }[] = [];
async function record(name: string, facts: unknown) { results.push({ name, passed: true, facts }); console.log(`PASS ${name}`); }
async function snapshot(shop: string) { const log = await auditEntries(shop); const chain = await verifyChain(shop); assert.ok(chain.valid); return { log, chain, attempts: attemptStates(log).map((s) => ({ operation: s.attempt.operation, route: s.attempt.route, key: s.attempt.requestId, state: s.state })), reserved: [...purchaseReservations(log).values()].reduce((n, x) => n + x.amountCents, 0) }; }
async function clean() {
  await db.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`; await tx.auditEntry.deleteMany({ where: { shop: { in: shops } } }); });
  for (const shop of shops) {
    await db.restockJob.deleteMany({ where: { shop } }); await db.session.deleteMany({ where: { shop } }); await db.supplier.deleteMany({ where: { shop } });
    await db.managedProduct.deleteMany({ where: { shop } }); await db.dailySales.deleteMany({ where: { shop } }); await db.salesBackfill.deleteMany({ where: { shop } });
    await db.paymentLock.deleteMany({ where: { shop: { contains: shop } } });
  }
  await db.paymentLock.deleteMany({ where: { shop: `funding:${fundingKey()}` } });
  shops.length = 0; batches = new Map(); orders = new Map(); orderKeys = new Map(); paymentRequests = []; captures = 0; proposals = 0; stockReads = 0; balanceCents = 1000000; available = 1;
}
async function expireLeases() {
  await db.paymentLock.updateMany({ data: { lockedUntil: new Date(0) } });
  await db.restockJob.updateMany({ where: { holder: { not: null } }, data: { lockedUntil: new Date(0) } });
}
function heldBalance() { let release!: () => void; releaseBalance = new Promise<void>((r) => { release = r; }); holdBalance = true; return { entered: new Promise<void>((r) => { balanceHeld = r; }), release }; }
try {
  // ISM-37: exercise real capture/execution code with denied server mappings and provider identities.
  const bindingJson = (shop: string, payerIds = ["TESTPAYER"], clientId = "offline-worker-test") =>
    JSON.stringify({ [shop]: { clientId, payerIds } });
  for (const identity of [undefined, "WRONGPAYER", "OTHERSTOREPAYER"]) {
    const f = await fixture(true);
    const create = await worker("order", f.shop, f.seq); create.start(); assert.ok((await create.done).ok);
    const order = [...orders.values()][0]; order.payer = identity ? { payer_id: identity } : {};
    const mapping = JSON.parse(bindingJson(f.shop)); mapping["other.myshopify.com"] = { clientId: "offline-worker-test", payerIds: ["OTHERSTOREPAYER"] };
    const denied = await worker("capture", f.shop, f.seq, { GUARDBUY_PAYPAL_STORES: JSON.stringify(mapping) }); denied.start(); assert.equal((await denied.done).ok, false);
    const state = await snapshot(f.shop);
    assert.equal(captures, 0); assert.equal(paymentRequests.length, 0);
    assert.ok(state.log.some((e) => e.event.type === "order_closed" && e.event.reason === "wrong_payer"));
    await record(`ISM-37 ${identity ?? "missing payer"}: zero capture POSTs`, { identity: identity ?? null, captures, paymentRequests, ...state }); await clean();
  }
  for (const config of ["unmapped", "empty-payers", "wrong-client"]) {
    const f = await fixture(true);
    const create = await worker("order", f.shop, f.seq); create.start(); assert.ok((await create.done).ok);
    const mapping = config === "unmapped" ? "{}" : bindingJson(f.shop, config === "empty-payers" ? [] : ["TESTPAYER"], config === "wrong-client" ? "other-client" : "offline-worker-test");
    const denied = await worker("capture", f.shop, f.seq, { GUARDBUY_PAYPAL_STORES: mapping }); denied.start(); assert.equal((await denied.done).ok, false);
    assert.equal(captures, 0); assert.equal(paymentRequests.length, 0);
    await record(`ISM-37 ${config}: zero capture POSTs`, { captures, paymentRequests, ...(await snapshot(f.shop)) }); await clean();
  }
  for (const action of ["payout", "order"]) {
    const f = await fixture(action === "order");
    const denied = await worker(action, f.shop, f.seq, { GUARDBUY_PAYPAL_STORES: "{}" }); denied.start(); assert.equal((await denied.done).ok, false);
    assert.equal(batches.size, 0); assert.equal(orders.size, 0); assert.equal(paymentRequests.length, 0);
    await record(`ISM-37 unbound store cannot submit ${action}`, { batches: batches.size, orders: orders.size, ...(await snapshot(f.shop)) }); await clean();
  }
  for (const mismatch of ["order-id", "amount", "currency", "payee"]) {
    const f = await fixture(true);
    const create = await worker("order", f.shop, f.seq); create.start(); assert.ok((await create.done).ok);
    const order = [...orders.values()][0];
    if (mismatch === "order-id") order.id = "UNRELATEDORDER";
    if (mismatch === "amount") order.purchase_units![0].amount!.value = "999.00";
    if (mismatch === "currency") order.purchase_units![0].amount!.currency_code = "EUR";
    if (mismatch === "payee") order.purchase_units![0].payee!.email_address = "wrong@example.test";
    const denied = await worker("capture", f.shop, f.seq); denied.start(); assert.equal((await denied.done).ok, false);
    assert.equal(captures, 0); assert.equal(paymentRequests.length, 0);
    await record(`ISM-37 approval ${mismatch} mismatch sends zero capture POSTs`, { captures, paymentRequests, ...(await snapshot(f.shop)) }); await clean();
  }
  const bound = await fixture(true);
  const boundCreate = await worker("order", bound.shop, bound.seq); boundCreate.start(); assert.ok((await boundCreate.done).ok);
  const approved = await worker("capture", bound.shop, bound.seq); approved.start(); assert.ok((await approved.done).ok);
  assert.equal(captures, 1);
  const repeated = await worker("capture", bound.shop, bound.seq); repeated.start(); assert.ok((await repeated.done).ok); assert.equal(captures, 1);
  await record("ISM-37 bound merchant captures once; repeat returns saved evidence", { captures, paymentRequests, ...(await snapshot(bound.shop)) }); await clean();

  // An uncertain earlier capture remains reserved if later authorization no longer matches.
  const unknown = await fixture(true);
  const unknownCreate = await worker("order", unknown.shop, unknown.seq); unknownCreate.start(); assert.ok((await unknownCreate.done).ok);
  const unknownOrder = [...orders.values()][0];
  const { candidateAttempt } = await import("../app/lib/payments/attempts.server");
  await appendAudit(unknown.shop, candidateAttempt({ decisionSeq: unknown.seq, operation: "order_capture", route: "order", requestId: `gb-capture-${unknownOrder.id}`, providerId: unknownOrder.id, amountCents: 1000, currency: "USD", payeeEmail: "supplier@example.test", body: {} }));
  unknownOrder.payer = { payer_id: "WRONGPAYER" };
  const unknownRetry = await worker("capture", unknown.shop, unknown.seq); unknownRetry.start(); assert.equal((await unknownRetry.done).ok, false);
  const unknownState = await snapshot(unknown.shop);
  assert.equal(captures, 0); assert.equal(unknownState.reserved, 1000); assert.equal(unknownState.log.some((e) => e.event.type === "order_closed"), false);
  await record("ISM-37 uncertain capture with changed payer is retained, never closed or replayed", { captures, paymentRequests, ...unknownState });
  // Existing provider settlement remains money spent even after server authorization is removed.
  unknownOrder.status = "COMPLETED"; unknownOrder.purchase_units![0].payments = { captures: [{ id: "EXISTINGCAPTURE", status: "COMPLETED", amount: unknownOrder.purchase_units![0].amount! }] };
  const recovered = await worker("capture", unknown.shop, unknown.seq, { GUARDBUY_PAYPAL_STORES: "{}" }); recovered.start(); assert.ok((await recovered.done).ok);
  assert.equal(captures, 0); assert.equal(paymentRequests.length, 0);
  const recoveredState = await snapshot(unknown.shop); assert.ok(recoveredState.log.some((e) => e.event.type === "order_captured"));
  await record("ISM-37 read-only settlement recovery survives removed authorization", { captures, paymentRequests, ...recoveredState }); await clean();

  // Different processes choose different payment routes. Whichever wins is the only payable route.
  const f = await fixture(true); let releaseCreated!: () => void;
  releaseOrder = new Promise<void>((r) => { releaseCreated = r; }); holdOrder = true;
  const created = new Promise<void>((r) => { orderHeld = r; });
  const a = await worker("order", f.shop, f.seq); a.start();
  await Promise.race([created, a.done.then(() => { throw new Error("Order finished before its held response"); })]);
  const beforeResponse = await snapshot(f.shop);
  assert.equal(beforeResponse.log.filter((e) => e.event.type === "order_created").length, 0);
  assert.equal(beforeResponse.attempts[0].operation, "order_create");
  const b = await worker("approve", f.shop, f.seq); b.start(); const competingApproval = await b.done;
  assert.equal(competingApproval.ok, false); assert.equal(batches.size, 0);
  releaseCreated(); const routeResults = [await a.done, competingApproval];
  let state = await snapshot(f.shop);
  assert.equal(new Set(state.attempts.map((a) => a.route)).size, 1);
  if (orders.size) { const c = await worker("capture", f.shop, f.seq); c.start(); assert.ok((await c.done).ok); }
  assert.equal(batches.size + captures, 1);
  await record("Order creation response held: competing Payout refused before Order evidence arrives", { beforeResponse, results: routeResults, acceptedPayments: batches.size + captures, ...(await snapshot(f.shop)) }); await clean();

  const payoutFirst = await fixture(true); let releaseFirstPayout!: () => void;
  releasePayout = new Promise<void>((r) => { releaseFirstPayout = r; }); holdPayout = true;
  const payoutEntered = new Promise<void>((r) => { payoutHeld = r; });
  const pay = await worker("approve", payoutFirst.shop, payoutFirst.seq); pay.start();
  await Promise.race([payoutEntered, pay.done.then(() => { throw new Error("Payout finished before its held response"); })]);
  const alternate = await worker("order", payoutFirst.shop, payoutFirst.seq); let alternateFinished = false;
  void alternate.done.then(() => { alternateFinished = true; }); alternate.start();
  await new Promise((r) => setTimeout(r, 300)); assert.equal(alternateFinished, false, "Order must wait for the shared funding lease");
  releaseFirstPayout(); await pay.done; assert.equal((await alternate.done).ok, false);
  assert.equal(batches.size, 1); assert.equal(orders.size, 0);
  await record("Payout response held: competing Order waits then cannot switch routes", { acceptedPayments: batches.size, ...(await snapshot(payoutFirst.shop)) }); await clean();

  const d = await fixture(true); const approve = await worker("approve", d.shop, d.seq), decline = await worker("decline", d.shop, d.seq);
  approve.start(); decline.start(); const decisions = await Promise.all([approve.done, decline.done]);
  state = await snapshot(d.shop); assert.ok(batches.size <= 1);
  assert.ok(!(state.log.some((e) => e.event.type === "rejected") && state.log.some((e) => e.event.type === "payout")));
  await record("Approve versus decline across processes cannot both take effect", { decisions, acceptedPayments: batches.size, ...state }); await clean();

  const late = await fixture(); const held = heldBalance(); const oldWorker = await worker("payout", late.shop, late.seq); oldWorker.start();
  await Promise.race([held.entered, oldWorker.done.then(() => { throw new Error("Worker finished before held balance read"); })]);
  await expireLeases(); const replacement = await worker("payout", late.shop, late.seq); replacement.start(); assert.ok((await replacement.done).ok);
  held.release(); const lateResult = await oldWorker.done;
  assert.equal(batches.size, 1); state = await snapshot(late.shop);
  assert.equal(state.log.filter((e) => e.event.type === "payment_outcome" && e.event.status === "failed").length, 0);
  await record("Forced lease loss during a provider read fences the late worker", { lateResult, acceptedPayments: batches.size, ...state }); await clean();

  const crash = await fixture(); let release!: () => void;
  releasePayout = new Promise<void>((r) => { release = r; }); holdPayout = true;
  const accepted = new Promise<void>((r) => { payoutHeld = r; }); const first = await worker("payout", crash.shop, crash.seq); first.start();
  await Promise.race([accepted, first.done.then(() => { throw new Error("Worker finished before accepted payment gate"); })]);
  first.child.kill("SIGKILL"); await first.done; release(); await expireLeases();
  state = await snapshot(crash.shop); assert.equal(state.reserved, 1000); const original = state.attempts[0].key;
  const resumed = await worker("resume", crash.shop, crash.seq); resumed.start(); assert.ok((await resumed.done).ok);
  assert.equal(batches.size, 1); assert.deepEqual(paymentRequests, [original, original]);
  await record("Killed after provider acceptance: restart uses the saved key and one payment", { acceptedPayments: batches.size, paymentRequests, ...(await snapshot(crash.shop)) }); await clean();

  const callbacks = await fixture(true); const order = await worker("order", callbacks.shop, callbacks.seq); order.start(); assert.ok((await order.done).ok);
  const c1 = await worker("capture", callbacks.shop, callbacks.seq), c2 = await worker("sweep", callbacks.shop, callbacks.seq);
  c1.start(); c2.start(); await Promise.all([c1.done, c2.done]); assert.equal(captures, 1);
  state = await snapshot(callbacks.shop); assert.equal(state.log.filter((e) => e.event.type === "order_captured").length, 1);
  await record("Duplicate callback/sweep processes capture and record once", { captures, ...state }); await clean();

  balanceCents = 10000; const s1 = await fixture(false, 8500), s2 = await fixture(false, 8500);
  const p1 = await worker("payout", s1.shop, s1.seq), p2 = await worker("payout", s2.shop, s2.seq);
  p1.start(); p2.start(); const shared = await Promise.all([p1.done, p2.done]); assert.equal(batches.size, 1);
  await record("Two shops sharing one funding account cannot both spend the stale balance", { shared, acceptedPayments: batches.size, shops: [await snapshot(s1.shop), await snapshot(s2.shop)] }); await clean();

  const restock = await fixture(false, 100000, false);
  await Promise.all(Array.from({ length: 10 }, () => queue.enqueueRestock(restock.shop, "456")));
  assert.equal(await db.restockJob.count({ where: { shop: restock.shop } }), 1);
  const pause = heldBalance(); const beforeCrash = await worker("drain", restock.shop); beforeCrash.start();
  await Promise.race([pause.entered, beforeCrash.done.then(() => { throw new Error("Restock finished before proposal crash gate"); })]);
  const before = await snapshot(restock.shop); assert.equal(before.log.filter((e) => e.event.type === "proposal").length, 1);
  await queue.enqueueRestock(restock.shop, "456");
  beforeCrash.child.kill("SIGKILL"); await beforeCrash.done; pause.release(); await expireLeases();
  const afterCrash = await worker("drain", restock.shop); afterCrash.start(); assert.ok((await afterCrash.done).ok);
  const queued = await db.restockJob.findFirstOrThrow({ where: { shop: restock.shop } });
  assert.equal(queued.completedGeneration, 10); assert.equal(queued.generation, 11);
  // New stock is now high: the newer generation must read it, not replay the stored low-stock snapshot.
  available = 10000; const fresh = await worker("drain", restock.shop); fresh.start(); assert.ok((await fresh.done).ok);
  const final = await db.restockJob.findFirstOrThrow({ where: { shop: restock.shop } });
  state = await snapshot(restock.shop); assert.equal(state.log.filter((e) => e.event.type === "proposal").length, 1);
  assert.equal(proposals, 1); assert.equal(batches.size, 1); assert.equal(final.completedGeneration, 11); assert.equal(final.holder, null); assert.ok(stockReads >= 3);
  await record("Queued restock survives process death, resumes one proposal and preserves newer webhooks", { proposals, acceptedPayments: batches.size, stockReads, job: final, ...state }); await clean();

  const concurrent = await fixture(false, 100000, false);
  await Promise.all([queue.enqueueRestock(concurrent.shop, "456"), queue.enqueueRestock(concurrent.shop, "456")]);
  const j1 = await worker("drain", concurrent.shop), j2 = await worker("drain", concurrent.shop);
  j1.start(); j2.start(); await Promise.all([j1.done, j2.done]);
  state = await snapshot(concurrent.shop); assert.equal(proposals, 1); assert.equal(batches.size, 1);
  assert.equal(state.log.filter((e) => e.event.type === "proposal").length, 1);
  await record("Concurrent restock workers claim one coalesced job and pay once", { proposals, acceptedPayments: batches.size, ...state }); await clean();

  const uncertainJob = await fixture(false, 100000, false);
  await queue.enqueueRestock(uncertainJob.shop, "456");
  releasePayout = new Promise<void>((r) => { release = r; }); holdPayout = true;
  const uncertainAccepted = new Promise<void>((r) => { payoutHeld = r; });
  const interrupted = await worker("drain", uncertainJob.shop); interrupted.start();
  await Promise.race([uncertainAccepted, interrupted.done.then(() => { throw new Error("Restock finished before accepted payment crash gate"); })]);
  interrupted.child.kill("SIGKILL"); await interrupted.done; release(); await expireLeases();
  const recovery = await worker("drain", uncertainJob.shop); recovery.start(); assert.ok((await recovery.done).ok);
  state = await snapshot(uncertainJob.shop); assert.equal(batches.size, 1); assert.equal(paymentRequests.length, 1);
  assert.equal(state.attempts[0].state, "unresolved"); assert.equal(state.reserved, 1000);
  const recoveredJob = await db.restockJob.findFirstOrThrow({ where: { shop: uncertainJob.shop } });
  assert.equal(recoveredJob.completedGeneration, recoveredJob.generation);
  await record("Job restart never automatically replays an uncertain payment POST", { acceptedPayments: batches.size, paymentRequests, job: recoveredJob, ...state }); await clean();

  const fencing = await fixture(false, 100000, false);
  await queue.enqueueRestock(fencing.shop, "456"); const claimA = (await queue.claimRestockJob())!;
  await expireLeases(); const claimB = (await queue.claimRestockJob())!;
  assert.equal(queue.restockJobKey(claimA), queue.restockJobKey(claimB));
  assert.equal(await queue.finishRestockJob(claimA), false); assert.equal(await queue.retryRestockJob(claimA), false);
  await assert.rejects(queue.renewRestockJob(claimA));
  await queue.enqueueRestock(fencing.shop, "456"); assert.ok(await queue.retryRestockJob(claimB, 30_000));
  const backoff = await db.restockJob.findFirstOrThrow({ where: { shop: fencing.shop } });
  await queue.enqueueRestock(fencing.shop, "456");
  assert.equal((await db.restockJob.findFirstOrThrow({ where: { shop: fencing.shop } })).availableAt.getTime(), backoff.availableAt.getTime(), "new webhooks must not bypass a retry cooldown");
  await db.restockJob.updateMany({ where: { shop: fencing.shop }, data: { availableAt: new Date(0) } });
  const claimC = (await queue.claimRestockJob())!; assert.equal(queue.restockJobKey(claimB), queue.restockJobKey(claimC));
  assert.ok(await queue.finishRestockJob(claimC));
  const notLost = await db.restockJob.findFirstOrThrow({ where: { shop: fencing.shop } });
  assert.equal(notLost.completedGeneration, 1); assert.equal(notLost.generation, 3);
  await record("Expired job holders cannot acknowledge newer claims; retries preserve generations", { job: notLost }); await clean();

  const startup = await fixture(false, 100000, false); await queue.enqueueRestock(startup.shop, "456");
  const background = await worker("startup", startup.shop, 0, { GUARDBUY_RESTOCK_WORKER: "on" }); background.start();
  assert.ok((await background.done).ok); assert.equal(batches.size, 1);
  await record("Web-process startup worker automatically drains saved jobs", { acceptedPayments: batches.size, job: await db.restockJob.findFirst({ where: { shop: startup.shop } }), ...(await snapshot(startup.shop)) }); await clean();

  const stoppedShop = await fixture(false, 100000, false); available = 10000;
  await queue.enqueueRestock(stoppedShop.shop, "456"); const highStock = await worker("drain", stoppedShop.shop); highStock.start(); assert.ok((await highStock.done).ok);
  assert.equal(proposals, 0); assert.equal(batches.size, 0); assert.equal(stockReads, 1);
  available = 1; await appendAudit(stoppedShop.shop, { type: "agent_state", on: false, by: "shopify-staff:test" });
  await queue.enqueueRestock(stoppedShop.shop, "456"); const paused = await worker("drain", stoppedShop.shop); paused.start(); assert.ok((await paused.done).ok);
  assert.equal(proposals, 0); assert.equal(batches.size, 0);
  await db.session.deleteMany({ where: { shop: stoppedShop.shop } });
  await queue.enqueueRestock(stoppedShop.shop, "456"); const uninstalled = await worker("drain", stoppedShop.shop); uninstalled.start(); assert.ok((await uninstalled.done).ok);
  assert.equal(stockReads, 2); assert.equal(batches.size, 0);
  await record("Recovered jobs re-read stock and respect pause/uninstall state", { proposals, stockReads, acceptedPayments: batches.size, ...(await snapshot(stoppedShop.shop)) }); await clean();

  const stop = await fixture(); const disabled = await worker("payout", stop.shop, stop.seq, { GUARDBUY_PAYMENTS_DISABLED: "1" }); disabled.start();
  assert.equal((await disabled.done).ok, false); assert.equal(batches.size, 0);
  await record("Emergency stop still prevents provider payment", { acceptedPayments: batches.size, ...(await snapshot(stop.shop)) }); await clean();

  // Exercise the migration's conditional grant with the same restricted-role name used in deployment.
  await db.$executeRawUnsafe("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbuy_app') THEN CREATE ROLE guardbuy_app NOLOGIN; END IF; END $$;");
  await db.$executeRawUnsafe('GRANT SELECT, INSERT ON "AuditEntry" TO guardbuy_app');
  const migration = await readFile("prisma/migrations/20261104140000_durable_restock_jobs/migration.sql", "utf8");
  await db.$executeRawUnsafe(migration.slice(migration.indexOf("DO $$ BEGIN")));
  const roleJob = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE guardbuy_app");
    await tx.restockJob.create({ data: { id: roleJob, shop: "test-role.test", inventoryItemId: "456" } });
    await tx.restockJob.update({ where: { id: roleJob }, data: { generation: 2 } });
    assert.equal((await tx.restockJob.findUniqueOrThrow({ where: { id: roleJob } })).generation, 2);
    await tx.restockJob.delete({ where: { id: roleJob } });
  });
  for (const statement of ['UPDATE "AuditEntry" SET "hash" = "hash" WHERE false', 'DELETE FROM "AuditEntry" WHERE false']) {
    await assert.rejects(db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE guardbuy_app"); await tx.$executeRawUnsafe(statement); }), /permission denied/);
  }
  await record("Migration gives the app role job CRUD without audit UPDATE/DELETE", { jobCreateReadUpdateDelete: true, auditUpdateDenied: true, auditDeleteDenied: true });
  console.log(`${results.length} multi-process payment/job checks passed; real Postgres, simulated provider, no live payments.`);
} finally {
  const stopped = [...workers].map((w) => new Promise<void>((resolve) => w.once("exit", () => resolve())));
  for (const w of workers) w.kill("SIGKILL");
  await Promise.all(stopped);
  await writeFile(process.env.GUARDBUY_TEST_EVIDENCE_PATH ?? path.join(directory, "results.json"), JSON.stringify({ at: new Date().toISOString(), realPostgres: true, separateNodeProcesses: true, simulatedExternalProviders: true, results }, null, 2));
  await clean(); await db.$disconnect(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
}
