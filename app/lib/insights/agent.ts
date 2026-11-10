import {
  createAiToolContext,
  type AgAiAgentRunner,
  type AgStudioApi,
} from "ag-studio";
import { InsightPlanSchema, type InsightPlan } from "./plan";
import {
  INSIGHT_VIEWS,
  describeInsightView,
  type InsightRow,
  type InsightView,
} from "./types";

export type InsightAgentPorts = {
  plan: (prompt: string, signal?: AbortSignal) => Promise<InsightPlan>;
  select: (view: InsightView) => void;
  rows: () => InsightRow[];
};
/** One view-selection tool, no built-in agent roster, no backend/business write capability. */
export function createInsightsAgent(
  api: Pick<AgStudioApi, "defineAiTool">,
  ports: InsightAgentPorts,
): AgAiAgentRunner {
  const show = () =>
    api.defineAiTool({
      name: "show_purchases",
      description:
        "Select a local read-only purchase view and summarize its proposal value; cannot pay, approve or edit rules.",
      params: (s) => s.object({ view: s.enum([...INSIGHT_VIEWS]) }),
      execute: async ({ view }, ctx) => {
        if (ctx.signal.aborted) return ctx.error("The request was cancelled.");
        ports.select(view);
        return ctx.success(describeInsightView(ports.rows(), view));
      },
    });
  return {
    id: "guardbuy-insights",
    name: "GuardBuy insights",
    description: "Explore recorded purchases without changing them.",
    tools: () => [show()],
    run: async function* (input, ctx) {
      const { threadId, runId } = input;
      yield { type: "RUN_STARTED", threadId, runId };
      try {
        const prompt =
          input.messages.filter((message) => message.role === "user").at(-1)
            ?.content ?? "";
        const plan = InsightPlanSchema.parse(
          await ports.plan(prompt, ctx.signal),
        );
        if (ctx.signal?.aborted) return;
        let answer =
          "I can only show all, pending, blocked, paid or attention-needed purchases. I cannot approve purchases, send payments or change rules.";
        if (!plan.refused) {
          const tool = ctx
            .tools()
            .find((candidate) => candidate.name === "show_purchases");
          if (!tool?.execute) throw new Error("View tool is unavailable.");
          const toolCallId = crypto.randomUUID();
          yield {
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: tool.name,
          };
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId,
            delta: JSON.stringify({ view: plan.view }),
          };
          yield { type: "TOOL_CALL_END", toolCallId };
          const result = await tool.execute(
            { toolCallId, name: tool.name, args: { view: plan.view } },
            createAiToolContext({
              signal: ctx.signal,
              run: { threadId, runId, agentId: "guardbuy-insights" },
            }),
          );
          answer = result.success
            ? result.response
            : "The view could not be opened. Use the purchase filters instead.";
          yield {
            type: "TOOL_CALL_RESULT",
            messageId: crypto.randomUUID(),
            toolCallId,
            content: answer,
            role: "tool",
          };
        }
        const messageId = crypto.randomUUID();
        yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
        yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: answer };
        yield { type: "TEXT_MESSAGE_END", messageId };
        yield { type: "RUN_FINISHED", threadId, runId };
      } catch {
        if (!ctx.signal?.aborted)
          yield {
            type: "RUN_ERROR",
            message:
              "Insights assistant is unavailable. Use the purchase filters or try again later.",
          };
      }
    },
  };
}
