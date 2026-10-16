import type { LoaderFunctionArgs } from "react-router";

import { captureApprovalOrder, ExecutionRefused, findOrder } from "../lib/agent/execute.server";

// PayPal sends the merchant here after they approve (or cancel) a purchase order in PayPal.
// Public on purpose: PayPal's redirect carries no Shopify session. That's safe because capture
// only succeeds for an order the merchant has already approved inside PayPal, and the amount
// and supplier come from the audit log, not from this request.

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GuardBuy · ${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1a1a1a}h1{font-size:1.4rem}p{color:#555}</style>
</head><body><h1>${title}</h1><p>${body}</p><p>You can close this tab and go back to GuardBuy.</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("token");
  if (!orderId) return page("Missing order", "PayPal did not say which order this is.", 400);

  const found = await findOrder(orderId);
  if (!found) return page("Unknown order", "GuardBuy has no purchase order with this PayPal id.", 404);

  if (url.searchParams.has("cancelled")) {
    return page("Not approved", "You cancelled in PayPal, so nothing was paid. The purchase is still waiting for approval.");
  }

  try {
    const entry = await captureApprovalOrder(found.shop, found.decisionSeq);
    const amount = entry.event.type === "order_captured" ? `$${(entry.event.amountCents / 100).toFixed(2)}` : "";
    return page("Purchase approved and paid", `PayPal paid the supplier ${amount}. It's recorded in GuardBuy's audit log as entry #${entry.seq}.`);
  } catch (e) {
    console.error(`[orders] capture failed for ${orderId}:`, e);
    const msg = e instanceof ExecutionRefused ? escape(e.message) : "PayPal could not complete the payment. Nothing was charged twice; try again from GuardBuy.";
    return page("Payment not completed", msg, 409);
  }
};
