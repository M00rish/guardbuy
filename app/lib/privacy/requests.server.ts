import db from "../../db.server";
import { privacyShopHash } from "./state.server";

const TOPICS = new Set(["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT", "SHOP_REDACT"]);
const DAY = 86_400_000;
export type PrivacyDelivery = { shop: string; topic: string; eventId: string; requestId?: string };

/** Store receipt metadata only. A 200 acknowledges durable receipt, never fulfillment. */
export async function receivePrivacyRequest({ shop, topic, eventId, requestId }: PrivacyDelivery) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !TOPICS.has(topic) || !eventId || eventId.length > 200) throw new Response("Invalid privacy delivery", { status: 400 });
  const shopHash = privacyShopHash(shop);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"privacy:" + shop}))`;
    const { count } = await tx.privacyRequest.createMany({ data: [{ shop, shopHash, topic, eventId, requestId, dueAt: new Date(Date.now() + 30 * DAY) }], skipDuplicates: true });
    if (count === 0) return;
    if (topic === "SHOP_REDACT") {
      // INSERT only: duplicate deliveries never lift or reset an existing suppression marker.
      await tx.privacyBlock.createMany({ data: [{ shopHash }], skipDuplicates: true });
      await tx.session.deleteMany({ where: { shop } });
      await tx.shopSettings.deleteMany({ where: { shop } });
      await tx.alertChannel.deleteMany({ where: { shop } });
      await tx.restockJob.deleteMany({ where: { shop } });
      await tx.payoutCheck.deleteMany({ where: { shop } });
      await tx.payPalPayoutSignal.deleteMany({ where: { shop } });
    }
  }, { maxWait: 15_000, timeout: 20_000 });
}
