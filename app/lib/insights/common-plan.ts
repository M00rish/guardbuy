import {
  InsightPlanSchema,
  InsightPromptSchema,
  type InsightPlan,
} from "./plan";
import type { GuardQuery } from "./query-schema";
/** Conservative whole-question intents. Never discard an unrecognised condition or time range. */
export function commonInsightPlan(
  prompt: string,
  context?: { reorderBelowDays?: number },
): InsightPlan | undefined {
  const parsed = InsightPromptSchema.safeParse({ prompt });
  if (!parsed.success) return;
  const q = parsed.data.prompt
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/, "")
    .replace(/^(?:please |can you |could you )/, "")
    .trim();
  const plan = (query: GuardQuery) =>
    InsightPlanSchema.parse({ view: "all", refused: false, query });
  if (
    /^(?:how many (?:configured )?suppliers(?: do i have| are there| are configured| are in (?:guardbuy|my store))?|(?:count|number of) (?:my |the |configured )?suppliers)$/.test(
      q,
    )
  )
    return plan({ source: "supplierDirectory", operation: "count" });
  if (
    /^(?:(?:show|list) (?:my |all |the |configured )?suppliers|who are my suppliers|what suppliers do i have)$/.test(
      q,
    )
  )
    return plan({ source: "supplierDirectory", operation: "list", limit: 20 });
  if (
    /^(?:how many (?:products|product variants)(?: do i have| are there)?|(?:count|number of) (?:my )?(?:products|product variants))$/.test(
      q,
    )
  )
    return plan({ source: "products", operation: "count" });
  const summaries: [RegExp, GuardQuery["metric"]][] = [
    [
      /^(?:(?:what is|what's|show) (?:my |the )?)?remaining budget$|^how much (?:budget|spending budget) (?:do i have left|is left)$|^how much can i still spend$/,
      "remainingCents",
    ],
    [
      /^(?:(?:what is|what's|show) (?:my |the )?)?(?:paypal balance|paypal balance after commitments)$/,
      "balanceCents",
    ],
    [
      /^(?:how much have i spent(?: in the last 7 days)?|(?:show|what is) (?:my )?(?:spending|spend) (?:over|in) the last 7 days)$/,
      "spentCents",
    ],
    [
      /^(?:(?:what is|what's|show) (?:my |the )?)?(?:spending cap|7-day spending cap)$/,
      "capCents",
    ],
    [
      /^(?:how much is reserved|(?:show|what are) (?:my |the )?(?:current )?reservations|reserved funds)$/,
      "reservedCents",
    ],
  ];
  for (const [pattern, metric] of summaries)
    if (pattern.test(q))
      return plan({ source: "summary", operation: "list", metric });
  const rank = q.match(
    /^(?:rank|sort) (?:my )?products by (auto(?:matic)? restock (?:times|count|frequency)|paid (?:purchase|restock) count|stock|days of cover)(?: in the last (\d{1,3}) days)?$/,
  );
  if (rank) {
    const metric = rank[1].startsWith("auto")
      ? "automaticRestocks"
      : rank[1].startsWith("paid")
        ? "paidRestocks"
        : rank[1] === "stock"
          ? "stock"
          : "cover";
    const days = rank[2] ? Number(rank[2]) : undefined;
    if (days !== undefined && (days < 1 || days > 365)) return;
    return plan({
      source: "products",
      operation: "rank",
      metric,
      direction: ["cover", "stock"].includes(metric) ? "asc" : "desc",
      ...(days ? { days } : {}),
    });
  }
  if (
    /^(?:which products (?:may|will) run out soon|which products (?:are low on stock|need restocking)|show (?:low stock|at-risk) products)$/.test(
      q,
    )
  ) {
    if (!context) return;
    if (context.reorderBelowDays === undefined)
      return {
        view: "all",
        refused: true,
        reason: "unsupported",
        clarification:
          "The signed restock threshold is unavailable in this snapshot. Open your rules to review it.",
      };
    return plan({
      source: "products",
      operation: "rank",
      metric: "cover",
      direction: "asc",
      match: "any",
      where: [
        { field: "cover", op: "lt", value: context.reorderBelowDays },
        { field: "stock", op: "lte", value: 0 },
      ],
    });
  }
  if (
    /^(?:compare|rank) suppliers by (?:settled spend|spending|activity|purchase count)$/.test(
      q,
    )
  )
    return plan({
      source: "suppliers",
      operation: "rank",
      metric: /activity|purchase count/.test(q) ? "purchaseCount" : "settled",
      direction: "desc",
    });
  const purchase = q.match(
    /^(?:why (?:was|is)|explain) purchase #?(\d+)(?: (?:blocked|declined|pending))?$/,
  );
  if (purchase && Number.isSafeInteger(Number(purchase[1])))
    return plan({
      source: "purchases",
      operation: "explain",
      where: [{ field: "purchase", op: "eq", value: Number(purchase[1]) }],
    });
  const current = q.match(
    /^(?:(?:show|list) (?:my |the )?|how many )(?:(?:purchases|payments) (?:are )?)?(pending payments|uncertain payments|approvals waiting|purchases needing approval)(?: (?:are there|do i have))?$/,
  );
  if (current) {
    const lane =
      current[1] === "pending payments"
        ? "pending"
        : current[1] === "uncertain payments"
          ? "uncertain"
          : "approval";
    return plan({
      source: "purchases",
      operation: q.startsWith("how many") ? "count" : "list",
      where: [{ field: "attentionState", op: "eq", value: lane }],
    });
  }
  if (/^(?:what needs (?:my )?attention|show outstanding purchases)$/.test(q))
    return plan({
      source: "purchases",
      operation: "list",
      match: "any",
      where: ["approval", "pending", "uncertain", "failed", "blocked"].map(
        (value) => ({ field: "attentionState", op: "eq", value }),
      ),
    });
  if (/^(?:show|list) (?:my |the )?(?:spending )?rules$/.test(q))
    return plan({
      source: "details",
      operation: "list",
      where: [{ field: "category", op: "contains", value: "rules" }],
    });
  if (/^(?:show|list) (?:my |the )?(?:recent |latest )?activity$/.test(q))
    return plan({ source: "activity", operation: "list", limit: 20 });
  if (
    /^(?:how (?:do|does) (?:automatic )?restocks? work|how does guardbuy restock products)$/.test(
      q,
    )
  )
    return plan({ source: "help", operation: "explain", topic: "restocks" });
  if (/^(?:what can you do|how does (?:the |this )?assistant work)$/.test(q))
    return plan({ source: "help", operation: "explain", topic: "assistant" });
  if (
    /^(?:approve|pay|refund|decline) (?:all |every |the )?(?:purchases?|payments?)(?: now)?$/.test(
      q,
    )
  )
    return { view: "all", refused: true, reason: "write" };
  if (/^(?:which product has the highest profit|what is my profit)$/.test(q))
    return {
      view: "all",
      refused: true,
      reason: "unsupported",
      clarification: "Profit is not available in this snapshot.",
    };
}
