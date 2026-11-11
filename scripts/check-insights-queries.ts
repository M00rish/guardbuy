import assert from "node:assert/strict";
import { GuardQuerySchema } from "../app/lib/insights/query-schema";
import { runGuardQuery } from "../app/lib/insights/query";
import { InsightPlanSchema } from "../app/lib/insights/plan";
import { createInsightsAgent } from "../app/lib/insights/agent";
import { demoSnapshot } from "../app/lib/insights/demo";
import { demoWorkspace } from "../app/lib/insights/workspace";
import type { InsightRow } from "../app/lib/insights/types";
import type { AgAiEvent, AgAiTool } from "ag-studio";
const snapshot = demoSnapshot(new Date("2026-11-11T12:00:00Z"));
const workspace = demoWorkspace(snapshot);
workspace.products = [
  {
    ...workspace.products![0],
    variantId: "a",
    title: "Same name",
    stock: 2,
    cover: 1,
  },
  {
    ...workspace.products![1],
    variantId: "b",
    title: "Same name",
    stock: 10,
    cover: null,
  },
  {
    ...workspace.products![2],
    variantId: "c",
    title: "Other product",
    stock: 4,
    cover: 2,
  },
];
const row = (purchase: number, overrides: Partial<InsightRow>): InsightRow => ({
  ...snapshot.rows[0],
  purchase,
  variantId: "a",
  proposedAt: "2026-11-01T00:00:00Z",
  settledAt: "2026-11-10T00:00:00Z",
  settled: 10,
  reserved: 0,
  automatic: true,
  ...overrides,
});
snapshot.rows = [
  row(1, {}),
  row(2, { automatic: false }),
  row(3, { settled: 0, status: "Payment pending", reserved: 5 }),
  row(4, { settled: 0, status: "Returned" }),
  row(5, { settled: 2, status: "Partially refunded" }),
  row(6, { variantId: "b", automatic: false, settled: 20 }),
  row(7, { variantId: undefined, product: "Same name" }),
];
const data = { snapshot, workspace },
  before = JSON.stringify(data);
const automatic = runGuardQuery(
  { source: "products", operation: "rank", metric: "automaticRestocks" },
  data,
);
assert.equal(automatic.products![0].variantId, "a");
assert.equal(automatic.products![0].automaticRestocks, 2);
assert.equal(automatic.products![0].paidRestocks, 3);
assert.equal(automatic.products![1].automaticRestocks, 0);
assert.match(automatic.answer, /not physical stock receipts/);
assert.match(automatic.answer, /exact variant IDs/);
assert.equal(automatic.grid!.sort!.field, "automaticRestocks");
const recent = runGuardQuery(
  {
    source: "products",
    operation: "rank",
    metric: "automaticRestocks",
    days: 7,
  },
  data,
);
assert.equal(
  recent.products![0].automaticRestocks,
  2,
  "use settlement time, not older proposal time",
);
const risk = runGuardQuery(
  {
    source: "products",
    operation: "rank",
    metric: "cover",
    direction: "asc",
    where: [{ field: "cover", op: "lt", value: 3 }],
  },
  data,
);
assert.deepEqual(
  risk.products!.map((product) => product.variantId),
  ["a", "c"],
);
const spend = runGuardQuery(
  { source: "purchases", operation: "sum", metric: "settled" },
  data,
);
assert.match(spend.answer, /\$52\.00/);
const unknownBalance = runGuardQuery(
  { source: "summary", operation: "list", metric: "balanceCents" },
  data,
);
assert.match(unknownBalance.answer, /Unavailable/);
assert.equal(unknownBalance.grid?.view, "details");
assert.equal(
  runGuardQuery(
    { source: "summary", operation: "list", metric: "balanceCents", days: 30 },
    data,
  ).grid,
  undefined,
);
assert.equal(
  runGuardQuery(
    { source: "products", operation: "list", metric: "stock", days: 30 },
    data,
  ).grid,
  undefined,
);
assert.equal(
  runGuardQuery(
    { source: "products", operation: "rank", metric: "stock" },
    { snapshot, workspace: { ...workspace, products: null } },
  ).grid,
  undefined,
);
const explain = runGuardQuery(
  {
    source: "purchases",
    operation: "explain",
    where: [{ field: "purchase", op: "eq", value: 3 }],
  },
  data,
);
assert.equal(explain.grid?.expandPurchase, 3);
assert.match(explain.answer, /Payment pending/);
const missing = runGuardQuery(
  {
    source: "products",
    operation: "list",
    where: [{ field: "title", op: "contains", value: "not in store" }],
  },
  data,
);
assert.equal(missing.products!.length, 0);
assert.match(missing.answer, /No matching records/);
assert.equal(
  JSON.stringify(data),
  before,
  "queries never mutate the source snapshot",
);
for (const invalid of [
  { source: "products", operation: "delete" },
  { source: "products", operation: "rank", metric: "sql" },
  { source: "products", operation: "rank", metric: "stock", limit: 999 },
  { source: "products", operation: "sum", metric: "cover" },
  {
    source: "purchases",
    operation: "list",
    where: [{ field: "stock", op: "gt", value: 0 }],
  },
  {
    source: "summary",
    operation: "list",
    metric: "capCents",
    where: [{ field: "capCents", op: "gt", value: 100 }],
  },
  { source: "products", operation: "list", code: "fetch('/payments')" },
])
  assert.equal(GuardQuerySchema.safeParse(invalid).success, false);
assert.equal(
  InsightPlanSchema.safeParse({
    view: "all",
    refused: false,
    query: {
      source: "products",
      operation: "rank",
      metric: "automaticRestocks",
    },
  }).success,
  true,
);
// Run the real agent against an explicit tool adapter: schema, tool selection and refusal.
let calls = 0;
const api = {
  defineAiTool: (config: {
    name: string;
    description: string;
    execute: (args: never, ctx: unknown) => Promise<unknown>;
  }): AgAiTool => ({
    name: config.name,
    description: config.description,
    kind: "client",
    schema: () => undefined,
    execute: async (call, ctx) =>
      config.execute(call.args as never, ctx) as ReturnType<
        NonNullable<AgAiTool["execute"]>
      >,
  }),
};
const ports = {
  rows: () => snapshot.rows,
  select: () => {},
  query: (query: Parameters<typeof runGuardQuery>[0]) => {
    calls++;
    return runGuardQuery(query, data);
  },
  plan: async () => ({
    view: "all" as const,
    refused: false,
    query: {
      source: "products" as const,
      operation: "rank" as const,
      metric: "automaticRestocks" as const,
    },
  }),
};
const agent = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  ports,
);
const input = {
  threadId: "q",
  runId: "q",
  messages: [
    {
      id: "u",
      role: "user" as const,
      content: "rank products by auto restock times",
    },
  ],
  tools: [],
  state: {},
  context: [],
  forwardedProps: {},
};
const events: AgAiEvent[] = [];
for await (const event of agent.run(input, {
  params: undefined,
  instructions: () => undefined,
  tools: () => agent.tools!({} as never, undefined),
}))
  events.push(event);
assert.equal(calls, 1);
assert.ok(
  events.some(
    (event) =>
      event.type === "TOOL_CALL_START" &&
      event.toolCallName === "query_guardbuy",
  ),
);
assert.ok(
  events.some(
    (event) =>
      event.type === "TEXT_MESSAGE_CONTENT" &&
      event.delta.includes("automatic paid purchases"),
  ),
);
const refused = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  {
    ...ports,
    plan: async () => ({ view: "all", refused: true, reason: "write" }),
  },
);
for await (const event of refused.run(input, {
  params: undefined,
  instructions: () => undefined,
  tools: () => refused.tools!({} as never, undefined),
}))
  assert.notEqual(event.type, "TOOL_CALL_START");
assert.equal(calls, 1);
console.log(
  "PASS GuardBuy queries: exact-ID automatic/approved/pending/refund counts, settlement dates, stock risk, financial scopes, missing data, strict schema, no mutation and read-only agent execution/refusal",
);

const settledCount = runGuardQuery(
  {
    source: "purchases",
    operation: "count",
    days: 7,
    dateBasis: "settled",
    where: [
      { field: "automatic", op: "eq", value: true },
      { field: "settled", op: "gt", value: 0 },
    ],
  },
  data,
);
assert.match(settledCount.answer, /3 matching purchases/); // includes the unlinked historical purchase
const alternatives = runGuardQuery(
  {
    source: "purchases",
    operation: "count",
    match: "any",
    where: [
      { field: "status", op: "contains", value: "pending" },
      { field: "status", op: "contains", value: "returned" },
    ],
  },
  data,
);
assert.match(alternatives.answer, /2 matching purchases/);
console.log("PASS settlement-basis counts and bounded OR conditions");
const { AssistantRequestError, safeAssistantError } =
  await import("../app/lib/insights/agent");
const unavailableAgent = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  {
    ...ports,
    plan: async () => ({
      view: "all",
      refused: true,
      reason: "unsupported",
      clarification: "Profit data is not available.",
    }),
  },
);
const unavailableEvents: AgAiEvent[] = [];
for await (const event of unavailableAgent.run(input, {
  params: undefined,
  instructions: () => undefined,
  tools: () => unavailableAgent.tools!({} as never, undefined),
}))
  unavailableEvents.push(event);
assert.ok(
  unavailableEvents.some(
    (event) =>
      event.type === "TEXT_MESSAGE_CONTENT" &&
      event.delta.includes("Profit data is not available"),
  ),
);
assert.ok(!unavailableEvents.some((event) => event.type === "TOOL_CALL_START"));
const rateAgent = createInsightsAgent(
  api as Parameters<typeof createInsightsAgent>[0],
  {
    ...ports,
    plan: async () => {
      throw new AssistantRequestError("rate_limit");
    },
  },
);
const rateEvents: AgAiEvent[] = [];
for await (const event of rateAgent.run(input, {
  params: undefined,
  instructions: () => undefined,
  tools: () => rateAgent.tools!({} as never, undefined),
}))
  rateEvents.push(event);
assert.ok(
  rateEvents.some(
    (event) =>
      event.type === "RUN_ERROR" &&
      event.message.includes("wait a few seconds"),
  ),
);
assert.ok(
  !safeAssistantError("provider secret token=example").includes("secret"),
);
const controller = new AbortController();
controller.abort();
for await (const event of agent.run(input, {
  params: undefined,
  signal: controller.signal,
  instructions: () => undefined,
  tools: () => agent.tools!({} as never, undefined),
}))
  assert.notEqual(event.type, "TOOL_CALL_START");
assert.equal(
  calls,
  1,
  "refusal, missing data, rate limits and cancellation cannot execute a query",
);
console.log(
  "PASS unsupported-data wording, safe rate-limit errors and cancellation before grid updates",
);
