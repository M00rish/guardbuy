// Offline financial/agent boundaries. No DB, provider, payment or audit writes.
import assert from "node:assert/strict";
import { insightsSnapshot } from "../app/lib/insights/projection.server";
import { inInsightView, describeInsightView } from "../app/lib/insights/types";
import {
  InsightPlanSchema,
  InsightPromptSchema,
} from "../app/lib/insights/plan";
import { createInsightsAgent } from "../app/lib/insights/agent";
import type { AgAiEvent, AgAiTool, AgAiToolContext } from "ag-studio";
import type { AuditEntry, AuditEvent } from "../app/lib/policy/schema";
import { readFileSync } from "node:fs";
const now = new Date("2026-11-10T12:00:00Z"),
  log: AuditEntry[] = [];
const add = (event: AuditEvent, at = now.toISOString()) => {
  const e = {
    seq: log.length,
    event,
    at,
    shop: "offline.test",
    hash: "private-hash",
    prevHash: "private-prev",
  };
  log.push(e);
  return e.seq;
};
add({
  type: "ruleset_signed",
  ruleSet: {
    rules: {
      reorderBelowDaysOfCover: 3,
      targetDaysOfCover: 14,
      maxQuantityMultiple: 3,
      approvalAboveCents: 30000,
      weeklySpendCapCents: 100000,
      cashFloorCents: 1000,
      maxPurchasesPer24h: 5,
      supplierAllowlist: ["supplier"],
    },
    hash: "rules",
    signedAt: now.toISOString(),
    signedBy: "private-staff",
  },
} as AuditEvent);
function purchase(
  verdict: "auto" | "approval" | "block",
  amount: number,
  at = now.toISOString(),
  scenario?: string,
) {
  const proposal = add(
    {
      type: "proposal",
      scenario,
      proposal: {
        sku: "coffee",
        supplierId: "supplier",
        quantity: 1,
        unitPriceCents: amount,
        reasoning: "PRIVATE AI REASON",
        payeeEmail: "private@example.test",
      },
    },
    at,
  );
  return add(
    {
      type: "decision",
      proposalSeq: proposal,
      decision: {
        verdict,
        totalCents: amount,
        ruleSetHash: "rules",
        checks:
          verdict === "block"
            ? [
                {
                  rule: "weeklySpendCap",
                  outcome: "block",
                  detail: "Spending cap exceeded.",
                },
              ]
            : [],
      },
    },
    at,
  );
}
const paid = purchase("auto", 10000, "2026-11-03T13:00:00Z");
const payout = add(
  {
    type: "payout",
    decisionSeq: paid,
    payoutBatchId: "PRIVATE-PAYOUT",
    amountCents: 10000,
    status: "SUCCESS",
  },
  "2026-11-03T13:00:00Z",
);
let snapshot = insightsSnapshot(log, {}, now);
assert.equal(
  snapshot.summary.spentCents,
  0,
  "batch success is not recipient settlement",
);
assert.equal(snapshot.summary.reservedCents, 10000);
add(
  {
    type: "payout_status",
    payoutSeq: payout,
    status: "SUCCESS",
    confirmedByTransactionSearch: true,
  },
  "2026-11-03T13:01:00Z",
);
const pending = purchase("auto", 2000);
add({
  type: "payout",
  decisionSeq: pending,
  amountCents: 2000,
  payoutBatchId: "PENDING",
  status: "PENDING",
});
const unknown = purchase("approval", 3000);
add({
  type: "payment_failed",
  decisionSeq: unknown,
  reason: "PRIVATE UNKNOWN PAYLOAD",
});
const waiting = purchase("approval", 4000);
purchase("block", 5000);
purchase("approval", 6000, "2026-11-01T12:00:00Z");
const refund = purchase("auto", 8000);
add({
  type: "order_captured",
  decisionSeq: refund,
  orderId: "PRIVATE-ORDER",
  captureId: "PRIVATE-CAPTURE",
  amountCents: 8000,
  status: "COMPLETED",
  confirmedByGetOrder: true,
});
add({
  type: "order_status",
  decisionSeq: refund,
  orderId: "PRIVATE-ORDER",
  status: "PARTIALLY_REFUNDED",
  refundedCents: 2000,
});
const simulated = purchase("block", 999999, now.toISOString(), "attack");
add({
  type: "payout",
  decisionSeq: simulated,
  payoutBatchId: "SIMULATED",
  amountCents: 999999,
  status: "PENDING",
});
const before = JSON.stringify(log);
snapshot = insightsSnapshot(
  log,
  { product: () => "Coffee", supplier: () => "Supplier" },
  now,
);
assert.equal(snapshot.summary.spentCents, 16000);
assert.equal(snapshot.summary.reservedCents, 9000);
assert.equal(snapshot.summary.remainingCents, 75000);
assert.equal(snapshot.summary.blockedCents, 5000);
assert.equal(snapshot.summary.blockedCount, 1);
assert.equal(
  Math.round(snapshot.trend.reduce((sum, day) => sum + day.spent, 0) * 100),
  snapshot.summary.spentCents,
  "partial first UTC day reconciles with rolling window",
);
assert.equal(
  Math.round(snapshot.rows.reduce((sum, row) => sum + row.reserved, 0) * 100),
  snapshot.summary.reservedCents,
);
assert.equal(
  snapshot.rows.filter((row) => inInsightView(row, "pending")).length,
  2,
);
assert.equal(
  snapshot.rows.find((row) => row.purchase === unknown)?.status,
  "Payment awaiting confirmation",
);
assert.equal(
  snapshot.rows.find((row) => row.purchase === unknown)?.route,
  "Not confirmed",
);
assert.equal(
  snapshot.rows.find((row) => row.purchase === waiting)?.status,
  "Needs approval",
);
assert.ok(!JSON.stringify(snapshot).includes("private@example.test"));
assert.ok(!JSON.stringify(snapshot).includes("PRIVATE AI REASON"));
assert.ok(!JSON.stringify(snapshot).includes("PRIVATE UNKNOWN PAYLOAD"));
assert.ok(!JSON.stringify(snapshot).includes("private-hash"));
assert.equal(
  JSON.stringify(log),
  before,
  "projection preserves original records",
);
assert.equal(insightsSnapshot([], {}, now).summary.spentCents, 0);
assert.equal(insightsSnapshot([], {}, now).rows.length, 0);
assert.ok(
  describeInsightView(snapshot.rows, "blocked").includes(
    "Spending cap exceeded.",
  ),
);
assert.ok(
  describeInsightView(snapshot.rows, "blocked").includes(
    "not a total of settled payments",
  ),
);
assert.equal(
  InsightPromptSchema.safeParse({ prompt: "a".repeat(801) }).success,
  false,
);
assert.equal(
  InsightPromptSchema.safeParse({ prompt: "show pending", tools: ["pay"] })
    .success,
  false,
);
assert.equal(
  InsightPlanSchema.safeParse({ view: "pay", refused: false }).success,
  false,
);
// Tool execution boundary independent of any model: the runner exposes only local view selection.
let selected = "unchanged";
const api = {
  defineAiTool: (config: {
    name: string;
    description: string;
    execute: (
      args: { view: "pending" },
      ctx: AgAiToolContext,
    ) => Promise<unknown>;
  }): AgAiTool => ({
    name: config.name,
    description: config.description,
    kind: "client",
    schema: () => undefined,
    execute: async (call, ctx) =>
      config.execute(call.args as { view: "pending" }, ctx) as ReturnType<
        NonNullable<AgAiTool["execute"]>
      >,
  }),
};
const ports = {
  plan: async () => ({ view: "pending" as const, refused: false }),
  select: (view: string) => {
    selected = view;
  },
  rows: () => snapshot.rows,
};
const agent = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  ports,
);
const input = {
  threadId: "thread",
  runId: "run",
  messages: [
    { id: "user", role: "user" as const, content: "Show pending purchases" },
  ],
  tools: [],
  state: {},
  context: [],
  forwardedProps: {},
};
const ctx = {
  params: undefined,
  instructions: () => undefined,
  tools: () => agent.tools!({} as never, undefined),
};
const events: AgAiEvent[] = [];
for await (const event of agent.run(input, ctx)) events.push(event);
assert.equal(selected, "pending");
assert.deepEqual(
  ctx.tools().map((tool) => tool.name),
  ["show_purchases"],
);
assert.ok(
  events.some(
    (event) =>
      event.type === "TOOL_CALL_START" &&
      event.toolCallName === "show_purchases",
  ),
);
assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
selected = "unchanged";
const refused = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  { ...ports, plan: async () => ({ view: "all", refused: true }) },
);
const refusedEvents: AgAiEvent[] = [];
for await (const event of refused.run(
  {
    ...input,
    messages: [
      { id: "user", role: "user", content: "Approve and pay every purchase" },
    ],
  },
  { ...ctx, tools: () => refused.tools!({} as never, undefined) },
))
  refusedEvents.push(event);
assert.equal(selected, "unchanged");
assert.ok(!refusedEvents.some((event) => event.type === "TOOL_CALL_START"));
for (const file of [
  "app/routes/app.insights.tsx",
  "app/lib/insights/planner.server.ts",
  "app/lib/insights/agent.ts",
])
  assert.ok(
    !/appendAudit|executePurchase|approvePurchase|refreshPayouts|sweepPayPalOrders/.test(
      readFileSync(file, "utf8"),
    ),
    `${file} has no payment/audit command imports`,
  );
console.log(
  "PASS insights: settled/reserved/refund math, rolling-day reconciliation, simulation exclusion, empty data, redaction, schema limits, read-only agent tool and refused money actions.",
);

// Analysis plans cannot introduce arbitrary fields or write commands.
assert.equal(
  InsightPlanSchema.safeParse({
    view: "all",
    refused: false,
    analysis: "suppliers",
  }).success,
  true,
);
assert.equal(
  InsightPlanSchema.safeParse({
    view: "all",
    refused: false,
    analysis: "status",
  }).success,
  true,
);
assert.equal(
  InsightPlanSchema.safeParse({
    view: "all",
    refused: false,
    analysis: "execute_payment",
  }).success,
  false,
);
const { demoSnapshot } = await import("../app/lib/insights/demo");
const demo = demoSnapshot(now);
assert.equal(demo.rows.length, 64);
assert.equal(new Set(demo.rows.map((r) => r.supplier)).size, 4);
assert.ok(
  demo.rows.every(
    (r) => r.activityUrl === "" && r.route === "Demo · no payment",
  ),
);
assert.equal(
  demo.summary.spentCents,
  Math.round(demo.trend.reduce((s, r) => s + r.spent, 0) * 100),
);
assert.equal(
  demo.summary.reservedCents,
  Math.round(demo.rows.reduce((s, r) => s + r.reserved, 0) * 100),
);
let analysisSelected = "";
const analysisAgent = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  {
    ...ports,
    plan: async () => ({ view: "all", refused: false, analysis: "status" }),
    analyze: (value) => {
      analysisSelected = value;
    },
  },
);
for await (const event of analysisAgent.run(input, {
  ...ctx,
  tools: () => analysisAgent.tools!({} as never, undefined),
}))
  void event;
assert.equal(analysisSelected, "status");
console.log(
  "PASS analysis presets, strict plan boundary, demo isolation and reconciled fixture totals",
);
