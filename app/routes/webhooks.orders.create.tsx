import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recordSale } from "../lib/inventory/sales.server";

// Keeps daily sales totals current. Only SKU, quantity and date are read from the order.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as {
    processed_at?: string;
    created_at: string;
    line_items: { sku: string | null; quantity: number }[];
  };

  const at = new Date(order.processed_at ?? order.created_at);
  for (const li of order.line_items) {
    if (li.sku) await recordSale(shop, li.sku, at, li.quantity);
  }

  return new Response();
};
