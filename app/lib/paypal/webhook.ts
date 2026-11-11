// Browser-safe constants and pure validation; never trust a notification as payment proof.
export const PAYOUT_WEBHOOK_EVENTS = [
  "BLOCKED",
  "CANCELED",
  "FAILED",
  "HELD",
  "REFUNDED",
  "RETURNED",
  "SUCCEEDED",
  "UNCLAIMED",
].map((s) => `PAYMENT.PAYOUTS-ITEM.${s}`);
const ID = /^[A-Za-z0-9-]{1,160}$/;
export type PayoutNotification = {
  id: string;
  event_type: string;
  resource: { payout_batch_id: string };
};
export function payoutNotification(value: unknown): PayoutNotification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<PayoutNotification>;
  return typeof v.id === "string" &&
    ID.test(v.id) &&
    typeof v.event_type === "string" &&
    PAYOUT_WEBHOOK_EVENTS.includes(v.event_type) &&
    typeof v.resource?.payout_batch_id === "string" &&
    ID.test(v.resource.payout_batch_id)
    ? (v as PayoutNotification)
    : null;
}
export function signatureInput(
  headers: Headers,
  webhookId: string,
  event: unknown,
) {
  const read = (key: string) => {
    const v = headers.get(key);
    if (!v || v.length > 3000) throw Error("Missing signature header");
    return v;
  };
  const cert = read("paypal-cert-url");
  const url = new URL(cert);
  if (
    url.protocol !== "https:" ||
    ![
      "api.sandbox.paypal.com",
      "api-m.sandbox.paypal.com",
      "api.paypal.com",
      "api-m.paypal.com",
    ].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/v1/notifications/certs/")
  )
    throw Error("Invalid certificate origin");
  const algo = read("paypal-auth-algo");
  if (algo !== "SHA256withRSA") throw Error("Invalid signature algorithm");
  return {
    auth_algo: algo,
    cert_url: cert,
    transmission_id: read("paypal-transmission-id"),
    transmission_sig: read("paypal-transmission-sig"),
    transmission_time: read("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  };
}
