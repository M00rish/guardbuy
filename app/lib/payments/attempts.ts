import { deliveries } from "../inventory/deliveries";
import type { AuditEntry, AuditEvent } from "../policy/schema";

export type Attempt = Extract<AuditEvent, { type: "payment_attempt" }>;
export type PaymentResult = Extract<AuditEvent, { type: "payout" | "order_created" | "order_captured" }>;
export class PaymentPending extends Error {
  constructor() { super("Awaiting PayPal confirmation. The original payment remains reserved; do not create a replacement purchase."); }
}
export class PaymentRejected extends Error {}
export class PaymentRouteRefused extends Error {}

export function attemptStates(log: AuditEntry[]) {
  return log.flatMap((entry) => {
    if (entry.event.type !== "payment_attempt") return [];
    const attempt = entry.event;
    const result = log.find((e) => "paymentAttemptId" in e.event && e.event.paymentAttemptId === attempt.attemptId);
    const outcome = [...log].reverse().find((e) => e.event.type === "payment_outcome" && e.event.attemptId === attempt.attemptId)?.event;
    return [{ attempt, at: entry.at, result, state: result ? "recorded" as const : outcome?.type === "payment_outcome" && outcome.status === "failed" ? "failed" as const : "unresolved" as const }];
  });
}
export const unresolvedPayments = (log: AuditEntry[]) => attemptStates(log).filter((s) => s.state === "unresolved");
export function canCloseOrder(log: AuditEntry[], decisionSeq: number, orderId: string) {
  return !unresolvedPayments(log).some((s) => s.attempt.decisionSeq === decisionSeq && s.attempt.operation === "order_capture")
    && !log.some((e) => (e.event.type === "order_captured" || e.event.type === "order_closed") && e.event.orderId === orderId);
}
export function paymentReservations(log: AuditEntry[]) {
  return new Map(unresolvedPayments(log).map((s) => [s.attempt.decisionSeq, s]));
}

const SETTLED_FAILURES = new Set(["DENIED", "CANCELED", "CANCELLED", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DECLINED"]);

export function canStartAttempt(log: AuditEntry[], attempt: Attempt) {
  if (attemptStates(log).some((s) => s.attempt.attemptId === attempt.attemptId)) return false;
  if (log.some((e) => "decisionSeq" in e.event && e.event.decisionSeq === attempt.decisionSeq && ["payout", "order_captured", "rejected"].includes(e.event.type))) return false;
  if (unresolvedPayments(log).some((s) => s.attempt.decisionSeq === attempt.decisionSeq)) return false;
  const legacyUnknown = log.some((e) => e.event.type === "payment_failed" && e.event.decisionSeq === attempt.decisionSeq && !e.event.definitive)
    && !attemptStates(log).some((s) => s.attempt.decisionSeq === attempt.decisionSeq);
  if (legacyUnknown && (attempt.operation !== "payout" || !attempt.previouslyUncertain)) return false;
  const proposalFor = (seq: number) => {
    const decision = log.find((e) => e.seq === seq)?.event;
    if (decision?.type !== "decision") return null;
    const p = log.find((e) => e.seq === decision.proposalSeq)?.event;
    return p?.type === "proposal" ? p.proposal : null;
  };
  const current = proposalFor(attempt.decisionSeq);
  const decision = log.find((e) => e.seq === attempt.decisionSeq)?.event;
  const source = decision?.type === "decision" ? log.find((e) => e.seq === decision.proposalSeq)?.event : undefined;
  if (decision?.type !== "decision" || decision.decision.verdict === "block" || source?.type !== "proposal" || source.scenario
    || decision.decision.totalCents !== attempt.amountCents || current?.payeeEmail?.toLowerCase() !== attempt.payeeEmail.toLowerCase()) return false;
  const approved = log.some((e) => e.event.type === "approved" && e.event.decisionSeq === attempt.decisionSeq);
  if (attempt.operation === "payout" && decision.decision.verdict === "approval" && !approved) return false;
  if (attempt.operation === "order_create" && (decision.decision.verdict !== "approval" || approved)) return false;
  if (deliveries(log).some((d) => d.decisionSeq !== attempt.decisionSeq && d.variantId === current?.variantId && (d.remaining > 0 || d.pending) && (d.payment !== "failed" || d.pending))) return false;
  if ([...purchaseReservations(log).keys()].some((seq) => {
    if (seq === attempt.decisionSeq) return false;
    const other = proposalFor(seq);
    return !!current && !!other && (current.variantId && other.variantId ? current.variantId === other.variantId : current.sku === other.sku);
  })) return false;
  const created = [...log].reverse().find((e) => e.event.type === "order_created" && e.event.decisionSeq === attempt.decisionSeq)?.event;
  const open = created?.type === "order_created" && !log.some((e) => e.event.type === "order_closed" && e.event.orderId === created.orderId);
  if (attempt.operation === "order_capture") return !!open && created.type === "order_created" && created.orderId === attempt.providerId;
  return !open;
}

type Ports = {
  read: () => Promise<AuditEntry[]>;
  reserve: (attempt: Attempt) => Promise<boolean>;
  append: (event: AuditEvent) => Promise<unknown>;
  record: (event: PaymentResult) => Promise<AuditEntry>;
  lookup: (attempt: Attempt) => Promise<PaymentResult | null>;
  send: (attempt: Attempt) => Promise<PaymentResult>;
  beforeSend: (attempt: Attempt) => Promise<void>;
  fundingKey: string;
  now?: () => number;
};

/** Durable, append-only protocol; every provider write uses the exact persisted body and key. */
export async function runPaymentAttempt(candidate: Attempt, ports: Ports): Promise<AuditEntry> {
  let log = await ports.read();
  let state = attemptStates(log).find((s) => s.attempt.decisionSeq === candidate.decisionSeq && s.attempt.operation === candidate.operation && s.state === "unresolved")
    ?? attemptStates(log).find((s) => s.attempt.attemptId === candidate.attemptId && s.state !== "failed");
  let fresh = false;
  if (!state) {
    if (!await ports.reserve(candidate)) throw new PaymentRouteRefused("Another payment route or decision update already reserved this purchase. Refresh its status.");
    fresh = true;
    log = await ports.read();
    state = attemptStates(log).find((s) => s.attempt.attemptId === candidate.attemptId);
  }
  if (!state) throw new PaymentPending();
  const attempt = state.attempt;
  if (attempt.fundingKey !== ports.fundingKey) throw new PaymentPending();
  if (state.result) return state.result;
  // Read-only recovery is permitted even after the provider's idempotency window has expired.
  try {
    const found = await ports.lookup(attempt);
    if (found) return await ports.record({ ...found, paymentAttemptId: attempt.attemptId });
  } catch { throw new PaymentPending(); }
  if ((ports.now ?? Date.now)() >= Date.parse(attempt.retryUntil)) throw new PaymentPending();
  // Safety checks may refuse a replay that could otherwise perform a first payment. Keep the reservation.
  try { await ports.beforeSend(attempt); }
  catch {
    if (fresh && !attempt.previouslyUncertain) {
      await ports.append({ type: "payment_outcome", decisionSeq: attempt.decisionSeq, attemptId: attempt.attemptId, status: "failed" });
      throw new PaymentRejected("Payment was not submitted because current safety checks or account access could not be confirmed.");
    }
    throw new PaymentPending();
  }
  if ((ports.now ?? Date.now)() >= Date.parse(attempt.retryUntil)) throw new PaymentPending();
  try {
    const result = await ports.send(attempt);
    return await ports.record({ ...result, paymentAttemptId: attempt.attemptId });
  } catch (error) {
    // A later error can NEVER prove that an earlier uncertain request did not move money.
    const definitive = fresh && !attempt.previouslyUncertain && error instanceof PaymentRejected;
    await ports.append({ type: "payment_outcome", decisionSeq: attempt.decisionSeq, attemptId: attempt.attemptId, status: definitive ? "failed" : "unknown" });
    if (definitive) throw error;
    throw new PaymentPending();
  }
}

/** Unknown and provider-pending money never ages out of the committed budget. */
export function purchaseReservations(log: AuditEntry[]) {
  const reserved = new Map<number, { amountCents: number; at: string }>();
  for (const state of unresolvedPayments(log)) reserved.set(state.attempt.decisionSeq, { amountCents: state.attempt.amountCents, at: state.at });
  for (const entry of log) {
    const ev = entry.event;
    if (ev.type === "payout") {
      const update = [...log].reverse().find((e) => e.event.type === "payout_status" && e.event.payoutSeq === entry.seq)?.event;
      // A batch SUCCESS alone does not prove that its recipient item succeeded.
      const status = update?.type === "payout_status" ? update.status : SETTLED_FAILURES.has(ev.status) ? ev.status : "PENDING";
      if (status !== "SUCCESS" && !SETTLED_FAILURES.has(status)) reserved.set(ev.decisionSeq, { amountCents: ev.amountCents, at: entry.at });
    }
    if (ev.type === "order_captured") {
      const update = [...log].reverse().find((e) => e.event.type === "order_status" && e.event.orderId === ev.orderId)?.event;
      const status = update?.type === "order_status" ? update.status : ev.status;
      if (status !== "COMPLETED" && status !== "PARTIALLY_REFUNDED" && !SETTLED_FAILURES.has(status)) reserved.set(ev.decisionSeq, { amountCents: ev.amountCents, at: entry.at });
    }
    if (ev.type === "order_created" && !log.some((e) => (e.event.type === "order_closed" || e.event.type === "order_captured") && e.event.orderId === ev.orderId)) {
      reserved.set(ev.decisionSeq, { amountCents: ev.amountCents, at: entry.at });
    }
    if (ev.type === "payment_failed" && !ev.definitive && !log.some((e) => "decisionSeq" in e.event && e.event.decisionSeq === ev.decisionSeq && ["payment_attempt", "payout", "order_captured", "rejected"].includes(e.event.type))) {
      const d = log.find((e) => e.seq === ev.decisionSeq);
      if (d?.event.type === "decision") reserved.set(ev.decisionSeq, { amountCents: d.event.decision.totalCents, at: entry.at });
    }
  }
  return reserved;
}

/** Known pending payments are tracked in Activity; only missing outcomes need resumption. */
export function unknownPaymentDecisions(log: AuditEntry[]) {
  const unknown = new Set(unresolvedPayments(log).map((s) => s.attempt.decisionSeq));
  for (const seq of purchaseReservations(log).keys()) {
    const known = log.some((e) => "decisionSeq" in e.event && e.event.decisionSeq === seq && (["payout", "order_captured"].includes(e.event.type)
      || e.event.type === "order_created" && !log.some((closed) => closed.event.type === "order_closed" && closed.event.orderId === (e.event.type === "order_created" ? e.event.orderId : ""))));
    if (!known) unknown.add(seq);
  }
  return unknown;
}
