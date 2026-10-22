import db from "../../db.server";
import { appendAudit, auditEntries } from "../audit/log.server";
import { paypal } from "../paypal/client.server";
import { runPayPalTool } from "../paypal/toolkit.server";
import type { AuditEntry, RecordedProposal } from "../policy/schema";
import { isManaged, offersForVariant, supplierPaymentEmail, supplierRoster } from "../suppliers/directory.server";
import { evaluate } from "../policy/engine";
import { withPaymentLock } from "./payment-lock.server";
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
    amount?: { value: string };
    payee?: { email_address?: string };
    payments?: { captures?: { id: string; status: string; amount: { value: string } }[] };
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
  if (!cap) throw new Error(`PayPal order ${order.id} has no capture`);
  if (toCents(cap.amount.value) !== amountCents) throw new Error(`Captured ${cap.amount.value}, expected ${(amountCents / 100).toFixed(2)}`);
  const payee = unit?.payee?.email_address;
  if (payee && payee.toLowerCase() !== payeeEmail?.toLowerCase()) throw new Error(`PayPal order ${order.id} pays an unexpected payee`);
  return cap;
}

export async function closeOrder(shop: string, decisionSeq: number, orderId: string, reason: "cancelled" | "expired" | "wrong_payer") {
  const log = await auditEntries(shop);
  const already = log.find((e) => e.event.type === "order_closed" && e.event.orderId === orderId);
  return already ?? appendAudit(shop, { type: "order_closed", decisionSeq, orderId, reason });
}

/**
 * PayPal accounts allowed to approve purchases in PayPal (the merchant's own). Until each merchant
 * connects their PayPal (Phase B), it's configured: GUARDBUY_APPROVER_PAYER_IDS (comma-separated
 * PayPal payer ids). Empty list = any approver is accepted and recorded (dev only).
 */
export function allowedApprover(payerId: string | undefined) {
  const list = (process.env.GUARDBUY_APPROVER_PAYER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  return !!payerId && list.includes(payerId);
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

  if (decisionEntry.event.decision.verdict === "approval" && approvalExpired(decisionEntry.at)) {
    throw new ExecutionRefused(`Decision ${decisionSeq} expired: approvals are valid for 48 hours`);
  }
  const rules = currentRuleSet(log);
  if (!rules) throw new ExecutionRefused("No signed rules");
  if (!opts.approvedByPerson && !agentOn(log)) throw new ExecutionRefused("The agent is paused");

  const [managed, offers, balance] = await Promise.all([
    proposal.variantId ? isManaged(shop, proposal.variantId) : Promise.resolve(false),
    proposal.variantId ? offersForVariant(shop, proposal.variantId) : Promise.resolve([]),
    paypalBalanceCents(),
  ]);
  const fresh = evaluate(proposal, rules, policyContext(proposal, log, balance, { managed, offers, suppliers: await supplierRoster(shop) }, new Date(), decisionSeq));
  const reasons = (verdict: string) => fresh.checks.filter((c) => c.outcome === verdict).map((c) => c.detail).join("; ");
  if (fresh.verdict === "block") throw new ExecutionRefused(`Rules re-checked at payment time blocked it: ${reasons("block")}`);
  if (fresh.verdict === "approval" && !opts.approvedByPerson) throw new ExecutionRefused(`Rules re-checked at payment time: it now needs a person (${reasons("approval")})`);
  return fresh;
}

// ---------- Payouts ----------

export async function executePurchase(shop: string, decisionSeq: number): Promise<AuditEntry> {
  const { log, decisionEntry, decision, proposal } = await payableDecision(shop, decisionSeq);

  const existing = forDecision(log, "payout", decisionSeq);
  if (existing) return existing; // already paid: never pay twice
  if (openOrder(log, decisionSeq)) {
    throw new ExecutionRefused(`Decision ${decisionSeq} is being paid through a PayPal order`);
  }
  const approved = !!forDecision(log, "approved", decisionSeq);
  if (decision.verdict === "approval" && !approved) {
    throw new ExecutionRefused(`Decision ${decisionSeq} is waiting for approval`);
  }

  return withPaymentLock(shop, async () => {
  // Under the lock: paid meanwhile by someone else? Then return that payout instead of paying again.
  const paidMeanwhile = forDecision(await auditEntries(shop), "payout", decisionSeq);
  if (paidMeanwhile) return paidMeanwhile;
  await recheckAtPayment(shop, decisionSeq, { approvedByPerson: approved });
  assertPaymentsEnabled(); // last thing before money moves

  // Deterministic id per decision: PayPal treats a repeated id as the same payout.
  const batchId = `gb-${decisionSeq}-${decisionEntry.hash.slice(0, 16)}`;
  const res = await paypal<PayoutResponse>("/v1/payments/payouts", {
    method: "POST",
    requestId: batchId,
    body: {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: "GuardBuy purchase order payment",
        email_message: `Payment for ${proposal.quantity} x ${proposal.sku}`,
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: await payeeFor(shop, proposal),
          amount: { value: (decision.totalCents / 100).toFixed(2), currency: "USD" },
          note: `GuardBuy PO ${shop} #${decisionSeq}: ${proposal.quantity} x ${proposal.sku} (rules ${decision.ruleSetHash.slice(0, 12)})`,
          sender_item_id: `po-${decisionSeq}`,
        },
      ],
    },
  });

  return appendAudit(shop, {
    type: "payout",
    decisionSeq,
    payoutBatchId: res.batch_header.payout_batch_id,
    status: res.batch_header.batch_status,
    amountCents: decision.totalCents,
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
  const { log, decisionEntry, decision, proposal } = await payableDecision(shop, decisionSeq);

  const existing = openOrder(log, decisionSeq);
  if (existing) return existing;
  if (forDecision(log, "order_captured", decisionSeq)) throw new ExecutionRefused(`Decision ${decisionSeq} was already paid`);
  if (decision.verdict !== "approval") throw new ExecutionRefused(`Decision ${decisionSeq} does not need approval`);
  if (forDecision(log, "payout", decisionSeq)) throw new ExecutionRefused(`Decision ${decisionSeq} was already paid`);
  // A person approves inside PayPal next; the rules (caps, floor, expiry) are re-checked first.
  await withPaymentLock(shop, () => recheckAtPayment(shop, decisionSeq, { approvedByPerson: true }));

  // One request id per attempt: a new order after a cancelled/expired one must not reuse the old id.
  const attempt = log.filter((e) => e.event.type === "order_created" && e.event.decisionSeq === decisionSeq).length;
  const requestId = `gb-order-${decisionSeq}-${decisionEntry.hash.slice(0, 16)}${attempt ? `-${attempt + 1}` : ""}`;
  const order = await paypal<PayPalOrder>("/v2/checkout/orders", {
    method: "POST",
    requestId,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: `po-${decisionSeq}`,
          custom_id: requestId,
          description: `GuardBuy PO #${decisionSeq}: ${proposal.quantity} x ${proposal.sku}`.slice(0, 127),
          amount: { currency_code: "USD", value: (decision.totalCents / 100).toFixed(2) },
          payee: { email_address: await payeeFor(shop, proposal) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "GuardBuy",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: returnUrl,
            cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}cancelled=1`,
          },
        },
      },
    },
  });

  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  if (!approveUrl) throw new Error(`PayPal order ${order.id} has no approval link`);
  return appendAudit(shop, { type: "order_created", decisionSeq, orderId: order.id, approveUrl, amountCents: decision.totalCents });
}

// Capture can be triggered by PayPal's redirect and by a manual check at the same time.
const capturing = new Map<string, Promise<AuditEntry>>();

/** Captures a PayPal order once the merchant has approved it, then confirms it through the Agent Toolkit. */
export function captureApprovalOrder(shop: string, decisionSeq: number): Promise<AuditEntry> {
  const key = `${shop}|${decisionSeq}`;
  const inFlight = capturing.get(key);
  if (inFlight) return inFlight;
  const job = capture(shop, decisionSeq).finally(() => capturing.delete(key));
  capturing.set(key, job);
  return job;
}

async function capture(shop: string, decisionSeq: number): Promise<AuditEntry> {
  const { log, proposal } = await payableDecision(shop, decisionSeq);
  const done = forDecision(log, "order_captured", decisionSeq);
  if (done) return done;
  const created = openOrder(log, decisionSeq);
  if (created?.event.type !== "order_created") throw new ExecutionRefused(`Decision ${decisionSeq} has no open PayPal order`);
  const { orderId, amountCents } = created.event;

  return withPaymentLock(shop, async () => {
  const again = forDecision(await auditEntries(shop), "order_captured", decisionSeq);
  if (again) return again;
  let order = await runPayPalTool<PayPalOrder>("get_order", { id: orderId });
  if (order.status === "APPROVED") {
    // Only the merchant's own PayPal account may approve; anyone else holding the link can't pay.
    if (!allowedApprover(order.payer?.payer_id)) {
      await closeOrder(shop, decisionSeq, orderId, "wrong_payer");
      throw new ExecutionRefused("This PayPal order was approved by an account that isn't the store's; nothing was captured");
    }
    // The merchant approved inside PayPal; the rules still get the final word before capture.
    await recheckAtPayment(shop, decisionSeq, { approvedByPerson: true });
    assertPaymentsEnabled(); // last thing before money moves
    order = await paypal<PayPalOrder>(`/v2/checkout/orders/${orderId}/capture`, { method: "POST", requestId: `gb-capture-${orderId}` });
  } else if (order.status !== "COMPLETED") {
    throw new ExecutionRefused(`PayPal order ${orderId} is ${order.status}, not approved yet`);
  }

  const cap = checkCapture(order, amountCents, proposal.payeeEmail);

  // Independent read-back through PayPal's Agent Toolkit.
  const confirmed = await runPayPalTool<PayPalOrder>("get_order", { id: orderId }).then(
    (o) => o.status === "COMPLETED",
    () => false,
  );

  return appendAudit(shop, {
    type: "order_captured",
    decisionSeq,
    orderId,
    captureId: cap.id,
    status: cap.status,
    amountCents,
    payerId: order.payer?.payer_id,
    confirmedByGetOrder: confirmed,
  });
  });
}

/** Finds which shop and decision a PayPal order belongs to (PayPal's redirect only carries the order id). */
export async function findOrder(orderId: string) {
  const row = await db.auditEntry.findFirst({ where: { type: "order_created", event: { path: ["orderId"], equals: orderId } } });
  const event = row?.event as { decisionSeq?: number } | undefined;
  return row && typeof event?.decisionSeq === "number" ? { shop: row.shop, decisionSeq: event.decisionSeq } : null;
}
