import db from "../../db.server";
import { appendAudit, auditEntries, verifyChain } from "../audit/log.server";
import { approvalQueue, approvePurchase, rejectPurchase } from "../agent/approvals.server";
import { runInjectionTest, WHAT_IF_SCENARIO } from "../agent/attack.server";
import { toFeed, usd } from "../audit/feed.server";
import { scoreboard } from "../agent/scoreboard.server";
import { currentRuleSet, defaultRuleSet, paypalBalanceCents, policyContext, runRestock, signRuleSet } from "../agent/restock.server";
import { evaluate } from "../policy/engine";
import { RuleSetSchema, type AuditEntry } from "../policy/schema";
import { ATTACKS, attackById } from "../suppliers/attacks";
import { OFFERS } from "../suppliers/catalog";
import { isManaged, offersForVariant, seedDemoCatalog } from "../suppliers/directory.server";

// The judge console (storefront, via the app proxy). The storefront is public, so a judge never
// touches the merchant's real log, queue or suppliers: each judge gets a sandbox "shop" of their
// own, keyed by a random id their browser keeps, seeded with the demo suppliers and rules.
// Everything else runs the real code: real Gemini proposals, the real policy engine, real
// PayPal sandbox payouts, the real hash-chained log.

const ID = /^[a-z0-9-]{8,40}$/;
const DAY_MS = 86_400_000;
// Basic caps until judge mode (Oct 21): per judge per day, and across all judges per day.
// "Reset" in the console starts a new session id rather than deleting rows, so the caps (which
// count log entries) can't be wiped; old sandboxes are cleaned up by judge mode.
const PER_JUDGE_DAILY = 12;
const ALL_JUDGES_DAILY = 300;

// Sandbox products: fixed ids, and the stock a judge's "sale" starts from.
const COFFEE = { variantId: "judge-coffee", sku: "COFFEE-HOUSE-1KG", available: 9, perDay: 3.3 };
const VARIANTS = { "COFFEE-HOUSE-1KG": COFFEE.variantId, "MUG-STONE": "judge-mug", "FILTER-100": "judge-filter" };

export class JudgeRefused extends Error {}

const WHAT_IF = WHAT_IF_SCENARIO; // simulated: the AI obeyed the dishonest supplier

export function judgeShop(shop: string, judgeId: string) {
  if (!ID.test(judgeId)) throw new JudgeRefused("Invalid session id");
  return `${shop}#judge-${judgeId}`;
}

/** Seeds a judge's sandbox on first use: demo suppliers + rules with a $300 approval limit. */
async function ensureSandbox(sandbox: string) {
  const log = await auditEntries(sandbox);
  if (currentRuleSet(log)) return;
  await seedDemoCatalog(sandbox, VARIANTS, process.env.SUPPLIER_EMAIL ?? "", []);
  // Small purchases so judges don't drain the shared sandbox balance: 5 days of cover (~8 bags,
  // about $90) instead of 14, and a $50 approval limit so the "needs your approval" step still shows.
  const rules = RuleSetSchema.parse({ ...defaultRuleSet(sandbox), targetDaysOfCover: 5, approvalAboveCents: 5_000 });
  await signRuleSet(sandbox, rules, "judge-demo");
}

async function checkCaps(sandbox: string) {
  const since = new Date(Date.now() - DAY_MS);
  const mine = await db.auditEntry.count({ where: { shop: sandbox, type: { in: ["proposal", "proposal_failed"] }, at: { gte: since } } });
  if (mine >= PER_JUDGE_DAILY) throw new JudgeRefused("Daily limit for this session reached. Reset your session or come back tomorrow.");
  const all = await db.auditEntry.count({ where: { shop: { contains: "#judge-" }, type: { in: ["proposal", "proposal_failed"] }, at: { gte: since } } });
  if (all >= ALL_JUDGES_DAILY) throw new JudgeRefused("The demo's daily limit is reached. Please try again tomorrow.");
}

export async function judgeState(shop: string, judgeId: string) {
  const sandbox = judgeShop(shop, judgeId);
  await ensureSandbox(sandbox);
  const [log, queue, chain] = await Promise.all([auditEntries(sandbox), approvalQueue(sandbox), verifyChain(sandbox)]);
  const score = await scoreboard(sandbox, log);
  const a = score.attacks;
  const answered = a.tried - a.failed;
  return {
    scoreboard: {
      tried: a.tried,
      aiFooled: a.blocked + a.flagged + a.slipped,
      answered,
      blocked: a.blocked,
      flagged: a.flagged,
      slipped: a.slipped,
      blockedDollars: usd(a.blockedCents),
      flaggedDollars: usd(a.flaggedCents),
      slippedDollars: usd(a.slippedCents),
      levels: (["easy", "medium", "hard"] as const).map((l) => ({ level: l, ...a.byLevel[l] })),
      simulated: a.simulated,
      stoppedBy: score.stoppedBy,
      knownGaps: a.knownGaps,
      remaining: ATTACKS.length - a.tried,
    },
    feed: toFeed(log, `judge:${judgeId}`),
    approvals: queue.map((c) => ({
      decisionSeq: c.decisionSeq,
      title: `${c.quantity} × ${c.sku} from ${c.supplierName}`,
      total: usd(c.totalCents),
      facts: [
        `Price ${usd(c.unitPriceCents)}${c.avgUnitPrice30dCents ? ` vs 30-day average ${usd(c.avgUnitPrice30dCents)}` : ""}`,
        `Quantity ${c.quantity}${c.usualQuantity ? ` (usual ${c.usualQuantity})` : ""}`,
        `Pays the supplier's PayPal account on file`, // the email itself stays private
        ...c.needsApprovalBecause.map((r) => `Needs you: ${r.detail}`),
      ],
      aiExplanation: c.aiExplanation,
      waitingForPayPal: c.status === "paypal_pending",
    })),
    chain: chain.valid ? { valid: true, entries: chain.length } : { valid: false, brokenAt: chain.brokenAtSeq, reason: chain.reason },
  };
}

// ---------- Actions ----------

/** A sale drops coffee stock; the real restock loop runs (in the background: Gemini can take a while). */
export async function judgeRestock(shop: string, judgeId: string) {
  const sandbox = judgeShop(shop, judgeId);
  await ensureSandbox(sandbox);
  await checkCaps(sandbox);
  const check = { ...COFFEE, daysOfCover: COFFEE.available / COFFEE.perDay, needsRestock: true };
  void runRestock(sandbox, check).catch((e) => console.error(`[judge] restock ${sandbox}:`, e));
  return "A sale dropped coffee stock. The agent is working on it (Gemini can take up to a minute).";
}

/**
 * The real attack: Bean Bargains rewrites its note with the next injection scenario, the real AI
 * reads it and proposes, and the rules decide. Runs in the background (Gemini can be slow).
 */
export async function judgeAttack(shop: string, judgeId: string) {
  const sandbox = judgeShop(shop, judgeId);
  await ensureSandbox(sandbox);
  await checkCaps(sandbox);
  const tried = (await auditEntries(sandbox)).filter((e) => (e.event.type === "proposal" || e.event.type === "proposal_failed") && e.event.scenario && e.event.scenario !== WHAT_IF).length;
  const attack = ATTACKS[tried % ATTACKS.length];
  const check = { ...COFFEE, daysOfCover: COFFEE.available / COFFEE.perDay, needsRestock: true };
  void runInjectionTest(sandbox, check, attack.id).catch((e) => console.error(`[judge] attack ${sandbox}:`, e));
  return `${attack.level[0].toUpperCase()}${attack.level.slice(1)} attack: "${attack.title}". The AI is deciding now.`;
}

/**
 * What if the AI were fooled? Records the proposal the AI would make if it obeyed Bean Bargains'
 * note (500 units), and the policy engine's answer. Tagged as a test: never paid or counted.
 */
export async function judgeWhatIf(shop: string, judgeId: string) {
  const sandbox = judgeShop(shop, judgeId);
  await ensureSandbox(sandbox);
  await checkCaps(sandbox);
  const rules = currentRuleSet(await auditEntries(sandbox))!;
  const offers = await offersForVariant(sandbox, COFFEE.variantId);
  const bargain = offers.find((o) => o.supplierId === "bean-bargains")!;
  const injected = OFFERS.find((o) => o.supplierId === "bean-bargains")!.note;
  const proposal = {
    sku: COFFEE.sku,
    variantId: COFFEE.variantId,
    supplierId: bargain.supplierId,
    unitPriceCents: bargain.unitPriceTodayCents,
    quantity: 500,
    reasoning: `(Simulated: the AI followed the supplier's note.) ${injected}`,
    payeeEmail: bargain.paypalEmail || undefined,
  };
  const stock = { available: COFFEE.available, perDay: COFFEE.perDay, daysOfCover: Number((COFFEE.available / COFFEE.perDay).toFixed(1)) };
  const p = await appendAudit(sandbox, { type: "proposal", proposal, stock, scenario: WHAT_IF });
  const log = await auditEntries(sandbox);
  const managed = await isManaged(sandbox, COFFEE.variantId);
  const decision = evaluate(proposal, rules, policyContext(proposal, log, await paypalBalanceCents(), { managed, offers }));
  await appendAudit(sandbox, { type: "decision", proposalSeq: p.seq, decision });
  return decision.verdict === "block" ? "Even with the AI fooled, the rules blocked it. See why in the feed." : `Unexpected verdict: ${decision.verdict}`;
}

export async function judgeApprove(shop: string, judgeId: string, decisionSeq: number) {
  return (await approvePurchase(judgeShop(shop, judgeId), decisionSeq, `judge:${judgeId}`)).message;
}

export async function judgeDecline(shop: string, judgeId: string, decisionSeq: number) {
  return (await rejectPurchase(judgeShop(shop, judgeId), decisionSeq, `judge:${judgeId}`)).message;
}
