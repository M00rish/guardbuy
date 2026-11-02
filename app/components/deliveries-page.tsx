import { useCallback, useEffect, useRef, useState, type ElementRef } from "react";
import { useFetcher, useRevalidator, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { action, loader } from "../routes/app.deliveries";
import { DELIVERY_VIEWS } from "../lib/inventory/delivery-view";
import { Empty, Filters } from "./ui";

type Data = Awaited<ReturnType<typeof loader>>;
type Card = Data["cards"][number];

function deliveryStatus(card: Card) {
  if (card.pending) return { label: "Confirm receipt", tone: "warning" as const };
  if (card.remaining === 0) return { label: "Received", tone: "success" as const };
  if (card.payment === "failed") return { label: "Payment needs review", tone: "critical" as const };
  if (card.payment === "pending") return { label: "Payment pending", tone: "caution" as const };
  if (card.received > 0) return { label: "Partially received", tone: "info" as const };
  return { label: "Awaiting delivery", tone: "info" as const };
}

export function DeliveriesPage({ data }: { data: Data }) {
  const { cards, view, counts, total, page, pages } = data;
  const [, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const modal = useRef<ElementRef<"s-modal">>(null);
  const receiveButton = useRef<ElementRef<"s-button">>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [locationId, setLocationId] = useState("");
  const [error, setError] = useState("");
  const lastResult = useRef<typeof fetcher.data>();
  const card = cards.find((row) => row.decisionSeq === selected);
  const busy = fetcher.state !== "idle";
  const defaultQuantity = String(card?.pending?.quantity ?? card?.remaining ?? "");
  const defaultLocation = card?.pending?.locationId ?? (card?.locations.length === 1 ? card.locations[0].id : "");

  // A fresh receipt ID/remaining quantity means the old form must never keep its old amount.
  useEffect(() => {
    setQuantity(defaultQuantity);
    setLocationId(defaultLocation);
    setError("");
  }, [selected, card?.receiptId, card?.remaining, defaultQuantity, defaultLocation]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || lastResult.current === fetcher.data) return;
    lastResult.current = fetcher.data;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    if (fetcher.data.ok) {
      modal.current?.hideOverlay();
      setSelected(null);
    } else setError(fetcher.data.message);
  }, [fetcher.state, fetcher.data, shopify]);

  const open = (row: Card) => {
    setSelected(row.decisionSeq);
    setQuantity(String(row.pending?.quantity ?? row.remaining));
    setLocationId(row.pending?.locationId ?? (row.locations.length === 1 ? row.locations[0].id : ""));
    setError("");
    modal.current?.showOverlay();
  };
  const receive = useCallback(() => {
    if (!card || busy) return;
    const amount = card.pending?.quantity ?? Number(quantity);
    const location = card.pending?.locationId ?? locationId;
    if (!card.pending && (!Number.isSafeInteger(amount) || amount < 1 || amount > card.remaining)) {
      setError(`Enter a whole number from 1 to ${card.remaining}.`); return;
    }
    if (!location) { setError("Choose the location where these goods arrived."); return; }
    setError("");
    fetcher.submit({ intent: "receive", decisionSeq: card.decisionSeq, receiptId: card.receiptId, quantity: amount,
      expectedReceived: card.pending?.expectedReceived ?? card.received, locationId: location }, { method: "POST" });
  }, [card, busy, quantity, locationId, fetcher]);
  // Modal footer actions are slotted by Polaris. A native listener also works when
  // their click does not bubble through React's delegated event root.
  useEffect(() => {
    const button = receiveButton.current;
    button?.addEventListener("click", receive);
    return () => button?.removeEventListener("click", receive);
  }, [receive]);
  const pageLink = (number: number) => `/app/deliveries?${new URLSearchParams({ ...(view === "all" ? {} : { view }), page: String(number) })}`;

  return (
    <s-page heading="Supplier deliveries" inlineSize="large">
      <s-button slot="primary-action" variant="primary" disabled={busy || revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}
        {...(revalidator.state !== "idle" ? { loading: true } : {})}>Refresh status</s-button>
      <s-button slot="secondary-actions" href="/app/activity">View activity</s-button>
      <s-section>
        <s-stack gap="base">
          <Filters value={view} options={DELIVERY_VIEWS.map((v) => ({ ...v, count: counts[v.id] }))}
            onChange={(next) => { if (!busy) setParams(next === "all" ? {} : { view: next }, { replace: true }); }} />
          {total === 0 ? <Empty heading="No supplier deliveries yet">Supplier purchases appear here after payment is submitted. Receive goods when they arrive to update Shopify stock.</Empty>
            : cards.length === 0 ? <Empty heading="No deliveries in this view">Try All to see your supplier purchases.</Empty>
            : <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="secondary">Supplier</s-table-header>
                <s-table-header format="numeric">Ordered</s-table-header>
                <s-table-header format="numeric">Received</s-table-header>
                <s-table-header format="numeric">Remaining</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {cards.map((row) => {
                  const status = deliveryStatus(row);
                  const canReceive = !!row.pending || row.remaining > 0 && row.payment === "paid";
                  return <s-table-row key={row.decisionSeq}>
                    <s-table-cell><s-stack gap="none"><s-link href={`/app/products/${row.variantId}`}>{row.title}</s-link><s-text tone="neutral">{`${row.sku} · purchase #${row.decisionSeq}`}</s-text></s-stack></s-table-cell>
                    <s-table-cell>{row.supplier}</s-table-cell>
                    <s-table-cell>{row.ordered}</s-table-cell>
                    <s-table-cell>{row.received}</s-table-cell>
                    <s-table-cell><s-text type={row.remaining ? "strong" : "generic"}>{row.remaining}</s-text></s-table-cell>
                    <s-table-cell><s-stack gap="small-200"><s-badge tone={status.tone}>{status.label}</s-badge>
                      {row.locationError && <s-text tone="neutral">Locations unavailable</s-text>}
                    </s-stack></s-table-cell>
                    <s-table-cell>{canReceive
                      ? <s-button variant="tertiary" disabled={busy} onClick={() => open(row)}>{row.pending ? "Confirm receipt" : "Receive"}</s-button>
                      : <s-button variant="tertiary" href="/app/activity">View activity</s-button>}
                    </s-table-cell>
                  </s-table-row>;
                })}
              </s-table-body>
            </s-table>}
          <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
            <s-text tone="neutral">Record only goods that have physically arrived. Receiving adds them to Shopify stock.</s-text>
            {pages > 1 && <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text tone="neutral">{`Page ${page} of ${pages}`}</s-text>
              {page > 1 && <s-button variant="tertiary" href={pageLink(page - 1)}>Previous</s-button>}
              {page < pages && <s-button variant="tertiary" href={pageLink(page + 1)}>Next</s-button>}
            </s-stack>}
          </s-stack>
        </s-stack>
      </s-section>

      <s-modal ref={modal} id="receive-delivery" heading={card?.pending ? "Confirm delivery receipt" : "Receive delivery"}>
        {card && <s-stack gap="base">
          <s-stack gap="small-200">
            <s-text type="strong">{card.title}</s-text>
            <s-text tone="neutral">{`${card.supplier} · purchase #${card.decisionSeq}`}</s-text>
          </s-stack>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="inline" gap="large">
              <s-text>{`${card.ordered} ordered`}</s-text><s-text>{`${card.received} received`}</s-text><s-text type="strong">{`${card.remaining} remaining`}</s-text>
            </s-stack>
          </s-box>
          {card.pending ? <>
            <s-banner tone="warning" heading="Confirm the existing receipt">Stock may already have been added. This retries the same receipt without adding it twice.</s-banner>
            <s-text>{`${card.pending.quantity} units in this receipt. Quantity and location are fixed until the outcome is confirmed.`}</s-text>
          </> : <>
            {card.locationError || card.locations.length === 0 ? <s-banner tone="warning" heading="Receiving locations unavailable">Close this dialog and refresh status. Check the app’s inventory permissions if locations still cannot be loaded.</s-banner> : <>
              <s-number-field label="Quantity received" value={quantity} min={1} max={card.remaining} step={1} disabled={busy}
                details={`Up to ${card.remaining} units outstanding. Enter only what arrived.`}
                onInput={(event) => { setQuantity(event.currentTarget.value); setError(""); }} />
              <s-select label="Receiving location" value={locationId} disabled={busy} onChange={(event) => { setLocationId(event.currentTarget.value); setError(""); }}>
                <s-option value="" disabled>Choose a location</s-option>
                {card.locations.map((location) => <s-option key={location.id} value={location.id}>{location.name}</s-option>)}
              </s-select>
              <s-text tone="neutral">{`This will add ${Number.isSafeInteger(Number(quantity)) && Number(quantity) > 0 && Number(quantity) <= card.remaining ? quantity : "the received"} units to the selected location.`}</s-text>
            </>}
          </>}
          {error && <s-banner tone="critical">{error}</s-banner>}
        </s-stack>}
        <s-button ref={receiveButton} slot="primary-action" variant="primary" disabled={!card || busy || !card.pending && (!card.locations.length || card.locationError)}
          {...(busy ? { loading: true } : {})}>{card?.pending ? "Confirm receipt" : "Receive stock"}</s-button>
        <s-button slot="secondary-actions" commandFor="receive-delivery" command="--hide" disabled={busy}>Cancel</s-button>
      </s-modal>
    </s-page>
  );
}
