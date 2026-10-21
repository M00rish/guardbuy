import { appendAudit, auditEntries } from "../audit/log.server";
import type { AuditEntry, RuleCheck } from "../policy/schema";
import { offersForVariant, supplierNames } from "../suppliers/directory.server";
import { createApprovalOrder, ExecutionRefused, executePurchase } from "./execute.server";
import { APPROVAL_TTL_MS, approvalExpired } from "./restock.server";

// The approval queue: purchases the policy engine sent to a person ("approval" verdict).
// Cards lead with facts GuardBuy computed itself (price vs history, quantity vs usual, who gets
// paid, which rules asked for approval). The AI's explanation comes last and is labelled as such,
// because a dishonest supplier's note can steer what the AI writes.

export type ApprovalCard = {
  decisionSeq: number;
  proposedAt: string;
  expiresAt: string; // approvals are valid for 48 hours
  status: "waiting" | "paypal_pending"; // paypal_pending: a PayPal order exists, waiting for approval in PayPal
  sku: string;
  quantity: number;
  supplierId: string;
  supplierName: string;
  payeeEmail: string | null;
  unitPriceCents: number;
  totalCents: number;
  avgUnitPrice30dCents: number | null; // null if the supplier is no longer linked to the product
  usualQuantity: number | null;
  needsApprovalBecause: RuleCheck[]; // the checks that asked for a person
  otherChecks: RuleCheck[];
  aiExplanation: string; // written by the AI: unverified
  paypalApproveUrl?: string;
};

const ofDecision = (log: AuditEntry[], type: AuditEntry["event"]["type"], decisionSeq: number) =>
  log.filter((e) => e.event.type === type && "decisionSeq" in e.event && e.event.decisionSeq === decisionSeq);

/** Decisions still waiting for a person: verdict "approval", not yet approved, declined, paid or expired (48 h). */
function pendingDecisions(log: AuditEntry[], now = new Date()) {
  return log.filter((e) => {
    if (e.event.type !== "decision" || e.event.decision.verdict !== "approval") return false;
    if (approvalExpired(e.at, now)) return false;
    const proposalSeq = e.event.proposalSeq;
    const proposal = log.find((p) => p.seq === proposalSeq);
    if (proposal?.event.type === "proposal" && proposal.event.scenario) return false; // injection tests are never paid
    return (["approved", "rejected", "payout", "order_captured"] as const).every((t) => ofDecision(log, t, e.seq).length === 0);
  });
}

export async function approvalQueue(shop: string): Promise<ApprovalCard[]> {
  const log = await auditEntries(shop);
  const names = await supplierNames(shop);
  const cards: ApprovalCard[] = [];

  for (const d of pendingDecisions(log)) {
    if (d.event.type !== "decision") continue;
    const p = log.find((e) => e.seq === (d.event.type === "decision" ? d.event.proposalSeq : -1));
    if (p?.event.type !== "proposal") continue;
    const { proposal } = p.event;
    const { decision } = d.event;

    const offer = proposal.variantId
      ? (await offersForVariant(shop, proposal.variantId)).find((o) => o.supplierId === proposal.supplierId)
      : undefined;
    const order = ofDecision(log, "order_created", d.seq).at(-1);

    cards.push({
      decisionSeq: d.seq,
      proposedAt: p.at,
      expiresAt: new Date(Date.parse(d.at) + APPROVAL_TTL_MS).toISOString(),
      status: order ? "paypal_pending" : "waiting",
      sku: proposal.sku,
      quantity: proposal.quantity,
      supplierId: proposal.supplierId,
      supplierName: names.get(proposal.supplierId) ?? proposal.supplierId,
      payeeEmail: proposal.payeeEmail ?? null,
      unitPriceCents: proposal.unitPriceCents,
      totalCents: decision.totalCents,
      avgUnitPrice30dCents: offer?.avgUnitPrice30dCents ?? null,
      usualQuantity: offer?.usualQuantity ?? null,
      needsApprovalBecause: decision.checks.filter((c) => c.outcome === "approval"),
      otherChecks: decision.checks.filter((c) => c.outcome !== "approval"),
      aiExplanation: proposal.reasoning,
      paypalApproveUrl: order?.event.type === "order_created" ? order.event.approveUrl : undefined,
    });
  }
  return cards.reverse(); // newest first
}

// One action at a time per purchase: a double click must not log (or pay) twice.
const acting = new Map<string, Promise<unknown>>();
function oncePerDecision<T>(shop: string, decisionSeq: number, fn: () => Promise<T>): Promise<T> {
  const key = `${shop}|${decisionSeq}`;
  if (acting.has(key)) return Promise.reject(new ExecutionRefused("This purchase is already being handled"));
  const job = fn().finally(() => acting.delete(key));
  acting.set(key, job);
  return job;
}

async function assertPending(shop: string, decisionSeq: number) {
  const log = await auditEntries(shop);
  const d = log.find((e) => e.seq === decisionSeq);
  if (d?.event.type === "decision" && d.event.decision.verdict === "approval" && approvalExpired(d.at)) {
    throw new ExecutionRefused(`Purchase #${decisionSeq} expired (approvals are valid for 48 hours); the agent will propose it again with fresh numbers`);
  }
  if (!pendingDecisions(log).some((d) => d.seq === decisionSeq)) {
    throw new ExecutionRefused(`Purchase #${decisionSeq} is not waiting for approval`);
  }
  return log;
}

export type ApprovalResult = { paid: boolean; message: string };

/**
 * A person approves inside GuardBuy: logged, then paid by payout. `actor` is recorded as-is,
 * e.g. "shopify-staff:<id>" (admin) or "judge:<session>" (judge console sandbox).
 */
export function approvePurchase(shop: string, decisionSeq: number, actor: string): Promise<ApprovalResult> {
  return oncePerDecision(shop, decisionSeq, async () => {
    const log = await assertPending(shop, decisionSeq);
    if (ofDecision(log, "order_created", decisionSeq).length) {
      throw new ExecutionRefused("This purchase is already being approved in PayPal");
    }
    await appendAudit(shop, { type: "approved", decisionSeq, approvedBy: actor });
    try {
      const payout = await executePurchase(shop, decisionSeq);
      return { paid: true, message: `Approved and paid (log entry #${payout.seq})` };
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await appendAudit(shop, { type: "payment_failed", decisionSeq, reason });
      return { paid: false, message: `Approved, but the payment failed: ${reason}` };
    }
  });
}

export function rejectPurchase(shop: string, decisionSeq: number, actor: string, reason?: string): Promise<ApprovalResult> {
  return oncePerDecision(shop, decisionSeq, async () => {
    await assertPending(shop, decisionSeq);
    await appendAudit(shop, { type: "rejected", decisionSeq, rejectedBy: actor, reason: reason?.slice(0, 500) || undefined });
    return { paid: false, message: "Declined. Nothing was paid." };
  });
}

/** Creates (or returns) the PayPal order, so the merchant approves and pays in PayPal itself. */
export function approveInPayPal(shop: string, decisionSeq: number, returnUrl: string): Promise<{ approveUrl: string }> {
  return oncePerDecision(shop, decisionSeq, async () => {
    await assertPending(shop, decisionSeq);
    const order = await createApprovalOrder(shop, decisionSeq, returnUrl);
    if (order.event.type !== "order_created") throw new Error("Unexpected log entry");
    return { approveUrl: order.event.approveUrl };
  });
}
