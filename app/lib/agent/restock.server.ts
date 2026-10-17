import { appendAudit, auditEntries } from "../audit/log.server";
import type { StockCheck } from "../inventory/trigger.server";
import { paypal } from "../paypal/client.server";
import { evaluate, type PolicyContext } from "../policy/engine";
import { hashOf } from "../policy/hash";
import { RuleSetSchema, type AuditEntry, type RecordedProposal, type RuleSet } from "../policy/schema";
import { isManaged, offersForVariant, type Offer } from "../suppliers/directory.server";
import { executePurchase } from "./execute.server";
import { proposePurchase } from "./proposer.server";

// The restock loop: low stock -> LLM proposal -> policy decision -> payout (only if "auto").
// Each step is written to the audit log before the next one runs, so the log always shows
// how far a restock got and why it stopped. Failures are logged too, never dropped silently.

const DAY_MS = 86_400_000;
const OPEN_RESTOCK_MS = 3 * DAY_MS; // a paid or pending restock covers the SKU for this long (until stock-in-transit tracking)
const RETRY_AFTER_BLOCK_MS = 60 * 60_000; // after a blocked proposal or failed payment, wait before trying again
const RETRY_AFTER_LLM_FAILURE_MS = 15 * 60_000; // after the LLM failed or timed out
const RETRY_AFTER_REJECT_MS = DAY_MS; // the merchant said no: don't ask again the same day
const IN_FLIGHT_MS = 10 * 60_000; // an "auto" decision with no payment result yet is still being paid

// PayPal payout statuses (batch or item) meaning the supplier did not get, or did not keep, the money.
const PAYOUT_FAILED = new Set(["DENIED", "CANCELED", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "UNCLAIMED"]);

/** Demo rules, signed by a script until merchants sign their own in the app (Oct 18). */
export function defaultRuleSet(shop: string): RuleSet {
  return RuleSetSchema.parse({
    version: 1,
    shop,
    currency: "USD",
    reorderBelowDaysOfCover: 7,
    targetDaysOfCover: 14,
    maxPriceAboveAvgPct: 10,
    approvalAboveCents: 50_000, // $500
    weeklySpendCapCents: 150_000, // $1,500
    cashFloorCents: 100_000, // $1,000
    supplierAllowlist: ["atlas-roasters", "kiln-co", "paperworks"],
    maxQuantityMultiple: 3,
    maxPurchasesPer24h: 5,
  });
}

/** The latest rule set the merchant signed, or null: without one, the agent buys nothing. */
export function currentRuleSet(log: AuditEntry[]): RuleSet | null {
  const signed = log.filter((e) => e.event.type === "ruleset_signed").at(-1);
  return signed?.event.type === "ruleset_signed" ? signed.event.ruleSet.rules : null;
}

export function signRuleSet(shop: string, rules: RuleSet, signedBy: string) {
  return appendAudit(shop, {
    type: "ruleset_signed",
    ruleSet: { rules, hash: hashOf(rules), signedBy, signedAt: new Date().toISOString() },
  });
}

/** PayPal available balance in cents, or null if it can't be read (the policy then asks a person). */
export async function paypalBalanceCents(): Promise<number | null> {
  try {
    const res = await paypal<{ balances?: { currency: string; available_balance?: { value: string } }[] }>(
      "/v1/reporting/balances?currency_code=USD",
    );
    const usd = res.balances?.find((b) => b.currency === "USD")?.available_balance?.value;
    return usd === undefined ? null : Math.round(Number(usd) * 100);
  } catch (e) {
    console.warn(`[restock] balance unavailable: ${(e as Error).message}`);
    return null;
  }
}

/** When a payout's latest known status shows the money didn't reach (or stay with) the supplier. */
function payoutFailedAt(payout: AuditEntry, log: AuditEntry[]): string | null {
  if (payout.event.type !== "payout") return null;
  const latest = log.filter((e) => e.event.type === "payout_status" && e.event.payoutSeq === payout.seq).at(-1);
  if (latest?.event.type === "payout_status") return PAYOUT_FAILED.has(latest.event.status) ? latest.at : null;
  return PAYOUT_FAILED.has(payout.event.status) ? payout.at : null;
}

/** Everything the policy engine needs, built from the audit log and the merchant's own offers. */
export function policyContext(
  proposal: RecordedProposal,
  log: AuditEntry[],
  balanceCents: number | null,
  merchant: { managed: boolean; offers: Offer[] },
  now = new Date(),
): PolicyContext {
  const offer = merchant.offers.find((o) => o.supplierId === proposal.supplierId);
  // Money that left: payouts that didn't fail, plus captured PayPal orders.
  const spent = log.flatMap((e) =>
    (e.event.type === "payout" && !payoutFailedAt(e, log)) || e.event.type === "order_captured"
      ? [{ at: e.at, cents: e.event.amountCents }]
      : [],
  );
  const since = (ms: number) => spent.filter((s) => now.getTime() - Date.parse(s.at) < ms);

  return {
    productManaged: merchant.managed,
    supplierLinked: !!offer,
    // An offer the merchant never linked has no history: 0 makes the price check block it too.
    avgUnitPrice30dCents: offer?.avgUnitPrice30dCents ?? 0,
    usualQuantity: offer?.usualQuantity ?? 0,
    spentLast7dCents: since(7 * DAY_MS).reduce((sum, s) => sum + s.cents, 0),
    purchasesLast24h: since(DAY_MS).length,
    paypalBalanceCents: balanceCents,
  };
}

/**
 * Why this SKU should not get a new proposal right now, or null if it should.
 * Only a restock that is paid or waiting for approval keeps the SKU covered; a blocked proposal,
 * a failed LLM call or a failed payment frees it again after a short wait.
 */
export function skipReason(item: { variantId: string; sku: string }, log: AuditEntry[], now = new Date()): string | null {
  // Matched by variant (SKUs can be shared); entries without a variant id fall back to the SKU.
  const same = (r: { variantId?: string; sku: string }) => (r.variantId ? r.variantId === item.variantId : r.sku === item.sku);
  const last = log
    .filter((e) => (e.event.type === "proposal" || e.event.type === "proposal_failed") && !e.event.scenario) // injection tests don't count
    .filter((e) => (e.event.type === "proposal" && same(e.event.proposal)) || (e.event.type === "proposal_failed" && same(e.event)))
    .at(-1);
  if (!last) return null;
  const since = (at: string) => now.getTime() - Date.parse(at);
  const wait = (at: string, ms: number, what: string) =>
    since(at) < ms ? `${what} ${Math.round(since(at) / 60_000)} min ago; retrying after ${ms / 60_000} min` : null;

  if (last.event.type === "proposal_failed") return wait(last.at, RETRY_AFTER_LLM_FAILURE_MS, "the AI proposal failed");

  const decision = log.find((e) => e.event.type === "decision" && e.event.proposalSeq === last.seq);
  if (decision?.event.type !== "decision") return wait(last.at, RETRY_AFTER_LLM_FAILURE_MS, `proposal #${last.seq} was left undecided`);
  const { verdict } = decision.event.decision;
  if (verdict === "block") return wait(last.at, RETRY_AFTER_BLOCK_MS, `proposal #${last.seq} was blocked`);

  const ofDecision = (type: string) =>
    log.filter((e) => e.event.type === type && "decisionSeq" in e.event && e.event.decisionSeq === decision.seq);
  const open = () => (since(last.at) < OPEN_RESTOCK_MS ? `restock #${last.seq} is already open` : null);

  const payout = ofDecision("payout").at(-1);
  if (payout) {
    const failedAt = payoutFailedAt(payout, log);
    return failedAt ? wait(failedAt, RETRY_AFTER_BLOCK_MS, `payout for #${last.seq} failed`) : open();
  }
  if (ofDecision("order_captured").length) return open();
  const rejected = ofDecision("rejected").at(-1);
  if (rejected) return wait(rejected.at, RETRY_AFTER_REJECT_MS, `restock #${last.seq} was declined`);
  const failed = ofDecision("payment_failed").at(-1);
  if (failed) return wait(failed.at, RETRY_AFTER_BLOCK_MS, `payment for #${last.seq} failed`);
  if (verdict === "approval") return open(); // waiting for a person
  // "auto" with no payment result: still being paid, or the server stopped mid-payment.
  return wait(decision.at, IN_FLIGHT_MS, `restock #${last.seq} started paying`);
}

export type RestockResult =
  | { outcome: "skipped" | "failed"; reason: string }
  | { outcome: "auto" | "approval" | "block"; proposalSeq: number; decisionSeq: number; payoutSeq?: number; error?: string };

// One restock at a time per shop + variant in this process. Webhooks for the same SKU arrive in bursts
// (each sale changes stock), and the LLM call is too slow to hold a database lock across.
const running = new Map<string, Promise<RestockResult>>();

export function runRestock(shop: string, check: StockCheck): Promise<RestockResult> {
  const key = `${shop}|${check.variantId}`;
  const inFlight = running.get(key);
  if (inFlight) return inFlight.then(() => ({ outcome: "skipped" as const, reason: "a restock for this product was already running" }));

  const job = restock(shop, check).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function restock(shop: string, check: StockCheck): Promise<RestockResult> {
  let log = await auditEntries(shop);
  const rules = currentRuleSet(log);
  if (!rules) return { outcome: "skipped", reason: "no signed rules yet, so the agent is off" };
  // The merchant chooses what GuardBuy may buy, and from whom. Checked again by the policy engine.
  const managed = await isManaged(shop, check.variantId);
  if (!managed) return { outcome: "skipped", reason: `${check.sku} is not switched on for GuardBuy` };
  const offers = await offersForVariant(shop, check.variantId);
  if (!offers.length) return { outcome: "skipped", reason: `no suppliers linked to ${check.sku}` };

  const skip = skipReason(check, log);
  if (skip) return { outcome: "skipped", reason: skip };
  if (check.daysOfCover >= rules.reorderBelowDaysOfCover) {
    return { outcome: "skipped", reason: `${check.daysOfCover.toFixed(1)} days of cover is above the rule's ${rules.reorderBelowDaysOfCover}` };
  }

  // 1. The LLM proposes (untrusted). GuardBuy adds who gets paid; the LLM never supplies it.
  let proposal: RecordedProposal;
  try {
    const proposed = await proposePurchase({ check, rules, offers });
    const payee = offers.find((o) => o.supplierId === proposed.supplierId)?.paypalEmail;
    proposal = { ...proposed, variantId: check.variantId, payeeEmail: payee || undefined };
  } catch (e) {
    const reason = errorText(e);
    await appendAudit(shop, { type: "proposal_failed", sku: check.sku, variantId: check.variantId, reason });
    return { outcome: "failed", reason };
  }
  const stock = { available: check.available, perDay: Number(check.perDay.toFixed(2)), daysOfCover: Number(check.daysOfCover.toFixed(1)) };
  const p = await appendAudit(shop, { type: "proposal", proposal, stock });

  // 2. The policy engine decides (deterministic).
  log = await auditEntries(shop);
  const decision = evaluate(proposal, rules, policyContext(proposal, log, await paypalBalanceCents(), { managed, offers }));
  const d = await appendAudit(shop, { type: "decision", proposalSeq: p.seq, decision });
  const result: RestockResult = { outcome: decision.verdict, proposalSeq: p.seq, decisionSeq: d.seq };

  // 3. Only "auto" pays now; "approval" waits for a person, "block" stops here.
  if (decision.verdict === "auto") {
    try {
      result.payoutSeq = (await executePurchase(shop, d.seq)).seq;
    } catch (e) {
      // Logged so the SKU is retried later; paying the same decision again can never pay twice.
      result.error = errorText(e);
      await appendAudit(shop, { type: "payment_failed", decisionSeq: d.seq, reason: result.error });
    }
  }
  return result;
}
