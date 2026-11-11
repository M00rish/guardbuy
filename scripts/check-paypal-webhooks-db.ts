// Isolated Postgres + fake PayPal REST only. No real provider, credentials, payments or inventory.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const dbUrl = process.env.DATABASE_URL ?? "";
if (!new URL(dbUrl).pathname.endsWith("/guardbuy_ism15_test"))
  throw Error("Use guardbuy_ism15_test only");
process.env.NODE_ENV = "test";
process.env.GUARDBUY_PAYPAL_TEST_API = "1";
process.env.GUARDBUY_PAYMENTS_DISABLED = "1";
process.env.SHOPIFY_APP_URL = "https://guardbuy-webhook-fixture.example";
process.env.PAYPAL_CLIENT_ID = `fixture-${randomUUID()}`;
process.env.PAYPAL_CLIENT_SECRET = "offline";
const shop = `test-webhooks-${randomUUID()}.test`;
process.env.GUARDBUY_PAYPAL_STORES = JSON.stringify({
  [shop]: { clientId: process.env.PAYPAL_CLIENT_ID, payerIds: ["FIXTURE"] },
});
let status = "PENDING",
  batchCalls = 0,
  registrations = 0,
  verificationCalls = 0;
let registered = false;
const hook = {
  id: "HOOK-1",
  url: "https://guardbuy-webhook-fixture.example/paypal/webhook",
  event_types: [] as { name: string }[],
};
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body =
    raw && req.headers["content-type"]?.includes("application/json")
      ? JSON.parse(raw)
      : {};
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/oauth2/token") {
    res.end(
      JSON.stringify({ access_token: "fixture-token", expires_in: 3600 }),
    );
    return;
  }
  if (req.url === "/v1/notifications/webhooks" && req.method === "GET") {
    res.end(JSON.stringify({ webhooks: registered ? [hook] : [] }));
    return;
  }
  if (req.url === "/v1/notifications/webhooks" && req.method === "POST") {
    registrations++;
    registered = true;
    assert.equal(body.url, hook.url);
    hook.event_types = body.event_types;
    res.end(JSON.stringify(hook));
    return;
  }
  if (
    req.url === "/v1/notifications/verify-webhook-signature" &&
    req.method === "POST"
  ) {
    verificationCalls++;
    assert.equal(body.webhook_id, hook.id);
    res.end(
      JSON.stringify({
        verification_status:
          body.transmission_sig === "fixture-valid" ? "SUCCESS" : "FAILURE",
      }),
    );
    return;
  }
  if (req.url?.startsWith("/v1/payments/payouts/") && req.method === "GET") {
    batchCalls++;
    res.end(
      JSON.stringify({
        items: [
          { transaction_id: "TRANSACTION-1", transaction_status: status },
        ],
      }),
    );
    return;
  }
  res.statusCode = 500;
  res.end(JSON.stringify({ error: "Unexpected API route" }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
assert.ok(addr && typeof addr === "object");
process.env.PAYPAL_API_BASE = `http://127.0.0.1:${addr.port}`;
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries } =
  await import("../app/lib/audit/log.server");
const { fundingKey } = await import("../app/lib/payments/attempts.server");
const accountKey = fundingKey();
const { ensurePayoutWebhook, activePayoutWebhook } =
  await import("../app/lib/paypal/webhook-registration.server");
const { receivePayoutWebhook } =
  await import("../app/lib/paypal/webhook-handler.server");
const { processPayoutSignal } =
  await import("../app/lib/paypal/webhook-worker.server");
const { payoutSchedule } =
  await import("../app/lib/paypal/payout-schedule.server");
const { createPayoutRefresh } =
  await import("../app/lib/paypal/payout-refresh");
const { paypal } = await import("../app/lib/paypal/client.server");
const { privacyShopHash } = await import("../app/lib/privacy/state.server");
const refresh = createPayoutRefresh(
  {
    read: auditEntries,
    append: payoutSchedule.append,
    schedule: payoutSchedule,
    batch: (id) => paypal(`/v1/payments/payouts/${id}`, { maxAttempts: 1 }),
    confirmed: async () => true,
  },
  { webhooks: async () => true, waitMs: 10_000 },
);
const notification = (id: string, batchId = "BATCH-1") => ({
  id,
  event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  resource: {
    payout_batch_id: batchId,
    transaction_status: "SUCCESS",
    payout_item: { receiver: "never-store@example.test" },
  },
});
const request = (
  event: unknown,
  sig = "fixture-valid",
  cert = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
) =>
  new Request("https://guardbuy-webhook-fixture.example/paypal/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": cert,
      "paypal-transmission-id": "TRANSMISSION-1",
      "paypal-transmission-sig": sig,
      "paypal-transmission-time": new Date().toISOString(),
    },
    body: JSON.stringify(event),
  });
try {
  await Promise.all([ensurePayoutWebhook(), ensurePayoutWebhook()]);
  assert.equal(registrations, 1);
  assert.ok(await activePayoutWebhook());
  await ensurePayoutWebhook();
  assert.equal(registrations, 1, "registration survives repeat startup");
  await db.payPalWebhookSubscription.update({
    where: { accountKey },
    data: { webhookId: null, availableAt: new Date(0) },
  });
  await ensurePayoutWebhook();
  assert.equal(
    registrations,
    1,
    "lost stored response is recovered by listing, without creating a duplicate endpoint",
  );
  assert.equal(
    (await receivePayoutWebhook(new Request("https://example.test"))).status,
    405,
  );
  assert.equal(
    (await receivePayoutWebhook(request(notification("BAD-1"), "invalid")))
      .status,
    401,
  );
  const beforeVerify = verificationCalls;
  assert.equal(
    (
      await receivePayoutWebhook(
        request(
          notification("BAD-2"),
          "fixture-valid",
          "https://attacker.example/cert",
        ),
      )
    ).status,
    401,
  );
  assert.equal(
    verificationCalls,
    beforeVerify,
    "untrusted certificate is refused without outbound call",
  );
  assert.equal(
    await db.payPalWebhookReceipt.count({ where: { accountKey } }),
    0,
    "invalid notifications leave no receipt/job",
  );
  const paid = await appendAudit(shop, {
    type: "payout",
    decisionSeq: 1,
    payoutBatchId: "BATCH-1",
    amountCents: 100,
    status: "PENDING",
  });
  const duplicates = await Promise.all([
    receivePayoutWebhook(request(notification("EVENT-1"))),
    receivePayoutWebhook(request(notification("EVENT-1"))),
  ]);
  assert.ok(duplicates.every((r) => r.status === 204));
  assert.equal(
    await db.payPalWebhookReceipt.count({ where: { accountKey } }),
    1,
  );
  assert.equal(
    (
      await db.payPalPayoutSignal.findUniqueOrThrow({
        where: { accountKey_batchId: { accountKey, batchId: "BATCH-1" } },
      })
    ).generation,
    1,
  );
  status = "SUCCESS";
  await processPayoutSignal(refresh);
  assert.equal(batchCalls, 1);
  const saved = await db.payoutCheck.findUniqueOrThrow({
    where: { shop_payoutSeq: { shop, payoutSeq: paid.seq } },
  });
  assert.ok(saved.lastCheckOk);
  assert.ok(
    saved.nextCheckAt.getTime() - saved.checkedAt!.getTime() >= 86_400_000,
  );
  await refresh(shop);
  assert.equal(
    batchCalls,
    1,
    "page refresh does not poll a webhook-managed payout",
  );
  // A delayed success notification must not overwrite a current return.
  status = "RETURNED";
  assert.equal(
    (await receivePayoutWebhook(request(notification("EVENT-2")))).status,
    204,
  );
  const newerSignal = await db.payPalPayoutSignal.findUniqueOrThrow({
    where: { accountKey_batchId: { accountKey, batchId: "BATCH-1" } },
  });
  await db.payoutCheck.update({
    where: { shop_payoutSeq: { shop, payoutSeq: paid.seq } },
    data: {
      startedAt: new Date(newerSignal.receivedAt.getTime() - 1000),
      checkedAt: new Date(newerSignal.receivedAt.getTime() + 1000),
    },
  });
  await processPayoutSignal(refresh);
  const statuses = (await auditEntries(shop)).filter(
    (e) => e.event.type === "payout_status",
  );
  assert.equal(
    (statuses.at(-1)!.event as { status: string }).status,
    "RETURNED",
  );
  assert.equal(batchCalls, 2);
  // A notification received before the positive payment audit commits remains queued.
  assert.equal(
    (await receivePayoutWebhook(request(notification("EARLY-1", "BATCH-2"))))
      .status,
    204,
  );
  await processPayoutSignal(refresh);
  let early = await db.payPalPayoutSignal.findUniqueOrThrow({
    where: { accountKey_batchId: { accountKey, batchId: "BATCH-2" } },
  });
  assert.equal(early.completedGeneration, 0);
  status = "PENDING";
  await appendAudit(shop, {
    type: "payout",
    decisionSeq: 2,
    payoutBatchId: "BATCH-2",
    amountCents: 100,
    status: "PENDING",
  });
  await db.payPalPayoutSignal.update({
    where: { accountKey_batchId: { accountKey, batchId: "BATCH-2" } },
    data: { availableAt: new Date(0) },
  });
  await processPayoutSignal(refresh);
  early = await db.payPalPayoutSignal.findUniqueOrThrow({
    where: { accountKey_batchId: { accountKey, batchId: "BATCH-2" } },
  });
  assert.equal(early.completedGeneration, early.generation);
  assert.ok(
    !JSON.stringify(
      await db.payPalWebhookReceipt.findMany({ where: { accountKey } }),
    ).includes("receiver"),
    "raw payload/recipient is not stored",
  );
  await db.privacyBlock.create({ data: { shopHash: privacyShopHash(shop) } });
  await db.payPalPayoutSignal.deleteMany({ where: { shop } });
  assert.equal(
    (await receivePayoutWebhook(request(notification("PRIVATE-1")))).status,
    204,
  );
  assert.equal(
    await db.payPalPayoutSignal.count({ where: { accountKey } }),
    0,
    "suppressed shop cannot recreate a payout job",
  );
  assert.equal(
    (
      await receivePayoutWebhook(
        new Request("https://example.test", {
          method: "POST",
          body: "x".repeat(128 * 1024 + 1),
        }),
      )
    ).status,
    400,
  );
  console.log(
    "PASS PayPal webhooks: automatic registration, verification contract/fail-closed, concurrent duplicate delivery, targeted status read, no page polling, stale delivery/current return, early commit race, bounded body and privacy suppression. Fake provider only; no money/inventory writes.",
  );
} finally {
  await db.payPalPayoutSignal.deleteMany({ where: { accountKey } });
  await db.payPalWebhookReceipt.deleteMany({ where: { accountKey } });
  await db.payPalWebhookSubscription.deleteMany({ where: { accountKey } });
  await db.payoutCheck.deleteMany({ where: { shop } });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.deleteMany({ where: { shop } });
  });
  await db.privacyBlock.deleteMany({
    where: { shopHash: privacyShopHash(shop) },
  });
  await db.$disconnect();
  await new Promise<void>((r) => server.close(() => r()));
}
