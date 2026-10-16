import { appendAudit, auditEntries } from "../audit/log.server";
import type { StockCheck } from "../inventory/trigger.server";
import { paypal } from "../paypal/client.server";
import { evaluate, type PolicyContext } from "../policy/engine";
import { hashOf } from "../policy/hash";
import { RuleSetSchema, type AuditEntry, type Proposal, type RuleSet } from "../policy/schema";
import { averagePrice, offersFor } from "../suppliers/catalog";
import { executePurchase } from "./execute.server";
import { proposePurchase } from "./proposer.server";

// The restock loop: low stock -> LLM proposal -> policy decision -> payout (only if "auto").
// Each step is written to the audit log before the next one runs, so the log always shows
// how far a restock got and why it stopped.

const DAY_MS = 86_400_000;
const OPEN_RESTOCK_MS = 3 * DAY_MS; // a paid or pending restock covers the SKU for this long (until stock-in-transit tracking)
const RETRY_AFTER_BLOCK_MS = 60 * 60_000; // after a blocked proposal, wait before asking the LLM again

/** Demo rules until merchants sign their own (merchant UI task). */
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

/** The latest signed rule set in the log; signs the demo defaults the first time. */
export async function activeRuleSet(shop: string, log: AuditEntry[]): Promise<RuleSet> {
  const signed = log.filter((e) => e.event.type === "ruleset_signed").at(-1);
  if (signed?.event.type === "ruleset_signed") return signed.event.ruleSet.rules;

  const rules = defaultRuleSet(shop);
  await appendAudit(shop, {
    type: "ruleset_signed",
    ruleSet: { rules, hash: hashOf(rules), signedBy: "guardbuy-defaults", signedAt: new Date().toISOString() },
  });
  return rules;
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

/** Everything the policy engine needs, built from the audit log and the catalog. */
export function policyContext(
  proposal: Proposal,
  log: AuditEntry[],
  balanceCents: number | null,
  now = new Date(),
): PolicyContext {
  const offer = offersFor(proposal.sku).find((o) => o.supplierId === proposal.supplierId);
  // Money that left: payouts plus captured PayPal orders.
  const spent = log.flatMap((e) =>
    e.event.type === "payout" || e.event.type === "order_captured" ? [{ at: e.at, cents: e.event.amountCents }] : [],
  );
  const since = (ms: number) => spent.filter((s) => now.getTime() - Date.parse(s.at) < ms);

  return {
    // An offer outside the catalog has no history: 0 makes the price check block it.
    avgUnitPrice30dCents: offer ? averagePrice(offer, now) : 0,
    usualQuantity: offer?.usualQuantity ?? 0,
    spentLast7dCents: since(7 * DAY_MS).reduce((sum, s) => sum + s.cents, 0),
    purchasesLast24h: since(DAY_MS).length,
    paypalBalanceCents: balanceCents,
  };
}

/** Why this SKU should not get a new proposal right now, or null if it should. */
export function skipReason(sku: string, log: AuditEntry[], now = new Date()): string | null {
  for (const p of log.filter((e) => e.event.type === "proposal" && e.event.proposal.sku === sku).reverse()) {
    const age = now.getTime() - Date.parse(p.at);
    const decision = log.find((e) => e.event.type === "decision" && e.event.proposalSeq === p.seq);
    const verdict = decision?.event.type === "decision" ? decision.event.decision.verdict : undefined;

    if (verdict === "block" || !decision) {
      if (age < RETRY_AFTER_BLOCK_MS) return `proposal #${p.seq} was ${verdict ? "blocked" : "left undecided"} less than an hour ago`;
      continue;
    }
    if (age < OPEN_RESTOCK_MS) return `restock #${p.seq} (${verdict}) is already open`;
  }
  return null;
}

export type RestockResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "auto" | "approval" | "block"; proposalSeq: number; decisionSeq: number; payoutSeq?: number; error?: string };

// One restock at a time per shop + SKU in this process. Webhooks for the same SKU arrive in bursts
// (each sale changes stock), and the LLM call is too slow to hold a database lock across.
const running = new Map<string, Promise<RestockResult>>();

export function runRestock(shop: string, check: StockCheck): Promise<RestockResult> {
  const key = `${shop}|${check.sku}`;
  const inFlight = running.get(key);
  if (inFlight) return inFlight.then(() => ({ outcome: "skipped" as const, reason: "a restock for this SKU was already running" }));

  const job = restock(shop, check).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}

async function restock(shop: string, check: StockCheck): Promise<RestockResult> {
  let log = await auditEntries(shop);
  const skip = skipReason(check.sku, log);
  if (skip) return { outcome: "skipped", reason: skip };

  const rules = await activeRuleSet(shop, log);
  if (check.daysOfCover >= rules.reorderBelowDaysOfCover) {
    return { outcome: "skipped", reason: `${check.daysOfCover.toFixed(1)} days of cover is above the rule's ${rules.reorderBelowDaysOfCover}` };
  }

  // 1. The LLM proposes (untrusted).
  const proposal = await proposePurchase({ check, rules });
  const p = await appendAudit(shop, { type: "proposal", proposal });

  // 2. The policy engine decides (deterministic).
  log = await auditEntries(shop);
  const decision = evaluate(proposal, rules, policyContext(proposal, log, await paypalBalanceCents()));
  const d = await appendAudit(shop, { type: "decision", proposalSeq: p.seq, decision });
  const result: RestockResult = { outcome: decision.verdict, proposalSeq: p.seq, decisionSeq: d.seq };

  // 3. Only "auto" pays now; "approval" waits for a person, "block" stops here.
  if (decision.verdict === "auto") {
    try {
      result.payoutSeq = (await executePurchase(shop, d.seq)).seq;
    } catch (e) {
      // The decision stays in the log; the payout can be retried for the same decision without paying twice.
      result.error = (e as Error).message;
    }
  }
  return result;
}
