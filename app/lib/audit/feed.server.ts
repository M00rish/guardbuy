import { APPROVAL_LABEL, COPY, PAYMENT_LABEL, providerStatusLabel } from "../wording";
import { paymentStatus } from "../payments/status";
import type { AuditEntry } from "../policy/schema";
import { usd } from "../format";
import { classifyAttack, WHAT_IF_SCENARIO } from "../agent/attack.server";
import { attackById } from "../suppliers/attacks";

export type FeedItem = {
  seq: number;
  at: string;
  kind: "receipt_started" | "stock_received" | "delivery" | "rules" | "stock" | "attack" | "proposed" | "auto" | "approval" | "block" | "resisted" | "flagged" | "slipped" | "approved" | "declined" | "paid" | "failed" | "paypal" | "status";
  title: string;
  byYou?: boolean;
  detail?: string;
  untrusted?: string; // AI or supplier text: rendered as plain text and labelled
  untrustedLabel?: string;
  verifyId?: string; // PayPal id to look up on the public verify page (payments only)
};

const WHAT_IF = WHAT_IF_SCENARIO; // simulated: the AI obeyed the dishonest supplier

export { usd } from "../format";

const actor = (by: string, you?: string) =>
  you && by === you ? "you" : by.startsWith("shopify-staff:") ? "a staff member" : by.startsWith("judge:") ? "a demo judge" : "the recorded operator";

/**
 * The audit log as readable lines, newest first: used by the admin Activity page and the judge
 * console. Untrusted text (AI explanations, supplier notes) is kept separate and labelled; the
 * callers render it as plain text. `you` is the actor id to show as "you".
 */
export type FeedNames = { product?: (sku: string, variantId?: string) => string | undefined; supplier?: (id: string) => string | undefined };

export function toFeed(log: AuditEntry[], you?: string, names: FeedNames = {}): FeedItem[] {
  const items: FeedItem[] = [];
  const product = (sku: string, variantId?: string) => names.product?.(sku, variantId) ?? sku;
  const supplier = (id: string) => names.supplier?.(id) ?? id;
  /** "38 × House Blend Coffee 1kg from Atlas Roasters" for the purchase behind a decision. */
  const purchaseOf = (decisionSeq: number) => {
    const d = log.find((x) => x.seq === decisionSeq);
    const p = d?.event.type === "decision" ? log.find((x) => x.seq === (d.event.type === "decision" ? d.event.proposalSeq : -1)) : undefined;
    return p?.event.type === "proposal"
      ? `${p.event.proposal.quantity} × ${product(p.event.proposal.sku, p.event.proposal.variantId)} from ${supplier(p.event.proposal.supplierId)}`
      : undefined;
  };
  for (const e of log) {
    const ev = e.event;
    const base = { seq: e.seq, at: e.at };
    switch (ev.type) {
      case "payment_attempt":
        items.push({ ...base, kind: "paypal", title: `Payment started for purchase #${ev.decisionSeq}.`, detail: "PayPal confirmation is pending; the request ID and payment details are fixed." });
        break;
      case "payment_outcome":
        items.push({ ...base, kind: ev.status === "unknown" ? "paypal" : "failed", title: ev.status === "unknown" ? `${PAYMENT_LABEL.unknown} for purchase #${ev.decisionSeq}.` : `${PAYMENT_LABEL.failed} for purchase #${ev.decisionSeq}.` });
        break;
      case "delivery_estimate_updated":
        items.push({ ...base, kind: "delivery", byYou: ev.updatedBy === you, title: `Expected arrival updated for purchase #${ev.decisionSeq}.`, detail: `${ev.expectedAt.slice(0, 10)} (merchant estimate, UTC) by ${actor(ev.updatedBy, you)}` });
        break;
      case "delivery_remainder_closed":
        items.push({ ...base, kind: "delivery", byYou: ev.closedBy === you, title: `Delivery closed for ${ev.quantity} undelivered ${ev.quantity === 1 ? "unit" : "units"} in purchase #${ev.decisionSeq}.`, detail: `${ev.reason === "supplier_cancelled" ? "Supplier cancelled" : "Confirmed not arriving"} · ${actor(ev.closedBy, you)}. No inventory adjustment or refund.` });
        break;
      case "receipt_started":
        items.push({ ...base, kind: "receipt_started", byYou: ev.receivedBy === you, title: `Stock receipt started for ${ev.quantity} ${ev.quantity === 1 ? "unit" : "units"} in purchase #${ev.decisionSeq}.` });
        break;
      case "receipt_received":
        items.push({ ...base, kind: "stock_received", byYou: ev.receivedBy === you, title: `Stock received: ${ev.quantity} ${ev.quantity === 1 ? "unit" : "units"} for purchase #${ev.decisionSeq}.`, detail: `Shopify stock updated by ${actor(ev.receivedBy, you)}` });
        break;
      case "receipt_rejected":
        items.push({ ...base, kind: "failed", title: `Stock receipt rejected for purchase #${ev.decisionSeq}.` });
        break;
      case "ruleset_signed":
        items.push({ ...base, kind: "rules", byYou: ev.ruleSet.signedBy === you, title: `Rules signed by ${actor(ev.ruleSet.signedBy, you)}.`, detail: `Approval needed above ${usd(ev.ruleSet.rules.approvalAboveCents)}, 7-day spending cap ${usd(ev.ruleSet.rules.weeklySpendCapCents)}, approved suppliers: ${ev.ruleSet.rules.supplierAllowlist.join(", ")}` });
        break;
      case "proposal": {
        const attack = ev.scenario ? attackById(ev.scenario) : undefined;
        if (ev.scenario === WHAT_IF) {
          items.push({ ...base, kind: "attack", title: "Attack test simulated an AI following a dishonest supplier note.", detail: "Recorded as if the AI obeyed Bean Bargains' note. Test only: never paid." });
        } else if (attack) {
          const notes = Object.values(attack.setup.notes ?? {}).join(" / ");
          const quiet = [
            attack.setup.payeeChange && `the supplier's PayPal address was changed to ${attack.setup.payeeChange.email}`,
            attack.setup.lookalike && `staff added "${attack.setup.lookalike.name}" as a supplier`,
            attack.setup.perDay && `fake orders pushed sales to ${attack.setup.perDay}/day`,
          ].filter(Boolean).join("; ");
          items.push({
            ...base, kind: "attack",
            title: `Attack test started: ${attack.title}.`,
            detail: `Copies: ${attack.realWorld}.${quiet ? ` Setup: ${quiet}.` : ""}`,
            ...(notes ? { untrusted: notes, untrustedLabel: "Supplier note the AI read (written by the attacker)" } : {}),
          });
        } else if (ev.stock) {
          items.push({ ...base, kind: "stock", title: `Stock low for ${product(ev.proposal.sku, ev.proposal.variantId)}.`, detail: `${ev.stock.available} left, ${ev.stock.perDay}/day, ${ev.stock.daysOfCover} days of cover` });
        }
        items.push({ ...base, kind: "proposed", title: `Purchase proposed: ${ev.proposal.quantity} × ${product(ev.proposal.sku, ev.proposal.variantId)} from ${supplier(ev.proposal.supplierId)}.`, detail: `Price per unit: ${usd(ev.proposal.unitPriceCents)}`, untrusted: ev.proposal.reasoning, untrustedLabel: COPY.aiExplanation });
        break;
      }
      case "proposal_failed":
        items.push({ ...base, kind: "failed", title: `Purchase proposal failed for ${product(ev.sku, ev.variantId)}${ev.scenario ? " in an attack test" : ""}.`, detail: ev.reason });
        break;
      case "decision": {
        const d = ev.decision;
        const flagged = d.checks.filter((c) => c.outcome !== "auto");
        const proposalSeq = ev.proposalSeq;
        const source = log.find((p) => p.seq === proposalSeq);
        if (source?.event.type === "proposal" && source.event.scenario) {
          const attack = attackById(source.event.scenario);
          const outcome = attack ? classifyAttack(attack, source.event.proposal, d.verdict) : d.verdict === "block" ? "blocked" : "resisted";
          const reasons = flagged.map((c) => c.detail).join(" · ");
          const tail = "Attack test only; no payment was submitted.";
          items.push(
            outcome === "resisted" ? { ...base, kind: "resisted", title: "Attack test resisted by the AI.", detail: tail }
            : outcome === "blocked" ? { ...base, kind: "block", title: "Attack test blocked by the rules.", detail: `${usd(d.totalCents)} · ${reasons} · ${tail}` }
            : outcome === "flagged" ? { ...base, kind: "flagged", title: "Attack test needs approval under the rules.", detail: `${usd(d.totalCents)} · ${reasons} · ${tail}` }
            : { ...base, kind: "slipped", title: "Attack test allowed by the rules.", detail: `${usd(d.totalCents)} · ${tail} ${attack?.gap ? `Known gap: ${attack.gap}` : "No rule caught this attack."}` },
          );
          break;
        }
        const title = d.verdict === "auto" ? `Purchase allowed by the rules for ${usd(d.totalCents)}.` : d.verdict === "approval" ? `Purchase needs approval for ${usd(d.totalCents)}.` : `Purchase blocked by the rules for ${usd(d.totalCents)}.`;
        items.push({ ...base, kind: d.verdict, title, detail: flagged.length ? flagged.map((c) => c.detail).join(" · ") : `All ${d.checks.length} rules passed` });
        break;
      }
      case "approved":
        items.push({ ...base, kind: "approved", byYou: ev.approvedBy === you, title: `Purchase #${ev.decisionSeq} approved by ${actor(ev.approvedBy, you)}.`, detail: purchaseOf(ev.decisionSeq) });
        break;
      case "rejected":
        items.push({ ...base, kind: "declined", byYou: ev.rejectedBy === you, title: `Purchase #${ev.decisionSeq} declined by ${actor(ev.rejectedBy, you)}.`, detail: ev.reason });
        break;
      case "agent_state":
        items.push({ ...base, kind: ev.on ? "rules" : "failed", byYou: ev.by === you, title: ev.on ? `Agent resumed by ${actor(ev.by, you)}.` : `Agent paused by ${actor(ev.by, you)}.` });
        break;
      case "payment_failed":
        items.push({ ...base, kind: ev.definitive ? "failed" : "paypal", title: `${ev.definitive ? PAYMENT_LABEL.failed : PAYMENT_LABEL.unknown} for purchase #${ev.decisionSeq}.`, detail: ev.reason });
        break;
      case "payout":
        items.push({ ...base, kind: paymentStatus(log, e).settled ? "paid" : "paypal", title: `${paymentStatus(log, e).label}: ${usd(ev.amountCents)} for purchase #${ev.decisionSeq}.`, detail: `PayPal Payouts · Initial submission: ${ev.payoutBatchId} (${ev.status})${purchaseOf(ev.decisionSeq) ? ` · ${purchaseOf(ev.decisionSeq)}` : ""}`, verifyId: ev.payoutBatchId });
        break;
      case "payout_status": {
        const payout = log.find(entry => entry.seq === ev.payoutSeq)?.event;
        const id = payout?.type === "payout" ? payout.payoutBatchId : `for audit entry #${ev.payoutSeq}`;
        items.push({ ...base, kind: "status", title: `Payment status updated: ${providerStatusLabel(ev.status).toLowerCase()}.`, detail: `PayPal payout ${id} (${ev.status}). ${ev.confirmedByTransactionSearch ? "Confirmed in PayPal's transaction records." : "Provider status for the existing payout; this is not another payment."}` });
        break;
      }
      case "order_created":
        items.push({ ...base, kind: "paypal", title: `${APPROVAL_LABEL.paypal_pending} for purchase #${ev.decisionSeq}.`, detail: `PayPal order ID: ${ev.orderId}` });
        break;
      case "order_closed":
        items.push({ ...base, kind: ev.reason === "wrong_payer" ? "block" : "declined",
          title: ev.reason === "cancelled" ? "PayPal checkout cancelled." : ev.reason === "expired" ? "PayPal checkout expired without approval." : "PayPal checkout refused because the approving account does not match the store.",
          detail: `PayPal order ID: ${ev.orderId}. No payment was captured for this order; review the purchase in Rules & Approvals.` });
        break;
      case "order_status":
        items.push({ ...base, kind: ev.status.includes("REFUND") ? "paypal" : "status", title: `Payment status updated: ${providerStatusLabel(ev.status).toLowerCase()}.`, detail: `PayPal order ${ev.orderId} (${ev.status})${ev.refundedCents ? ` · ${usd(ev.refundedCents)} refunded by the supplier` : ""}` });
        break;
      case "order_captured":
        items.push({ ...base, kind: paymentStatus(log, e).settled ? "paid" : "paypal", title: `${paymentStatus(log, e).label}: ${usd(ev.amountCents)} for purchase #${ev.decisionSeq}.`, detail: `PayPal checkout · Initial capture response: ${ev.captureId} (${ev.status})${purchaseOf(ev.decisionSeq) ? ` · ${purchaseOf(ev.decisionSeq)}` : ""}`, verifyId: ev.orderId });
        break;
      default:
        items.push({ ...base, kind: "status", title: "Activity recorded.", detail: "Details for this event are not available in this version of GuardBuy." });
    }
  }
  return items.reverse(); // newest first
}
