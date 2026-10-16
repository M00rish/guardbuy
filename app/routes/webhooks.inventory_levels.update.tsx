import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { runRestock } from "../lib/agent/restock.server";
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
  if (check.needsRestock) {
    // Shopify retries webhooks that take over 5s, and the LLM + PayPal calls can, so answer now
    // and let the restock run in the background (runRestock skips SKUs that already have one).
    void runRestock(shop, check)
      .then((r) => console.log(`[restock] ${shop} ${sku}: ${JSON.stringify(r)}`))
      .catch((e) => console.error(`[restock] ${shop} ${sku} failed:`, e));
  }

  return new Response();
};
