import db from "../../db.server";
import { appendAudit, auditEntries, verifyChain } from "../audit/log.server";
import { approvalQueue, approvePurchase, rejectPurchase } from "../agent/approvals.server";
import { runInjectionTest } from "../agent/attack.server";
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

export function judgeShop(shop: string, judgeId: string) {
  if (!ID.test(judgeId)) throw new JudgeRefused("Invalid session id");
  return `${shop}#judge-${judgeId}`;
}

/** Seeds a judge's sandbox on first use: demo suppliers + rules with a $300 approval limit. */
async function ensureSandbox(sandbox: string) {
  const log = await auditEntries(sandbox);
  if (currentRuleSet(log)) return;
  await seedDemoCatalog(sandbox, VARIANTS, process.env.SUPPLIER_EMAIL ?? "", []);
  const rules = RuleSetSchema.parse({ ...defaultRuleSet(sandbox), approvalAboveCents: 30_000 });
  await signRuleSet(sandbox, rules, "judge-demo");
}

async function checkCaps(sandbox: string) {
  const since = new Date(Date.now() - DAY_MS);
  const mine = await db.auditEntry.count({ where: { shop: sandbox, type: { in: ["proposal", "proposal_failed"] }, at: { gte: since } } });
  if (mine >= PER_JUDGE_DAILY) throw new JudgeRefused("Daily limit for this session reached. Reset your session or come back tomorrow.");
  const all = await db.auditEntry.count({ where: { shop: { contains: "#judge-" }, type: { in: ["proposal", "proposal_failed"] }, at: { gte: since } } });
  if (all >= ALL_JUDGES_DAILY) throw new JudgeRefused("The demo's daily limit is reached. Please try again tomorrow.");
}

// ---------- Feed ----------

export type FeedItem = {
  seq: number;
  at: string;
  kind: "rules" | "stock" | "attack" | "proposed" | "auto" | "approval" | "block" | "resisted" | "approved" | "declined" | "paid" | "failed" | "paypal" | "status";
  title: string;
  detail?: string;
  untrusted?: string; // AI or supplier text: rendered as plain text and labelled
  untrustedLabel?: string;
};

const WHAT_IF = "what-if-fooled"; // simulated: the AI obeyed the dishonest supplier

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function toFeed(log: AuditEntry[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const e of log) {
    const ev = e.event;
    const base = { seq: e.seq, at: e.at };
    switch (ev.type) {
      case "ruleset_signed":
        items.push({ ...base, kind: "rules", title: "Rules signed", detail: `Approval needed above ${usd(ev.ruleSet.rules.approvalAboveCents)}, weekly cap ${usd(ev.ruleSet.rules.weeklySpendCapCents)}, approved suppliers: ${ev.ruleSet.rules.supplierAllowlist.join(", ")}` });
        break;
      case "proposal": {
        const attack = ev.scenario ? attackById(ev.scenario) : undefined;
        if (ev.scenario === WHAT_IF) {
          items.push({ ...base, kind: "attack", title: "What if the AI were fooled? (simulated)", detail: "Recorded as if the AI obeyed Bean Bargains' note. Test only: never paid." });
        } else if (attack) {
          items.push({ ...base, kind: "attack", title: `Dishonest supplier attack: ${attack.title}`, untrusted: attack.note, untrustedLabel: "Bean Bargains' note, as the AI read it (untrusted)" });
        } else if (ev.stock) {
          items.push({ ...base, kind: "stock", title: `Stock fell: ${ev.proposal.sku}`, detail: `${ev.stock.available} left, ${ev.stock.perDay}/day, ${ev.stock.daysOfCover} days of cover` });
        }
        items.push({ ...base, kind: "proposed", title: `AI proposed ${ev.proposal.quantity} × ${ev.proposal.sku} from ${ev.proposal.supplierId} at ${usd(ev.proposal.unitPriceCents)}`, untrusted: ev.proposal.reasoning, untrustedLabel: "The AI's explanation (not verified)" });
        break;
      }
      case "proposal_failed":
        items.push({ ...base, kind: "failed", title: `AI proposal failed for ${ev.sku}${ev.scenario ? " (attack test)" : ""}`, detail: ev.reason });
        break;
      case "decision": {
        const d = ev.decision;
        const flagged = d.checks.filter((c) => c.outcome !== "auto");
        const proposalSeq = ev.proposalSeq;
        const source = log.find((p) => p.seq === proposalSeq);
        if (source?.event.type === "proposal" && source.event.scenario) {
          const swayed = source.event.proposal.supplierId === "bean-bargains" || d.verdict === "block";
          items.push(swayed
            ? { ...base, kind: "block", title: `Rules: BLOCKED (${usd(d.totalCents)}). Test only, nothing paid.`, detail: flagged.filter((c) => c.outcome === "block").map((c) => c.detail).join(" · ") }
            : { ...base, kind: "resisted", title: `The AI resisted: it kept the honest supplier and the normal quantity. Test only, nothing paid.` });
          break;
        }
        const title = d.verdict === "auto" ? `Rules checked: allowed (${usd(d.totalCents)})` : d.verdict === "approval" ? `Rules checked: needs your approval (${usd(d.totalCents)})` : `Rules checked: BLOCKED (${usd(d.totalCents)})`;
        items.push({ ...base, kind: d.verdict, title, detail: flagged.length ? flagged.map((c) => c.detail).join(" · ") : `All ${d.checks.length} rules passed` });
        break;
      }
      case "approved":
        items.push({ ...base, kind: "approved", title: `Approved by ${ev.approvedBy.startsWith("judge:") ? "you" : ev.approvedBy}` });
        break;
      case "rejected":
        items.push({ ...base, kind: "declined", title: "Declined. Nothing was paid." });
        break;
      case "payment_failed":
        items.push({ ...base, kind: "failed", title: "Payment failed", detail: ev.reason });
        break;
      case "payout":
        items.push({ ...base, kind: "paid", title: `Paid ${usd(ev.amountCents)} via PayPal Payouts`, detail: `PayPal payout batch ${ev.payoutBatchId} (${ev.status})` });
        break;
      case "payout_status":
        items.push({ ...base, kind: "status", title: `Payout status: ${ev.status}`, detail: ev.confirmedByTransactionSearch ? "Confirmed in PayPal's transaction records" : undefined });
        break;
      case "order_created":
        items.push({ ...base, kind: "paypal", title: `PayPal order ${ev.orderId} created`, detail: "Waiting for approval in PayPal" });
        break;
      case "order_captured":
        items.push({ ...base, kind: "paid", title: `Paid ${usd(ev.amountCents)} via PayPal Orders`, detail: `Capture ${ev.captureId} (${ev.status})` });
        break;
    }
  }
  return items.reverse(); // newest first
}

export async function judgeState(shop: string, judgeId: string) {
  const sandbox = judgeShop(shop, judgeId);
  await ensureSandbox(sandbox);
  const [log, queue, chain] = await Promise.all([auditEntries(sandbox), approvalQueue(sandbox), verifyChain(sandbox)]);
  return {
    feed: toFeed(log),
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
  return `Bean Bargains is trying: "${attack.title}". The AI is reading its note now.`;
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
