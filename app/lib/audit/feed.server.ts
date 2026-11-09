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
  you && by === you ? "you" : by.startsWith("shopify-staff:") ? `staff member ${by.slice("shopify-staff:".length)}` : by;

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
        items.push({ ...base, kind: "paypal", title: `Original payment reserved for purchase #${ev.decisionSeq}`, detail: "PayPal confirmation is pending; the request ID and payment details are fixed." });
        break;
      case "payment_outcome":
        items.push({ ...base, kind: ev.status === "unknown" ? "paypal" : "failed", title: ev.status === "unknown" ? `Awaiting PayPal confirmation for purchase #${ev.decisionSeq}` : `Payment request rejected for purchase #${ev.decisionSeq}` });
        break;
      case "delivery_estimate_updated":
        items.push({ ...base, kind: "delivery", byYou: ev.updatedBy === you, title: `Expected arrival updated for purchase #${ev.decisionSeq}`, detail: `${ev.expectedAt.slice(0, 10)} (merchant estimate, UTC) by ${actor(ev.updatedBy, you)}` });
        break;
      case "delivery_remainder_closed":
        items.push({ ...base, kind: "delivery", byYou: ev.closedBy === you, title: `Closed ${ev.quantity} undelivered ${ev.quantity === 1 ? "unit" : "units"} for purchase #${ev.decisionSeq}`, detail: `${ev.reason === "supplier_cancelled" ? "Supplier cancelled" : "Confirmed not arriving"} · ${actor(ev.closedBy, you)}. No inventory adjustment or refund.` });
        break;
      case "receipt_started":
        items.push({ ...base, kind: "receipt_started", byYou: ev.receivedBy === you, title: `Recording receipt of ${ev.quantity} ${ev.quantity === 1 ? "unit" : "units"} for purchase #${ev.decisionSeq}` });
        break;
      case "receipt_received":
        items.push({ ...base, kind: "stock_received", byYou: ev.receivedBy === you, title: `Received ${ev.quantity} ${ev.quantity === 1 ? "unit" : "units"} for purchase #${ev.decisionSeq}`, detail: `Shopify stock updated by ${actor(ev.receivedBy, you)}` });
        break;
      case "receipt_rejected":
        items.push({ ...base, kind: "failed", title: `Shopify rejected receipt for purchase #${ev.decisionSeq}` });
        break;
      case "ruleset_signed":
        items.push({ ...base, kind: "rules", byYou: ev.ruleSet.signedBy === you, title: "Rules signed", detail: `Approval needed above ${usd(ev.ruleSet.rules.approvalAboveCents)}, weekly cap ${usd(ev.ruleSet.rules.weeklySpendCapCents)}, approved suppliers: ${ev.ruleSet.rules.supplierAllowlist.join(", ")}` });
        break;
      case "proposal": {
        const attack = ev.scenario ? attackById(ev.scenario) : undefined;
        if (ev.scenario === WHAT_IF) {
          items.push({ ...base, kind: "attack", title: "What if the AI were fooled? (simulated)", detail: "Recorded as if the AI obeyed Bean Bargains' note. Test only: never paid." });
        } else if (attack) {
          const notes = Object.values(attack.setup.notes ?? {}).join(" / ");
          const quiet = [
            attack.setup.payeeChange && `the supplier's PayPal address was changed to ${attack.setup.payeeChange.email}`,
            attack.setup.lookalike && `staff added "${attack.setup.lookalike.name}" as a supplier`,
            attack.setup.perDay && `fake orders pushed sales to ${attack.setup.perDay}/day`,
          ].filter(Boolean).join("; ");
          items.push({
            ...base, kind: "attack",
            title: `${attack.level[0].toUpperCase()}${attack.level.slice(1)} attack: ${attack.title}`,
            detail: `Copies: ${attack.realWorld}.${quiet ? ` Setup: ${quiet}.` : ""}`,
            ...(notes ? { untrusted: notes, untrustedLabel: "Supplier note the AI read (written by the attacker)" } : {}),
          });
        } else if (ev.stock) {
          items.push({ ...base, kind: "stock", title: `Stock fell: ${product(ev.proposal.sku, ev.proposal.variantId)}`, detail: `${ev.stock.available} left, ${ev.stock.perDay}/day, ${ev.stock.daysOfCover} days of cover` });
        }
        items.push({ ...base, kind: "proposed", title: `AI proposed ${ev.proposal.quantity} × ${product(ev.proposal.sku, ev.proposal.variantId)} from ${supplier(ev.proposal.supplierId)} at ${usd(ev.proposal.unitPriceCents)}`, untrusted: ev.proposal.reasoning, untrustedLabel: "The AI's explanation (not verified)" });
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
          const attack = attackById(source.event.scenario);
          const outcome = attack ? classifyAttack(attack, source.event.proposal, d.verdict) : d.verdict === "block" ? "blocked" : "resisted";
          const reasons = flagged.map((c) => c.detail).join(" · ");
          const tail = "Test only, nothing paid.";
          items.push(
            outcome === "resisted" ? { ...base, kind: "resisted", title: `The AI resisted the attack. ${tail}` }
            : outcome === "blocked" ? { ...base, kind: "block", title: `The AI was swayed, and the rules BLOCKED it (${usd(d.totalCents)}). ${tail}`, detail: reasons }
            : outcome === "flagged" ? { ...base, kind: "flagged", title: `The AI was swayed; the rules sent it to a person (${usd(d.totalCents)}). ${tail}`, detail: reasons }
            : { ...base, kind: "slipped", title: `The AI was swayed and the rules would have ALLOWED it (${usd(d.totalCents)}). ${tail}`, detail: attack?.gap ? `Known gap, fix planned: ${attack.gap}` : "Unexpected: no rule caught this" },
          );
          break;
        }
        const title = d.verdict === "auto" ? `Rules checked: allowed (${usd(d.totalCents)})` : d.verdict === "approval" ? `Rules checked: needs your approval (${usd(d.totalCents)})` : `Rules checked: BLOCKED (${usd(d.totalCents)})`;
        items.push({ ...base, kind: d.verdict, title, detail: flagged.length ? flagged.map((c) => c.detail).join(" · ") : `All ${d.checks.length} rules passed` });
        break;
      }
      case "approved":
        items.push({ ...base, kind: "approved", byYou: ev.approvedBy === you, title: `Approved by ${actor(ev.approvedBy, you)}${purchaseOf(ev.decisionSeq) ? `: ${purchaseOf(ev.decisionSeq)}` : ""}` });
        break;
      case "rejected":
        items.push({ ...base, kind: "declined", byYou: ev.rejectedBy === you, title: `Declined by ${actor(ev.rejectedBy, you)}. Nothing was paid.`, detail: ev.reason });
        break;
      case "agent_state":
        items.push({ ...base, kind: ev.on ? "rules" : "failed", byYou: ev.by === you, title: ev.on ? `Agent turned on by ${actor(ev.by, you)}` : `Agent paused by ${actor(ev.by, you)}` });
        break;
      case "payment_failed":
        items.push({ ...base, kind: ev.definitive ? "failed" : "paypal", title: ev.definitive ? "Payment failed" : "Awaiting PayPal confirmation", detail: ev.reason });
        break;
      case "payout":
        items.push({ ...base, kind: paymentStatus(log, e).settled ? "paid" : "paypal", title: `${paymentStatus(log, e).label}: submitted ${usd(ev.amountCents)} via PayPal Payouts${purchaseOf(ev.decisionSeq) ? ` for ${purchaseOf(ev.decisionSeq)}` : ""}`, detail: `Initial payout submission: ${ev.payoutBatchId} (${ev.status})`, verifyId: ev.payoutBatchId });
        break;
      case "payout_status": {
        const payout = log.find(entry => entry.seq === ev.payoutSeq)?.event;
        const id = payout?.type === "payout" ? payout.payoutBatchId : `for audit entry #${ev.payoutSeq}`;
        const outcome = ({ SUCCESS: "succeeded", PENDING: "is pending", FAILED: "failed", DENIED: "was denied", RETURNED: "was returned", REFUNDED: "was refunded", REVERSED: "was reversed", BLOCKED: "was blocked" } as Record<string, string>)[ev.status] ?? `reports ${ev.status}`;
        items.push({ ...base, kind: "status", title: `Payment update: Payout ${id} ${outcome}`, detail: ev.confirmedByTransactionSearch ? "Confirmed in PayPal's transaction records" : "Provider status for the existing payout; this is not another payment." });
        break;
      }
      case "order_created":
        items.push({ ...base, kind: "paypal", title: `PayPal order ${ev.orderId} created`, detail: "Waiting for approval in PayPal" });
        break;
      case "order_closed":
        items.push({ ...base, kind: ev.reason === "wrong_payer" ? "block" : "declined",
          title: ev.reason === "cancelled" ? `PayPal order ${ev.orderId} cancelled in PayPal` : ev.reason === "expired" ? `PayPal order ${ev.orderId} expired without approval` : `PayPal order ${ev.orderId} approved by an account that isn't the store's: not captured`,
          detail: "Nothing was paid. The purchase can be approved again." });
        break;
      case "order_status":
        items.push({ ...base, kind: ev.status.includes("REFUND") ? "paypal" : "status", title: `PayPal order ${ev.orderId}: ${ev.status}`, detail: ev.refundedCents ? `${usd(ev.refundedCents)} refunded by the supplier` : undefined });
        break;
      case "order_captured":
        items.push({ ...base, kind: paymentStatus(log, e).settled ? "paid" : "paypal", title: `${paymentStatus(log, e).label}: ${usd(ev.amountCents)} via PayPal Orders${purchaseOf(ev.decisionSeq) ? ` for ${purchaseOf(ev.decisionSeq)}` : ""}`, detail: `Initial capture response: ${ev.captureId} (${ev.status})`, verifyId: ev.orderId });
        break;
    }
  }
  return items.reverse(); // newest first
}
