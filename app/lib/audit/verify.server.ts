import db from "../../db.server";
import { usd } from "../format";
import type { AuditEntry } from "../policy/schema";
import { RULE_LABELS } from "../policy/rules";
import { auditEntries, verifyChain } from "./log.server";

// Public "verify this payment": given a PayPal payout batch id, order id or capture id, show
// whether GuardBuy's hash-chained log records it, what led to it (signed rules -> AI proposal ->
// rules decision -> approval -> payment) and whether the whole chain is intact.
// Privacy: by default only hashes, dates and outcomes. Product, supplier, amount and rule details
// only when the merchant opted in (judge sandboxes always share). Never emails, PayPal approval
// links or payer ids.

export type ProofStep = { seq: number; at: string; step: string; hash: string; prevHash: string; note?: string };

export type PaymentProof =
  | { found: false }
  | {
      found: true;
      demo: boolean; // a judge sandbox, not a real store
      paidBy: "PayPal Payouts" | "PayPal Orders";
      how: "automatic" | "approved";
      approvedByKind?: string;
      paidAt: string;
      rulesFingerprint: string | null;
      rulesSignedAt: string | null;
      steps: ProofStep[]; // oldest first
      chain: { valid: true; length: number } | { valid: false; brokenAtSeq: number; reason: string };
      details: null | {
        product: string; quantity: number; supplier: string; amount: string; unitPrice: string;
        checks: { rule: string; outcome: string; detail: string }[];
        aiModel?: string;
      };
    };

const ID = /^[A-Za-z0-9-]{8,64}$/;

/** The payment entry for a payout batch id, PayPal order id or capture id (any shop). */
async function findPayment(id: string) {
  const byBatch = await db.auditEntry.findFirst({ where: { type: "payout", event: { path: ["payoutBatchId"], equals: id } } });
  if (byBatch) return byBatch;
  const byOrder = await db.auditEntry.findFirst({ where: { type: "order_captured", event: { path: ["orderId"], equals: id } } });
  if (byOrder) return byOrder;
  return db.auditEntry.findFirst({ where: { type: "order_captured", event: { path: ["captureId"], equals: id } } });
}

const shareDetails = async (shop: string) =>
  shop.includes("#judge-") || ((await db.shopSettings.findUnique({ where: { shop } }))?.shareVerifyDetails ?? false);

export async function verifyPayment(rawId: string): Promise<PaymentProof> {
  const id = rawId.trim();
  if (!ID.test(id)) return { found: false };
  const row = await findPayment(id);
  if (!row) return { found: false };

  const log = await auditEntries(row.shop);
  const chain = await verifyChain(row.shop);
  const pay = log.find((e) => e.seq === row.seq);
  if (!pay || (pay.event.type !== "payout" && pay.event.type !== "order_captured")) return { found: false };

  const decisionSeq = pay.event.decisionSeq;
  const decision = log.find((e) => e.seq === decisionSeq);
  const proposal = decision?.event.type === "decision" ? log.find((e) => e.seq === (decision.event.type === "decision" ? decision.event.proposalSeq : -1)) : undefined;
  const rules = proposal ? log.filter((e) => e.event.type === "ruleset_signed" && e.seq < proposal.seq).at(-1) : undefined;
  const approved = log.find((e) => e.event.type === "approved" && e.event.decisionSeq === decisionSeq);
  const orderCreated = log.find((e) => e.event.type === "order_created" && e.event.decisionSeq === decisionSeq);
  const statuses = pay.event.type === "payout" ? log.filter((e) => e.event.type === "payout_status" && e.event.payoutSeq === pay.seq) : [];

  const step = (e: AuditEntry | undefined, label: string, note?: string): ProofStep[] =>
    e ? [{ seq: e.seq, at: e.at, step: label, hash: e.hash, prevHash: e.prevHash, note }] : [];
  const steps = [
    ...step(rules, "Rules signed"),
    ...step(proposal, "AI proposed the purchase"),
    ...step(decision, "Rules checked it", decision?.event.type === "decision" ? `verdict: ${decision.event.decision.verdict === "auto" ? "allowed automatically" : decision.event.decision.verdict === "approval" ? "needs a person" : "blocked"}` : undefined),
    ...step(approved, "A person approved it"),
    ...step(orderCreated, "PayPal order created for approval in PayPal"),
    ...step(pay, pay.event.type === "payout" ? "Paid via PayPal Payouts" : "Paid via PayPal Orders"),
    ...statuses.flatMap((s) => step(s, "PayPal status update", s.event.type === "payout_status" ? s.event.status + (s.event.confirmedByTransactionSearch ? " · confirmed in PayPal's records" : "") : undefined)),
  ].sort((a, b) => a.seq - b.seq);

  const approvedBy = approved?.event.type === "approved" ? approved.event.approvedBy : undefined;
  const demo = row.shop.includes("#judge-");
  let details: Extract<PaymentProof, { found: true }>["details"] = null;
  if (await shareDetails(row.shop) && proposal?.event.type === "proposal" && decision?.event.type === "decision") {
    const p = proposal.event.proposal;
    const [product, supplier] = await Promise.all([
      p.variantId ? db.managedProduct.findUnique({ where: { shop_variantId: { shop: row.shop, variantId: p.variantId } } }) : null,
      db.supplier.findUnique({ where: { shop_id: { shop: row.shop, id: p.supplierId } } }),
    ]);
    details = {
      product: product?.title ?? p.sku,
      quantity: p.quantity,
      supplier: supplier?.name ?? p.supplierId,
      amount: usd(decision.event.decision.totalCents),
      unitPrice: usd(p.unitPriceCents),
      // Rule outcomes; the payee email and the PayPal balance are never shown, even when sharing.
      checks: decision.event.decision.checks.map((c) => ({
        rule: RULE_LABELS[c.rule] ?? c.rule,
        outcome: c.outcome,
        detail:
          c.rule === "payeeOnFile" ? (c.outcome === "auto" ? "a PayPal email was on file (not shown)" : "no PayPal email on file")
          : c.rule === "cashFloor" ? (c.outcome === "auto" ? "the PayPal balance stayed above the merchant's floor (balance not shown)" : c.outcome === "approval" ? "the balance couldn't be read, so a person decided" : "it would have gone below the floor (balance not shown)")
          : c.detail,
      })),
      aiModel: p.model,
    };
  }

  return {
    found: true,
    demo,
    paidBy: pay.event.type === "payout" ? "PayPal Payouts" : "PayPal Orders",
    how: approved || orderCreated ? "approved" : "automatic",
    approvedByKind: approvedBy ? (approvedBy.startsWith("judge:") ? "a demo judge" : "a store staff member") : orderCreated ? "the merchant, inside PayPal" : undefined,
    paidAt: pay.at,
    rulesFingerprint: rules?.event.type === "ruleset_signed" ? rules.event.ruleSet.hash : null,
    rulesSignedAt: rules?.event.type === "ruleset_signed" ? rules.event.ruleSet.signedAt : null,
    steps,
    chain,
    details,
  };
}

export async function setShareVerifyDetails(shop: string, share: boolean) {
  await db.shopSettings.upsert({ where: { shop }, create: { shop, shareVerifyDetails: share }, update: { shareVerifyDetails: share } });
}

export async function shareVerifyDetails(shop: string) {
  return (await db.shopSettings.findUnique({ where: { shop } }))?.shareVerifyDetails ?? false;
}
