import { paypalStoreBinding } from "./config.server";
import { privacyWriteAllowed } from "../privacy/state.server";
import db from "../../db.server";
import { fundingKey } from "../payments/attempts.server";
import { paypal } from "./client.server";
import { webhookUrl } from "./webhook-registration.server";
import { payoutNotification, signatureInput } from "./webhook";
const LIMIT = 128 * 1024;
export async function readWebhookJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > LIMIT) {
      await reader.cancel();
      throw Error("Body too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export async function receivePayoutWebhook(request: Request) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (process.env.GUARDBUY_PAYPAL_WEBHOOKS === "off")
    return new Response(null, { status: 404 });
  let event: unknown;
  try {
    event = await readWebhookJson(request);
  } catch {
    return new Response("Invalid notification", { status: 400 });
  }
  const notification = payoutNotification(event);
  if (!notification)
    return new Response("Unsupported notification", { status: 400 });
  try {
    const accountKey = fundingKey();
    const sub = await db.payPalWebhookSubscription.findUnique({
      where: { accountKey },
    });
    if (!sub?.webhookId || sub.url !== webhookUrl())
      return new Response("Webhook setup pending", { status: 503 });
    let body;
    try {
      body = signatureInput(request.headers, sub.webhookId, event);
    } catch {
      return new Response("Invalid signature headers", { status: 401 });
    }
    const verification = await paypal<{ verification_status?: string }>(
      "/v1/notifications/verify-webhook-signature",
      { method: "POST", body, maxAttempts: 1, timeoutMs: 10_000 },
    );
    if (verification.verification_status !== "SUCCESS")
      return new Response("Invalid signature", { status: 401 });
    const owners = await db.auditEntry.findMany({
      where: {
        type: "payout",
        event: {
          path: ["payoutBatchId"],
          equals: notification.resource.payout_batch_id,
        },
      },
      select: { shop: true },
      take: 2,
    });
    const shop = owners.length === 1 ? owners[0].shop : null;
    if (shop) {
      try {
        paypalStoreBinding(shop);
      } catch {
        return new Response(null, { status: 204 });
      }
    }
    await db.$transaction(async (tx) => {
      const inserted = await tx.payPalWebhookReceipt.createMany({
        data: [{ accountKey, eventId: notification.id }],
        skipDuplicates: true,
      });
      if (!inserted.count) return;
      if (shop && !(await privacyWriteAllowed(tx, shop))) return;
      const batchId = notification.resource.payout_batch_id;
      await tx.payPalPayoutSignal.upsert({
        where: { accountKey_batchId: { accountKey, batchId } },
        create: { accountKey, batchId, shop },
        update: {
          generation: { increment: 1 },
          receivedAt: new Date(),
          availableAt: new Date(),
          attempts: 0,
        },
      });
    });
    // Acknowledge only after durable storage. The worker never receives the untrusted body.
    return new Response(null, { status: 204 });
  } catch {
    console.warn("[paypal-webhooks] Notification deferred");
    return new Response("Try again later", { status: 503 });
  }
}
