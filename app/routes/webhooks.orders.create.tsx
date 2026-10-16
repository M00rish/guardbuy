import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recordSalesOnce } from "../lib/inventory/sales.server";

// Keeps daily sales totals current. Only variant, quantity and date are read from the order.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, eventId, webhookId } = await authenticate.webhook(request);
  const order = payload as {
    processed_at?: string;
    created_at: string;
    line_items: { variant_id: number | null; quantity: number }[];
  };

  await recordSalesOnce(
    shop,
    eventId ?? webhookId,
    topic,
    new Date(order.processed_at ?? order.created_at),
    order.line_items.map((li) => ({ variantId: li.variant_id, units: li.quantity })),
  );
  return new Response();
};
