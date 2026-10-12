import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { checkStock, ensureSalesHistory, skuForInventoryItem } from "../lib/inventory/trigger.server";

// Fires whenever stock changes (sales, restocks, manual edits). This is the agent's trigger.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response(); // app uninstalled; nothing to do

  const { inventory_item_id, available } = payload as { inventory_item_id: number; available: number | null };
  if (available == null) return new Response();

  await ensureSalesHistory(admin, shop);
  const sku = await skuForInventoryItem(admin, inventory_item_id);
  if (!sku) return new Response();

  const check = await checkStock(shop, sku, available);
  console.log(
    `[stock] ${shop} ${sku}: ${available} left, ${check.perDay.toFixed(2)}/day, ` +
      `${Number.isFinite(check.daysOfCover) ? check.daysOfCover.toFixed(1) : "∞"} days of cover` +
      (check.needsRestock ? " -> needs restock" : ""),
  );
  // Next: hand `check` to the LLM proposer when needsRestock is true.

  return new Response();
};
