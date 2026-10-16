import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import db from "../../db.server";
import { backfillSales, daysOfCover, salesPerDay, variantKey } from "./sales.server";

// Until merchants can sign their own rules (policy engine task), use the demo default.
export const DEFAULT_REORDER_BELOW_DAYS = 7;

export type StockCheck = {
  variantId: string;
  sku: string;
  available: number; // across all locations
  perDay: number;
  daysOfCover: number;
  needsRestock: boolean;
};

/** Backfills sales history until one backfill has fully completed for this shop. */
export async function ensureSalesHistory(admin: AdminApiContext, shop: string) {
  const done = await db.salesBackfill.findUnique({ where: { shop } });
  if (!done) await backfillSales(admin, shop);
}

export type StockItem = { variantId: string; sku: string | null; createdAt: Date; available: number };

/**
 * The variant behind an inventory item and its stock summed over every location. Webhook payloads
 * only carry one location's level, but sales are counted store-wide, so cover must use the total.
 */
export async function stockForInventoryItem(admin: AdminApiContext, inventoryItemId: number | string): Promise<StockItem | null> {
  const res = await admin.graphql(
    `#graphql
    query Stock($id: ID!) {
      inventoryItem(id: $id) {
        variant { id sku createdAt }
        inventoryLevels(first: 50) { nodes { quantities(names: ["available"]) { quantity } } }
      }
    }`,
    { variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` } },
  );
  type Data = {
    inventoryItem: {
      variant: { id: string; sku: string | null; createdAt: string } | null;
      inventoryLevels: { nodes: { quantities: { quantity: number }[] }[] };
    } | null;
  };
  const { data } = (await res.json()) as { data: Data };
  const item = data.inventoryItem;
  if (!item?.variant) return null;
  const available = item.inventoryLevels.nodes.reduce((sum, l) => sum + (l.quantities[0]?.quantity ?? 0), 0);
  return { variantId: variantKey(item.variant.id), sku: item.variant.sku || null, createdAt: new Date(item.variant.createdAt), available };
}

export async function checkStock(
  shop: string,
  item: StockItem & { sku: string },
  reorderBelowDays = DEFAULT_REORDER_BELOW_DAYS,
): Promise<StockCheck> {
  const perDay = await salesPerDay(shop, item.variantId, item.createdAt);
  const cover = daysOfCover(item.available, perDay);
  return { variantId: item.variantId, sku: item.sku, available: item.available, perDay, daysOfCover: cover, needsRestock: cover < reorderBelowDays };
}
