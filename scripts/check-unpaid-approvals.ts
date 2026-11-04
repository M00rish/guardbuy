// Offline workflow regression: no database, environment file, AI or PayPal network access.
import assert from "node:assert/strict";
import { createApprovalActions, ApprovalRefused } from "../app/lib/agent/approval-actions";
import { approvalStates } from "../app/lib/agent/approval-state";
import { canStartAttempt, runPaymentAttempt, purchaseReservations, PaymentPending, PaymentRejected, type Attempt, type PaymentResult } from "../app/lib/payments/attempts";
import { AuditEventSchema, type AuditEntry, type AuditEvent } from "../app/lib/policy/schema";
import { skipReason } from "../app/lib/agent/restock.server";

function fixture() {
  const log: AuditEntry[] = [];
  const provider = new Map<string, PaymentResult>();
  let reject = true, loseResponse = false, time = Date.now();
  const add = (event: AuditEvent) => {
    const entry = { seq: log.length, shop: "offline.test", at: new Date(time).toISOString(), event: AuditEventSchema.parse(event), hash: "hash", prevHash: "" };
    log.push(entry); return entry;
  };
  add({ type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", quantity: 10, unitPriceCents: 100, reasoning: "restock", payeeEmail: "supplier@example.test" } });
  add({ type: "decision", proposalSeq: 0, decision: { verdict: "approval", totalCents: 1000, checks: [], ruleSetHash: "rules" } });
  // Two service instances share durable state and the decision lock, just as separate workers do.
  let tail: Promise<unknown> = Promise.resolve();
  const lock = <T>(_shop: string, _seq: number, fn: () => Promise<T>): Promise<T> => {
    const job = tail.then(fn); tail = job.catch(() => {}); return job;
  };
  const ports = {
    read: async () => log,
    appendWhen: async (_shop: string, event: AuditEvent, when: (entries: AuditEntry[]) => boolean) => when(log) ? add(event) : null,
    lock,
    execute: async () => {
      const n = log.filter((e) => e.event.type === "payment_attempt").length;
      const candidate: Attempt = { type: "payment_attempt", decisionSeq: 1, operation: "payout", route: "payout", attemptId: `request-${n}`, requestId: `request-${n}`,
        fundingKey: "account", amountCents: 1000, currency: "USD", payeeEmail: "supplier@example.test", body: { amount: 1000, payee: "supplier@example.test" }, retryUntil: new Date(time + 86400_000).toISOString() };
      return runPaymentAttempt(candidate, {
        fundingKey: "account", now: () => time,
        read: async () => log,
        reserve: async (a) => { if (!canStartAttempt(log, a)) return false; add(a); return true; },
        append: async (e) => add(e),
        record: async (e) => add(e),
        lookup: async () => null,
        beforeSend: async () => {},
        send: async (saved) => {
          assert.equal(saved.amountCents, 1000); assert.equal(saved.payeeEmail, "supplier@example.test");
          if (reject) throw new PaymentRejected("Definitive rejection");
          const result: PaymentResult = provider.get(saved.requestId) ?? { type: "payout", decisionSeq: 1, payoutBatchId: "BATCH", status: "PENDING", amountCents: 1000 };
          provider.set(saved.requestId, result);
          if (loseResponse) { loseResponse = false; throw new Error("Lost response"); }
          return result;
        },
      });
    },
  };
  return { log, add, provider, ports, actions: () => createApprovalActions(ports), succeed: () => { reject = false; }, loseResponse: () => { reject = false; loseResponse = true; }, expire: () => { time += 3 * 86400_000; }, now: () => new Date(time) };
}

const failed = fixture();
assert.equal((await failed.actions().approve("offline.test", 1, "staff:1")).paid, false);
let card = approvalStates(failed.log)[0];
assert.equal(card.status, "payment_failed"); assert.ok(card.approved && card.canRetry && card.canCancel);
assert.equal(purchaseReservations(failed.log).size, 0, "definitive failure releases provider budget");
assert.match(skipReason({ variantId: "123", sku: "coffee" }, failed.log) ?? "", /needs attention/, "failed card prevents a competing replacement before expiry");
await assert.rejects(failed.actions().approve("offline.test", 1, "staff:2"), ApprovalRefused);
failed.succeed();
const retryResults = await Promise.allSettled([failed.actions().retry("offline.test", 1, "staff:1"), failed.actions().retry("offline.test", 1, "staff:2")]);
assert.equal(retryResults.filter((r) => r.status === "fulfilled").length, 1);
assert.equal(failed.provider.size, 1, "concurrent retry clicks submit one payment");
card = approvalStates(failed.log)[0]; assert.equal(card.status, "payment_pending"); assert.equal(card.canRetry, false);
await assert.rejects(failed.actions().reject("offline.test", 1, "staff:2"), ApprovalRefused);
const payout = failed.log.find((e) => e.event.type === "payout")!;
failed.add({ type: "payout_status", payoutSeq: payout.seq, status: "SUCCESS", confirmedByTransactionSearch: false });
assert.equal(approvalStates(failed.log).length, 0, "settlement resolves the approved card");
failed.add({ type: "payout_status", payoutSeq: payout.seq, status: "RETURNED", confirmedByTransactionSearch: false });
card = approvalStates(failed.log)[0];
assert.equal(card.status, "payment_failed"); assert.equal(card.canRetry, false); assert.equal(card.canCancel, false);
assert.match(card.reason ?? "", /returned/);
await assert.rejects(failed.actions().retry("offline.test", 1, "staff:1"), ApprovalRefused);
await assert.rejects(failed.actions().reject("offline.test", 1, "staff:1"), ApprovalRefused);
assert.equal(purchaseReservations(failed.log).size, 0, "confirmed return releases the reservation without hiding its evidence");

const lost = fixture(); lost.loseResponse();
assert.equal((await lost.actions().approve("offline.test", 1, "staff:1")).paid, false);
card = approvalStates(lost.log)[0]; assert.equal(card.status, "payment_unknown"); assert.equal(card.canRetry, false); assert.equal(card.canCancel, false);
await assert.rejects(lost.actions().retry("offline.test", 1, "staff:2"), ApprovalRefused);
await assert.rejects(lost.actions().reject("offline.test", 1, "staff:2"), ApprovalRefused);
assert.equal(lost.provider.size, 1);
assert.equal(purchaseReservations(lost.log).size, 1);
await lost.ports.execute(); // restart recovery uses the already persisted request
assert.equal(lost.provider.size, 1, "same-key resumption cannot create a second payment");
const expiredUnknown = fixture(); expiredUnknown.loseResponse();
await expiredUnknown.actions().approve("offline.test", 1, "staff:1");
expiredUnknown.expire();
assert.equal(approvalStates(expiredUnknown.log, expiredUnknown.now())[0].status, "payment_unknown", "unknown remains visible after approval expiry");
await assert.rejects(expiredUnknown.ports.execute(), PaymentPending);
assert.equal(expiredUnknown.provider.size, 1);

const crash = fixture(); crash.add({ type: "approved", decisionSeq: 1, approvedBy: "staff:1", paymentProtocol: "durable-v1" });
assert.equal(approvalStates(crash.log)[0].canRetry, true, "crash after approval but before reserving stays visible");
crash.expire();
card = approvalStates(crash.log, crash.now())[0]; assert.equal(card.canRetry, false); assert.equal(card.canCancel, true);

const preflight = fixture();
const preflightActions = createApprovalActions({ ...preflight.ports, execute: async () => { throw new Error("failure before request persistence"); } });
assert.equal((await preflightActions.approve("offline.test", 1, "staff:1")).paid, false);
assert.equal(approvalStates(preflight.log)[0].canRetry, true);
assert.equal(preflight.log.some((e) => e.event.type === "payment_failed" && e.event.definitive), true);
assert.equal(preflight.provider.size, 0);

const order = fixture();
order.add({ type: "order_created", decisionSeq: 1, orderId: "ORDER", amountCents: 1000, approveUrl: "https://www.sandbox.paypal.com/approve" });
assert.equal(approvalStates(order.log)[0].status, "paypal_pending");
await assert.rejects(order.actions().approve("offline.test", 1, "staff:1"), ApprovalRefused);
await assert.rejects(order.actions().reject("offline.test", 1, "staff:1"), ApprovalRefused);
order.add({ type: "order_captured", decisionSeq: 1, orderId: "ORDER", captureId: "CAPTURE", amountCents: 1000, status: "PENDING", confirmedByGetOrder: false });
assert.equal(approvalStates(order.log)[0].status, "payment_pending");
order.add({ type: "order_status", decisionSeq: 1, orderId: "ORDER", status: "DENIED", refundedCents: 0 });
card = approvalStates(order.log)[0]; assert.equal(card.status, "payment_failed"); assert.equal(card.canCancel, false); assert.equal(card.canRetry, false);

const cancel = fixture();
await cancel.actions().approve("offline.test", 1, "staff:1");
await cancel.actions().reject("offline.test", 1, "staff:2", "cancel unpaid");
assert.equal(approvalStates(cancel.log).length, 0);
await assert.rejects(cancel.actions().retry("offline.test", 1, "staff:1"), ApprovalRefused);
assert.equal(cancel.provider.size, 0);
assert.equal(cancel.log.at(-1)?.event.type, "rejected", "cancellation leaves permanent evidence");

const race = fixture(); race.succeed();
await Promise.allSettled([race.actions().approve("offline.test", 1, "staff:1"), race.actions().reject("offline.test", 1, "staff:2")]);
assert.equal(race.provider.size, 1); assert.equal(race.log.some((e) => e.event.type === "rejected"), false);
const declineFirst = fixture(); declineFirst.succeed();
await Promise.allSettled([declineFirst.actions().reject("offline.test", 1, "staff:2"), declineFirst.actions().approve("offline.test", 1, "staff:1")]);
assert.equal(declineFirst.provider.size, 0);

const unknownLegacy = fixture(); unknownLegacy.add({ type: "approved", decisionSeq: 1, approvedBy: "staff:1" });
unknownLegacy.add({ type: "payment_failed", decisionSeq: 1, reason: "old timeout" });
assert.equal(approvalStates(unknownLegacy.log)[0].status, "payment_unknown");
assert.equal(approvalStates(unknownLegacy.log)[0].canCancel, false);
const untracked = fixture(); untracked.add({ type: "approved", decisionSeq: 1, approvedBy: "older-worker" });
card = approvalStates(untracked.log)[0];
assert.equal(card.status, "payment_unknown"); assert.equal(card.canResume, false); assert.equal(card.canRetry, false); assert.equal(card.canCancel, false);
await assert.rejects(untracked.actions().retry("offline.test", 1, "staff:1"), ApprovalRefused);
await assert.rejects(untracked.actions().reject("offline.test", 1, "staff:1"), ApprovalRefused);
assert.equal(purchaseReservations(untracked.log).get(1)?.amountCents, 1000, "untracked historical approvals remain reserved for manual reconciliation");
assert.equal(canStartAttempt(untracked.log, { type: "payment_attempt", decisionSeq: 1, operation: "payout", route: "payout", attemptId: "unsafe", requestId: "unsafe", fundingKey: "account", amountCents: 1000, currency: "USD", payeeEmail: "supplier@example.test", body: {}, retryUntil: new Date(Date.now() + 60000).toISOString() }), false);
console.log("Unpaid approval checks passed: rejection visibility, safe retry, duplicate clicks, cancellation, approve/decline races, crash recovery, lost response, legacy uncertainty, pending settlement and expiry.");
