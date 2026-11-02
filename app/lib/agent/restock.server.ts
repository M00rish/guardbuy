import db from "../../db.server";
import { deliveries } from "../inventory/deliveries";
import { appendAudit, auditEntries } from "../audit/log.server";
import type { StockCheck } from "../inventory/trigger.server";
import { paypal } from "../paypal/client.server";
import { evaluate, SPLIT_WINDOW_HOURS, type PolicyContext } from "../policy/engine";
import { hashOf } from "../policy/hash";
import { RuleSetSchema, type AuditEntry, type RecordedProposal, type RuleSet } from "../policy/schema";
import { isManaged, offersForVariant, supplierRoster, type Offer, type RosterEntry } from "../suppliers/directory.server";
import { lookalikeOf } from "../policy/lookalike";
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

/** A purchase waiting for approval expires after this long: it can't be paid, and the product is re-proposed with fresh numbers. */
export const APPROVAL_TTL_MS = 48 * 60 * 60_000;
export const approvalExpired = (decisionAt: string, now = new Date()) => now.getTime() - Date.parse(decisionAt) >= APPROVAL_TTL_MS;

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
    priceToleranceCents: 50, // $0.50 per unit
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

/** Whether the agent is running: on once rules are signed, unless the merchant paused it since. */
export function agentOn(log: AuditEntry[]) {
  const last = log.filter((e) => e.event.type === "agent_state").at(-1);
  return last?.event.type === "agent_state" ? last.event.on : true;
}

export function setAgentState(shop: string, on: boolean, by: string) {
  return appendAudit(shop, { type: "agent_state", on, by });
}

export function signRuleSet(shop: string, rules: RuleSet, signedBy: string) {
  return appendAudit(shop, {
    type: "ruleset_signed",
    ruleSet: { rules, hash: hashOf(rules), signedBy, signedAt: new Date().toISOString() },
  });
}

/**
 * PayPal available balance in cents, or null if it can't be read (the policy then asks a person).
 * PayPal's balance report lags (minutes to hours), so GuardBuy's own payments made after the
 * report's "as of" time are subtracted; a burst of purchases can't all see the same stale balance.
 * (Demo: one PayPal account serves every shop, so payments from all shops count.)
 */
export async function paypalBalanceCents(): Promise<number | null> {
  try {
    const res = await paypal<{ as_of_time?: string; balances?: { currency: string; available_balance?: { value: string } }[] }>(
      "/v1/reporting/balances?currency_code=USD",
    );
    const usd = res.balances?.find((b) => b.currency === "USD")?.available_balance?.value;
    if (usd === undefined) return null;
    return adjustForLag(Math.round(Number(usd) * 100), res.as_of_time ? new Date(res.as_of_time) : null);
  } catch (e) {
    console.warn(`[restock] balance unavailable: ${(e as Error).message}`);
    return null;
  }
}

async function adjustForLag(reportedCents: number, asOf: Date | null) {
  if (!asOf || Number.isNaN(asOf.getTime())) return reportedCents;
  const since = await db.auditEntry.findMany({ where: { type: { in: ["payout", "order_captured"] }, at: { gt: asOf } }, select: { event: true } });
  return reportedCents - sinceTotal(since.map((r) => r.event as { amountCents?: number }));
}

/** Sum of amounts paid after the balance report (exported for checks). */
export const sinceTotal = (events: { amountCents?: number }[]) => events.reduce((sum, e) => sum + (e.amountCents ?? 0), 0);

/** When a payout's latest known status shows the money didn't reach (or stay with) the supplier. */
function payoutFailedAt(payout: AuditEntry, log: AuditEntry[]): string | null {
  if (payout.event.type !== "payout") return null;
  const latest = log.filter((e) => e.event.type === "payout_status" && e.event.payoutSeq === payout.seq).at(-1);
  if (latest?.event.type === "payout_status") return PAYOUT_FAILED.has(latest.event.status) ? latest.at : null;
  return PAYOUT_FAILED.has(payout.event.status) ? payout.at : null;
}

/**
 * Money committed over the rolling windows the rules use: payouts that didn't fail, captured PayPal
 * orders, and purchases still waiting for approval (they'd be paid if approved). `exclude` is the
 * decision being paid right now, so it doesn't count against itself.
 */
export function spending(log: AuditEntry[], now = new Date(), exclude?: number) {
  const paid = log.flatMap((e) => {
    if (e.event.type === "payout" && !payoutFailedAt(e, log) && e.event.decisionSeq !== exclude) return [{ at: e.at, cents: e.event.amountCents }];
    if (e.event.type === "order_captured" && e.event.decisionSeq !== exclude) {
      // Refunded money no longer counts as spent.
      const orderId = e.event.orderId;
      const status = log.filter((x) => x.event.type === "order_status" && x.event.orderId === orderId).at(-1);
      const refunded = status?.event.type === "order_status" ? status.event.refundedCents : 0;
      const cents = Math.max(0, e.event.amountCents - refunded);
      return cents > 0 ? [{ at: e.at, cents }] : [];
    }
    return [];
  });
  const since = (ms: number) => paid.filter((s) => now.getTime() - Date.parse(s.at) < ms);
  return {
    spentLast7dCents: since(7 * DAY_MS).reduce((sum, s) => sum + s.cents, 0),
    purchasesLast24h: since(DAY_MS).length,
    pendingCents: pendingApprovalCents(log, now, exclude),
  };
}

/** Total of purchases waiting for approval (not expired, not paid, declined or tests). */
export function pendingApprovalCents(log: AuditEntry[], now = new Date(), exclude?: number) {
  let total = 0;
  for (const d of log) {
    if (d.event.type !== "decision" || d.event.decision.verdict !== "approval" || d.seq === exclude || approvalExpired(d.at, now)) continue;
    const proposalSeq = d.event.proposalSeq;
    const p = log.find((e) => e.seq === proposalSeq);
    if (p?.event.type === "proposal" && p.event.scenario) continue;
    const settled = log.some(
      (e) => "decisionSeq" in e.event && e.event.decisionSeq === d.seq && ["payout", "order_captured", "rejected", "payment_failed"].includes(e.event.type),
    );
    if (!settled) total += d.event.decision.totalCents;
  }
  return total;
}

type Commitment = { at: string; proposal: RecordedProposal; cents: number; paid: boolean };

/**
 * Real purchases that are paid (payouts that didn't fail, captured orders net of refunds) or waiting
 * for approval, oldest first, with the proposal behind each. Tests and `exclude` are left out.
 */
function commitments(log: AuditEntry[], now: Date, exclude?: number): Commitment[] {
  const proposalOf = (decisionSeq: number) => {
    const d = log.find((e) => e.seq === decisionSeq);
    if (d?.event.type !== "decision") return null;
    const proposalSeq = d.event.proposalSeq;
    const p = log.find((e) => e.seq === proposalSeq);
    return p?.event.type === "proposal" && !p.event.scenario ? p.event.proposal : null;
  };
  const out: Commitment[] = [];
  for (const e of log) {
    const ev = e.event;
    if ("decisionSeq" in ev && ev.decisionSeq === exclude) continue;
    if (ev.type === "payout" && !payoutFailedAt(e, log)) {
      const proposal = proposalOf(ev.decisionSeq);
      if (proposal) out.push({ at: e.at, proposal, cents: ev.amountCents, paid: true });
    } else if (ev.type === "order_captured") {
      const status = log.filter((x) => x.event.type === "order_status" && x.event.orderId === ev.orderId).at(-1);
      const cents = Math.max(0, ev.amountCents - (status?.event.type === "order_status" ? status.event.refundedCents : 0));
      const proposal = proposalOf(ev.decisionSeq);
      if (proposal && cents > 0) out.push({ at: e.at, proposal, cents, paid: true });
    } else if (ev.type === "decision" && ev.decision.verdict === "approval" && e.seq !== exclude && !approvalExpired(e.at, now)) {
      const settled = log.some((x) => "decisionSeq" in x.event && x.event.decisionSeq === e.seq && ["payout", "order_captured", "rejected", "payment_failed"].includes(x.event.type));
      const p = log.find((x) => x.seq === ev.proposalSeq);
      if (!settled && p?.event.type === "proposal" && !p.event.scenario) out.push({ at: e.at, proposal: p.event.proposal, cents: ev.decision.totalCents, paid: false });
    }
  }
  return out;
}

/** Everything the policy engine needs, built from the audit log and the merchant's own offers. */
export function policyContext(
  proposal: RecordedProposal,
  log: AuditEntry[],
  balanceCents: number | null,
  merchant: { managed: boolean; offers: Offer[]; suppliers?: RosterEntry[] }, // suppliers: every supplier of the shop (defaults to the offers')
  now = new Date(),
  exclude?: number, // the decision being paid right now (re-check at payment time)
): PolicyContext {
  const offer = merchant.offers.find((o) => o.supplierId === proposal.supplierId);
  const { spentLast7dCents, purchasesLast24h, pendingCents } = spending(log, now, exclude);
  return {
    productManaged: merchant.managed,
    supplierLinked: !!offer,
    usualQuantity: offer?.usualQuantity ?? 0,
    spentLast7dCents: spentLast7dCents + pendingCents, // committed: paid plus waiting for approval
    purchasesLast24h,
    paypalBalanceCents: balanceCents,
    payeeChangedDaysAgo: offer?.paypalEmailChangedAt ? (now.getTime() - Date.parse(offer.paypalEmailChangedAt)) / DAY_MS : null,
    ...historyContext(proposal, log, merchant, offer, now, exclude),
  };
}

/** Order-size history, split orders and supplier age for one proposal. */
function historyContext(
  proposal: RecordedProposal,
  log: AuditEntry[],
  merchant: { offers: Offer[]; suppliers?: RosterEntry[] },
  offer: Offer | undefined,
  now: Date,
  exclude?: number,
): Pick<PolicyContext, "recentPaidQuantities" | "sameSupplierLast24hCents" | "supplierAddedDaysAgo" | "supplierPaidBefore" | "lookalikeOf" | "acceptedUnitPriceCents"> {
  const sameProduct = (p: RecordedProposal) => (proposal.variantId && p.variantId ? p.variantId === proposal.variantId : p.sku === proposal.sku);
  const all = commitments(log, now, exclude);
  const fromSupplier = all.filter((c) => c.proposal.supplierId === proposal.supplierId);
  const roster = merchant.suppliers ?? merchant.offers.map((o) => ({ id: o.supplierId, name: o.supplierName, addedAt: o.supplierAddedAt }));
  const addedAt = offer?.supplierAddedAt ? Date.parse(offer.supplierAddedAt) : null;
  const older = addedAt === null ? [] : roster.filter((r) => r.id !== proposal.supplierId && Date.parse(r.addedAt) < addedAt).map((r) => r.name);
  return {
    recentPaidQuantities: all.filter((c) => c.paid && sameProduct(c.proposal)).map((c) => c.proposal.quantity),
    sameSupplierLast24hCents: fromSupplier
      .filter((c) => sameProduct(c.proposal) && now.getTime() - Date.parse(c.at) < SPLIT_WINDOW_HOURS * 3_600_000)
      .reduce((sum, c) => sum + c.cents, 0),
    supplierAddedDaysAgo: addedAt === null ? null : (now.getTime() - addedAt) / DAY_MS,
    supplierPaidBefore: fromSupplier.filter((c) => c.paid).length,
    lookalikeOf: offer ? lookalikeOf(offer.supplierName, older) : null,
    acceptedUnitPriceCents: offer ? acceptedUnitPrice(proposal, log, offer, exclude) : null,
  };
}

/**
 * The merchant's price for this product from this supplier: what they entered when linking, raised
 * only by purchases a person approved (in GuardBuy or in PayPal), never by automatic ones.
 */
export function acceptedUnitPrice(proposal: RecordedProposal, log: AuditEntry[], offer: Offer, exclude?: number) {
  const sameProduct = (p: RecordedProposal) => (proposal.variantId && p.variantId ? p.variantId === proposal.variantId : p.sku === proposal.sku);
  const approved = approvedPrices(log, exclude).filter((a) => sameProduct(a) && a.supplierId === proposal.supplierId);
  return Math.max(offer.acceptedUnitPriceCents, ...approved.map((a) => a.unitPriceCents));
}

/** Proposals a person approved: approved in GuardBuy (then paid or not) or paid through a PayPal order they approved. */
function approvedPrices(log: AuditEntry[], exclude?: number): RecordedProposal[] {
  const out: RecordedProposal[] = [];
  for (const e of log) {
    if ((e.event.type !== "approved" && e.event.type !== "order_captured") || e.event.decisionSeq === exclude) continue;
    const decisionSeq = e.event.decisionSeq;
    const d = log.find((x) => x.seq === decisionSeq);
    if (d?.event.type !== "decision") continue;
    const proposalSeq = d.event.proposalSeq;
    const p = log.find((x) => x.seq === proposalSeq);
    if (p?.event.type === "proposal" && !p.event.scenario) out.push(p.event.proposal);
  }
  return out;
}

/**
 * Why this SKU should not get a new proposal right now, or null if it should.
 * Only a restock that is paid or waiting for approval keeps the SKU covered; a blocked proposal,
 * a failed LLM call or a failed payment frees it again after a short wait.
 */
export function skipReason(item: { variantId: string; sku: string }, log: AuditEntry[], now = new Date()): string | null {
  // Matched by variant (SKUs can be shared); entries without a variant id fall back to the SKU.
  const outstanding = deliveries(log).find((d) => d.variantId === item.variantId && (d.remaining > 0 || d.pending) && (d.payment !== "failed" || d.pending));
  if (outstanding) return `restock #${outstanding.decisionSeq} is already open: ${outstanding.remaining} units awaiting delivery${outstanding.pending ? " (receipt needs confirmation)" : ""}`;
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
    if (failedAt) return wait(failedAt, RETRY_AFTER_BLOCK_MS, `payout for #${last.seq} failed`);
    // Fully received variant orders no longer block a future restock. Legacy SKU-only logs retain their old cooldown.
    return last.event.type === "proposal" && last.event.proposal.variantId ? null : open();
  }
  if (ofDecision("order_captured").length) return last.event.type === "proposal" && last.event.proposal.variantId ? null : open();
  const rejected = ofDecision("rejected").at(-1);
  if (rejected) return wait(rejected.at, RETRY_AFTER_REJECT_MS, `restock #${last.seq} was declined`);
  const failed = ofDecision("payment_failed").at(-1);
  if (failed) return wait(failed.at, RETRY_AFTER_BLOCK_MS, `payment for #${last.seq} failed`);
  if (verdict === "approval") return approvalExpired(decision.at, now) ? null : open(); // waiting for a person (until it expires)
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
  if (!agentOn(log)) return { outcome: "skipped", reason: "the merchant paused the agent" };
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
  const decision = evaluate(proposal, rules, policyContext(proposal, log, await paypalBalanceCents(), { managed, offers, suppliers: await supplierRoster(shop) }));
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
