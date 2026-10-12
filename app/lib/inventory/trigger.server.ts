import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import db from "../../db.server";
import { backfillSales, daysOfCover, salesPerDay } from "./sales.server";

// Until merchants can sign their own rules (policy engine task), use the demo default.
export const DEFAULT_REORDER_BELOW_DAYS = 7;

export type StockCheck = {
  sku: string;
  available: number;
  perDay: number;
  daysOfCover: number;
  needsRestock: boolean;
};

/** Backfills sales history until one backfill has fully completed for this shop. */
export async function ensureSalesHistory(admin: AdminApiContext, shop: string) {
  const done = await db.salesBackfill.findUnique({ where: { shop } });
  if (!done) await backfillSales(admin, shop);
}

/** Looks up the SKU behind an inventory item (webhook payloads only carry the item id). */
export async function skuForInventoryItem(admin: AdminApiContext, inventoryItemId: number | string) {
  const res = await admin.graphql(
    `#graphql
    query Sku($id: ID!) { inventoryItem(id: $id) { sku } }`,
    { variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` } },
  );
  const { data } = (await res.json()) as { data: { inventoryItem: { sku: string | null } | null } };
  return data.inventoryItem?.sku ?? null;
}

export async function checkStock(
  shop: string,
  sku: string,
  available: number,
  reorderBelowDays = DEFAULT_REORDER_BELOW_DAYS,
): Promise<StockCheck> {
  const perDay = await salesPerDay(shop, sku);
  const cover = daysOfCover(available, perDay);
  return { sku, available, perDay, daysOfCover: cover, needsRestock: cover < reorderBelowDays };
}
