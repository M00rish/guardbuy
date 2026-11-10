// Real disposable Postgres + loopback Telegram provider. No Shopify/Telegram credentials or messages.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { AuditEventSchema, type AuditEvent } from "../app/lib/policy/schema";
for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[key] ?? "invalid:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/guardbuy_ism36_test");
}
Object.assign(process.env, {
  NODE_ENV: "test",
  TELEGRAM_ALERTS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "12345:offline_token_never_real_123456789",
  TELEGRAM_BOT_USERNAME: "GuardBuyTestBot",
  TELEGRAM_WEBHOOK_SECRET: "offline_webhook_secret_1234567890123456",
  SHOPIFY_API_KEY: "offline-api-key",
  GUARDBUY_TELEGRAM_TEST_MODE: "true",
});
const { default: db } = await import("../app/db.server");
const { entryHash, auditEntries, verifyChain } =
  await import("../app/lib/audit/log.server");
const {
  beginPairing,
  confirmPairing,
  disconnectAlerts,
  scanShop,
  telegramWebhook,
  retryAlert,
  pairingCode,
  currentAttention,
} = await import("../app/lib/alerts/service.server");
const { deliverOne, startAlertWorker } =
  await import("../app/lib/alerts/worker.server");
const { purchaseEntries, purchaseParam } =
  await import("../app/lib/alerts/projection");
const { privacyShopHash } = await import("../app/lib/privacy/state.server");
const { receivePrivacyRequest } =
  await import("../app/lib/privacy/requests.server");
const results: { name: string; passed: boolean }[] = [];
const record = (name: string) => {
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
};
const shops: string[] = [];
const calls: { chat_id: string; text: string }[] = [];
let mode = "ok";
const server = http.createServer(async (req, res) => {
  assert.match(
    req.url!,
    /^\/bot12345:offline_token_never_real_123456789\/sendMessage$/,
  );
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  calls.push(message);
  assert.equal(message.link_preview_options.is_disabled, true);
  assert.equal(message.protect_content, true);
  if (mode === "lost") {
    req.socket.destroy();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  if (mode === "429") {
    res.statusCode = 429;
    res.end(
      JSON.stringify({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 2 },
      }),
    );
  } else if (mode === "403") {
    res.statusCode = 403;
    res.end(
      JSON.stringify({
        ok: false,
        error_code: 403,
        description: "secret raw error must not be stored",
      }),
    );
  } else
    res.end(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.env.GUARDBUY_TELEGRAM_TEST_ORIGIN = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
async function fixture(enabled = true) {
  const shop = `alerts-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  if (enabled)
    await db.alertChannel.create({
      data: { shop, enabled: true, chatId: "123456" },
    });
  await add(shop, {
    type: "proposal",
    proposal: {
      variantId: "123",
      sku: "SECRET-SKU",
      supplierId: "SECRET-SUPPLIER",
      quantity: 10,
      unitPriceCents: 100,
      reasoning: "UNTRUSTED-MESSAGE",
      payeeEmail: "secret@example.test",
    },
  });
  await add(shop, {
    type: "decision",
    proposalSeq: 0,
    decision: {
      verdict: "approval",
      totalCents: 1000,
      checks: [],
      ruleSetHash: "rules",
    },
  });
  return shop;
}
async function add(shop: string, event: AuditEvent, age = 60_000) {
  const last = await db.auditEntry.findFirst({
    where: { shop },
    orderBy: { seq: "desc" },
  });
  const seq = last ? last.seq + 1 : 0;
  const at = new Date(Date.now() - age).toISOString();
  const parsed = AuditEventSchema.parse(event),
    prevHash = last?.hash ?? "0".repeat(64);
  const hash = entryHash(prevHash, { seq, shop, at, event: parsed });
  await db.auditEntry.create({
    data: {
      shop,
      seq,
      at: new Date(at),
      type: parsed.type,
      event: parsed as object,
      prevHash,
      hash,
    },
  });
  return seq;
}
async function pending(shop: string) {
  return db.merchantAlert.findFirstOrThrow({
    where: { shop, status: "pending" },
  });
}
async function webhook(
  token: string,
  id = 123456,
  type = "private",
  authorized = true,
) {
  return telegramWebhook(
    new Request("http://local/telegram/webhook", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": authorized
          ? process.env.TELEGRAM_WEBHOOK_SECRET!
          : "wrong",
      },
      body: JSON.stringify({
        message: { chat: { id, type }, from: { id }, text: `/start ${token}` },
      }),
    }),
  );
}
async function drain() {
  for (let n = 0; n < 100 && (await deliverOne()); n++);
}
try {
  const shop = await fixture(false);
  const link = await beginPairing(shop);
  const token = new URL(link).searchParams.get("start")!;
  assert.equal((await webhook(token, 123456, "private", false)).status, 401);
  await webhook(token, -1, "group");
  assert.equal(await db.merchantAlert.count({ where: { shop } }), 0);
  await webhook(token);
  await webhook(token);
  await webhook(token, 999999);
  assert.equal(await db.merchantAlert.count({ where: { shop } }), 1);
  assert.equal(
    (await db.alertChannel.findUniqueOrThrow({ where: { shop } }))
      .pendingChatId,
    "123456",
  );
  await scanShop(shop);
  assert.equal(
    await db.merchantAlert.count({ where: { shop, kind: { not: "pairing" } } }),
    0,
  );
  await deliverOne();
  const code = calls.at(-1)!.text.match(/code: (\d{6})/)![1];
  assert.ok(!calls.at(-1)!.text.includes(shop));
  assert.equal(await confirmPairing(shop, "bad"), false);
  assert.equal(await confirmPairing(shop, code), true);
  assert.equal(await confirmPairing(shop, code), false);
  assert.equal(
    (await db.alertChannel.findUniqueOrThrow({ where: { shop } })).tokenHash,
    null,
  );
  record(
    "Secret-authenticated private pairing, duplicate/forwarded starts, in-app OTP and single use",
  );
  const locked = await fixture(false);
  const lockedLink = await beginPairing(locked);
  await webhook(new URL(lockedLink).searchParams.get("start")!);
  const correct = pairingCode(
    await db.alertChannel.findUniqueOrThrow({ where: { shop: locked } }),
  );
  for (let i = 0; i < 5; i++)
    assert.equal(await confirmPairing(locked, "invalid"), false);
  assert.equal(await confirmPairing(locked, correct), false);
  await disconnectAlerts(locked);
  const expired = await fixture(false);
  const expiredToken = new URL(await beginPairing(expired)).searchParams.get(
    "start",
  )!;
  await db.alertChannel.update({
    where: { shop: expired },
    data: { expiresAt: new Date(0) },
  });
  await webhook(expiredToken);
  assert.equal(await db.merchantAlert.count({ where: { shop: expired } }), 0);
  await disconnectAlerts(expired);
  record("Pairing expiry and five-attempt lockout");
  const before = await auditEntries(shop);
  await Promise.all([scanShop(shop), scanShop(shop)]);
  assert.equal(
    await db.merchantAlert.count({ where: { shop, kind: "waiting" } }),
    1,
  );
  await Promise.all([deliverOne(), deliverOne()]);
  assert.match(calls.at(-1)!.text, /Needs approval\./);
  assert.match(
    calls.at(-1)!.text,
    /admin.shopify.com\/store\/.*\/apps\/offline-api-key\/app\/rules\?tab=approvals&purchase=1/,
  );
  assert.ok(!/SECRET|secret@|UNTRUSTED|offline_token/.test(calls.at(-1)!.text));
  assert.deepEqual(await auditEntries(shop), before);
  record(
    "Concurrent scanners and senders deliver one minimal authenticated approval link without audit/payment writes",
  );
  await add(shop, {
    type: "approved",
    decisionSeq: 1,
    approvedBy: "staff:1",
    paymentProtocol: "durable-v1",
  });
  await scanShop(shop);
  assert.equal((await pending(shop)).kind, "unpaid");
  await drain();
  const attempt = {
    type: "payment_attempt" as const,
    decisionSeq: 1,
    attemptId: "PRIVATE-ATTEMPT",
    operation: "payout" as const,
    route: "payout" as const,
    requestId: "PRIVATE-REQUEST",
    fundingKey: "PRIVATE-ACCOUNT",
    amountCents: 1000,
    currency: "USD" as const,
    payeeEmail: "secret@example.test",
    body: { secret: "private" },
    retryUntil: new Date(Date.now() + 86_400_000).toISOString(),
  };
  await add(shop, attempt);
  await scanShop(shop);
  assert.equal((await pending(shop)).kind, "payment_unknown");
  await drain();
  assert.match(calls.at(-1)!.text, /original payment remains reserved/);
  assert.match(calls.at(-1)!.text, /Do not create a replacement/);
  await add(
    shop,
    {
      type: "payment_outcome",
      decisionSeq: 1,
      attemptId: attempt.attemptId,
      status: "unknown",
    },
    0,
  );
  await scanShop(shop);
  assert.equal(
    await db.merchantAlert.count({ where: { shop, status: "pending" } }),
    0,
  );
  await add(shop, {
    type: "payment_outcome",
    decisionSeq: 1,
    attemptId: attempt.attemptId,
    status: "failed",
  });
  await scanShop(shop);
  assert.equal((await pending(shop)).kind, "failed");
  await drain();
  record(
    "Unsubmitted approval, unknown outcome and definite failure remain distinct; repeated unknown evidence deduplicates",
  );
  const payoutSeq = await add(
    shop,
    {
      type: "payout",
      paymentAttemptId: attempt.attemptId,
      decisionSeq: 1,
      payoutBatchId: "PRIVATE-BATCH",
      status: "PENDING",
      amountCents: 1000,
    },
    20 * 60_000,
  );
  await scanShop(shop);
  assert.equal((await pending(shop)).kind, "payment_pending");
  await add(shop, {
    type: "payout_status",
    payoutSeq,
    status: "SUCCESS",
    confirmedByTransactionSearch: false,
  });
  await scanShop(shop);
  assert.equal(
    await db.merchantAlert.count({ where: { shop, status: "pending" } }),
    0,
  );
  await add(shop, {
    type: "payout_status",
    payoutSeq,
    status: "RETURNED",
    confirmedByTransactionSearch: false,
  });
  await scanShop(shop);
  await drain();
  assert.match(calls.at(-1)!.text, /failed or was returned/);
  const related = purchaseEntries(await auditEntries(shop), 1);
  assert.ok(related.has(payoutSeq + 2));
  assert.equal(purchaseParam("https://local/app?purchase=1"), 1);
  assert.equal(purchaseParam("https://local/app?purchase=-1"), null);
  record(
    "Pending settlement resolves stale queued alerts; returned payout re-alerts with purchase-scoped history",
  );
  const stale = await fixture();
  await scanShop(stale);
  const old = await pending(stale);
  await add(stale, { type: "rejected", decisionSeq: 1, rejectedBy: "staff" });
  await deliverOne();
  assert.equal(
    (await db.merchantAlert.findUniqueOrThrow({ where: { id: old.id } }))
      .status,
    "cancelled",
  );
  record(
    "Queued purchase is revalidated immediately before send and cancelled after rejection",
  );
  const transient = await fixture();
  await scanShop(transient);
  const retry = await pending(transient);
  mode = "429";
  await deliverOne();
  const saved = await db.merchantAlert.findUniqueOrThrow({
    where: { id: retry.id },
  });
  assert.equal(saved.status, "pending");
  assert.ok(saved.availableAt.getTime() > Date.now());
  await db.merchantAlert.update({
    where: { id: retry.id },
    data: { availableAt: new Date(0) },
  });
  mode = "ok";
  await deliverOne();
  assert.equal(
    (await db.merchantAlert.findUniqueOrThrow({ where: { id: retry.id } }))
      .status,
    "sent",
  );
  record("Explicit Telegram rate-limit rejection backs off and retries safely");
  const uncertain = await fixture();
  await scanShop(uncertain);
  const lost = await pending(uncertain);
  mode = "lost";
  await deliverOne();
  assert.equal(
    (await db.merchantAlert.findUniqueOrThrow({ where: { id: lost.id } }))
      .status,
    "uncertain",
  );
  const n = calls.length;
  await deliverOne();
  assert.equal(calls.length, n);
  assert.equal(await retryAlert(uncertain, lost.id, false), false);
  assert.equal(await retryAlert(shop, lost.id, true), false);
  assert.equal(await retryAlert(uncertain, lost.id, true), true);
  mode = "ok";
  await deliverOne();
  record(
    "Lost Telegram response is never auto-replayed; retry requires explicit duplicate consent and shop ownership",
  );
  const crash = await fixture();
  await scanShop(crash);
  const crashed = await pending(crash);
  await db.merchantAlert.update({
    where: { id: crashed.id },
    data: { status: "sending", lockedUntil: new Date(0) },
  });
  const preCrash = calls.length;
  await deliverOne();
  assert.equal(calls.length, preCrash);
  assert.equal(
    (await db.merchantAlert.findUniqueOrThrow({ where: { id: crashed.id } }))
      .status,
    "uncertain",
  );
  record(
    "Expired sending lease after process crash becomes unconfirmed without replay",
  );
  const permanent = await fixture();
  await scanShop(permanent);
  const fail = await pending(permanent);
  mode = "403";
  await deliverOne();
  mode = "ok";
  assert.equal(
    (await db.merchantAlert.findUniqueOrThrow({ where: { id: fail.id } }))
      .status,
    "failed",
  );
  assert.ok(
    !JSON.stringify(await db.merchantAlert.findMany()).includes(
      "secret raw error",
    ),
  );
  record(
    "Permanent provider rejection is visible without storing error bodies or credentials",
  );
  const restock = await fixture();
  await disconnectAlerts(restock);
  await db.alertChannel.create({
    data: { shop: restock, enabled: true, chatId: "123456" },
  });
  await add(restock, { type: "rejected", decisionSeq: 1, rejectedBy: "staff" });
  await add(restock, {
    type: "proposal_failed",
    sku: "PRIVATE-SKU",
    variantId: "123",
    reason: "PRIVATE-ERROR",
  });
  await scanShop(restock);
  await drain();
  assert.match(calls.at(-1)!.text, /restock could not be prepared/);
  assert.ok(!calls.at(-1)!.text.includes("PRIVATE"));
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.update({
      where: { shop_seq: { shop: restock, seq: 0 } },
      data: { event: { type: "unknown-broken-schema", malicious: "PRIVATE" } },
    });
  });
  assert.equal((await verifyChain(restock)).valid, false);
  assert.deepEqual(await currentAttention(restock), [
    { subject: "integrity", state: "broken", kind: "integrity" },
  ]);
  await scanShop(restock);
  await drain();
  assert.match(calls.at(-1)!.text, /verification failed/);
  assert.ok(!calls.at(-1)!.text.includes("PRIVATE"));
  await scanShop(restock);
  assert.equal(
    await db.merchantAlert.count({
      where: { shop: restock, kind: "integrity" },
    }),
    1,
  );
  record(
    "Restock failure and corrupt/unparseable audit stream produce safe deduplicated alerts",
  );
  const disconnected = await fixture();
  await scanShop(disconnected);
  await disconnectAlerts(disconnected);
  assert.equal(
    await db.merchantAlert.count({ where: { shop: disconnected } }),
    0,
  );
  assert.equal(
    await db.alertCursor.count({ where: { shop: disconnected } }),
    0,
  );
  const privacy = await fixture();
  await scanShop(privacy);
  await receivePrivacyRequest({
    shop: privacy,
    topic: "SHOP_REDACT",
    eventId: randomUUID(),
  });
  assert.equal(await db.alertChannel.count({ where: { shop: privacy } }), 0);
  await assert.rejects(
    db.alertChannel.create({
      data: { shop: privacy, enabled: true, chatId: "123456" },
    }),
  );
  record(
    "Disconnect cascades outbox/cursors; privacy suppression removes routing and prevents recreation",
  );
  // No browser/session request: run the same startup worker used by the deployed server.
  const closed = await fixture();
  const baseline = calls.length;
  const historyBefore = await auditEntries(closed);
  startAlertWorker();
  const deadline = Date.now() + 10_000;
  while (
    !calls
      .slice(baseline)
      .some((c) => c.text.includes(closed.replace(".myshopify.com", "")))
  ) {
    assert.ok(Date.now() < deadline, "background alert did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(await auditEntries(closed), historyBefore);
  record(
    "Startup background worker scans and delivers with no open browser and no payment/audit mutation",
  );
  if (process.env.GUARDBUY_ALERT_EVIDENCE_PATH)
    await writeFile(
      process.env.GUARDBUY_ALERT_EVIDENCE_PATH,
      JSON.stringify(
        {
          localTestOnly: true,
          provider: "loopback Telegram mock",
          realPostgres: true,
          results,
          sampleMessages: calls.map((c) => c.text),
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  console.log(`${results.length} alert checks passed`);
} finally {
  // Worker timers are unref'ed; cleanup isolates the disposable run from later checks.
  for (const shop of shops) {
    await db.alertChannel.deleteMany({ where: { shop } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
      await tx.auditEntry.deleteMany({ where: { shop } });
      await tx.privacyRequest.deleteMany({
        where: { shopHash: privacyShopHash(shop) },
      });
      await tx.privacyBlock.deleteMany({
        where: { shopHash: privacyShopHash(shop) },
      });
    });
  }
  server.closeAllConnections();
  server.close();
  await db.$disconnect();
}
