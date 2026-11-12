// Current-state chart projection; no provider, Shopify, database or payment calls.
import assert from "node:assert/strict";
import { approvalCount } from "../app/lib/agent/approval-state";
import { currentAttention } from "../app/lib/insights/attention";
import { overviewModel } from "../app/lib/insights/overview";
import { demoSnapshot } from "../app/lib/insights/demo";
import { demoWorkspace } from "../app/lib/insights/workspace";
import { insightsSnapshot } from "../app/lib/insights/projection.server";
import type { AuditEntry, AuditEvent } from "../app/lib/policy/schema";
const now = new Date("2026-11-11T12:00:00Z");
const log: AuditEntry[] = [];
function add(event: AuditEvent, at = now.toISOString()) {
  const seq = log.length + 1;
  log.push({
    seq,
    event,
    at,
    shop: "offline.test",
    hash: "hash",
    prevHash: "prev",
  });
  return seq;
}
function decision(
  variantId: string,
  verdict: "auto" | "approval" | "block",
  at = now.toISOString(),
  scenario?: string,
) {
  const proposalSeq = add(
    {
      type: "proposal",
      scenario,
      proposal: {
        sku: "SAME-SKU",
        variantId,
        supplierId: "supplier",
        quantity: 1,
        unitPriceCents: 100,
        reasoning: "fixture",
      },
    },
    at,
  );
  return add(
    {
      type: "decision",
      proposalSeq,
      decision: { verdict, totalCents: 100, ruleSetHash: "rules", checks: [] },
    },
    at,
  );
}
const old = decision("a", "block");
const independent = decision("b", "block");
assert.deepEqual(
  [...currentAttention(log, now).keys()],
  [old, independent],
  "exact variant identity, even with duplicate SKU",
);
const newer = decision("a", "auto");
const paid = add({
  type: "order_captured",
  decisionSeq: newer,
  orderId: "order",
  captureId: "capture",
  amountCents: 100,
  status: "COMPLETED",
  confirmedByGetOrder: true,
});
assert.equal(
  currentAttention(log, now).has(old),
  false,
  "a later successful proposal removes the older block",
);
decision("b", "block", now.toISOString(), "attack");
assert.equal(
  currentAttention(log, now).has(independent),
  true,
  "simulated proposals cannot supersede real work",
);
const expired = decision("expired", "approval", "2026-11-01T12:00:00Z");
assert.equal(currentAttention(log, now).has(expired), false);
const waiting = decision("waiting", "approval");
assert.equal(currentAttention(log, now).get(waiting), "approval");
assert.equal(approvalCount(log, now), 1, "only the live human approval needs a review banner");
add({
  type: "rejected",
  decisionSeq: waiting,
  rejectedBy: "staff",
} as AuditEvent);
assert.equal(
  currentAttention(log, now).has(waiting),
  false,
  "declined work is resolved",
);
const unknown = decision("unknown", "approval");
add({
  type: "payment_failed",
  decisionSeq: unknown,
  reason: "Uncertain transport",
});
assert.equal(currentAttention(log, now).get(unknown), "uncertain");
const pending = decision("pending", "auto");
const payout = add({
  type: "payout",
  decisionSeq: pending,
  payoutBatchId: "batch",
  amountCents: 100,
  status: "PENDING",
});
assert.equal(currentAttention(log, now).get(pending), "pending");
assert.equal(approvalCount(log, now), 0, "within-policy pending payment is not a request for approval");
add({
  type: "payout_status",
  payoutSeq: payout,
  status: "SUCCESS",
  confirmedByTransactionSearch: true,
});
assert.equal(
  currentAttention(log, now).has(pending),
  false,
  "confirmed settlement leaves the outstanding matrix",
);
assert.equal(approvalCount(log, now), 0, "settled payments never need approval");
const failed = decision("failed", "approval");
add({
  type: "approved",
  decisionSeq: failed,
  approvedBy: "staff",
} as AuditEvent);
add({
  type: "payment_failed",
  decisionSeq: failed,
  reason: "Definitive rejection",
  definitive: true,
});
assert.equal(currentAttention(log, now).get(failed), "failed");
decision("failed", "block");
assert.equal(
  currentAttention(log, now).has(failed),
  false,
  "superseded failures do not linger",
);
const before = JSON.stringify(log);
const live = insightsSnapshot(log, {}, now);
assert.equal(
  live.rows.find((r) => r.purchase === old)?.attentionState,
  undefined,
);
assert.equal(
  live.rows.find((r) => r.purchase === independent)?.attentionState,
  "blocked",
);
assert.equal(
  live.rows.find((r) => r.purchase === newer)?.attentionState,
  undefined,
);
assert.equal(
  JSON.stringify(log),
  before,
  "projection never mutates audit evidence",
);
assert.ok(paid > newer);
const snapshot = demoSnapshot(now),
  workspace = demoWorkspace(snapshot);
workspace.policy = { reorderBelowDays: 7, cashFloorCents: 100000 };
workspace.summary = {
  ...workspace.summary,
  capCents: 10000,
  spentCents: 9000,
  reservedCents: 2500,
  remainingCents: 0,
  balanceCents: null,
};
const template = workspace.products![0];
workspace.products = [
  { ...template, variantId: "zero", title: "Out", stock: 0, cover: null },
  {
    ...template,
    variantId: "unknown",
    title: "Unknown",
    stock: 4,
    cover: null,
  },
  { ...template, variantId: "low", title: "Low", stock: 2, cover: 2 },
  {
    ...template,
    variantId: "threshold",
    title: "Threshold",
    stock: 7,
    cover: 7,
  },
  {
    ...template,
    variantId: "off",
    title: "Off",
    stock: 0,
    cover: 0,
    managed: false,
  },
];
const inputs = JSON.stringify({ snapshot, workspace });
const model = overviewModel(snapshot, workspace);
assert.equal(
  model.budget.headroomCents,
  -1500,
  "over-cap headroom is never clamped to an apparently healthy zero",
);
assert.equal(
  model.budget.steps.reduce((s, d) => s + Math.round(d.value * 100), 0),
  -1500,
  "waterfall cents reconcile",
);
assert.deepEqual(
  model.stock.urgent.map((p) => p.variantId),
  ["zero", "low"],
);
assert.deepEqual(
  model.stock.unknown.map((p) => p.variantId),
  ["unknown"],
);
assert.equal(model.stock.risk[0].days, 0);
assert.equal(model.stock.disabledCount, 1);
assert.equal(
  model.stock.risk.some((p) => p.variantId === "off"),
  false,
);
assert.equal(
  model.stock.risk.some((p) => p.variantId === "unknown"),
  false,
  "missing cover is not plotted as zero",
);
assert.equal(
  model.attention.cells.reduce((n, c) => n + c.count, 0),
  model.attention.total,
);
assert.equal(
  new Set(model.attention.cells.flatMap((c) => c.purchaseIds)).size,
  model.attention.total,
  "exclusive lanes avoid double counting",
);
assert.ok(
  model.budget.spentIds.every((id) =>
    snapshot.rows.some(
      (r) =>
        r.purchase === id &&
        r.settled > 0 &&
        Date.parse(r.settledAt!) > now.getTime() - 7 * 86400000,
    ),
  ),
);
assert.ok(
  model.budget.reservedIds.every((id) =>
    snapshot.rows.some((r) => r.purchase === id && r.reserved > 0),
  ),
);
assert.equal(JSON.stringify({ snapshot, workspace }), inputs);
assert.equal(
  overviewModel(snapshot, { ...workspace, products: null }).stock.unavailable,
  true,
);
assert.equal(
  overviewModel(snapshot, { ...workspace, policy: null }).budget.configured,
  false,
);
const empty = { ...snapshot, rows: [] };
assert.equal(overviewModel(empty, workspace).attention.total, 0);
const many = {
  ...snapshot,
  rows: Array.from({ length: 9 }, (_, i) => ({
    ...snapshot.rows[0],
    purchase: 200 + i,
    supplier: `Supplier ${i}`,
    attentionState: "approval" as const,
  })),
};
const manyModel = overviewModel(many, workspace);
assert.equal(manyModel.attention.hiddenSuppliers, 3);
assert.equal(
  manyModel.attention.purchaseIds.length,
  9,
  "View all preserves suppliers beyond the chart limit",
);
console.log(
  "PASS current overview: lifecycle resolution/expiry/supersession, exact identities, safe demo isolation, cents/over-cap reconciliation, unknown/zero/disabled stock, exclusive attention lanes and exact supporting IDs",
);
