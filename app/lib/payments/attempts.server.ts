import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { sha256Hex } from "../policy/hash";
import { merchantCredentials, paypal, PayPalError } from "../paypal/client.server";
import { renewPaymentLease, type PaymentLease } from "../agent/payment-lock.server";
import { canStartAttempt, runPaymentAttempt, PaymentRejected, type Attempt, type PaymentResult } from "./attempts";

export function fundingKey() {
  return sha256Hex((process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com") + ":" + merchantCredentials().clientId);
}

// Only positive request rejections are definitive, and only for the very first submission.
const REJECTIONS = new Set(["VALIDATION_ERROR", "INVALID_REQUEST", "INSUFFICIENT_FUNDS", "PERMISSION_DENIED", "AUTHENTICATION_FAILURE", "NOT_AUTHORIZED"]);
export function definitivePayPalRejection(error: unknown) {
  if (!(error instanceof PayPalError) || ![400, 401, 403, 422].includes(error.status)) return false;
  const body = error.body as { name?: string; details?: { issue?: string }[] } | null;
  if (!body) return false;
  if (body.details !== undefined && !Array.isArray(body.details)) return false;
  if (body.details?.length) return body.details.every((d) => !!d && REJECTIONS.has(d.issue ?? ""));
  return REJECTIONS.has(body.name ?? "");
}

export function candidateAttempt(input: Omit<Attempt, "type" | "attemptId" | "fundingKey" | "retryUntil">, anchor = Date.now()): Attempt {
  return { type: "payment_attempt", ...input, attemptId: input.requestId, fundingKey: fundingKey(), retryUntil: new Date(anchor + (input.operation === "payout" ? 29 * 24 : 5) * 60 * 60_000).toISOString() };
}

export function performAttempt(shop: string, attempt: Attempt, lease: PaymentLease, callbacks: {
  lookup: (attempt: Attempt) => Promise<PaymentResult | null>;
  send: (attempt: Attempt) => Promise<PaymentResult>;
  beforeSend: (attempt: Attempt) => Promise<void>;
}) {
  return runPaymentAttempt(attempt, {
    read: () => auditEntries(shop), fundingKey: fundingKey(),
    reserve: async (event) => !!await appendAuditWhen(shop, event, (log) => canStartAttempt(log, event), lease),
    append: (event) => appendAuditWhen(shop, event, (log) => {
      if (event.type !== "payment_outcome") return true;
      const previous = [...log].reverse().find((e) => e.event.type === "payment_outcome" && e.event.attemptId === event.attemptId)?.event;
      return previous?.type !== "payment_outcome" || previous.status !== event.status;
    }, event.type === "payment_outcome" && event.status === "failed" ? lease : undefined),
    record: async (event) => {
      const appended = await appendAuditWhen(shop, event, (log) => !log.some((e) => "paymentAttemptId" in e.event && e.event.paymentAttemptId === event.paymentAttemptId));
      if (appended) return appended;
      const recorded = (await auditEntries(shop)).find((e) => "paymentAttemptId" in e.event && e.event.paymentAttemptId === event.paymentAttemptId);
      if (!recorded) throw new Error("Payment evidence unavailable");
      return recorded;
    },
    lookup: callbacks.lookup,
    beforeSend: async (saved) => {
      await callbacks.beforeSend(saved);
      await renewPaymentLease(lease);
    },
    send: async (saved) => {
      try { return await callbacks.send(saved); }
      catch (error) {
        if (definitivePayPalRejection(error)) throw new PaymentRejected("PayPal definitively rejected this new payment request. Review the purchase before trying again.");
        throw error;
      }
    },
  });
}

/** Never follow a provider link to another host or outside the payout-detail endpoint. */
export function duplicatePayoutPath(body: unknown, base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com"): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { links?: { href?: string }[]; details?: { links?: { href?: string }[] }[] };
  const links = [...(Array.isArray(b.links) ? b.links : []), ...(Array.isArray(b.details) ? b.details : []).flatMap((d) => Array.isArray(d?.links) ? d.links : [])];
  for (const link of links) {
    try {
      const url = new URL(link.href ?? "", base);
      if (url.origin === new URL(base).origin && /^\/v1\/payments\/payouts\/[A-Z0-9]+$/.test(url.pathname) && !url.search && !url.hash) return url.pathname;
    } catch { /* Ignore malformed/untrusted links. */ }
  }
  return null;
}

export async function submitPayout<T>(attempt: Attempt): Promise<T> {
  try { return await paypal<T>("/v1/payments/payouts", { method: "POST", requestId: attempt.requestId, body: attempt.body, maxAttempts: 1 }); }
  catch (error) {
    const path = error instanceof PayPalError ? duplicatePayoutPath(error.body) : null;
    if (!path) throw error;
    const found = await paypal<T>(path);
    const batch = found as { batch_header?: { sender_batch_header?: { sender_batch_id?: string } }; items?: { payout_item?: { receiver?: string; amount?: { value?: string; currency?: string } } }[] };
    const item = batch.items?.[0]?.payout_item;
    if (batch.batch_header?.sender_batch_header?.sender_batch_id !== attempt.requestId || batch.items?.length !== 1 || item?.receiver?.toLowerCase() !== attempt.payeeEmail.toLowerCase() || item.amount?.currency !== attempt.currency || Math.round(Number(item.amount?.value) * 100) !== attempt.amountCents) throw new Error("Original payout identity could not be verified");
    return found;
  }
}
