// Local fake PayPal only: no environment files, production database or provider credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Attempt } from "../app/lib/payments/attempts";

let originalBody = "", accepted = 0, posts = 0, reads = 0;
let mismatch = false;
const server = createServer(async (req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/v1/oauth2/token") {
    if (req.headers.authorization === "Basic " + Buffer.from("slow-oauth:fake").toString("base64")) return;
    return json(200, { access_token: "fake-token", expires_in: 3600 });
  }
  if (req.url === "/slow") return;
  if (req.url === "/ok") return json(200, { ok: true });
  if (req.url === "/v1/payments/payouts" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    assert.equal(req.headers["paypal-request-id"], "original-key");
    posts++;
    if (!accepted) {
      originalBody = body; accepted++;
      req.socket.destroy(); // PayPal accepted it, but GuardBuy never received its ID.
      return;
    }
    assert.equal(body, originalBody, "same-key retry must preserve the exact original body");
    return json(400, { name: "VALIDATION_ERROR", details: [{ issue: "DUPLICATE_BATCH_HEADER" }], links: [{ href: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/payments/payouts/BATCH123` }] });
  }
  if (req.url === "/v1/payments/payouts/BATCH123") {
    reads++;
    return json(200, { batch_header: { payout_batch_id: "BATCH123", batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: "original-key" } }, items: [{ payout_item: { receiver: mismatch ? "wrong@example.test" : "supplier@example.test", amount: { value: "10.00", currency: "USD" } } }] });
  }
  json(404, { name: "NOT_FOUND" });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.NODE_ENV = "test";
process.env.GUARDBUY_PAYPAL_TEST_API = "1";
process.env.PAYPAL_API_BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.PAYPAL_CLIENT_ID = "offline-test";
process.env.PAYPAL_CLIENT_SECRET = "fake";
try {
  const { submitPayout } = await import("../app/lib/payments/attempts.server");
  const { paypal } = await import("../app/lib/paypal/client.server");
  const attempt: Attempt = { type: "payment_attempt", attemptId: "original-key", requestId: "original-key", operation: "payout", route: "payout", decisionSeq: 1, fundingKey: "fake-account", amountCents: 1000, currency: "USD", payeeEmail: "supplier@example.test", retryUntil: new Date(Date.now() + 3600_000).toISOString(), body: { sender_batch_header: { sender_batch_id: "original-key" }, items: [{ recipient_type: "EMAIL", receiver: "supplier@example.test", amount: { value: "10.00", currency: "USD" } }] } };
  await assert.rejects(submitPayout(attempt));
  assert.equal(posts, 1, "a new payment write is not automatically retried");
  const recovered = await submitPayout<{ batch_header: { payout_batch_id: string } }>(attempt);
  assert.equal(recovered.batch_header.payout_batch_id, "BATCH123");
  assert.equal(accepted, 1);
  assert.equal(reads, 1);
  mismatch = true;
  await assert.rejects(submitPayout(attempt), /identity could not be verified/);
  assert.equal(accepted, 1);

  for (const [clientId, path] of [["slow-resource", "/slow"], ["slow-oauth", "/ok"]]) {
    const began = Date.now();
    await assert.rejects(paypal(path, { creds: { clientId, clientSecret: "fake" }, maxAttempts: 1, timeoutMs: 80 }));
    assert.ok(Date.now() - began < 2000, "OAuth and resource requests have a bounded deadline");
  }
  await paypal("/ok", { creds: { clientId: "throttle", clientSecret: "fake" } });
  const began = Date.now();
  await assert.rejects(paypal("/ok", { creds: { clientId: "throttle", clientSecret: "fake" }, timeoutMs: 80 }));
  assert.ok(Date.now() - began < 2000, "throttle wait shares the request deadline");
  console.log("Payment HTTP checks passed: lost response, verified duplicate-batch recovery, one provider batch, recipient mismatch refusal, bounded OAuth/resource/throttle waits.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
