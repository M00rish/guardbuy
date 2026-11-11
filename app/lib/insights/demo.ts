import { PAYMENT_LABEL, type InsightsSnapshot, type InsightRow } from "./types";
/** Browser-only fixtures. Never written to Shopify, the audit log or payment services. */
export function demoSnapshot(now = new Date()): InsightsSnapshot {
  const suppliers = [
    "Atlas Roasters",
    "Cedar Packaging",
    "Harbor Tea",
    "Summit Equipment",
  ];
  const products = [
    "House blend",
    "Compostable cups",
    "Jasmine tea",
    "Pour-over filters",
  ];
  const rows: InsightRow[] = Array.from({ length: 64 }, (_, i) => {
    const kind = (i + Math.floor(i / 4)) % 8,
      amount = 18 + ((i * 37) % 480),
      paid = kind < 4;
    const pending = kind === 4,
      blocked = kind === 5;
    const at = new Date(now.getTime() - (i % 28) * 86400000);
    return {
      purchase: 10001 + i,
      variantId: `demo-${i % 8}`,
      automatic: paid && i % 3 !== 0,
      settledAt: paid ? at.toISOString() : undefined,
      proposedAt: at.toISOString(),
      product:
        products[i % 4] +
        (Math.floor(i / 4) % 2 ? " · premium" : " · standard"),
      supplier: suppliers[i % 4],
      status: paid
        ? PAYMENT_LABEL.paid
        : pending
          ? PAYMENT_LABEL.pending
          : blocked
            ? "Blocked"
            : kind === 6
              ? "Needs approval"
              : "Payment awaiting confirmation",
      reason: blocked
        ? "Proposal exceeds the signed spending cap."
        : kind === 6
          ? "Above the automatic approval limit."
          : kind === 7
            ? "Provider confirmation required before retrying."
            : "Within signed purchasing rules.",
      amount,
      settled: paid ? amount : 0,
      reserved: pending || kind > 5 ? amount : 0,
      blocked: blocked ? amount : 0,
      paymentReference: paid || pending ? `DEMO-${10001 + i}` : "",
      route: "Demo · no payment",
      activityUrl: "",
      pending: pending || kind === 7,
      attention: kind > 5,
    };
  });
  const trend = Array.from({ length: 8 }, (_, i) => {
    const day = new Date(now.getTime() - (7 - i) * 86400000)
      .toISOString()
      .slice(0, 10);
    return {
      day,
      spent: rows
        .filter((r) => r.proposedAt.startsWith(day))
        .reduce((s, r) => s + r.settled, 0),
    };
  });
  const spentCents = Math.round(trend.reduce((s, d) => s + d.spent, 0) * 100);
  const reservedCents = Math.round(
    rows.reduce((s, r) => s + r.reserved, 0) * 100,
  );
  return {
    rows,
    trend,
    checkedAt: now.toISOString(),
    summary: {
      spentCents,
      reservedCents,
      capCents: 1500000,
      remainingCents: 1500000 - spentCents - reservedCents,
      overCents: 0,
      blockedCents: rows.reduce((s, r) => s + r.blocked * 100, 0),
      blockedCount: rows.filter((r) => r.blocked).length,
    },
  };
}
