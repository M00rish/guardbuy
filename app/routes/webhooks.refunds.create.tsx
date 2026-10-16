import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { recordSalesOnce } from "../lib/inventory/sales.server";

// Refunds (including cancelled orders, which Shopify refunds) take units back out of the sales
// totals, so refunded sales don't inflate the sales rate and trigger over-ordering.
// Units come off on the refund's day. Only variant, quantity and date are read.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, eventId, webhookId } = await authenticate.webhook(request);
  const refund = payload as {
    created_at: string;
    refund_line_items?: { quantity: number; line_item?: { variant_id: number | null } }[];
  };

  await recordSalesOnce(
    shop,
    eventId ?? webhookId,
    topic,
    new Date(refund.created_at),
    (refund.refund_line_items ?? []).map((r) => ({ variantId: r.line_item?.variant_id ?? null, units: -r.quantity })),
  );
  return new Response();
};
