import { sha256Hex } from "../policy/hash";
import { randomUUID } from "node:crypto";
import db from "../../db.server";
import { fundingKey } from "../payments/attempts.server";
import { paypal } from "./client.server";
import { PAYOUT_WEBHOOK_EVENTS } from "./webhook";
export function webhookUrl() {
  const url = new URL(process.env.SHOPIFY_APP_URL ?? "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw Error("A public HTTPS app URL is required");
  return `${url.origin}/paypal/webhook`;
}
export async function activePayoutWebhook() {
  if (process.env.GUARDBUY_PAYPAL_WEBHOOKS === "off") return null;
  try {
    const row = await db.payPalWebhookSubscription.findUnique({
      where: { accountKey: fundingKey() },
    });
    return row?.webhookId &&
      row.url === webhookUrl() &&
      row.checkedAt &&
      Date.now() - row.checkedAt.getTime() < 24 * 3600_000
      ? row
      : null;
  } catch {
    return null;
  }
}
/** List before create: a lost registration response is recovered without a second endpoint. */
export async function ensurePayoutWebhook() {
  const accountKey = fundingKey(),
    url = webhookUrl(),
    holder = randomUUID(),
    now = new Date();
  await db.payPalWebhookSubscription.createMany({
    data: [{ accountKey, url, availableAt: now }],
    skipDuplicates: true,
  });
  const claim = await db.payPalWebhookSubscription.updateMany({
    where: {
      accountKey,
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      AND: [{ OR: [{ availableAt: { lte: now } }, { url: { not: url } }] }],
    },
    data: { holder, lockedUntil: new Date(Date.now() + 180_000) },
  });
  if (!claim.count) return;
  try {
    type Hook = { id: string; url: string; event_types: { name: string }[] };
    const list = await paypal<{ webhooks?: Hook[] }>(
      "/v1/notifications/webhooks",
    );
    let hook = list.webhooks?.find((h) => h.url === url);
    if (!hook)
      hook = await paypal<Hook>("/v1/notifications/webhooks", {
        method: "POST",
        body: {
          url,
          event_types: PAYOUT_WEBHOOK_EVENTS.map((name) => ({ name })),
        },
        requestId: `gb-hook-${sha256Hex(accountKey + url).slice(0, 28)}`,
      });
    else if (
      !PAYOUT_WEBHOOK_EVENTS.every((name) =>
        hook!.event_types.some((e) => e.name === name || e.name === "*"),
      )
    ) {
      // Update this endpoint only. Other integrations on the same app are left alone.
      await paypal(
        `/v1/notifications/webhooks/${encodeURIComponent(hook.id)}`,
        {
          method: "PATCH",
          body: [
            {
              op: "replace",
              path: "/event_types",
              value: PAYOUT_WEBHOOK_EVENTS.map((name) => ({ name })),
            },
          ],
        },
      );
    }
    if (hook.url !== url || !hook.id) throw Error("Missing webhook identity");
    await db.payPalWebhookSubscription.updateMany({
      where: { accountKey, holder },
      data: {
        url,
        webhookId: hook.id,
        checkedAt: new Date(),
        availableAt: new Date(Date.now() + 6 * 3600_000),
        holder: null,
        lockedUntil: null,
      },
    });
  } catch {
    await db.payPalWebhookSubscription.updateMany({
      where: { accountKey, holder },
      data: {
        availableAt: new Date(Date.now() + 15 * 60_000),
        holder: null,
        lockedUntil: null,
      },
    });
    console.warn(
      "[paypal-webhooks] Registration deferred; reconciliation remains available",
    );
  }
}
