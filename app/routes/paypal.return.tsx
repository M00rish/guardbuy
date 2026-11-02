import type { LoaderFunctionArgs } from "react-router";

import { PaymentPending, PaymentRouteRefused } from "../lib/payments/attempts";
import { captureApprovalOrder, closeOrder, ExecutionRefused, findOrder } from "../lib/agent/execute.server";
import { runPayPalTool } from "../lib/paypal/toolkit.server";

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
    // Close the order only if PayPal agrees it wasn't approved (this page is public).
    const status = await runPayPalTool<{ status: string }>("get_order", { id: orderId }).then((o) => o.status, () => "UNKNOWN");
    if (["CREATED", "PAYER_ACTION_REQUIRED", "VOIDED"].includes(status)) {
      try { await closeOrder(found.shop, found.decisionSeq, orderId, "cancelled"); }
      catch { return page("Awaiting confirmation", "The original payment is still reserved. Check it in GuardBuy before taking another action.", 409); }
    } else return page("Check payment status", "PayPal has not confirmed that this order is cancelled. Its reservation remains in GuardBuy.", 409);
    return page("Not approved", "You cancelled in PayPal, so nothing was paid. The purchase is back in GuardBuy's Approvals, where you can approve, decline or try PayPal again.");
  }

  try {
    const entry = await captureApprovalOrder(found.shop, found.decisionSeq);
    const amount = entry.event.type === "order_captured" ? `$${(entry.event.amountCents / 100).toFixed(2)}` : "";
    if (entry.event.type === "order_captured" && entry.event.status !== "COMPLETED") return page("Payment awaiting confirmation", "PayPal recorded the payment, but it is not yet confirmed complete. Check its status in GuardBuy.");
    return page("Purchase approved and paid", `PayPal paid the supplier ${amount}. It's recorded in GuardBuy's audit log as entry #${entry.seq}.`);
  } catch (e) {
    console.error("[orders] Capture outcome could not be confirmed");
    const msg = (e instanceof ExecutionRefused || e instanceof PaymentPending || e instanceof PaymentRouteRefused) ? escape(e.message) : "The original payment outcome is not confirmed. Check the purchase in GuardBuy before retrying.";
    return page("Payment not completed", msg, 409);
  }
};
