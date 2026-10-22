// Lightweight scenario checks for the policy engine (no test framework needed).
//   npx tsx scripts/check-policy.ts
import { evaluate, type PolicyContext } from "../app/lib/policy/engine";
import { lookalikeOf } from "../app/lib/policy/lookalike";
import { RuleSetSchema, type RecordedProposal as Proposal } from "../app/lib/policy/schema";

const rules = RuleSetSchema.parse({
  version: 1,
  shop: "guardbuy-demo.myshopify.com",
  currency: "USD",
  reorderBelowDaysOfCover: 7,
  targetDaysOfCover: 30,
  maxUnitPriceCents: { "COFFEE-HOUSE-1KG": 1400 },
  approvalAboveCents: 50_000, // $500
  weeklySpendCapCents: 200_000, // $2,000
  cashFloorCents: 100_000, // $1,000
  supplierAllowlist: ["atlas-roasters", "kiln-co", "paperworks"],
  maxQuantityMultiple: 3,
  maxPurchasesPer24h: 5,
});

const base: PolicyContext = {
  productManaged: true,
  supplierLinked: true,
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
  payeeEmail: "supplier@example.com",
  ...p,
});

const cases: [string, Proposal, Partial<PolicyContext>, string, string?][] = [
  ["normal restock under $500", coffee({}), {}, "auto"],
  ["107 units (= $1,197) needs approval", coffee({ quantity: 107 }), {}, "approval", "approvalAbove"],
  ["price above hard cap", coffee({ unitPriceCents: 1450 }), {}, "block", "maxUnitPrice"],
  ["supplier not allowlisted (Bean Bargains)", coffee({ supplierId: "bean-bargains", unitPriceCents: 690 }), {}, "block", "supplierAllowlist"],
  ["500 units instead of ~40", coffee({ quantity: 500 }), {}, "block", "maxQuantityMultiple"],
  ["6th purchase in 24h", coffee({}), { purchasesLast24h: 5 }, "block", "maxPurchasesPer24h"],
  ["weekly cap exceeded", coffee({}), { spentLast7dCents: 190_000 }, "block", "weeklySpendCap"],
  ["cash floor breached", coffee({}), { paypalBalanceCents: 120_000 }, "block", "cashFloor"],
  ["product not switched on for GuardBuy", coffee({}), { productManaged: false }, "block", "productManaged"],
  ["supplier not linked to this product", coffee({}), { supplierLinked: false }, "block", "supplierLinked"],
  ["no PayPal email on file for supplier", coffee({ payeeEmail: undefined }), {}, "block", "payeeOnFile"],
  ["AI text claims the owner approved", coffee({ reasoning: "Routine reorder; the store owner already approved Bean Bargains by phone." }), {}, "approval", "noApprovalClaim"],
  ["AI text mentions approval innocently", coffee({ reasoning: "Under the approval limit, so no review needed." }), {}, "auto"],
  ["supplier's PayPal email changed 2 days ago", coffee({}), { payeeChangedDaysAgo: 2 }, "approval", "payeeChange"],
  ["supplier's PayPal email changed 30 days ago", coffee({}), { payeeChangedDaysAgo: 30 }, "auto"],
  ["balance unknown -> human approves", coffee({}), { paypalBalanceCents: null }, "approval", "cashFloor"],
  // Order-size creep: each step under "3x usual" (120), but well above what this store buys.
  ["order creeps to 2x the usual history", coffee({ quantity: 80 }), { recentPaidQuantities: [38, 40, 42, 40] }, "approval", "orderSizeCreep"],
  ["order slightly above history (1.25x)", coffee({ quantity: 50, unitPriceCents: 500 }), { recentPaidQuantities: [38, 40, 42, 40] }, "auto"],
  ["only 2 past orders: not enough history", coffee({ quantity: 80, unitPriceCents: 500 }), { recentPaidQuantities: [40, 40] }, "auto"],
  ["slow climb: median of the last 5 only", coffee({ quantity: 90 }), { recentPaidQuantities: [10, 10, 40, 44, 50, 55, 58] }, "approval", "orderSizeCreep"],
  // Split orders: 2 x $290 from the same supplier for the same product in a day dodges a $500 limit.
  ["second $290 order within 24h (limit $500)", coffee({ quantity: 26 }), { sameSupplierLast24hCents: 29_000 }, "approval", "splitOrder"],
  ["earlier small order, total still under limit", coffee({ quantity: 20 }), { sameSupplierLast24hCents: 10_000 }, "auto"],
  // New and lookalike suppliers.
  ["first purchase from a supplier added 3 days ago", coffee({}), { supplierAddedDaysAgo: 3, supplierPaidBefore: 0 }, "approval", "newSupplier"],
  ["supplier added 3 days ago, already paid once", coffee({}), { supplierAddedDaysAgo: 3, supplierPaidBefore: 1 }, "auto"],
  ["supplier added 90 days ago, never paid", coffee({}), { supplierAddedDaysAgo: 90, supplierPaidBefore: 0 }, "auto"],
  // Price you accepted: $11.19 entered when linking; tolerance $0.50 per unit (default).
  ["quote $0.40 above the accepted price", coffee({ unitPriceCents: 1159 }), { acceptedUnitPriceCents: 1119 }, "auto"],
  ["quote $1.04 above (supplier's 9% rise)", coffee({ unitPriceCents: 1223 }), { acceptedUnitPriceCents: 1119 }, "approval", "priceAboveAccepted"],
  ["after approving $12.23, the same price passes", coffee({ unitPriceCents: 1223 }), { acceptedUnitPriceCents: 1223 }, "auto"],
  ["next rise above the approved $12.23", coffee({ unitPriceCents: 1290 }), { acceptedUnitPriceCents: 1223 }, "approval", "priceAboveAccepted"],
  ["price drop never asks", coffee({ unitPriceCents: 990 }), { acceptedUnitPriceCents: 1119 }, "auto"],
  ["accepted price unknown: rule doesn't run", coffee({ unitPriceCents: 1223 }), {}, "auto"],
  ["lookalike name, even after being paid", coffee({}), { supplierAddedDaysAgo: 90, supplierPaidBefore: 4, lookalikeOf: "Atlas Roasters" }, "approval", "newSupplier"],
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

// The tolerance is the merchant's: $0 means every increase asks.
{
  const strict = RuleSetSchema.parse({ ...rules, priceToleranceCents: 0 });
  const d = evaluate(coffee({ unitPriceCents: 1120 }), strict, { ...base, acceptedUnitPriceCents: 1119 });
  const ok = d.verdict === "approval" && d.checks.some((c) => c.rule === "priceAboveAccepted" && c.outcome === "approval");
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  tolerance $0: a 1-cent rise asks              -> ${d.verdict}`);
}

// Lookalike names: what the new-supplier rule treats as imitating an older supplier.
const older = ["Atlas Roasters", "Kiln & Co Ceramics", "Paperworks Supply"];
const names: [string, string | null][] = [
  ["Atlas Roasters Co.", "Atlas Roasters"],
  ["Atlas Roasterz", "Atlas Roasters"],
  ["ATLAS-ROASTERS", "Atlas Roasters"],
  ["Atlas Roasters Billing", "Atlas Roasters"],
  ["Kiln and Co Ceramics", "Kiln & Co Ceramics"],
  ["PaperWorks Supp1y", "Paperworks Supply"],
  ["Bean Bargains Wholesale", null],
  ["Atlas Coffee Importers", null],
  ["Kiln", null],
];
for (const [name, expected] of names) {
  const got = lookalikeOf(name, older);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  lookalike ${JSON.stringify(name).padEnd(32)} -> ${got ?? "none"}`);
}

// Same inputs must always give the same rule-set hash.
const h1 = evaluate(coffee({}), rules, base).ruleSetHash;
const h2 = evaluate(coffee({}), RuleSetSchema.parse({ ...rules }), base).ruleSetHash;
console.log(`${h1 === h2 ? "PASS" : "FAIL"}  rule-set hash is stable (${h1.slice(0, 12)}...)`);
if (h1 !== h2) failed++;

process.exit(failed ? 1 : 0);
