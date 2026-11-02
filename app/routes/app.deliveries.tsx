import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { auditEntries } from "../lib/audit/log.server";
import { feedNames } from "../lib/merchant/dashboard.server";
import { deliveries, DeliveryRefused } from "../lib/inventory/deliveries";
import { receiptLocations, receiver } from "../lib/inventory/receive.server";
import { refreshPayouts } from "../lib/paypal/reconcile.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await adminWithStaff(request);
  await refreshPayouts(session.shop);
  const [log, names] = await Promise.all([auditEntries(session.shop), feedNames(session.shop)]);
  const all = deliveries(log).reverse();
  const outstanding = all.filter((d) => d.remaining > 0 || d.pending);
  const requested = Number(new URL(request.url).searchParams.get("page") ?? 1);
  const page = Math.min(Math.max(1, Number.isSafeInteger(requested) ? requested : 1), Math.max(1, Math.ceil(outstanding.length / 30)));
  const rows = outstanding.slice((page - 1) * 30, page * 30);
  const cards = await Promise.all(rows.map(async (d) => {
    let locations: { id: string; name: string }[] = [];
    let locationError = false;
    if (d.payment === "paid" && !d.pending) {
      try { locations = (await receiptLocations(admin, d.variantId)).locations; }
      catch { locationError = true; }
    }
    return {
      ...d,
      // Never send the entire pending audit entry to the browser.
      pending: d.pending ? { receiptId: d.pending.event.receiptId, quantity: d.pending.event.quantity, expectedReceived: d.pending.event.expectedReceived, locationId: d.pending.event.locationId } : null,
      receiptId: d.pending?.event.receiptId ?? randomUUID(),
      title: names.product(d.sku, d.variantId) ?? d.sku,
      supplier: names.supplier(d.supplierId) ?? "Supplier",
      locations, locationError,
    };
  }));
  return { cards, page, pages: Math.max(1, Math.ceil(outstanding.length / 30)), completed: all.filter((d) => d.remaining === 0 && !d.pending).length };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, actor } = await adminWithStaff(request);
  const form = await request.formData();
  if (form.get("intent") !== "receive") return { ok: false, message: "Unknown action" };
  try {
    const message = await receiver(admin)(session.shop, actor, {
      decisionSeq: Number(form.get("decisionSeq")), receiptId: String(form.get("receiptId") ?? ""),
      quantity: Number(form.get("quantity")), expectedReceived: Number(form.get("expectedReceived")), locationId: String(form.get("locationId") ?? ""),
    });
    return { ok: true, message };
  } catch (error) {
    return { ok: false, message: error instanceof DeliveryRefused ? error.message : "Receipt could not be confirmed. Reload and resolve any pending receipt before making manual stock changes." };
  }
};

export default function Deliveries() {
  const { cards, completed, page, pages } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <s-page heading="Supplier deliveries" inlineSize="large">
      <s-section>
        <s-stack gap="base">
          <s-paragraph>Payment and delivery are separate steps. Record goods only when they physically arrive. Choose the location and quantity actually received; Shopify stock increases by that quantity.</s-paragraph>
          <s-text>{`${completed} purchases fully received.`}</s-text>
          <s-button disabled={revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}>Refresh payment and delivery status</s-button>
          <s-link href="/app/activity">Check payment status and receipt history in Activity</s-link>
          {cards.length === 0 && <s-text>No outstanding supplier deliveries.</s-text>}
          {pages > 1 && <s-stack direction="inline" gap="base">
            <s-text>{`Page ${page} of ${pages}`}</s-text>
            {page > 1 && <s-link href={`/app/deliveries?page=${page - 1}`}>Previous</s-link>}
            {page < pages && <s-link href={`/app/deliveries?page=${page + 1}`}>Next</s-link>}
          </s-stack>}
        </s-stack>
      </s-section>
      {cards.map((card) => <DeliveryCard key={card.decisionSeq} card={card} />)}
    </s-page>
  );
}

type Card = Awaited<ReturnType<typeof loader>>["cards"][number];
function DeliveryCard({ card }: { card: Card }) {
  const fetcher = useFetcher<typeof action>();
  const pending = card.pending;
  return (
    <s-section heading={`${card.title} · purchase #${card.decisionSeq}`}>
      <s-stack gap="base">
        <s-text>{`${card.supplier} · ${card.ordered} ordered · ${card.received} received · ${card.remaining} outstanding`}</s-text>
        <s-badge tone={card.payment === "paid" ? "success" : card.payment === "failed" ? "critical" : "caution"}>
          {card.payment === "paid" ? "Paid · awaiting delivery" : card.payment === "failed" ? "Payment failed or returned · review needed" : "Payment pending · awaiting confirmation"}
        </s-badge>
        {card.locationError && <s-text>Inventory locations could not be loaded. Check inventory permissions and refresh.</s-text>}
        {pending && <s-banner tone="warning" heading="Receipt needs confirmation">Shopify may already have added these units. Retry the same receipt to confirm its outcome. Do not enter another receipt or adjust stock manually.</s-banner>}
        {(pending || card.payment === "paid" && card.locations.length > 0) && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="receive" />
            <input type="hidden" name="decisionSeq" value={card.decisionSeq} />
            <input type="hidden" name="receiptId" value={card.receiptId} />
            <input type="hidden" name="expectedReceived" value={pending?.expectedReceived ?? card.received} />
            {pending ? <>
              <input type="hidden" name="quantity" value={pending.quantity} />
              <input type="hidden" name="locationId" value={pending.locationId} />
              <p>{`Confirm the existing receipt for ${pending.quantity} units.`}</p>
            </> : <>
              <p><label>Quantity received now <input name="quantity" type="number" min={1} max={card.remaining} step={1} defaultValue={card.remaining} required /></label></p>
              <p><label>Receiving location <select name="locationId" required defaultValue={card.locations.length === 1 ? card.locations[0].id : ""}>
                <option value="" disabled>Choose a location</option>
                {card.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select></label></p>
            </>}
            <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>{pending ? "Confirm existing receipt" : "Receive delivery and update stock"}</s-button>
          </fetcher.Form>
        )}
        {fetcher.data && <s-text>{fetcher.data.message}</s-text>}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
