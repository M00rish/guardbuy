import { timingSafeEqual } from "node:crypto";

import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { auditEntries } from "../audit/log.server";
import { reconcileShop } from "../paypal/reconcile.server";
import { enqueueRestock } from "./restock-queue.server";

// The hourly job (called by a scheduler with JOBS_SECRET):
//  1. reconcile payouts and PayPal orders (status, transaction-search confirmation, approvals
//     captured in PayPal, expired orders, refunds)
//  2. sweep every managed product, so restocks don't depend only on Shopify webhooks
//  3. return each store's latest audit-log fingerprint, for publishing outside the database

export function authorized(request: Request) {
  const secret = process.env.JOBS_SECRET ?? "";
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 24 || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

const recent = () => new Date(Date.now() - 7 * 86_400_000);

export async function runHourlyJob() {
  const report: Record<string, string[]> = {};
  const note = (shop: string, line: string) => (report[shop] ??= []).push(line);

  // Stores with GuardBuy installed, plus any shop (incl. judge sandboxes) that paid in the last week.
  const installed = (await db.session.findMany({ where: { isOnline: false }, select: { shop: true } })).map((s) => s.shop);
  const paying = (
    await db.auditEntry.findMany({ where: { type: { in: ["payout", "order_created"] }, at: { gte: recent() } }, distinct: ["shop"], select: { shop: true } })
  ).map((r) => r.shop);

  // 1. Reconcile.
  for (const shop of new Set([...installed, ...paying])) {
    try {
      for (const line of await reconcileShop(shop)) note(shop, line);
    } catch (e) {
      note(shop, `reconcile failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 2. Sweep managed products in installed stores.
  for (const shop of installed) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const managed = await db.managedProduct.findMany({ where: { shop, managed: true } });
      for (const p of managed) {
        const res = await admin.graphql(
          `#graphql
          query Sweep($id: ID!) { productVariant(id: $id) { sku inventoryItem { id } } }`,
          { variables: { id: `gid://shopify/ProductVariant/${p.variantId}` } },
        );
        const v = ((await res.json()) as { data?: { productVariant?: { sku: string | null; inventoryItem: { id: string } } | null } }).data?.productVariant;
        if (!v?.sku) continue;
        await enqueueRestock(shop, v.inventoryItem.id.split("/").pop()!);
        note(shop, `${v.sku}: stock check queued`);
      }
    } catch (e) {
      note(shop, `product sweep failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 3. Latest fingerprint per installed store (judge sandboxes are throwaway and aren't published).
  const fingerprints = [];
  for (const shop of installed) {
    const head = (await auditEntries(shop)).at(-1);
    if (head) fingerprints.push({ shop, seq: head.seq, at: head.at, hash: head.hash });
  }
  return { at: new Date().toISOString(), fingerprints, report };
}
