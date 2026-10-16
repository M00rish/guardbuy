import type { Decision, RecordedProposal, RuleCheck, RuleSet, Verdict } from "./schema";
import { hashOf } from "./hash";

// Deterministic: same proposal + rules + context always gives the same decision.
// No network, no LLM, no clock reads. Everything the rules need is passed in.

export type PolicyContext = {
  avgUnitPrice30dCents: number; // this SKU at this supplier
  usualQuantity: number; // this SKU at this supplier
  spentLast7dCents: number; // auto + approved purchases, rolling 7 days
  purchasesLast24h: number;
  paypalBalanceCents: number | null; // null when the balance could not be read
};

const RANK: Record<Verdict, number> = { auto: 0, approval: 1, block: 2 };
const strictest = (verdicts: Verdict[]): Verdict =>
  verdicts.reduce<Verdict>((worst, v) => (RANK[v] > RANK[worst] ? v : worst), "auto");

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function evaluate(proposal: RecordedProposal, rules: RuleSet, ctx: PolicyContext): Decision {
  const total = proposal.unitPriceCents * proposal.quantity;
  const checks: RuleCheck[] = [];
  const check = (rule: string, failed: boolean, onFail: Verdict, detail: string) =>
    checks.push({ rule, outcome: failed ? onFail : "auto", detail });

  const allowed = rules.supplierAllowlist.includes(proposal.supplierId);
  check("supplierAllowlist", !allowed, "block",
    allowed ? `${proposal.supplierId} is an approved supplier` : `${proposal.supplierId} is not on the approved supplier list`);

  check("payeeOnFile", !proposal.payeeEmail, "block",
    proposal.payeeEmail ? `pays ${proposal.payeeEmail}` : `no PayPal email on file for ${proposal.supplierId}`);

  const cap = rules.maxUnitPriceCents[proposal.sku];
  if (cap !== undefined) {
    check("maxUnitPrice", proposal.unitPriceCents > cap, "block",
      `unit price ${usd(proposal.unitPriceCents)} vs cap ${usd(cap)}`);
  }

  const priceLimit = Math.floor(ctx.avgUnitPrice30dCents * (1 + rules.maxPriceAboveAvgPct / 100));
  check("maxPriceAboveAvg", proposal.unitPriceCents > priceLimit, "block",
    `unit price ${usd(proposal.unitPriceCents)} vs 30-day avg ${usd(ctx.avgUnitPrice30dCents)} (limit +${rules.maxPriceAboveAvgPct}% = ${usd(priceLimit)})`);

  const qtyLimit = Math.floor(ctx.usualQuantity * rules.maxQuantityMultiple);
  check("maxQuantityMultiple", proposal.quantity > qtyLimit, "block",
    `quantity ${proposal.quantity} vs limit ${qtyLimit} (${rules.maxQuantityMultiple}x usual ${ctx.usualQuantity})`);

  check("maxPurchasesPer24h", ctx.purchasesLast24h + 1 > rules.maxPurchasesPer24h, "block",
    `${ctx.purchasesLast24h} purchases in the last 24h, limit ${rules.maxPurchasesPer24h}`);

  check("weeklySpendCap", ctx.spentLast7dCents + total > rules.weeklySpendCapCents, "block",
    `${usd(ctx.spentLast7dCents)} spent this week + ${usd(total)} vs cap ${usd(rules.weeklySpendCapCents)}`);

  if (ctx.paypalBalanceCents === null) {
    // Fail safe: if we can't see the balance, a human decides.
    checks.push({ rule: "cashFloor", outcome: "approval", detail: "PayPal balance unavailable, so a person must approve" });
  } else {
    const after = ctx.paypalBalanceCents - total;
    check("cashFloor", after < rules.cashFloorCents, "block",
      `balance after purchase ${usd(after)} vs floor ${usd(rules.cashFloorCents)}`);
  }

  check("approvalAbove", total > rules.approvalAboveCents, "approval",
    `total ${usd(total)} vs auto-approve limit ${usd(rules.approvalAboveCents)}`);

  return {
    verdict: strictest(checks.map((c) => c.outcome)),
    totalCents: total,
    checks,
    ruleSetHash: hashOf(rules),
  };
}
