// Local Postgres integration; fake provider only. Never loads .env or sends PayPal requests.
// DATABASE_URL and DIRECT_URL must point to the disposable guardbuy_ism135_test database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApprovalActions, ApprovalRefused } from "../app/lib/agent/approval-actions";
import { canStartAttempt, runPaymentAttempt, PaymentRejected, type Attempt, type PaymentResult } from "../app/lib/payments/attempts";

for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[key] ?? "invalid:");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/guardbuy_ism135_test") throw new Error(`${key} must select the disposable local guardbuy_ism135_test database`);
}
const { default: db } = await import("../app/db.server");
const { appendAudit, appendAuditWhen, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { approvalQueue } = await import("../app/lib/agent/approvals.server");
const { withPaymentLock } = await import("../app/lib/agent/payment-lock.server");

const shop = `test-ism135-${randomUUID()}.test`;
const provider = new Map<string, PaymentResult>();
let reject = true;
const ports = {
  read: auditEntries,
  appendWhen: appendAuditWhen,
  lock: <T>(shop: string, seq: number, fn: () => Promise<T>) => withPaymentLock(`approval:${shop}:${seq}`, fn),
  execute: async (shop: string, decisionSeq: number) => withPaymentLock(`funding:offline-${shop}`, async (lease) => {
    const log = await auditEntries(shop);
    const n = log.filter((e) => e.event.type === "payment_attempt").length;
    const candidate: Attempt = { type: "payment_attempt", decisionSeq, operation: "payout", route: "payout", attemptId: `request-${n}`, requestId: `request-${n}`,
      fundingKey: "offline", amountCents: 1000, currency: "USD", payeeEmail: "supplier@example.test", body: { amount: 1000 }, retryUntil: new Date(Date.now() + 86400_000).toISOString() };
    return runPaymentAttempt(candidate, {
      fundingKey: "offline", read: () => auditEntries(shop),
      reserve: async (event) => !!await appendAuditWhen(shop, event, (current) => canStartAttempt(current, event), lease),
      append: (event) => appendAudit(shop, event),
      record: (event) => appendAudit(shop, event),
      lookup: async () => null,
      beforeSend: async () => {},
      send: async (saved) => {
        if (reject) throw new PaymentRejected("Fake provider rejected request");
        const result: PaymentResult = provider.get(saved.requestId) ?? { type: "payout", decisionSeq, payoutBatchId: "OFFLINE-BATCH", status: "PENDING", amountCents: saved.amountCents };
        provider.set(saved.requestId, result);
        return result;
      },
    });
  }),
};

try {
  const p = await appendAudit(shop, { type: "proposal", proposal: { variantId: "123", sku: "coffee", supplierId: "supplier", quantity: 10, unitPriceCents: 100, reasoning: "restock", payeeEmail: "supplier@example.test" } });
  const d = await appendAudit(shop, { type: "decision", proposalSeq: p.seq, decision: { verdict: "approval", totalCents: 1000, checks: [], ruleSetHash: "rules" } });
  assert.equal((await approvalQueue(shop))[0].status, "waiting");
  const first = await createApprovalActions(ports).approve(shop, d.seq, "staff:1");
  assert.equal(first.paid, false);
  let card = (await approvalQueue(shop))[0];
  assert.equal(card.status, "payment_failed"); assert.ok(card.canRetry && card.canCancel);
  reject = false;
  const retries = await Promise.allSettled([
    createApprovalActions(ports).retry(shop, d.seq, "staff:1"),
    createApprovalActions(ports).retry(shop, d.seq, "staff:2"),
  ]);
  assert.equal(retries.filter((r) => r.status === "fulfilled").length, 1);
  const refused = retries.find((r) => r.status === "rejected");
  assert.ok(refused?.status === "rejected" && refused.reason instanceof ApprovalRefused);
  assert.equal(provider.size, 1);
  card = (await approvalQueue(shop))[0]; assert.equal(card.status, "payment_pending");
  await assert.rejects(createApprovalActions(ports).reject(shop, d.seq, "staff:2"), ApprovalRefused);
  const log = await auditEntries(shop);
  const payout = log.find((e) => e.event.type === "payout")!;
  await appendAudit(shop, { type: "payout_status", payoutSeq: payout.seq, status: "SUCCESS", confirmedByTransactionSearch: false });
  assert.equal((await approvalQueue(shop)).length, 0);
  assert.ok((await verifyChain(shop)).valid);
  assert.equal(await db.paymentLock.count({ where: { shop: { contains: shop } } }), 0);
  console.log("Local Postgres approval checks passed: actual queue, atomic transitions, contended database leases, one retry payment, pending visibility, settlement and audit integrity.");
} finally {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.deleteMany({ where: { shop } });
  });
  await db.$disconnect();
}
