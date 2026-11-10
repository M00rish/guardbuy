import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { modelChain } from "../agent/proposer.server";
import {
  InsightPlanSchema,
  INSIGHTS_INSTRUCTIONS,
  type InsightPlan,
} from "./plan";

export const insightsAiConfigured = () =>
  !!(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.OPENROUTER_API_KEY
  );
/** Only the user's short request goes to the provider; no audit data, payment IDs or tool credentials. */
export async function planInsightView(
  prompt: string,
  signal?: AbortSignal,
): Promise<InsightPlan> {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(25_000),
    ...(signal ? [signal] : []),
  ]);
  for (const entry of modelChain().slice(0, 2)) {
    const split = entry.indexOf(":"),
      provider = entry.slice(0, split),
      id = entry.slice(split + 1);
    if (
      (provider === "google" && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
      (provider === "openrouter" && !process.env.OPENROUTER_API_KEY)
    )
      continue;
    try {
      const model =
        provider === "openrouter"
          ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(id)
          : google(id);
      const { output } = await generateText({
        model,
        system: INSIGHTS_INSTRUCTIONS,
        prompt,
        output: Output.object({ schema: InsightPlanSchema }),
        temperature: 0,
        maxRetries: 0,
        abortSignal: deadline,
        maxOutputTokens: 512,
      });
      return InsightPlanSchema.parse(output);
    } catch {
      if (deadline.aborted) break;
    }
  }
  throw new Error(
    "Insights assistant is unavailable. Use the purchase filters or try again later.",
  );
}
