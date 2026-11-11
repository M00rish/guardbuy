import {
  createAiToolContext,
  type AgAiAgentRunner,
  type AgStudioApi,
} from "ag-studio";
import {
  InsightPlanSchema,
  type InsightPlan,
  type InsightAnalysis,
} from "./plan";
import { GuardQuerySchema, type GuardQuery } from "./query-schema";
import type { GuardQueryResult } from "./query";
import {
  INSIGHT_VIEWS,
  describeInsightView,
  inInsightView,
  type InsightRow,
  type InsightView,
} from "./types";

export const ASSISTANT_ERRORS = {
  rate_limit: "Please wait a few seconds before asking another question.",
  unavailable:
    "The GuardBuy assistant is unavailable. Use the grid filters or try again later.",
  timeout:
    "The question took too long. Try again or ask a more specific question.",
} as const;
export class AssistantRequestError extends Error {
  constructor(readonly kind: keyof typeof ASSISTANT_ERRORS) {
    super(ASSISTANT_ERRORS[kind]);
  }
}
export function safeAssistantError(message: string) {
  return Object.values(ASSISTANT_ERRORS).some((value) => value === message)
    ? message
    : ASSISTANT_ERRORS.unavailable;
}
export type InsightAgentPorts = {
  plan: (prompt: string, signal?: AbortSignal) => Promise<InsightPlan>;
  select: (view: InsightView) => void;
  analyze?: (analysis: InsightAnalysis) => void;
  rows: () => InsightRow[];
  query?: (query: GuardQuery) => GuardQueryResult;
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
      params: (s) =>
        s.object({
          view: s.enum([...INSIGHT_VIEWS]),
          analysis: s.enum(["purchases", "suppliers", "status"]),
        }),
      execute: async ({ view, analysis }, ctx) => {
        if (ctx.signal.aborted) return ctx.error("The request was cancelled.");
        ports.select(view);
        ports.analyze?.(
          InsightPlanSchema.parse({ view, analysis, refused: false })
            .analysis ?? "purchases",
        );
        const selected = ports.rows().filter((row) => inInsightView(row, view));
        const suppliers = new Map<string, number>();
        for (const row of selected)
          suppliers.set(
            row.supplier,
            (suppliers.get(row.supplier) ?? 0) + Math.round(row.settled * 100),
          );
        const ranking = [...suppliers]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(
            ([name, cents]) =>
              `${name}: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)} settled`,
          )
          .join("; ");
        return ctx.success(
          `${analysis === "suppliers" ? "Supplier comparison opened: expand a supplier to explore its products. " : analysis === "status" ? "Supplier-by-status pivot opened. Proposal value, settled spend and reserved funds are shown separately. " : ""}${describeInsightView(ports.rows(), view)}${analysis === "suppliers" && ranking ? ` Leading suppliers in the selected date range: ${ranking}.` : ""}`,
        );
      },
    });
  const queryTool = () =>
    api.defineAiTool({
      name: "query_guardbuy",
      description:
        "Calculate a bounded read-only answer from the loaded GuardBuy snapshot and show the supporting grid records.",
      params: (s) => s.object({ query: s.string() }),
      execute: async ({ query }, ctx) => {
        if (ctx.signal.aborted) return ctx.error("The request was cancelled.");
        if (query.length > 4096) return ctx.error("The query is too large.");
        const validated = GuardQuerySchema.parse(JSON.parse(query));
        if (!ports.query) return ctx.error("Workspace data is unavailable.");
        return ctx.success(ports.query(validated).answer);
      },
    });
  return {
    id: "guardbuy-insights",
    name: "GuardBuy insights",
    description:
      "Answer GuardBuy questions and show supporting records without changing business data.",
    tools: () => [show(), ...(ports.query ? [queryTool()] : [])],
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
          plan.reason === "write"
            ? "I can explain and analyze GuardBuy data, but I cannot approve purchases, send payments or change rules."
            : plan.reason === "clarify"
              ? `I need one detail before choosing the data: ${plan.clarification || "Which product, purchase or metric do you mean?"}`
              : `I cannot answer that from the available GuardBuy snapshot yet.${plan.clarification ? ` ${plan.clarification}` : " Ask about products, stock, purchases, suppliers, budgets or recorded activity."}`;
        if (!plan.refused) {
          const tool = ctx
            .tools()
            .find(
              (candidate) =>
                candidate.name ===
                (plan.query ? "query_guardbuy" : "show_purchases"),
            );
          if (!tool?.execute) throw new Error("View tool is unavailable.");
          const toolCallId = crypto.randomUUID();
          yield {
            type: "TOOL_CALL_START",
            toolCallId,
            toolCallName: tool.name,
          };
          const args = plan.query
            ? { query: JSON.stringify(plan.query) }
            : { view: plan.view, analysis: plan.analysis ?? "purchases" };
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId,
            delta: JSON.stringify(args),
          };
          yield { type: "TOOL_CALL_END", toolCallId };
          const result = await tool.execute(
            {
              toolCallId,
              name: tool.name,
              args,
            },
            createAiToolContext({
              signal: ctx.signal,
              run: { threadId, runId, agentId: "guardbuy-insights" },
            }),
          );
          answer = result.success
            ? result.response
            : "The question could not be answered. Try a different metric or use the grid filters.";
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
      } catch (error) {
        if (!ctx.signal?.aborted)
          yield {
            type: "RUN_ERROR",
            message:
              error instanceof AssistantRequestError
                ? error.message
                : error instanceof DOMException && error.name === "TimeoutError"
                  ? ASSISTANT_ERRORS.timeout
                  : ASSISTANT_ERRORS.unavailable,
          };
      }
    },
  };
}
