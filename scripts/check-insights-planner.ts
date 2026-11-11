// Exercise the production planner with explicit model responses, never provider traffic.
import assert from "node:assert/strict";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { InsightPlanSchema } from "../app/lib/insights/plan";
import {
  classifyPlannerFailure,
  plannerFailureResponse,
  PlannerFailure,
} from "../app/lib/insights/failure.server";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise actual SDK serialization and parsing, with explicit HTTP responses.
// No provider credentials or traffic; provider transports are injected here only.
const plan = {
  view: "all",
  refused: false,
  query: {
    source: "products",
    operation: "rank",
    metric: "automaticRestocks",
    direction: "desc",
  },
};
let transportCalls = 0;
for (const provider of ["google", "openrouter"]) {
  const fetchFixture: typeof fetch = async (_url, init) => {
    transportCalls++;
    const body = JSON.parse(String(init?.body));
    assert.ok(
      provider === "google"
        ? body.generationConfig.responseJsonSchema ||
            body.generationConfig.responseSchema
        : body.response_format?.json_schema,
      "SDK sends structured output schema",
    );
    return Response.json(
      provider === "google"
        ? {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: JSON.stringify(plan) }],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 30,
              totalTokenCount: 40,
            },
          }
        : {
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(plan) },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 30,
              total_tokens: 40,
            },
          },
    );
  };
  const model =
    provider === "google"
      ? createGoogleGenerativeAI({ apiKey: "offline", fetch: fetchFixture })(
          "fixture",
        )
      : createOpenRouter({ apiKey: "offline", fetch: fetchFixture })("fixture");
  const result = await generateText({
    model,
    prompt: "rank products by restock times",
    output: Output.object({ schema: InsightPlanSchema }),
    maxRetries: 0,
  });
  assert.deepEqual(result.output, plan);
}
assert.equal(transportCalls, 2);
for (const [status, expected] of [
  [401, "credentials"],
  [429, "quota"],
  [404, "model"],
] as const) {
  const model = createOpenRouter({
    apiKey: "offline",
    fetch: async () =>
      Response.json(
        { error: { message: "private provider body", code: status } },
        { status },
      ),
  })("fixture");
  await assert.rejects(
    generateText({
      model,
      prompt: "question",
      output: Output.object({ schema: InsightPlanSchema }),
      maxRetries: 0,
    }),
    (error: unknown) => classifyPlannerFailure(error) === expected,
  );
}

assert.equal(classifyPlannerFailure({ statusCode: 401 }), "credentials");
assert.equal(classifyPlannerFailure({ statusCode: 429 }), "quota");
assert.equal(classifyPlannerFailure({ statusCode: 404 }), "model");
assert.equal(classifyPlannerFailure({ name: "TimeoutError" }), "timeout");
assert.equal(
  classifyPlannerFailure({ name: "AI_NoOutputGeneratedError" }),
  "response",
);
const safe = plannerFailureResponse(new Error("private provider body"));
assert.equal(safe.code, "unavailable");
assert.match(safe.requestId, /^[a-f0-9-]{36}$/);
assert.ok(!JSON.stringify(safe).includes("private"));
assert.equal(plannerFailureResponse(new PlannerFailure("quota")).code, "quota");

const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(resolve(root, "node_modules/.insights-planner-"));
const prior = {
  google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  router: process.env.OPENROUTER_API_KEY,
};
type Call = {
  model: string;
  prompt: string;
  system: string;
  maxOutputTokens: number;
  signal: AbortSignal;
};
const fixture = globalThis as typeof globalThis & {
  __plannerModels?: string[];
  __plannerCalls?: Call[];
  __plannerGenerate?: (call: Call) => Promise<unknown>;
};
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (entry: unknown) => warnings.push(String(entry));
try {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "offline-google";
  process.env.OPENROUTER_API_KEY = "offline-router";
  fixture.__plannerModels = [
    "google:overloaded",
    "openrouter:empty",
    "openrouter:retired",
    "google:healthy",
  ];
  fixture.__plannerCalls = [];
  await build({
    stdin: {
      contents:
        "export {planInsightView} from './app/lib/insights/planner.server';",
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: resolve(work, "planner.mjs"),
    plugins: [
      {
        name: "explicit-planner-provider-responses",
        setup(b) {
          b.onResolve(
            {
              filter:
                /^(ai|@ai-sdk\/google|@openrouter\/ai-sdk-provider)$|agent\/proposer.server$/,
            },
            ({ path }) => ({ path, namespace: "fixture" }),
          );
          b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            loader: "js",
            contents:
              path === "ai"
                ? `export const Output={object:()=>({})}; export async function generateText(o){const c={model:o.model,prompt:o.prompt,system:o.system,maxOutputTokens:o.maxOutputTokens,signal:o.abortSignal};globalThis.__plannerCalls.push(c);return globalThis.__plannerGenerate(c)}`
                : path === "@ai-sdk/google"
                  ? `export const google=id=>'google:'+id`
                  : path === "@openrouter/ai-sdk-provider"
                    ? `export const createOpenRouter=()=>id=>'openrouter:'+id`
                    : `export const modelChain=()=>globalThis.__plannerModels`,
          }));
        },
      },
    ],
  });
  const { planInsightView } = await import(
    pathToFileURL(resolve(work, "planner.mjs")).href
  );
  // Hosted failure: first two candidates fail, third retired, fourth is healthy.
  fixture.__plannerGenerate = async ({ model }) => {
    if (model === "google:overloaded") throw new Error("503 high demand");
    if (model === "openrouter:empty") throw new Error("No output generated");
    if (model === "openrouter:retired") throw new Error("404 retired model");
    return { output: { view: "pending", refused: false } };
  };
  assert.deepEqual(await planInsightView("Show pending purchases"), {
    view: "pending",
    refused: false,
  });
  assert.equal(
    fixture.__plannerCalls.length,
    4,
    "healthy fourth fallback remains reachable",
  );
  assert.ok(
    fixture.__plannerCalls.every((c) => c.maxOutputTokens >= 2048),
    "reasoning must not exhaust the old 512-token budget",
  );
  assert.ok(
    fixture.__plannerCalls.every((c) => c.prompt === "Show pending purchases"),
    "only the bounded user request is sent",
  );

  // A stalled first provider cannot monopolize the overall request deadline.
  fixture.__plannerModels = ["google:stalled", "google:healthy"];
  fixture.__plannerCalls = [];
  fixture.__plannerGenerate = async ({ model, signal }) => {
    if (model.endsWith("stalled"))
      await new Promise((_, reject) => {
        const keepAlive = setTimeout(
          () => reject(new Error("fallback never reached")),
          10_000,
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    return { output: { view: "paid", refused: false } };
  };
  const start = Date.now();
  assert.deepEqual(await planInsightView("Show paid purchases"), {
    view: "paid",
    refused: false,
  });
  assert.ok(
    Date.now() - start < 9_000,
    "per-model timeout leaves time for a healthy provider",
  );
  assert.equal(fixture.__plannerCalls.length, 2);

  // Schema validation still rejects invented write tools/fields and falls back.
  fixture.__plannerModels = ["google:invalid", "google:healthy"];
  fixture.__plannerGenerate = async ({ model }) => ({
    output: model.endsWith("invalid")
      ? { view: "pay", refused: false, tool: "approve" }
      : { view: "all", refused: true },
  });
  assert.deepEqual(await planInsightView("Approve purchases"), {
    view: "all",
    refused: true,
  });
  const controller = new AbortController();
  controller.abort();
  fixture.__plannerCalls = [];
  await assert.rejects(
    planInsightView("Show paid purchases", controller.signal),
    (error: unknown) =>
      error instanceof Error && "kind" in error && error.kind === "timeout",
  );
  assert.equal(
    fixture.__plannerCalls.length,
    0,
    "cancelled requests never start another provider call",
  );
  fixture.__plannerGenerate = async () => {
    throw new Error("private provider body");
  };
  await assert.rejects(
    planInsightView("Show paid purchases"),
    (e) =>
      e instanceof Error &&
      e.message.includes("unavailable") &&
      !e.message.includes("private"),
  );
  for (const [statusCode, kind] of [
    [401, "credentials"],
    [429, "quota"],
    [404, "model"],
  ] as const) {
    fixture.__plannerGenerate = async () => {
      throw Object.assign(new Error("private provider body"), { statusCode });
    };
    await assert.rejects(
      planInsightView("rank products by restock times"),
      (error: unknown) =>
        error instanceof Error &&
        "kind" in error &&
        error.kind === kind &&
        !error.message.includes("private"),
    );
  }
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  fixture.__plannerCalls = [];
  await assert.rejects(
    planInsightView("latest restock"),
    (error: unknown) =>
      error instanceof Error &&
      "kind" in error &&
      error.kind === "configuration",
  );
  assert.equal(fixture.__plannerCalls.length, 0);
  assert.ok(warnings.length > 0);
  assert.ok(
    warnings.every(
      (entry) =>
        !entry.includes("private") &&
        !entry.includes("restock times") &&
        !entry.includes("offline-"),
    ),
  );
  console.log(
    "PASS Insights planner: fourth fallback, bounded timeout, reasoning budget, strict output, cancellation and sanitized failure",
  );
} finally {
  console.warn = originalWarn;
  for (const [key, value] of [
    ["GOOGLE_GENERATIVE_AI_API_KEY", prior.google],
    ["OPENROUTER_API_KEY", prior.router],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
  delete fixture.__plannerModels;
  delete fixture.__plannerCalls;
  delete fixture.__plannerGenerate;
  await rm(work, { recursive: true, force: true });
}
