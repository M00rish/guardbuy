import type { Decision, RecordedProposal, RuleCheck, RuleSet, Verdict } from "./schema";
import { hashOf } from "./hash";

// Deterministic: same proposal + rules + context always gives the same decision.
// No network, no LLM, no clock reads. Everything the rules need is passed in.

export type PolicyContext = {
  productManaged: boolean; // the merchant switched this product on for GuardBuy
  supplierLinked: boolean; // the supplier is one the merchant linked to this product
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

// "already approved", "approved by phone", "the owner approved", "pre-approved", "manager signed off"...
const APPROVAL_CLAIM = /\b(already|pre-?|previously)\s*approved\b|\bapproved (by|over) (phone|email|the (store )?owner|the manager)\b|\b(owner|manager|merchant) (has |had )?(already )?(approved|signed off|authori[sz]ed)\b/i;

export function evaluate(proposal: RecordedProposal, rules: RuleSet, ctx: PolicyContext): Decision {
  const total = proposal.unitPriceCents * proposal.quantity;
  const checks: RuleCheck[] = [];
  const check = (rule: string, failed: boolean, onFail: Verdict, detail: string) =>
    checks.push({ rule, outcome: failed ? onFail : "auto", detail });

  check("productManaged", !ctx.productManaged, "block",
    ctx.productManaged ? `${proposal.sku} is managed by GuardBuy` : `${proposal.sku} is not switched on for GuardBuy`);
  check("supplierLinked", !ctx.supplierLinked, "block",
    ctx.supplierLinked ? `${proposal.supplierId} supplies ${proposal.sku}` : `${proposal.supplierId} is not one of your suppliers for ${proposal.sku}`);

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

  // The AI's explanation is untrusted text, so it never loosens anything; but if it claims that a
  // person already approved, someone must actually approve (supplier notes can plant that claim).
  const claim = APPROVAL_CLAIM.test(proposal.reasoning);
  check("noApprovalClaim", claim, "approval",
    claim ? "the AI's explanation claims an approval that GuardBuy has no record of" : "no approval claimed in the AI's explanation");

  check("approvalAbove", total > rules.approvalAboveCents, "approval",
    `total ${usd(total)} vs auto-approve limit ${usd(rules.approvalAboveCents)}`);

  return {
    verdict: strictest(checks.map((c) => c.outcome)),
    totalCents: total,
    checks,
    ruleSetHash: hashOf(rules),
  };
}
