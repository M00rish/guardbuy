import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { runRestock } from "../lib/agent/restock.server";
import { checkStock, ensureSalesHistory, stockForInventoryItem } from "../lib/inventory/trigger.server";

// Fires whenever stock changes (sales, restocks, manual edits). This is the agent's trigger.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  if (!admin) return new Response(); // app uninstalled; nothing to do

  const { inventory_item_id } = payload as { inventory_item_id: number };

  await ensureSalesHistory(admin, shop);
  const item = await stockForInventoryItem(admin, inventory_item_id);
  // Products without a SKU have no supplier offers yet (until merchants link suppliers per variant).
  if (!item?.sku) return new Response();

  const check = await checkStock(shop, { ...item, sku: item.sku });
  console.log(
    `[stock] ${shop} ${item.sku} (variant ${item.variantId}): ${item.available} left in all locations, ${check.perDay.toFixed(2)}/day, ` +
      `${Number.isFinite(check.daysOfCover) ? check.daysOfCover.toFixed(1) : "∞"} days of cover` +
      (check.needsRestock ? " -> needs restock" : ""),
  );
  if (check.needsRestock) {
    // Shopify retries webhooks that take over 5s, and the LLM + PayPal calls can, so answer now
    // and let the restock run in the background (runRestock skips SKUs that already have one).
    void runRestock(shop, check)
      .then((r) => console.log(`[restock] ${shop} ${item.sku}: ${JSON.stringify(r)}`))
      .catch((e) => console.error(`[restock] ${shop} ${item.sku} failed:`, e));
  }

  return new Response();
};
