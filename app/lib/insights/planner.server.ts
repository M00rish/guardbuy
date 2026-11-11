import { commonInsightPlan } from "./common-plan";
import { awaitWithSignal } from "./await-signal";
import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { randomUUID } from "node:crypto";
import { modelChain } from "../agent/proposer.server";
import {
  classifyPlannerFailure,
  PlannerFailure,
  type PlannerAttempt,
} from "./failure.server";
import type { AssistantFailureKind } from "./errors";
import {
  InsightPlanSchema,
  INSIGHTS_INSTRUCTIONS,
  type InsightPlan,
} from "./plan";

/** Default advanced-query fallbacks cross provider boundaries; explicit overrides are authoritative. */
export function insightModelCandidates(
  candidates = modelChain(),
  explicit = !!process.env.GUARDBUY_LLM_MODELS,
): string[] {
  if (explicit || candidates.some((entry) => entry.startsWith("google:")))
    return candidates.slice(0, 4);
  return [candidates[0], "google:gemini-3.8-flash", ...candidates.slice(1)]
    .filter((entry): entry is string => !!entry)
    .slice(0, 4);
}
export const insightsAiConfigured = () =>
  insightModelCandidates().some((entry) =>
    entry.startsWith("openrouter:")
      ? !!process.env.OPENROUTER_API_KEY
      : !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  );
/** Only the user's short request goes to the provider; no audit data, payment IDs or tool credentials. */
export async function planInsightView(
  prompt: string,
  signal?: AbortSignal,
): Promise<InsightPlan> {
  if (signal?.aborted) throw signal.reason;
  const common = commonInsightPlan(prompt);
  if (common) return common;
  const requestId = randomUUID();
  const failures: AssistantFailureKind[] = [];
  const attempts: PlannerAttempt[] = [];
  let attempted = 0;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(25_000),
    ...(signal ? [signal] : []),
  ]);
  // A slow/unavailable free model must leave time for the remaining providers.
  // Keep the whole request bounded while allowing the fourth configured fallback.
  for (const entry of insightModelCandidates()) {
    if (deadline.aborted) break;
    const split = entry.indexOf(":"),
      provider = entry.slice(0, split),
      id = entry.slice(split + 1);
    if (
      (provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
      (provider === "openrouter" && !process.env.OPENROUTER_API_KEY)
    )
      continue;
    try {
      attempted++;
      const model =
        provider === "openrouter"
          ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(id)
          : google(id);
      const attemptDeadline = AbortSignal.any([
        deadline,
        AbortSignal.timeout(8_000),
      ]);
      const { output } = await awaitWithSignal(
        generateText({
          model,
          system: INSIGHTS_INSTRUCTIONS,
          prompt,
          output: Output.object({ schema: InsightPlanSchema }),
          temperature: 0,
          maxRetries: 0,
          abortSignal: attemptDeadline,
          // Reasoning models spend part of this budget before producing the JSON.
          maxOutputTokens: 2048,
        }),
        attemptDeadline,
      );
      return InsightPlanSchema.parse(output);
    } catch (error) {
      if (signal?.aborted) throw error;
      const kind = deadline.aborted ? "timeout" : classifyPlannerFailure(error);
      failures.push(kind);
      const status =
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        typeof error.statusCode === "number" &&
        Number.isInteger(error.statusCode) &&
        error.statusCode >= 100 &&
        error.statusCode <= 599
          ? error.statusCode
          : undefined;
      const attempt: PlannerAttempt = {
        provider: provider === "openrouter" ? "openrouter" : "google",
        code: kind,
        ...(status ? { status } : {}),
      };
      attempts.push(attempt);
      console.warn(
        JSON.stringify({
          event: "insights.planner.failure",
          requestId,
          attempt: attempted,
          provider,
          code: kind,
          status,
        }),
      );
      if (deadline.aborted) break;
    }
  }
  const kind =
    attempted === 0 && !deadline.aborted
      ? "configuration"
      : deadline.aborted
        ? "timeout"
        : failures.length &&
            failures.every((code) => ["timeout", "service"].includes(code)) &&
            failures.includes("service")
          ? "service"
          : failures.length && failures.every((code) => code === failures[0])
            ? failures[0]
            : "unavailable";
  const failure = new PlannerFailure(kind, requestId, attempts);
  console.warn(
    JSON.stringify({
      event: "insights.planner.exhausted",
      requestId,
      attempted,
      code: kind,
    }),
  );
  throw failure;
}
