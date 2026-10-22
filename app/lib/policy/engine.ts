import type { Decision, RecordedProposal, RuleCheck, RuleSet, Verdict } from "./schema";
import { hashOf } from "./hash";
import { DEFAULT_PRICE_TOLERANCE_CENTS } from "./rules";

// Deterministic: same proposal + rules + context always gives the same decision.
// No network, no LLM, no clock reads. Everything the rules need is passed in.

export type PolicyContext = {
  productManaged: boolean; // the merchant switched this product on for GuardBuy
  supplierLinked: boolean; // the supplier is one the merchant linked to this product
  usualQuantity: number; // this SKU at this supplier
  spentLast7dCents: number; // auto + approved purchases, rolling 7 days
  purchasesLast24h: number;
  paypalBalanceCents: number | null; // null when the balance could not be read
  // Days since the supplier's PayPal email last changed (null: never changed since it was added).
  payeeChangedDaysAgo?: number | null;
  // Quantities of this product's most recent paid purchases (any supplier), newest last.
  recentPaidQuantities?: number[];
  // This product from this supplier in the last 24 hours, paid or waiting for approval.
  sameSupplierLast24hCents?: number;
  // When the supplier was added (null/undefined: unknown), how often it has been paid, and the
  // older supplier its name imitates, if any.
  supplierAddedDaysAgo?: number | null;
  supplierPaidBefore?: number;
  lookalikeOf?: string | null;
  // The unit price the merchant accepted for this product from this supplier (entered when linking,
  // raised only by purchases a person approved). Null/undefined: unknown, the rule doesn't run.
  acceptedUnitPriceCents?: number | null;
};

/** A supplier whose PayPal email changed this recently needs a person for every purchase. */
export const PAYEE_CHANGE_WINDOW_DAYS = 14;

/** Order-size creep: more than this multiple of the median of recent paid orders needs a person. */
export const CREEP_MULTIPLE = 1.5;
export const CREEP_MIN_HISTORY = 3; // fewer paid orders than this: not enough history to compare
export const CREEP_HISTORY = 5; // how many recent paid orders the median is taken over

/** Split orders: same product, same supplier, within this many hours, count as one purchase. */
export const SPLIT_WINDOW_HOURS = 24;

/** A supplier added this recently needs a person for its first purchase. */
export const NEW_SUPPLIER_DAYS = 30;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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

  // Price creep: every increase beyond the tolerance needs a person once; their approval becomes the
  // new accepted price, so the next increase asks again. Small automatic steps never move it.
  const accepted = ctx.acceptedUnitPriceCents ?? null;
  if (accepted !== null) {
    const tolerance = rules.priceToleranceCents ?? DEFAULT_PRICE_TOLERANCE_CENTS;
    const rise = proposal.unitPriceCents - accepted;
    check("priceAboveAccepted", rise > tolerance, "approval",
      rise > 0
        ? `unit price ${usd(proposal.unitPriceCents)} is ${usd(rise)} above the ${usd(accepted)} you accepted (tolerance ${usd(tolerance)})`
        : `unit price ${usd(proposal.unitPriceCents)}, at or below the ${usd(accepted)} you accepted`);
  }

  const qtyLimit = Math.floor(ctx.usualQuantity * rules.maxQuantityMultiple);
  check("maxQuantityMultiple", proposal.quantity > qtyLimit, "block",
    `quantity ${proposal.quantity} vs limit ${qtyLimit} (${rules.maxQuantityMultiple}x usual ${ctx.usualQuantity})`);

  check("maxPurchasesPer24h", ctx.purchasesLast24h + 1 > rules.maxPurchasesPer24h, "block",
    `${ctx.purchasesLast24h} purchases in the last 24h, limit ${rules.maxPurchasesPer24h}`);

  check("weeklySpendCap", ctx.spentLast7dCents + total > rules.weeklySpendCapCents, "block",
    `${usd(ctx.spentLast7dCents)} spent or awaiting approval this week + ${usd(total)} vs cap ${usd(rules.weeklySpendCapCents)}`);

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
  // "Please update our payment details" is the classic supplier fraud: after a change, a person confirms.
  const changed = ctx.payeeChangedDaysAgo ?? null;
  const recentChange = changed !== null && changed < PAYEE_CHANGE_WINDOW_DAYS;
  check("payeeChange", recentChange, "approval",
    recentChange
      ? `${proposal.supplierId}'s PayPal email changed ${changed! < 1 ? "today" : `${Math.floor(changed!)} days ago`}: confirm it with the supplier before paying`
      : `no recent change to ${proposal.supplierId}'s PayPal email`);

  // A quantity that keeps climbing, each step under the "times the usual" limit (a compromised
  // supplier, or poisoned sales data): compare with what this store actually bought recently.
  const history = (ctx.recentPaidQuantities ?? []).slice(-CREEP_HISTORY);
  if (history.length >= CREEP_MIN_HISTORY) {
    const typical = median(history);
    const creep = proposal.quantity > typical * CREEP_MULTIPLE;
    check("orderSizeCreep", creep, "approval",
      `quantity ${proposal.quantity} vs ${typical} typical in your last ${history.length} paid orders (limit ${CREEP_MULTIPLE}x)`);
  }

  // Several purchases just under the approval limit add up: same product, same supplier, 24 hours.
  const earlier = ctx.sameSupplierLast24hCents ?? 0;
  if (earlier > 0) {
    check("splitOrder", earlier + total > rules.approvalAboveCents, "approval",
      `${usd(earlier)} from ${proposal.supplierId} for ${proposal.sku} in the last ${SPLIT_WINDOW_HOURS}h + ${usd(total)} vs auto-approve limit ${usd(rules.approvalAboveCents)}`);
  }

  // A supplier that was just added, or whose name imitates an existing one, gets a person first.
  const added = ctx.supplierAddedDaysAgo ?? null;
  const firstPurchase = added !== null && added < NEW_SUPPLIER_DAYS && (ctx.supplierPaidBefore ?? 0) === 0;
  const imitates = ctx.lookalikeOf ?? null;
  check("newSupplier", firstPurchase || imitates !== null, "approval",
    imitates !== null
      ? `${proposal.supplierId}'s name looks like ${imitates}: check it's really them before paying`
      : firstPurchase
        ? `first purchase from ${proposal.supplierId}, added ${added! < 1 ? "today" : `${Math.floor(added!)} days ago`}`
        : `${proposal.supplierId} is an established supplier`);

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
