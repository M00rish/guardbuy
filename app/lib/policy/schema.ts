import { z } from "zod";

// GuardBuy's core contract:
//   the LLM produces a Proposal, the policy engine turns it into a Decision
//   using the merchant's RuleSet, and every step is written as an AuditEntry.
// Money is always integer cents (USD) so rule checks never hit float rounding.

const cents = z.number().int().nonnegative();
const sku = z.string().min(1);
const supplierId = z.string().min(1);

// ---------- Rule set (what the merchant signs) ----------

export const RuleSetSchema = z.object({
  version: z.literal(1),
  shop: z.string().min(1), // e.g. guardbuy-demo.myshopify.com
  currency: z.literal("USD"),

  // When to buy and how much
  reorderBelowDaysOfCover: z.number().positive(), // propose a buy when stock lasts fewer days than this
  targetDaysOfCover: z.number().positive(), // buy enough to reach this many days of stock

  // Price guards
  maxPriceAboveAvgPct: z.number().min(0).max(100), // unit price may exceed its 30-day average by at most this %
  maxUnitPriceCents: z.record(sku, cents).default({}), // optional hard cap per SKU

  // Spend guards
  approvalAboveCents: cents, // purchases above this total need a human approval
  weeklySpendCapCents: cents, // total auto + approved spend per rolling 7 days
  cashFloorCents: cents, // never let the PayPal balance drop below this

  // Behaviour guards
  supplierAllowlist: z.array(supplierId).min(1),
  maxQuantityMultiple: z.number().positive(), // quantity may be at most N x the usual order for that SKU
  maxPurchasesPer24h: z.number().int().positive(),
});
export type RuleSet = z.infer<typeof RuleSetSchema>;

// A rule set as stored: the rules plus who signed them and their fingerprint.
export const SignedRuleSetSchema = z.object({
  rules: RuleSetSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/), // sha256 of the canonical JSON of `rules`
  signedBy: z.string().min(1), // Shopify staff user id (v1) or passkey credential id (Phase B)
  signedAt: z.string().datetime(),
  signature: z.string().optional(), // passkey signature over `hash` (Phase B)
});
export type SignedRuleSet = z.infer<typeof SignedRuleSetSchema>;

// ---------- Proposal (what the LLM is allowed to output) ----------

export const ProposalSchema = z.object({
  sku,
  supplierId,
  unitPriceCents: cents.positive(),
  quantity: z.number().int().positive(),
  reasoning: z.string().min(1).max(1000),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---------- Decision (what the policy engine returns) ----------

export const VerdictSchema = z.enum(["auto", "approval", "block"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const RuleCheckSchema = z.object({
  rule: z.string(), // e.g. "weeklySpendCap"
  outcome: VerdictSchema, // the strictest verdict this rule asks for
  detail: z.string(), // human-readable, shown on the approval card and verify page
});
export type RuleCheck = z.infer<typeof RuleCheckSchema>;

export const DecisionSchema = z.object({
  verdict: VerdictSchema, // strictest outcome across all checks
  totalCents: cents,
  checks: z.array(RuleCheckSchema),
  ruleSetHash: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ---------- Audit log (append-only, hash-chained) ----------

export const AuditEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ruleset_signed"), ruleSet: SignedRuleSetSchema }),
  z.object({ type: z.literal("proposal"), proposal: ProposalSchema }),
  z.object({ type: z.literal("decision"), proposalSeq: z.number().int(), decision: DecisionSchema }),
  z.object({ type: z.literal("approved"), decisionSeq: z.number().int(), approvedBy: z.string() }),
  z.object({
    type: z.literal("payout"),
    decisionSeq: z.number().int(),
    payoutBatchId: z.string(),
    status: z.string(), // PayPal batch status at time of logging
  }),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEntrySchema = z.object({
  seq: z.number().int().nonnegative(), // 0, 1, 2, ... per shop
  shop: z.string(),
  at: z.string().datetime(),
  event: AuditEventSchema,
  prevHash: z.string(), // hash of entry seq-1 ("0" * 64 for the first entry)
  hash: z.string(), // sha256(prevHash + canonical JSON of {seq, shop, at, event})
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
