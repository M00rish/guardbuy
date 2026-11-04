import db from "../../db.server";
import { assertPrivacyActive } from "../privacy/state.server";
import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { paypal } from "../paypal/client.server";
import { allowedStorePayer, paypalStoreBinding } from "../paypal/config.server";
import { runPayPalTool } from "../paypal/toolkit.server";
import type { AuditEntry, RecordedProposal } from "../policy/schema";
import { isManaged, offersForVariant, supplierPaymentEmail, supplierRoster } from "../suppliers/directory.server";
import { evaluate } from "../policy/engine";
import { withPaymentLock } from "./payment-lock.server";
import { candidateAttempt, fundingKey, performAttempt, submitPayout } from "../payments/attempts.server";
import { attemptStates, canCloseOrder, purchaseReservations, unresolvedPayments, untrackedApproval, PaymentPending, PaymentRejected, type Attempt, type PaymentResult } from "../payments/attempts";
import { agentOn, approvalExpired, currentRuleSet, paypalBalanceCents, policyContext } from "./restock.server";

// The only code that moves money. It never takes amounts or suppliers from callers:
// everything comes from the hash-chained audit log, so money only moves for a proposal the
// policy engine approved (verdict "auto") or one a person approved afterwards.
// Two rails, never both for one decision:
//   - Payouts: automatic buys, and buys approved inside GuardBuy.
//   - PayPal Orders: buys over the approval limit that the merchant approves in PayPal itself
//     (payee = supplier, so the merchant gets PayPal's buyer protection).

type PayoutResponse = { batch_header: { payout_batch_id: string; batch_status: string } };

export type PayPalOrder = {
  id: string;
  status: string; // CREATED, APPROVED, COMPLETED, ...
  links?: { rel: string; href: string }[];
  payer?: { payer_id?: string };
  purchase_units?: {
    amount?: { value: string; currency_code?: string };
    payee?: { email_address?: string };
    payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code?: string } }[] };
  }[];
};

export class ExecutionRefused extends Error {}

/**
 * The address to pay: the payee recorded with the proposal (under the hash chain), and only if it
 * still matches the supplier's address on file. A changed address means re-proposing, not paying.
 */
async function payeeFor(shop: string, proposal: RecordedProposal): Promise<string> {
  if (!proposal.payeeEmail) throw new ExecutionRefused("The proposal has no recorded payee");
  const current = await supplierPaymentEmail(shop, proposal.supplierId);
  if (current?.toLowerCase() !== proposal.payeeEmail.toLowerCase()) {
    throw new ExecutionRefused(`${proposal.supplierId}'s PayPal email changed after this purchase was proposed`);
  }
  return proposal.payeeEmail;
}

const toCents = (value: string) => Math.round(Number(value) * 100);

/**
 * The PayPal order still in play for a decision: the latest one created that wasn't closed
 * (cancelled, expired, wrong payer). A closed order frees the purchase for a new order or an
 * in-app approval.
 */
export function openOrder(log: AuditEntry[], decisionSeq: number) {
  const created = log.filter((e) => e.event.type === "order_created" && e.event.decisionSeq === decisionSeq).at(-1);
  if (created?.event.type !== "order_created") return undefined;
  const orderId = created.event.orderId;
  const closed = log.some((e) => e.event.type === "order_closed" && e.event.orderId === orderId);
  return closed ? undefined : created;
}

/** The capture must pay the recorded supplier the recorded amount; anything else is an error. */
export function checkCapture(order: PayPalOrder, amountCents: number, payeeEmail: string | undefined) {
  const unit = order.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  if (order.purchase_units?.length !== 1 || unit?.payments?.captures?.length !== 1) throw new Error("Unexpected PayPal capture structure");
  if (!cap) throw new Error(`PayPal order ${order.id} has no capture`);
  if (!cap.id || !cap.status || !unit?.amount || toCents(unit.amount.value) !== amountCents) throw new Error("Incomplete or inconsistent PayPal capture evidence");
  if (toCents(cap.amount.value) !== amountCents) throw new Error(`Captured ${cap.amount.value}, expected ${(amountCents / 100).toFixed(2)}`);
  if (cap.amount.currency_code !== "USD" || unit?.amount?.currency_code !== "USD") throw new Error("Unexpected PayPal capture currency");
  const payee = unit?.payee?.email_address;
  if (!payee || payee.toLowerCase() !== payeeEmail?.toLowerCase()) throw new Error(`PayPal order ${order.id} pays an unexpected payee`);
  return cap;
}

export async function closeOrder(shop: string, decisionSeq: number, orderId: string, reason: "cancelled" | "expired" | "wrong_payer") {
  const log = await auditEntries(shop);
  const already = log.find((e) => e.event.type === "order_closed" && e.event.orderId === orderId);
  if (already) return already;
  const closed = await appendAuditWhen(shop, { type: "order_closed", decisionSeq, orderId, reason }, (current) => canCloseOrder(current, decisionSeq, orderId));
  if (closed) return closed;
  const concurrent = (await auditEntries(shop)).find((e) => e.event.type === "order_closed" && e.event.orderId === orderId);
  if (concurrent) return concurrent;
  throw new PaymentPending();
}

const forDecision = (log: AuditEntry[], type: AuditEntry["event"]["type"], decisionSeq: number) =>
  log.find((e) => e.event.type === type && "decisionSeq" in e.event && e.event.decisionSeq === decisionSeq);

/** Loads a decision and its proposal from the log and checks they are payable at all. */
async function payableDecision(shop: string, decisionSeq: number) {
  const log = await auditEntries(shop);
  const decisionEntry = log.find((e) => e.seq === decisionSeq);
  if (decisionEntry?.event.type !== "decision") throw new ExecutionRefused(`Entry ${decisionSeq} is not a decision`);
  const { decision, proposalSeq } = decisionEntry.event;

  const proposalEntry = log.find((e) => e.seq === proposalSeq);
  if (proposalEntry?.event.type !== "proposal") throw new ExecutionRefused(`Decision ${decisionSeq} has no proposal`);
  const proposal = proposalEntry.event.proposal;

  if (proposalEntry.event.scenario) throw new ExecutionRefused(`Decision ${decisionSeq} was an injection test; tests are never paid`);

  if (decision.verdict === "block") throw new ExecutionRefused(`Decision ${decisionSeq} was blocked by policy`);
  if (decision.totalCents !== proposal.unitPriceCents * proposal.quantity) {
    throw new ExecutionRefused(`Decision ${decisionSeq} total does not match its proposal`);
  }
  return { log, decisionEntry, decision, proposal };
}

/**
 * Re-runs the rules right before money moves, on current numbers: the latest signed rules, the
 * balance now, and everything spent or waiting for approval since the original decision. Runs
 * under the shop's payment lock, so two purchases can't both pass the weekly cap or cash floor.
 *   - blocked now: refused, with the reasons
 *   - an automatic purchase that now needs a person (e.g. its price rose): refused
 *   - an approval older than 48 hours: refused (re-proposed with fresh numbers instead)
 */
/** Emergency stop (and test safety): with GUARDBUY_PAYMENTS_DISABLED=1 no payout is sent and no order is captured. */
function assertPaymentsEnabled() {
  if (process.env.GUARDBUY_PAYMENTS_DISABLED === "1") throw new ExecutionRefused("Payments are disabled on this server (GUARDBUY_PAYMENTS_DISABLED)");
}

async function recheckAtPayment(shop: string, decisionSeq: number, opts: { approvedByPerson: boolean }) {
  const log = await auditEntries(shop);
  const decisionEntry = log.find((e) => e.seq === decisionSeq)!;
  const proposalEntry = log.find((e) => e.seq === (decisionEntry.event.type === "decision" ? decisionEntry.event.proposalSeq : -1));
  if (decisionEntry.event.type !== "decision" || proposalEntry?.event.type !== "proposal") throw new ExecutionRefused(`Decision ${decisionSeq} is incomplete`);
  const proposal = proposalEntry.event.proposal;

  if (proposalEntry.event.restockJobId && !await db.session.findFirst({ where: { shop, isOnline: false }, select: { id: true } })) {
    throw new ExecutionRefused("This store is no longer installed; queued purchases cannot submit payments");
  }

  if (decisionEntry.event.decision.verdict === "approval" && approvalExpired(decisionEntry.at)) {
    throw new ExecutionRefused(`Decision ${decisionSeq} expired: approvals are valid for 48 hours`);
  }
  const rules = currentRuleSet(log);
  if (!rules) throw new ExecutionRefused("No signed rules");
  if (!opts.approvedByPerson && !agentOn(log)) throw new ExecutionRefused("The agent is paused");

  const [managed, offers, balance] = await Promise.all([
    proposal.variantId ? isManaged(shop, proposal.variantId) : Promise.resolve(false),
    proposal.variantId ? offersForVariant(shop, proposal.variantId) : Promise.resolve([]),
    paypalBalanceCents({ shop, decisionSeq }),
  ]);
  const fresh = evaluate(proposal, rules, policyContext(proposal, log, balance, { managed, offers, suppliers: await supplierRoster(shop) }, new Date(), decisionSeq));
  const reasons = (verdict: string) => fresh.checks.filter((c) => c.outcome === verdict).map((c) => c.detail).join("; ");
  if (fresh.verdict === "block") throw new ExecutionRefused(`Rules re-checked at payment time blocked it: ${reasons("block")}`);
  if (fresh.verdict === "approval" && !opts.approvedByPerson) throw new ExecutionRefused(`Rules re-checked at payment time: it now needs a person (${reasons("approval")})`);
  return fresh;
}

// ---------- Payouts ----------

export async function executePurchase(shop: string, decisionSeq: number): Promise<AuditEntry> {
  return withPaymentLock(`funding:${fundingKey()}`, async (lease) => {
    const { log, decisionEntry, decision, proposal } = await payableDecision(shop, decisionSeq);
    const existing = forDecision(log, "payout", decisionSeq);
    if (existing) return existing;
    if (forDecision(log, "order_captured", decisionSeq) || openOrder(log, decisionSeq)) throw new ExecutionRefused("This purchase is reserved for a PayPal Order");
    const approved = !!forDecision(log, "approved", decisionSeq);
    if (decision.verdict === "approval" && !approved) throw new ExecutionRefused("This purchase is waiting for merchant approval");
    const unresolved = unresolvedPayments(log).find((s) => s.attempt.decisionSeq === decisionSeq);
    if (unresolved && unresolved.attempt.operation !== "payout") throw new PaymentPending();
    const previous = attemptStates(log).filter((s) => s.attempt.decisionSeq === decisionSeq && s.attempt.operation === "payout");
    const legacy = !previous.length && log.some((e) => e.event.type === "payment_failed" && e.event.decisionSeq === decisionSeq && !e.event.definitive);
    const batchId = `gb-${decisionSeq}-${decisionEntry.hash.slice(0, 16)}${previous.length ? `-${previous.length + 1}` : ""}`;
    const attempt = unresolved?.attempt ?? candidateAttempt({
      decisionSeq, operation: "payout", route: "payout", requestId: batchId,
      amountCents: decision.totalCents, currency: "USD", payeeEmail: await payeeFor(shop, proposal), previouslyUncertain: legacy,
      body: { sender_batch_header: { sender_batch_id: batchId, email_subject: "GuardBuy purchase order payment", email_message: `Payment for ${proposal.quantity} x ${proposal.sku}` },
        items: [{ recipient_type: "EMAIL", receiver: proposal.payeeEmail, amount: { value: (decision.totalCents / 100).toFixed(2), currency: "USD" },
          note: `GuardBuy PO ${shop} #${decisionSeq}: ${proposal.quantity} x ${proposal.sku} (rules ${decision.ruleSetHash.slice(0, 12)})`, sender_item_id: `po-${decisionSeq}` }] },
    }, legacy ? Date.parse(decisionEntry.at) : Date.now());
    return performAttempt(shop, attempt, lease, {
      lookup: async () => null, // No read-only Payouts endpoint searches by sender_batch_id.
      beforeSend: async (saved) => {
        await assertPrivacyActive(shop);
        paypalStoreBinding(shop);
        await recheckAtPayment(shop, decisionSeq, { approvedByPerson: approved });
        if (await payeeFor(shop, proposal) !== saved.payeeEmail) throw new ExecutionRefused("The recorded payee changed");
        assertPaymentsEnabled();
      },
      send: async (saved) => {
        const response = await submitPayout<PayoutResponse>(saved);
        if (!response.batch_header?.payout_batch_id || !response.batch_header.batch_status) throw new Error("Unconfirmed PayPal payout response");
        return { type: "payout", decisionSeq, payoutBatchId: response.batch_header.payout_batch_id, status: response.batch_header.batch_status, amountCents: saved.amountCents };
      },
    });
  });
}

// ---------- Approval through PayPal Orders ----------

/**
 * Creates a PayPal order that pays the supplier, for a decision waiting on approval.
 * The merchant approves it in PayPal (approveUrl); PayPal then sends them to `returnUrl`.
 * Calling it again for the same decision returns the same order.
 */
export async function createApprovalOrder(shop: string, decisionSeq: number, returnUrl: string): Promise<AuditEntry> {
  return withPaymentLock(`funding:${fundingKey()}`, async (lease) => {
    const { log, decisionEntry, decision, proposal } = await payableDecision(shop, decisionSeq);
    const existing = openOrder(log, decisionSeq);
    if (existing) return existing;
    if (forDecision(log, "payout", decisionSeq) || forDecision(log, "order_captured", decisionSeq)) throw new ExecutionRefused("This purchase already has a payment");
    if (decision.verdict !== "approval") throw new ExecutionRefused("This purchase does not need approval");
    const unresolved = unresolvedPayments(log).find((s) => s.attempt.decisionSeq === decisionSeq);
    if (unresolved && unresolved.attempt.operation !== "order_create") throw new PaymentPending();
    const attemptNumber = Math.max(log.filter((e) => e.event.type === "order_created" && e.event.decisionSeq === decisionSeq).length,
      attemptStates(log).filter((s) => s.attempt.decisionSeq === decisionSeq && s.attempt.operation === "order_create").length);
    const requestId = `gb-order-${decisionSeq}-${decisionEntry.hash.slice(0, 16)}${attemptNumber ? `-${attemptNumber + 1}` : ""}`;
    const attempt = unresolved?.attempt ?? candidateAttempt({ decisionSeq, operation: "order_create", route: "order", requestId,
      amountCents: decision.totalCents, currency: "USD", payeeEmail: await payeeFor(shop, proposal), body: {
        intent: "CAPTURE", purchase_units: [{ reference_id: `po-${decisionSeq}`, custom_id: requestId,
          description: `GuardBuy PO #${decisionSeq}: ${proposal.quantity} x ${proposal.sku}`.slice(0, 127), amount: { currency_code: "USD", value: (decision.totalCents / 100).toFixed(2) }, payee: { email_address: proposal.payeeEmail } }],
        payment_source: { paypal: { experience_context: { brand_name: "GuardBuy", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: returnUrl,
          cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}cancelled=1` } } },
      } });
    return performAttempt(shop, attempt, lease, {
      lookup: async () => null,
      beforeSend: async (saved) => {
        await assertPrivacyActive(shop);
        paypalStoreBinding(shop);
        await recheckAtPayment(shop, decisionSeq, { approvedByPerson: true });
        if (await payeeFor(shop, proposal) !== saved.payeeEmail) throw new ExecutionRefused("The recorded payee changed");
        assertPaymentsEnabled();
      },
      send: async (saved) => {
        const order = await paypal<PayPalOrder>("/v2/checkout/orders", { method: "POST", requestId: saved.requestId, body: saved.body, maxAttempts: 1 });
        const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
        if (!order.id || !approveUrl) throw new Error("Unconfirmed PayPal Order response");
        return { type: "order_created", decisionSeq, orderId: order.id, approveUrl, amountCents: saved.amountCents };
      },
    });
  });
}

/** Captures a PayPal order once the merchant has approved it, then confirms it through the Agent Toolkit. */
export function captureApprovalOrder(shop: string, decisionSeq: number): Promise<AuditEntry> {
  // The funding lease and recorded attempt protect callbacks from every process, including sweeps.
  return capture(shop, decisionSeq);
}

async function toolkitOrder(id: string): Promise<PayPalOrder> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([runPayPalTool<PayPalOrder>("get_order", { id }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PayPal confirmation timeout")), 10_000); })]);
  } finally { clearTimeout(timer); }
}
const confirmWithToolkit = (id: string) => toolkitOrder(id).then((o) => o.status === "COMPLETED", () => false);

function capturedResult(attempt: Attempt, order: PayPalOrder, confirmed = false): PaymentResult {
  if (order.id !== attempt.providerId) throw new Error("Unexpected PayPal order identity");
  const cap = checkCapture(order, attempt.amountCents, attempt.payeeEmail);
  return { type: "order_captured", decisionSeq: attempt.decisionSeq, orderId: order.id, captureId: cap.id, status: cap.status,
    amountCents: attempt.amountCents, payerId: order.payer?.payer_id, confirmedByGetOrder: confirmed };
}

async function capture(shop: string, decisionSeq: number): Promise<AuditEntry> {
  return withPaymentLock(`funding:${fundingKey()}`, async (lease) => {
    const { log, proposal } = await payableDecision(shop, decisionSeq);
    const done = forDecision(log, "order_captured", decisionSeq);
    if (done) return done;
    if (forDecision(log, "payout", decisionSeq)) throw new ExecutionRefused("This purchase already has a payout");
    const created = openOrder(log, decisionSeq);
    if (created?.event.type !== "order_created") throw new ExecutionRefused("This purchase has no open PayPal order");
    const { orderId, amountCents } = created.event;
    const unresolved = unresolvedPayments(log).find((s) => s.attempt.decisionSeq === decisionSeq);
    if (unresolved && unresolved.attempt.operation !== "order_capture") throw new PaymentPending();
    const priorCaptures = attemptStates(log).filter((s) => s.attempt.decisionSeq === decisionSeq && s.attempt.operation === "order_capture").length;
    const attempt = unresolved?.attempt ?? candidateAttempt({ decisionSeq, operation: "order_capture", route: "order", requestId: `gb-capture-${orderId}${priorCaptures ? `-${priorCaptures + 1}` : ""}`,
      amountCents, currency: "USD", payeeEmail: proposal.payeeEmail!, providerId: orderId, body: {} });
    // The provider read is authoritative for capture recovery, regardless of transaction-search lag.
    let wrongPayer = false;
    try { return await performAttempt(shop, attempt, lease, {
      lookup: async (saved) => {
        const order = await paypal<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(saved.providerId!)}`);
        if (order.status === "COMPLETED" || order.purchase_units?.[0]?.payments?.captures?.length) return capturedResult(saved, order, await confirmWithToolkit(order.id));
        return null;
      },
      beforeSend: async (saved) => {
        await assertPrivacyActive(shop);
        paypalStoreBinding(shop);
        const order = await toolkitOrder(saved.providerId!);
        if (order.id !== saved.providerId) throw new ExecutionRefused("Unexpected PayPal approval order identity");
        const unit = order.purchase_units?.[0];
        if (order.purchase_units?.length !== 1 || unit?.amount?.currency_code !== saved.currency
          || toCents(unit.amount.value) !== saved.amountCents
          || unit.payee?.email_address?.toLowerCase() !== saved.payeeEmail.toLowerCase()
          || unit.payments?.captures?.length) throw new ExecutionRefused("PayPal approval does not match the recorded purchase");
        if (order.status !== "APPROVED") throw new ExecutionRefused(`PayPal order is ${order.status}, not approved for capture`);
        if (!allowedStorePayer(shop, order.payer?.payer_id)) {
          wrongPayer = true;
          // An existing uncertain capture cannot be cancelled merely because a later read differs.
          throw new ExecutionRefused("This order was approved by an account outside the store's permitted payers");
        }
        await recheckAtPayment(shop, decisionSeq, { approvedByPerson: true });
        await payeeFor(shop, proposal);
        assertPaymentsEnabled();
      },
      send: async (saved) => {
        const response = await paypal<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(saved.providerId!)}/capture`, { method: "POST", requestId: saved.requestId, body: saved.body, maxAttempts: 1 });
        if (response.id !== saved.providerId) throw new Error("Unexpected PayPal capture response identity");
        // Capture POST may return a minimal representation without the unit amount/payee.
        // Validate the full Order readback rather than weakening the supplier/currency checks.
        const order = await paypal<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(saved.providerId!)}`);
        return capturedResult(saved, order, await confirmWithToolkit(order.id));
      },
    }); } catch (error) {
      if (wrongPayer && error instanceof PaymentRejected) await closeOrder(shop, decisionSeq, orderId, "wrong_payer");
      throw error;
    }
  });
}

/** Merchant-initiated resumption: this may submit the original request, never a new route/key. */
export async function resumePayment(shop: string, decisionSeq: number) {
  const log = await auditEntries(shop);
  if (untrackedApproval(log, decisionSeq)) throw new ExecutionRefused("This older approval has no saved payment request. Reconcile it with PayPal manually; do not submit a replacement payment.");
  const pending = unresolvedPayments(log).find((s) => s.attempt.decisionSeq === decisionSeq)?.attempt;
  if (pending?.operation === "order_capture") return captureApprovalOrder(shop, decisionSeq);
  if (pending?.operation === "order_create") {
    const source = pending.body.payment_source as { paypal?: { experience_context?: { return_url?: string } } } | undefined;
    return createApprovalOrder(shop, decisionSeq, source?.paypal?.experience_context?.return_url ?? "");
  }
  if (pending?.operation === "payout" || purchaseReservations(log).has(decisionSeq)) return executePurchase(shop, decisionSeq);
  throw new ExecutionRefused("No unfinished payment attempt exists for this purchase");
}

/** Read-only recovery. Missing payout/order-create IDs require explicit same-key resumption. */
export async function recoverKnownPayments(shop: string) {
  const log = await auditEntries(shop);
  for (const { attempt } of unresolvedPayments(log).filter((s) => s.attempt.operation === "order_capture").slice(0, 5)) {
    if (attempt.operation !== "order_capture" || !attempt.providerId || attempt.fundingKey !== fundingKey()) continue;
    try {
      const order = await paypal<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(attempt.providerId)}`);
      if (order.status === "COMPLETED" || order.purchase_units?.[0]?.payments?.captures?.length) {
        await appendAuditWhen(shop, { ...capturedResult(attempt, order, await confirmWithToolkit(order.id)), paymentAttemptId: attempt.attemptId }, (current) => !current.some((e) => "paymentAttemptId" in e.event && e.event.paymentAttemptId === attempt.attemptId));
      }
    } catch { /* Keep unresolved; never classify an unavailable provider as a failed payment. */ }
  }
}

/** Finds which shop and decision a PayPal order belongs to (PayPal's redirect only carries the order id). */
export async function findOrder(orderId: string) {
  const row = await db.auditEntry.findFirst({ where: { type: "order_created", event: { path: ["orderId"], equals: orderId } } });
  const event = row?.event as { decisionSeq?: number } | undefined;
  return row && typeof event?.decisionSeq === "number" ? { shop: row.shop, decisionSeq: event.decisionSeq } : null;
}
