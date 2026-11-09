// Offline regressions for hosted ISM-141 observations. No provider or store calls.
import assert from "node:assert/strict";
import { currentProblems } from "../app/lib/merchant/current-problems";
import { needsShopifyEntry } from "../app/lib/merchant/app-entry";
import { toFeed } from "../app/lib/audit/feed.server";
import { readableTime } from "../app/lib/format";
import {
  runPaymentAttempt,
  PaymentPending,
  PaymentRejected,
  type Attempt,
} from "../app/lib/payments/attempts";
import { PaymentSafetyRefusal } from "../app/lib/payments/safety-refusal";
import type { AuditEntry, AuditEvent } from "../app/lib/policy/schema";
const now = new Date("2026-11-09T18:00:00Z");
const log: AuditEntry[] = [];
function add(event: AuditEvent) {
  const e = {
    seq: log.length,
    event,
    at: now.toISOString(),
    shop: "offline.myshopify.com",
    hash: "",
    prevHash: "",
  };
  log.push(e);
  return e;
}
function proposal(variantId = "123") {
  return add({
    type: "proposal",
    proposal: {
      variantId,
      sku: "coffee",
      supplierId: "supplier",
      payeeEmail: "supplier@example.test",
      quantity: 1,
      unitPriceCents: 100,
      reasoning: "offline",
    },
  });
}
function decision(source: AuditEntry) {
  return add({
    type: "decision",
    proposalSeq: source.seq,
    decision: {
      verdict: "approval",
      totalCents: 100,
      ruleSetHash: "fixture",
      checks: [],
    },
  });
}
const p = proposal(),
  d = decision(p);
add({
  type: "approved",
  decisionSeq: d.seq,
  approvedBy: "shopify-staff:1",
  paymentProtocol: "durable-v1",
});
add({
  type: "payment_failed",
  decisionSeq: d.seq,
  definitive: true,
  reason: "product off",
});
add({
  type: "payment_failed",
  decisionSeq: d.seq,
  definitive: true,
  reason: "same purchase again",
});
assert.equal(
  currentProblems(log, now).payments,
  1,
  "repeat failures of the same purchase count once",
);
const payout = add({
  type: "payout",
  decisionSeq: d.seq,
  payoutBatchId: "ACTUAL-PAYOUT-ID",
  amountCents: 100,
  status: "PENDING",
});
assert.equal(
  currentProblems(log, now).payments,
  0,
  "a pending retry is not an active failure",
);
add({
  type: "payout_status",
  payoutSeq: payout.seq,
  status: "SUCCESS",
  confirmedByTransactionSearch: true,
});
assert.equal(
  currentProblems(log, now).payments,
  0,
  "a successful recovery clears the active failure",
);
assert.equal(
  log.filter((e) => e.event.type === "payment_failed").length,
  2,
  "history remains intact",
);
add({
  type: "proposal_failed",
  variantId: "456",
  sku: "coffee",
  reason: "temporary AI failure",
});
add({
  type: "proposal_failed",
  variantId: "456",
  sku: "coffee",
  reason: "again",
});
assert.equal(currentProblems(log, now).proposals, 1);
proposal("456");
assert.equal(currentProblems(log, now).proposals, 0);
const cancelled = decision(proposal("789"));
add({
  type: "payment_failed",
  decisionSeq: cancelled.seq,
  reason: "failed",
  definitive: true,
});
add({
  type: "rejected",
  decisionSeq: cancelled.seq,
  rejectedBy: "shopify-staff:1",
});
assert.equal(currentProblems(log, now).payments, 0);
const receiptId = "00000000-0000-4000-8000-000000000001";
const started = add({
  type: "receipt_started",
  decisionSeq: d.seq,
  receiptId,
  quantity: 1,
  expectedReceived: 0,
  variantId: "123",
  inventoryItemId: "item",
  locationId: "location",
  receivedBy: "shopify-staff:1",
});
const received = add({
  type: "receipt_received",
  decisionSeq: d.seq,
  receiptId,
  quantity: 1,
  variantId: "123",
  locationId: "location",
  receivedBy: "shopify-staff:1",
});
const feed = toFeed(log, "shopify-staff:1"),
  other = toFeed(log, "shopify-staff:2");
assert.equal(feed.find((e) => e.seq === started.seq)?.kind, "receipt_started");
assert.equal(feed.find((e) => e.seq === received.seq)?.kind, "stock_received");
assert.match(
  feed.find((e) => e.seq === received.seq)!.title,
  /Received 1 unit for/,
);
assert.ok(feed.filter((e) => e.byYou).some((e) => e.seq === started.seq));
assert.ok(feed.filter((e) => e.byYou).some((e) => e.seq === received.seq));
assert.ok(!other.find((e) => e.seq === received.seq)?.byYou);
assert.ok(
  feed.some(
    (e) => e.title === "Payment update: Payout ACTUAL-PAYOUT-ID succeeded",
  ),
);
assert.equal(readableTime("2026-11-09T18:00:00Z"), "9 Nov 2026, 18:00:00 UTC");
assert.equal(
  needsShopifyEntry(new Request("https://example.test/app/rules")),
  true,
);
for (const path of [
  "/app/rules?shop=store.myshopify.com",
  "/app?host=shopify-host",
  "/app?embedded=1",
  "/app?id_token=untrusted",
])
  assert.equal(
    needsShopifyEntry(new Request("https://example.test" + path)),
    false,
    "context still goes through SDK authentication",
  );
assert.equal(
  needsShopifyEntry(
    new Request("https://example.test/app/rules", {
      headers: { Authorization: "Bearer untrusted" },
    }),
  ),
  false,
);
assert.equal(
  needsShopifyEntry(
    new Request("https://example.test/app/rules", { method: "POST" }),
  ),
  false,
);
assert.equal(
  needsShopifyEntry(new Request("https://example.test/verify")),
  false,
);
assert.equal(needsShopifyEntry(new Request("https://example.test/app/rules", {headers:{"Sec-Fetch-Dest":"iframe"}})),false,"embedded bootstrap remains handled by Shopify SDK");
assert.equal(needsShopifyEntry(new Request("https://example.test/app/rules", {headers:{"Sec-Fetch-Dest":"empty"}})),false,"client loader fetches remain handled by Shopify SDK");
const candidate: Attempt = {
  type: "payment_attempt",
  decisionSeq: 1,
  attemptId: "attempt",
  operation: "payout",
  route: "payout",
  requestId: "request",
  fundingKey: "fixture-funding",
  amountCents: 100,
  currency: "USD",
  payeeEmail: "supplier@example.test",
  body: {},
  retryUntil: "2026-11-10T00:00:00Z",
};
async function refusal(error: Error, existing = false) {
  const rows: AuditEntry[] = [];
  let sends = 0;
  const push = (event: AuditEvent) => {
    const e = {
      seq: rows.length,
      event,
      at: now.toISOString(),
      shop: "offline",
      hash: "",
      prevHash: "",
    };
    rows.push(e);
    return e;
  };
  if (existing) push(candidate);
  const promise = runPaymentAttempt(candidate, {
    read: async () => rows,
    reserve: async (a) => {
      push(a);
      return true;
    },
    append: async (e) => push(e),
    record: async (e) => push(e),
    lookup: async () => null,
    beforeSend: async () => {
      throw error;
    },
    send: async () => {
      sends++;
      throw Error("must not send");
    },
    fundingKey: "fixture-funding",
    now: () => now.getTime(),
  });
  await assert.rejects(promise, (e) =>
    existing
      ? e instanceof PaymentPending
      : e instanceof PaymentRejected &&
        (error instanceof PaymentSafetyRefusal
          ? e.message === error.message
          : !e.message.includes("SECRET")),
  );
  assert.equal(sends, 0);
  return rows;
}
await refusal(new PaymentSafetyRefusal("product_off"));
await refusal(new PaymentSafetyRefusal("account_access"));
await refusal(new Error("SECRET credential provider body"));
const reserved = await refusal(new PaymentSafetyRefusal("product_off"), true);
assert.ok(
  !reserved.some((e) => e.event.type === "payment_outcome"),
  "an uncertain original stays reserved even for a confirmed product-off refusal",
);
console.log(
  "PASS merchant feedback: resolved failures, receipt labels/actors/grammar, payout identity, readable UTC time, direct entry guard and safe pre-send refusal reasons; unknown outcomes remain reserved.",
);
