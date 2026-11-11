import { GuardQuerySchema, type GuardQuery } from "./query-schema";
import type { InsightRow, InsightsSnapshot } from "./types";
import type {
  HomeWorkspaceData,
  WorkspaceProduct,
  WorkspaceDetail,
  WorkspaceActivity,
} from "./workspace";
import { usd } from "../format";
export type QueryGrid = {
  view: "products" | "purchases" | "activity" | "details";
  analysis?: "purchases" | "suppliers";
  sort?: { field: string; direction: "asc" | "desc" };
  columns?: string[];
  expandPurchase?: number;
};
export type GuardQueryResult = {
  answer: string;
  grid?: QueryGrid;
  products?: WorkspaceProduct[];
  purchases?: InsightRow[];
  details?: WorkspaceDetail[];
  activity?: WorkspaceActivity[];
};
export type QueryData = {
  snapshot: InsightsSnapshot;
  workspace: HomeWorkspaceData;
};
const moneyMetrics = new Set(["amount", "settled", "reserved", "blocked"]);
const labels: Record<string, string> = {
  automaticRestocks: "automatic paid purchases",
  paidRestocks: "paid purchases",
  purchaseCount: "recorded proposals",
  stock: "units in stock",
  incoming: "incoming units",
  cover: "days of cover",
  amount: "proposal value",
  settled: "net settled payments",
  reserved: "reserved funds",
  blocked: "blocked proposal value",
  spentCents: "spent over the rolling last 7 days",
  reservedCents: "current reservations",
  remainingCents: "remaining budget",
  balanceCents: "PayPal balance after commitments",
  capCents: "7-day spending cap",
  blockedCents: "all-time blocked proposal value",
  overCents: "over the spending cap",
  waiting: "current approval requests",
  blockedCount: "blocked proposals",
};
const sourceLabels: Record<GuardQuery["source"], string> = {
  products: "Products",
  purchases: "Purchases",
  suppliers: "Suppliers",
  summary: "Store summary",
  details: "Store details",
  activity: "Recent activity",
  help: "How GuardBuy works",
};
export function guardQueryLabel(query: GuardQuery) {
  return `${sourceLabels[query.source]}${query.metric ? ` · ${labels[query.metric]}` : ""}${query.days ? ` · last ${query.days} days` : ""}`;
}
function recent(
  row: InsightRow,
  days: number,
  checkedAt: string,
  metric?: string,
) {
  if (!days) return true;
  const at =
    metric === "automaticRestocks" ||
    metric === "paidRestocks" ||
    metric === "settled"
      ? row.settledAt
      : row.proposedAt;
  return (
    !!at &&
    Date.parse(at) >= Date.parse(checkedAt) - days * 86400000 &&
    Date.parse(at) <= Date.parse(checkedAt)
  );
}
export function productAnalytics(
  rows: InsightRow[],
  products: WorkspaceProduct[],
  days = 0,
  checkedAt = new Date().toISOString(),
  metric?: string,
): WorkspaceProduct[] {
  return products.map((product) => {
    const purchases = rows.filter(
      (row) =>
        row.variantId === product.variantId &&
        recent(row, days, checkedAt, metric),
    );
    const total = (field: "amount" | "settled" | "reserved" | "blocked") =>
      purchases.reduce((sum, row) => sum + Math.round(row[field] * 100), 0) /
      100;
    return {
      ...product,
      automaticRestocks: purchases.filter(
        (row) => row.automatic === true && row.settled > 0,
      ).length,
      paidRestocks: purchases.filter((row) => row.settled > 0).length,
      purchaseCount: purchases.length,
      amount: total("amount"),
      settled: total("settled"),
      reserved: total("reserved"),
      blocked: total("blocked"),
    };
  });
}
function read(row: object, field: string): unknown {
  const value = (row as Record<string, unknown>)[field];
  return field === "status" &&
    typeof value === "object" &&
    value !== null &&
    "label" in value
    ? value.label
    : value;
}
function matches(row: object, query: GuardQuery) {
  const conditions = query.where ?? [];
  if (!conditions.length) return true;
  const test = (filter: NonNullable<GuardQuery["where"]>[number]) => {
    const value = read(row, filter.field);
    if (value === null || value === undefined) return false;
    if (filter.op === "contains")
      return String(value)
        .toLocaleLowerCase()
        .includes(String(filter.value).toLocaleLowerCase());
    if (filter.op === "eq")
      return typeof value === "string" && typeof filter.value === "string"
        ? value.toLocaleLowerCase() === filter.value.toLocaleLowerCase()
        : value === filter.value;
    if (typeof value !== "number" || typeof filter.value !== "number")
      return false;
    return filter.op === "lt"
      ? value < filter.value
      : filter.op === "lte"
        ? value <= filter.value
        : filter.op === "gt"
          ? value > filter.value
          : value >= filter.value;
  };
  return query.match === "any" ? conditions.some(test) : conditions.every(test);
}
const HELP = {
  budget:
    "Remaining budget is the signed rolling 7-day cap minus net settled spend and current reservations, floored at zero. Pending/uncertain payments and unexpired approvals remain reserved. Grid filters do not change store-wide budget figures.",
  restocks:
    "GuardBuy proposes restocks for switched-on products using stock, sales and signed rules. An automatic paid purchase means a decision allowed without manual approval followed by a positive net settled payment. Payment does not establish a physical stock receipt; deliveries record receipt separately.",
  approvals:
    "Purchases requiring approval wait in Rules & Approvals. Viewing or filtering them does not approve or submit a payment. Unknown payments must be checked before any retry.",
  payments:
    "Proposal value, reserved funds and net settled payments describe different states. A submitted or uncertain payment is not proof of settlement. Returns and refunds affect recorded settlement separately from received stock.",
  audit:
    "GuardBuy records decisions, payments and deliveries in a hash-chained audit log. Home analyses require successful verification. Open Activity for full records and verification.",
  assistant:
    "I read the loaded GuardBuy snapshot, calculate results locally and show related records in the grid. I can filter, rank and summarize recorded data, but cannot move money or change rules. My model receives your question, not the dataset. I ask for clarification when the available data cannot answer a question.",
};
export function runGuardQuery(
  input: GuardQuery,
  data: QueryData,
): GuardQueryResult {
  const query = GuardQuerySchema.parse(input),
    { snapshot, workspace } = data;
  const days = query.days ?? 0,
    metric = query.metric,
    limit = query.limit ?? 10;
  const period = days ? `last ${days} days` : "all recorded dates";
  const definition =
    metric === "automaticRestocks"
      ? " Automatic paid purchases exclude manual approvals and unsettled or fully refunded/returned payments. Counts are not physical stock receipts."
      : "";
  const format = (value: number) =>
    metric?.endsWith("Cents")
      ? usd(Math.round(value))
      : moneyMetrics.has(metric ?? "")
        ? usd(Math.round(value * 100))
        : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
            value,
          );
  if (query.source === "help")
    return {
      answer: HELP[query.topic!],
      grid: {
        view:
          query.topic === "restocks"
            ? "products"
            : query.topic === "payments" || query.topic === "approvals"
              ? "purchases"
              : "details",
      },
    };
  if (query.source === "summary") {
    if (days && !(metric === "spentCents" && days === 7))
      return {
        answer:
          "Store summary figures are current; settled spending covers the rolling last 7 days. I cannot reconstruct that requested historical balance or budget from this snapshot.",
      };
    const values = {
      ...workspace.summary,
      blockedCount: workspace.summary.blocked,
      blockedCents: snapshot.summary.blockedCents,
      overCents: snapshot.summary.overCents,
    };
    const value = read(values, metric!);
    const text =
      typeof value === "number"
        ? format(value)
        : "Unavailable in the current snapshot";
    return {
      answer: `${labels[metric!]}: ${text}. Store-wide figures are independent of grid filters.`,
      grid: { view: "details" },
      details: [
        {
          id: `summary:${metric}`,
          category: "Store summary",
          setting: labels[metric!],
          value: text,
        },
      ],
    };
  }
  if (query.source === "products" && workspace.products === null)
    return {
      answer:
        "The product catalogue is unavailable. Refresh Home to load it before asking a product question.",
    };
  if (
    query.source === "products" &&
    days &&
    (!metric || ["stock", "incoming", "cover"].includes(metric))
  )
    return {
      answer:
        "Stock, incoming quantity and days of cover are current snapshot values. Historical inventory is unavailable here; ask about current stock or recorded purchases instead.",
    };
  const dateMetric =
    query.dateBasis === "settled"
      ? "settled"
      : query.dateBasis === "proposed"
        ? "amount"
        : metric;
  const purchaseRows = snapshot.rows.filter((row) =>
    recent(row, days, snapshot.checkedAt, dateMetric),
  );
  let source: object[] = [];
  if (query.source === "products")
    source = productAnalytics(
      snapshot.rows,
      workspace.products!,
      days,
      snapshot.checkedAt,
      dateMetric,
    );
  if (query.source === "purchases") source = purchaseRows;
  if (query.source === "suppliers") {
    const suppliers = [...new Set(purchaseRows.map((row) => row.supplier))];
    source = suppliers.map((supplier) => {
      const rows = purchaseRows.filter((row) => row.supplier === supplier);
      const total = (field: "amount" | "settled" | "reserved" | "blocked") =>
        rows.reduce((sum, row) => sum + Math.round(row[field] * 100), 0) / 100;
      return {
        supplier,
        purchaseCount: rows.length,
        automaticRestocks: rows.filter(
          (row) => row.automatic === true && row.settled > 0,
        ).length,
        paidRestocks: rows.filter((row) => row.settled > 0).length,
        amount: total("amount"),
        settled: total("settled"),
        reserved: total("reserved"),
        blocked: total("blocked"),
      };
    });
  }
  if (query.source === "details") source = workspace.details;
  if (query.source === "activity")
    source = workspace.activity.filter(
      (row) =>
        !days ||
        Date.parse(row.at) >= Date.parse(snapshot.checkedAt) - days * 86400000,
    );
  const matching = source.filter((row) => matches(row, query));
  const ordered = [...matching];
  if (metric)
    ordered.sort((a, b) => {
      const av = read(a, metric),
        bv = read(b, metric);
      if (av === null || av === undefined)
        return bv === null || bv === undefined ? 0 : 1;
      if (bv === null || bv === undefined) return -1;
      const delta =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return (query.direction === "asc" ? 1 : -1) * delta;
    });
  const displayed = ["sum", "count"].includes(query.operation)
    ? ordered
    : ordered.slice(0, limit);
  const grid: QueryGrid = {
    view: query.source === "suppliers" ? "purchases" : query.source,
    ...(query.source === "suppliers" ? { analysis: "suppliers" as const } : {}),
    ...(metric
      ? {
          sort: { field: metric, direction: query.direction ?? "desc" },
          columns: [metric],
        }
      : {}),
  };
  const result: GuardQueryResult = { answer: "", grid };
  if (query.source === "products")
    result.products = displayed as WorkspaceProduct[];
  if (query.source === "purchases") {
    result.purchases = displayed as InsightRow[];
    if (query.operation === "explain" && displayed.length === 1)
      grid.expandPurchase = (displayed[0] as InsightRow).purchase;
  }
  if (query.source === "suppliers")
    result.purchases = purchaseRows.filter((row) =>
      displayed.some((group) => read(group, "supplier") === row.supplier),
    );
  if (query.source === "details")
    result.details = displayed as WorkspaceDetail[];
  if (query.source === "activity")
    result.activity = displayed as WorkspaceActivity[];
  const scope =
    query.source === "activity"
      ? "loaded recent activity (up to 100 events)"
      : query.source === "products"
        ? `loaded product catalogue; ${period} for purchase metrics`
        : `recorded ${query.source}; ${period}`;
  if (!matching.length) {
    result.answer = `No matching records in the ${scope}. I have left the related grid empty rather than inventing a result.`;
    return result;
  }
  if (query.operation === "count")
    result.answer = `${matching.length} matching ${query.source} records in the ${scope}.`;
  else if (query.operation === "sum") {
    const numbers = matching
      .map((row) => read(row, metric!))
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    result.answer = numbers.length
      ? `${labels[metric!]}: ${format(numbers.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100)} across ${numbers.length} records in the ${scope}.`
      : `${labels[metric!]} is unavailable for these records.`;
  } else {
    const lines = displayed.map((row, index) => {
      const name = String(
        read(row, "title") ??
          read(row, "product") ??
          read(row, "supplier") ??
          read(row, "setting") ??
          `Purchase #${read(row, "purchase")}`,
      );
      const value = metric ? read(row, metric) : undefined;
      if (query.source === "details")
        return `${index + 1}. ${read(row, "setting")}: ${read(row, "value")}`;
      if (query.source === "activity")
        return `${index + 1}. ${read(row, "title")}`;
      if (query.operation === "explain" && query.source === "purchases")
        return `${index + 1}. Purchase #${read(row, "purchase")} · ${name}: ${read(row, "status")}. ${(row as InsightRow).reason}`;
      return `${index + 1}. ${name}${metric ? `: ${typeof value === "number" ? format(value) : "Unavailable"}` : ` · ${read(row, "status") ?? "recorded"}`}`;
    });
    result.answer = `${query.operation === "rank" ? "Ranking" : "Results"} from the ${scope}${metric ? ` by ${labels[metric]}` : ""} (${displayed.length} of ${matching.length} records):\n${lines.join("\n")}`;
  }
  if (
    metric === "automaticRestocks" &&
    matching.every((row) => read(row, "automaticRestocks") === 0)
  )
    result.answer =
      "No automatic paid purchases are recorded for the matched records. Ask for paid purchase counts to include approval-based purchases.\n" +
      result.answer;
  result.answer += definition;
  if (query.where?.length)
    result.answer += ` Applied filters: ${query.where.map((filter) => `${labels[filter.field] ?? filter.field} ${{ eq: "is", contains: "contains", lt: "<", lte: "≤", gt: ">", gte: "≥" }[filter.op]} ${filter.value}`).join("; ")}.`;
  if (
    query.source === "products" &&
    [
      "automaticRestocks",
      "paidRestocks",
      "purchaseCount",
      "amount",
      "settled",
      "reserved",
      "blocked",
    ].includes(metric ?? "")
  )
    result.answer +=
      " Products use exact variant IDs; unmatched history is excluded.";
  if (
    days &&
    ["automaticRestocks", "paidRestocks", "settled"].includes(dateMetric ?? "")
  )
    result.answer += " Date range uses recorded settlement time.";
  else if (
    days &&
    ["products", "purchases", "suppliers"].includes(query.source)
  )
    result.answer += " Date range uses proposal time.";
  return result;
}
