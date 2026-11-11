import { z } from "zod";
export const QUERY_METRICS = [
  "automaticRestocks",
  "paidRestocks",
  "purchaseCount",
  "stock",
  "incoming",
  "cover",
  "amount",
  "settled",
  "reserved",
  "blocked",
  "spentCents",
  "reservedCents",
  "remainingCents",
  "balanceCents",
  "capCents",
  "blockedCents",
  "overCents",
  "waiting",
  "blockedCount",
] as const;
export const QUERY_FIELDS = [
  ...QUERY_METRICS,
  "title",
  "product",
  "supplier",
  "status",
  "managed",
  "automatic",
  "purchase",
  "attentionState",
  "id",
  "kind",
  "category",
  "setting",
  "value",
] as const;
const fields = {
  products: [
    "title",
    "supplier",
    "status",
    "managed",
    "stock",
    "incoming",
    "cover",
    "automaticRestocks",
    "paidRestocks",
    "purchaseCount",
    "amount",
    "settled",
    "reserved",
    "blocked",
  ],
  purchases: [
    "product",
    "supplier",
    "status",
    "purchase",
    "attentionState",
    "automatic",
    "amount",
    "settled",
    "reserved",
    "blocked",
  ],
  supplierDirectory: ["supplier", "id"],
  suppliers: [
    "supplier",
    "automaticRestocks",
    "paidRestocks",
    "purchaseCount",
    "amount",
    "settled",
    "reserved",
    "blocked",
  ],
  summary: [
    "spentCents",
    "reservedCents",
    "remainingCents",
    "balanceCents",
    "capCents",
    "blockedCents",
    "overCents",
    "waiting",
    "blockedCount",
  ],
  details: ["category", "setting", "value"],
  activity: ["kind", "title"],
  help: [],
} satisfies Record<string, readonly string[]>;
export const GuardQuerySchema = z
  .object({
    source: z.enum([
      "products",
      "purchases",
      "suppliers",
      "supplierDirectory",
      "summary",
      "details",
      "activity",
      "help",
    ]),
    operation: z.enum(["list", "rank", "sum", "count", "explain"]),
    metric: z.enum(QUERY_METRICS).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    match: z.enum(["all", "any"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    days: z.number().int().min(0).max(365).optional(),
    dateBasis: z.enum(["proposed", "settled"]).optional(),
    where: z
      .array(
        z
          .object({
            field: z.enum(QUERY_FIELDS),
            op: z.enum(["eq", "contains", "lt", "lte", "gt", "gte"]),
            value: z.union([
              z.string().max(120),
              z.number().finite().min(-1e12).max(1e12),
              z.boolean(),
            ]),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    topic: z
      .enum([
        "budget",
        "restocks",
        "approvals",
        "payments",
        "audit",
        "assistant",
      ])
      .optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (
      query.source === "supplierDirectory" &&
      (!["list", "count"].includes(query.operation) ||
        query.days ||
        query.metric ||
        query.topic)
    )
      ctx.addIssue({
        code: "custom",
        message: "Configured suppliers support current lists and counts only",
      });
    if (query.operation === "count" && query.metric)
      ctx.addIssue({
        code: "custom",
        message: "Count counts records; use sum for metric totals",
      });
    if (
      query.dateBasis &&
      !["products", "purchases", "suppliers"].includes(query.source)
    )
      ctx.addIssue({
        code: "custom",
        message: "Date basis applies to purchase records only",
      });
    if (query.metric === "cover" && query.operation === "sum")
      ctx.addIssue({
        code: "custom",
        message: "Days of cover cannot be summed",
      });
    if (
      query.source === "summary" &&
      (!["list", "explain"].includes(query.operation) || query.where?.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Store metrics support direct lookup only",
      });
    if (
      query.source === "help" &&
      (query.metric || query.days || query.where?.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "Help uses an application topic only",
      });
    for (const filter of query.where ?? [])
      if (
        ["lt", "lte", "gt", "gte"].includes(filter.op) &&
        typeof filter.value !== "number"
      )
        ctx.addIssue({
          code: "custom",
          message: "Numeric comparisons require a number",
        });
    const allowed: readonly string[] = fields[query.source];
    if (query.metric && !allowed.includes(query.metric))
      ctx.addIssue({
        code: "custom",
        message: "Metric is unavailable for this source",
      });
    for (const filter of query.where ?? [])
      if (!allowed.includes(filter.field))
        ctx.addIssue({
          code: "custom",
          message: "Filter is unavailable for this source",
        });
    if (["rank", "sum"].includes(query.operation) && !query.metric)
      ctx.addIssue({ code: "custom", message: "Choose a metric" });
    if (query.source === "summary" && !query.metric)
      ctx.addIssue({ code: "custom", message: "Choose a store metric" });
    if (
      query.source === "help" &&
      (!query.topic || query.operation !== "explain")
    )
      ctx.addIssue({ code: "custom", message: "Choose a help topic" });
  });
export type GuardQuery = z.infer<typeof GuardQuerySchema>;
