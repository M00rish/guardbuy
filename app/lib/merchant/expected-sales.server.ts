import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { appendAuditWhen } from "../audit/log.server";
import { withPaymentLock } from "../agent/payment-lock.server";
import { enqueueRestockInTransaction } from "../jobs/restock-queue.server";

export async function saveExpectedSales(admin: AdminApiContext, shop: string, actor: string, variantId: string, raw: string) {
  const rate = raw.trim() === "" ? null : Number(raw);
  if (!/^\d+$/.test(variantId) || (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 1000000))) return { ok: false, message: "Enter expected sales greater than 0 and no more than 1,000,000 units per day, or leave blank to use sales history." };
  const response = await admin.graphql(`#graphql
    query ExpectedSalesProduct($id: ID!) { productVariant(id: $id) { id title sku product { title } inventoryItem { id tracked } } }
  `, { variables: { id: `gid://shopify/ProductVariant/${variantId}` } });
  const body = await response.json() as { errors?: unknown[]; data?: { productVariant: { id: string; title: string; sku: string | null; product: { title: string }; inventoryItem: { id: string; tracked: boolean } } | null } };
  const v = body.data?.productVariant;
  if (body.errors?.length || v?.id !== `gid://shopify/ProductVariant/${variantId}`) return { ok: false, message: "Product could not be verified in this store. Sales estimate was not saved." };
  const title = v.title === "Default Title" ? v.product.title : `${v.product.title} · ${v.title}`;
  return withPaymentLock(`restock:${shop}|${variantId}`, async lease => {
    await appendAuditWhen(shop, { type: "daily_sales_estimate_changed", variantId, unitsPerDay: rate, by: actor }, undefined, lease, undefined, async tx => {
      const product = await tx.managedProduct.upsert({
        where: { shop_variantId: { shop, variantId } },
        create: { shop, variantId, title, sku: v.sku, managed: false, dailySalesOverride: rate },
        update: { title, sku: v.sku, dailySalesOverride: rate },
      });
      const itemId = /^gid:\/\/shopify\/InventoryItem\/(\d+)$/.exec(v.inventoryItem.id)?.[1];
      if (product.managed && itemId && v.inventoryItem.tracked) {
        const job = await enqueueRestockInTransaction(tx, shop, itemId);
        if (!job) throw new Response("This store is not active", { status: 410 });
      }
    });
    return { ok: true, message: rate === null ? "Sales-history estimate restored. Enabled products will be rechecked under your current rules." : `Expected sales saved: ${rate} units/day. Enabled products will be rechecked under your current rules.` };
  });
}
