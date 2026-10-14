// Lightweight scenario checks for the policy engine (no test framework needed).
//   npx tsx scripts/check-policy.ts
import { evaluate, type PolicyContext } from "../app/lib/policy/engine";
import { RuleSetSchema, type Proposal } from "../app/lib/policy/schema";

const rules = RuleSetSchema.parse({
  version: 1,
  shop: "guardbuy-demo.myshopify.com",
  currency: "USD",
  reorderBelowDaysOfCover: 7,
  targetDaysOfCover: 30,
  maxPriceAboveAvgPct: 10,
  maxUnitPriceCents: { "COFFEE-HOUSE-1KG": 1400 },
  approvalAboveCents: 50_000, // $500
  weeklySpendCapCents: 200_000, // $2,000
  cashFloorCents: 100_000, // $1,000
  supplierAllowlist: ["atlas-roasters", "kiln-co", "paperworks"],
  maxQuantityMultiple: 3,
  maxPurchasesPer24h: 5,
});

const base: PolicyContext = {
  avgUnitPrice30dCents: 1148,
  usualQuantity: 40,
  spentLast7dCents: 0,
  purchasesLast24h: 0,
  paypalBalanceCents: 500_000,
};
const coffee = (p: Partial<Proposal>): Proposal => ({
  sku: "COFFEE-HOUSE-1KG",
  supplierId: "atlas-roasters",
  unitPriceCents: 1119,
  quantity: 40,
  reasoning: "test",
  ...p,
});

const cases: [string, Proposal, Partial<PolicyContext>, string, string?][] = [
  ["normal restock under $500", coffee({}), {}, "auto"],
  ["107 units (= $1,197) needs approval", coffee({ quantity: 107 }), {}, "approval", "approvalAbove"],
  ["price above hard cap", coffee({ unitPriceCents: 1450 }), {}, "block", "maxUnitPrice"],
  ["price >10% above 30-day avg", coffee({ unitPriceCents: 1290 }), {}, "block", "maxPriceAboveAvg"],
  ["supplier not allowlisted (Bean Bargains)", coffee({ supplierId: "bean-bargains", unitPriceCents: 690 }), {}, "block", "supplierAllowlist"],
  ["500 units instead of ~40", coffee({ quantity: 500 }), {}, "block", "maxQuantityMultiple"],
  ["6th purchase in 24h", coffee({}), { purchasesLast24h: 5 }, "block", "maxPurchasesPer24h"],
  ["weekly cap exceeded", coffee({}), { spentLast7dCents: 190_000 }, "block", "weeklySpendCap"],
  ["cash floor breached", coffee({}), { paypalBalanceCents: 120_000 }, "block", "cashFloor"],
  ["balance unknown -> human approves", coffee({}), { paypalBalanceCents: null }, "approval", "cashFloor"],
];

let failed = 0;
for (const [name, proposal, ctx, expected, rule] of cases) {
  const d = evaluate(proposal, rules, { ...base, ...ctx });
  const ruleOk = !rule || d.checks.some((c) => c.rule === rule && c.outcome === expected);
  const ok = d.verdict === expected && ruleOk;
  if (!ok) failed++;
  const why = d.checks.filter((c) => c.outcome !== "auto").map((c) => `${c.rule}: ${c.detail}`).join(" | ");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(42)} -> ${d.verdict}${why ? `  (${why})` : ""}`);
}

// Same inputs must always give the same rule-set hash.
const h1 = evaluate(coffee({}), rules, base).ruleSetHash;
const h2 = evaluate(coffee({}), RuleSetSchema.parse({ ...rules }), base).ruleSetHash;
console.log(`${h1 === h2 ? "PASS" : "FAIL"}  rule-set hash is stable (${h1.slice(0, 12)}...)`);
if (h1 !== h2) failed++;

process.exit(failed ? 1 : 0);
