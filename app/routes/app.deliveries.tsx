import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { DeliveriesPage } from "../components/deliveries-page";
import { DELIVERY_VIEWS, inDeliveryView } from "../lib/inventory/delivery-view";
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
  const params = new URL(request.url).searchParams;
  const view = DELIVERY_VIEWS.find((v) => v.id === params.get("view"))?.id ?? "all";
  const counts = Object.fromEntries(DELIVERY_VIEWS.map((v) => [v.id, all.filter((d) => inDeliveryView(d, v.id)).length])) as Record<typeof view, number>;
  const outstanding = all.filter((d) => inDeliveryView(d, view));
  const requested = Number(params.get("page") ?? 1);
  const page = Math.min(Math.max(1, Number.isSafeInteger(requested) ? requested : 1), Math.max(1, Math.ceil(outstanding.length / 30)));
  const rows = outstanding.slice((page - 1) * 30, page * 30);
  const cards = await Promise.all(rows.map(async (d) => {
    let locations: { id: string; name: string }[] = [];
    let locationError = false;
    if (d.payment === "paid" && d.remaining > 0 && !d.pending) {
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
  return { cards, view, counts, total: all.length, page, pages: Math.max(1, Math.ceil(outstanding.length / 30)) };
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
  return <DeliveriesPage data={useLoaderData<typeof loader>()} />;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
