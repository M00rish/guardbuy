import { APPROVAL_LABEL, PAYMENT_LABEL } from "../wording";

export const INSIGHT_VIEWS = [
  "all",
  "pending",
  "blocked",
  "paid",
  "attention",
] as const;
export type InsightView = (typeof INSIGHT_VIEWS)[number];
export const VIEW_LABEL: Record<InsightView, string> = {
  all: "All purchases",
  pending: "Pending payments",
  blocked: "Blocked proposals",
  paid: "Paid purchases",
  attention: "Needs attention",
};
export type InsightRow = {
  purchase: number;
  variantId?: string;
  automatic?: boolean;
  attentionState?: import("./attention").AttentionLane;
  settledAt?: string;
  proposedAt: string;
  product: string;
  supplier: string;
  status: string;
  reason: string;
  amount: number;
  settled: number;
  reserved: number;
  blocked: number;
  paymentReference: string;
  route: string;
  activityUrl: string;
  pending: boolean;
  attention: boolean;
};
export type InsightsSnapshot = {
  rows: InsightRow[];
  summary: {
    spentCents: number;
    reservedCents: number;
    remainingCents: number;
    capCents: number;
    overCents: number;
    blockedCents: number;
    blockedCount: number;
  };
  trend: { day: string; spent: number }[];
  checkedAt: string;
};
export function inInsightView(row: InsightRow, view: InsightView) {
  return (
    view === "all" ||
    (view === "pending"
      ? row.pending
      : view === "blocked"
        ? row.blocked > 0 || row.status === "Blocked"
        : view === "paid"
          ? row.status === PAYMENT_LABEL.paid ||
            row.status === PAYMENT_LABEL.partiallyRefunded
          : row.attention)
  );
}
export function describeInsightView(
  rows: InsightRow[],
  view: InsightView,
): string {
  const selected = rows.filter((row) => inInsightView(row, view));
  const amount = selected.reduce(
    (sum, row) => sum + Math.round(row.amount * 100),
    0,
  );
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount / 100);
  const reasons = [
    ...new Set(selected.map((row) => row.reason).filter(Boolean)),
  ].slice(0, 3);
  return `${VIEW_LABEL[view]}: ${selected.length} ${selected.length === 1 ? "purchase" : "purchases"}, ${money} in proposal value. This is not a total of settled payments.${view === "blocked" && reasons.length ? ` Recorded reasons: ${reasons.join("; ")}` : ""}${view === "pending" ? " Check the original payment before taking further action." : ""}`;
}
export { APPROVAL_LABEL, PAYMENT_LABEL };
