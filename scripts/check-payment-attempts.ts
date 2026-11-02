// Offline failure-injection tests: no environment file, database, AI or real PayPal calls.
import assert from "node:assert/strict";
import { AuditEventSchema, type AuditEntry, type AuditEvent } from "../app/lib/policy/schema";
import { runPaymentAttempt, canStartAttempt, canCloseOrder, attemptStates, unresolvedPayments, purchaseReservations, unknownPaymentDecisions, PaymentPending, PaymentRejected, PaymentRouteRefused, type Attempt, type PaymentResult } from "../app/lib/payments/attempts";
import { duplicatePayoutPath, definitivePayPalRejection } from "../app/lib/payments/attempts.server";
import { PayPalError } from "../app/lib/paypal/client.server";
import { balanceCommitmentCents, spending, skipReason } from "../app/lib/agent/restock.server";
import { checkCapture, type PayPalOrder } from "../app/lib/agent/execute.server";

const NOW = Date.parse("2026-11-02T12:00:00Z");
function fixture(verdict: "auto" | "approval" = "auto") {
  let now = NOW;
  const log: AuditEntry[] = [];
  const provider = new Map<string, PaymentResult>();
  const submitted: Attempt[] = [];
  let loseResponse = false, failWrite = false, failAfterWrite = false, reject = false, preflight = false;
  const add = (event: AuditEvent) => {
    const entry = { seq: log.length, shop: "a.test", at: new Date(now).toISOString(), event: AuditEventSchema.parse(event), hash: "hash", prevHash: "" };
    log.push(entry); return entry;
  };
  add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", quantity: 10, unitPriceCents: 100, reasoning: "restock", payeeEmail: "supplier@example.test" } });
  add({ type: "decision", proposalSeq: 0, decision: { verdict, totalCents: 1000, checks: [], ruleSetHash: "rules" } });
  const candidate = (operation: Attempt["operation"] = "payout", suffix = "1"): Attempt => ({ type: "payment_attempt", attemptId: operation + suffix, requestId: operation + suffix, operation, route: operation === "payout" ? "payout" : "order", decisionSeq: 1, amountCents: 1000, currency: "USD", payeeEmail: "supplier@example.test", fundingKey: "account", body: { immutable: "original" }, retryUntil: new Date(NOW + (operation === "payout" ? 29 * 24 : 5) * 60 * 60_000).toISOString(), ...(operation === "order_capture" ? { providerId: "ORDER" } : {}) });
  const ports = () => ({
    fundingKey: "account", now: () => now,
    read: async () => structuredClone(log),
    reserve: async (a: Attempt) => { if (!canStartAttempt(log, a)) return false; add(a); return true; },
    append: async (e: AuditEvent) => add(e),
    record: async (event: PaymentResult) => {
      if (failWrite) { failWrite = false; throw Error("db connection failed"); }
      const old = log.find((e) => "paymentAttemptId" in e.event && e.event.paymentAttemptId === event.paymentAttemptId);
      const entry = old ?? add(event);
      if (failAfterWrite) { failAfterWrite = false; throw Error("commit response lost"); }
      return entry;
    },
    lookup: async (a: Attempt) => a.operation === "order_capture" ? provider.get(a.requestId) ?? null : null,
    beforeSend: async () => { if (preflight) throw Error("policy refused"); },
    send: async (a: Attempt) => {
      assert.ok(log.some((e) => e.event.type === "payment_attempt" && e.event.attemptId === a.attemptId), "attempt must exist before POST");
      submitted.push(structuredClone(a));
      if (reject) throw new PaymentRejected("definitive request rejection");
      let result = provider.get(a.requestId);
      if (!result) {
        result = a.operation === "payout" ? { type: "payout", decisionSeq: 1, payoutBatchId: "BATCH", status: "PENDING", amountCents: a.amountCents }
          : a.operation === "order_create" ? { type: "order_created", decisionSeq: 1, orderId: "ORDER", approveUrl: "https://www.sandbox.paypal.com/approve", amountCents: a.amountCents }
          : { type: "order_captured", decisionSeq: 1, orderId: "ORDER", captureId: "CAPTURE", status: "COMPLETED", amountCents: a.amountCents, confirmedByGetOrder: true };
        provider.set(a.requestId, result);
      }
      if (loseResponse) { loseResponse = false; throw Error("response lost after provider accepted payment"); }
      return result;
    },
  });
  return { log, add, candidate, ports, provider, submitted, advance: (ms: number) => { now += ms; }, loseResponse: () => { loseResponse = true; }, failWrite: () => { failWrite = true; }, failAfterWrite: () => { failAfterWrite = true; }, reject: (value = true) => { reject = value; }, preflight: () => { preflight = true; } };
}

for (const failure of ["response", "audit", "commit"] as const) {
  const f = fixture();
  if (failure === "response") f.loseResponse(); else if (failure === "audit") f.failWrite(); else f.failAfterWrite();
  const original = f.candidate();
  await assert.rejects(runPaymentAttempt(original, f.ports()), PaymentPending);
  assert.equal(f.provider.size, 1);
  if (failure !== "commit") {
    assert.equal(purchaseReservations(f.log).get(1)?.amountCents, 1000);
    assert.equal(spending(f.log).pendingCents, 1000);
    assert.match(skipReason({ variantId: "123", sku: "coffee" }, f.log, new Date(NOW + 10 * 86400_000)) ?? "", /confirmation/);
  }
  // A new worker has no in-memory state; deliberately supply changed caller fields.
  const changed = { ...original, body: { immutable: "changed" }, payeeEmail: "attacker@example.test", amountCents: 99999 };
  await runPaymentAttempt(changed, f.ports());
  assert.equal(f.provider.size, 1, "recovery must never create another payment");
  assert.ok(f.submitted.every((a) => a.payeeEmail === original.payeeEmail && a.amountCents === 1000 && a.body.immutable === "original"));
  assert.equal(f.log.filter((e) => e.event.type === "payout").length, 1);
  assert.equal(purchaseReservations(f.log).size, 1, "a known pending payout still reserves money");
  assert.equal(unknownPaymentDecisions(f.log).size, 0, "a known pending payout needs status refresh, not resubmission");
  assert.equal(spending(f.log, new Date(NOW + 40 * 86400_000)).pendingCents, 1000);
  const payoutSeq = f.log.find((e) => e.event.type === "payout")!.seq;
  f.add({ type: "payout_status", payoutSeq, status: "UNCLAIMED", confirmedByTransactionSearch: false });
  assert.equal(purchaseReservations(f.log).size, 1, "unclaimed money can still settle and stays reserved");
  f.add({ type: "payout_status", payoutSeq, status: "SUCCESS", confirmedByTransactionSearch: false });
  assert.equal(purchaseReservations(f.log).size, 0, "provider item status settles without delayed transaction search");
  assert.equal(spending(f.log, new Date(NOW)).spentLast7dCents, 1000);
  await runPaymentAttempt(original, f.ports());
  assert.equal(f.provider.size, 1);
}

const failed = fixture(); failed.reject();
await assert.rejects(runPaymentAttempt(failed.candidate(), failed.ports()), PaymentRejected);
assert.equal(purchaseReservations(failed.log).size, 0);
assert.equal(attemptStates(failed.log)[0].state, "failed");
failed.reject(false);
await runPaymentAttempt(failed.candidate("payout", "2"), failed.ports());
assert.equal(failed.provider.size, 1, "only a definitive rejection permits a new attempt");

const beforeSubmission = fixture();
await beforeSubmission.ports().reserve(beforeSubmission.candidate()); // Worker crashes before sending anything.
await runPaymentAttempt({ ...beforeSubmission.candidate(), body: { changed: true } }, beforeSubmission.ports());
assert.equal(beforeSubmission.provider.size, 1);
assert.equal(beforeSubmission.submitted[0].body.immutable, "original");

const lostOrder = fixture("approval"); lostOrder.failWrite();
await assert.rejects(runPaymentAttempt(lostOrder.candidate("order_create"), lostOrder.ports()), PaymentPending);
await runPaymentAttempt({ ...lostOrder.candidate("order_create"), body: { changed: true } }, lostOrder.ports());
assert.equal(lostOrder.provider.size, 1, "Order creation recovers its existing provider order after a lost audit write");
assert.equal(lostOrder.log.filter((e) => e.event.type === "order_created").length, 1);

const lateRejection = fixture(); lateRejection.loseResponse();
await assert.rejects(runPaymentAttempt(lateRejection.candidate(), lateRejection.ports()), PaymentPending);
lateRejection.reject();
await assert.rejects(runPaymentAttempt(lateRejection.candidate(), lateRejection.ports()), PaymentPending);
assert.equal(purchaseReservations(lateRejection.log).size, 1, "a later rejection cannot release an earlier uncertain payment");

for (const operation of ["payout", "order_create"] as const) {
  const expired = fixture(operation === "order_create" ? "approval" : "auto"); expired.loseResponse();
  await assert.rejects(runPaymentAttempt(expired.candidate(operation), expired.ports()), PaymentPending);
  expired.advance(31 * 86400_000);
  const attempts = expired.submitted.length;
  await assert.rejects(runPaymentAttempt(expired.candidate(operation), expired.ports()), PaymentPending);
  assert.equal(expired.submitted.length, attempts, "expired idempotency keys are never re-submitted");
  assert.equal(purchaseReservations(expired.log).size, 1);
}

const capture = fixture("approval");
capture.add({ type: "order_created", decisionSeq: 1, orderId: "ORDER", approveUrl: "https://www.sandbox.paypal.com/approve", amountCents: 1000 });
capture.loseResponse();
await assert.rejects(runPaymentAttempt(capture.candidate("order_capture"), capture.ports()), PaymentPending);
capture.advance(7 * 86400_000);
assert.equal(canCloseOrder(capture.log, 1, "ORDER"), false, "an unknown capture cannot be cancelled or aged out");
assert.ok(unknownPaymentDecisions(capture.log).has(1), "capture recovery stays visible even when its approval has expired");
await runPaymentAttempt(capture.candidate("order_capture"), capture.ports());
assert.equal(capture.submitted.length, 1, "completed capture is recovered by GET even after key expiry");
assert.equal(capture.log.filter((e) => e.event.type === "order_captured").length, 1);
assert.equal(canCloseOrder(capture.log, 1, "ORDER"), false, "a recorded capture cannot be closed to free another route");

const replacement = fixture(); replacement.loseResponse();
await assert.rejects(runPaymentAttempt(replacement.candidate(), replacement.ports()), PaymentPending);
replacement.advance(40 * 86400_000);
replacement.add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", quantity: 10, unitPriceCents: 100, reasoning: "replacement", payeeEmail: "supplier@example.test" } });
const proposalSeq = replacement.log.at(-1)!.seq;
const second = replacement.add({ type: "decision", proposalSeq, decision: { verdict: "auto", totalCents: 1000, checks: [], ruleSetHash: "rules" } });
assert.equal(canStartAttempt(replacement.log, { ...replacement.candidate("payout", "replacement"), decisionSeq: second.seq }), false, "another decision cannot bypass an old uncertain SKU reservation");
assert.equal(spending(replacement.log, new Date(NOW + 40 * 86400_000)).pendingCents, 1000);

const race = fixture("approval");
const order = race.candidate("order_create");
assert.ok(await race.ports().reserve(order));
race.add({ type: "approved", decisionSeq: 1, approvedBy: "stale-worker" });
await assert.rejects(runPaymentAttempt(race.candidate(), race.ports()), PaymentRouteRefused);
assert.equal(race.provider.size, 0, "a competing route cannot send money");
const approveFirst = fixture("approval"); approveFirst.add({ type: "approved", decisionSeq: 1, approvedBy: "merchant" });
assert.equal(canStartAttempt(approveFirst.log, approveFirst.candidate("order_create")), false);
await runPaymentAttempt(approveFirst.candidate(), approveFirst.ports());
assert.equal(approveFirst.provider.size, 1);

const same = fixture();
const workers = await Promise.allSettled([runPaymentAttempt(same.candidate(), same.ports()), runPaymentAttempt(same.candidate(), same.ports())]);
assert.ok(workers.some((r) => r.status === "fulfilled"));
assert.equal(same.provider.size, 1);
assert.equal(same.log.filter((e) => e.event.type === "payment_attempt").length, 1);
const declined = fixture("approval"); declined.add({ type: "rejected", decisionSeq: 1, rejectedBy: "merchant" });
assert.equal(canStartAttempt(declined.log, declined.candidate("order_create")), false);

const policy = fixture(); policy.preflight();
await assert.rejects(runPaymentAttempt(policy.candidate(), policy.ports()), PaymentRejected);
assert.equal(policy.submitted.length, 0);
assert.equal(purchaseReservations(policy.log).size, 0);
const account = fixture(); account.loseResponse();
await assert.rejects(runPaymentAttempt(account.candidate(), account.ports()), PaymentPending);
await assert.rejects(runPaymentAttempt(account.candidate(), { ...account.ports(), fundingKey: "another-account" }), PaymentPending);
assert.equal(account.submitted.length, 1);

const legacy = fixture(); legacy.add({ type: "payment_failed", decisionSeq: 1, reason: "old ambiguous timeout" });
assert.equal(purchaseReservations(legacy.log).get(1)?.amountCents, 1000);
assert.equal(spending(legacy.log).pendingCents, 1000);
assert.equal(spending(legacy.log, new Date(), 1).pendingCents, 0);
assert.equal(canStartAttempt(legacy.log, legacy.candidate("order_create")), false);
assert.equal(canStartAttempt(legacy.log, legacy.candidate()), false, "legacy recovery must be explicitly marked uncertain");
assert.equal(canStartAttempt(legacy.log, { ...legacy.candidate(), previouslyUncertain: true }), true);
const legacySafe = fixture(); legacySafe.add({ type: "payment_failed", decisionSeq: 1, reason: "not submitted", definitive: true });
assert.equal(purchaseReservations(legacySafe.log).size, 0);
const resumedLegacy = fixture(); resumedLegacy.reject();
await assert.rejects(runPaymentAttempt({ ...resumedLegacy.candidate(), previouslyUncertain: true }, resumedLegacy.ports()), PaymentPending);

const pendingCapture = fixture("approval");
pendingCapture.add({ type: "order_created", decisionSeq: 1, orderId: "PENDINGORDER", approveUrl: "https://www.sandbox.paypal.com/approve", amountCents: 1000 });
pendingCapture.add({ type: "order_captured", decisionSeq: 1, orderId: "PENDINGORDER", captureId: "CAPTURE", status: "PENDING", amountCents: 1000, confirmedByGetOrder: false });
assert.equal(spending(pendingCapture.log, new Date(NOW + 40 * 86400_000)).pendingCents, 1000);
pendingCapture.add({ type: "order_status", decisionSeq: 1, orderId: "PENDINGORDER", status: "DENIED", refundedCents: 0 });
assert.equal(purchaseReservations(pendingCapture.log).size, 0);
assert.equal(spending(pendingCapture.log, new Date(NOW)).spentLast7dCents, 0, "definitively denied capture releases its budget");

const lateSettlement = fixture();
await runPaymentAttempt(lateSettlement.candidate(), lateSettlement.ports());
lateSettlement.advance(40 * 86400_000);
const lateNow = new Date(NOW + 40 * 86400_000);
const staleReport = new Date(lateNow.getTime() - 60_000);
assert.equal(balanceCommitmentCents(lateSettlement.log, staleReport), 1000, "pending funds count once even with a stale balance report");
assert.equal(balanceCommitmentCents(lateSettlement.log, staleReport, 1), 0, "a replay excludes its own existing reservation");
lateSettlement.add({ type: "payout_status", payoutSeq: lateSettlement.log.find((e) => e.event.type === "payout")!.seq, status: "SUCCESS", confirmedByTransactionSearch: false });
assert.equal(spending(lateSettlement.log, lateNow).pendingCents, 0);
assert.equal(spending(lateSettlement.log, lateNow).spentLast7dCents, 1000, "late settlement moves the reservation into current spending");
assert.equal(balanceCommitmentCents(lateSettlement.log, staleReport), 1000, "settlement newer than the balance report remains deducted");
assert.equal(balanceCommitmentCents(lateSettlement.log, lateNow), 0, "a fresh settled balance is not deducted twice");

assert.equal(definitivePayPalRejection(new PayPalError(422, { name: "INSUFFICIENT_FUNDS" })), true);
assert.equal(definitivePayPalRejection(new PayPalError(422, { name: "INVALID_REQUEST", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] })), false);
assert.equal(definitivePayPalRejection(new PayPalError(500, { name: "INSUFFICIENT_FUNDS" })), false);
assert.equal(definitivePayPalRejection(new PayPalError(422, { name: "DUPLICATE_BATCH_HEADER" })), false);
assert.equal(duplicatePayoutPath({links:[{href:"https://evil.example/v1/payments/payouts/ABC"}]}), null);
assert.equal(duplicatePayoutPath({links:[{href:"https://api-m.sandbox.paypal.com/v1/payments/payouts/ABC"}]}), "/v1/payments/payouts/ABC");
assert.equal(duplicatePayoutPath({links:[{href:"/v1/payments/payouts/ABC?secret=x"}]}), null);
assert.equal(duplicatePayoutPath({links: "bad", details: {bad:true}}), null);
assert.equal(definitivePayPalRejection(new PayPalError(422, { name: "INVALID_REQUEST", details: { length: 1 } })), false);
const proof: PayPalOrder = { id: "ORDER", status: "COMPLETED", purchase_units: [{ amount: { value: "10.00", currency_code: "USD" }, payee: { email_address: "supplier@example.test" }, payments: { captures: [{ id: "CAPTURE", status: "COMPLETED", amount: { value: "10.00", currency_code: "USD" } }] } }] };
assert.equal(checkCapture(proof, 1000, "supplier@example.test").id, "CAPTURE");
for (const corrupt of [
  (p: PayPalOrder) => { p.purchase_units![0].payments!.captures![0].amount.currency_code = "EUR"; },
  (p: PayPalOrder) => { p.purchase_units![0].payee!.email_address = "another@example.test"; },
  (p: PayPalOrder) => { p.purchase_units![0].payments!.captures![0].amount.value = "20.00"; },
  (p: PayPalOrder) => { p.purchase_units!.push(p.purchase_units![0]); },
]) {
  const changed = structuredClone(proof); corrupt(changed);
  assert.throws(() => checkCapture(changed, 1000, "supplier@example.test"));
}
assert.equal(unresolvedPayments(same.log).length, 0);
console.log("Payment attempt checks passed: lost responses, database/commit failures, restart recovery, immutable requests, one route, concurrency, budget/SKU reservations, definitive rejection, account binding, expiry and read-only capture recovery.");
