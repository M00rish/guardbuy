import { useEffect } from "react";
import { useFetcher, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Empty, Unavailable } from "./ui";
import type {
  ProductsPageData,
  ProductActionData,
} from "../lib/merchant/products-page.server";
type View = "all" | "managed" | "none";
const VIEWS: { id: View; label: string }[] = [
  { id: "all", label: "All" },
  { id: "managed", label: "Managed" },
  { id: "none", label: "No supplier" },
];

export function ProductsPanel({ data }: { data: ProductsPageData }) {
  const { products, supplierCount, unavailable } = data;
  const fetcher = useFetcher<ProductActionData>();
  const shopify = useAppBridge();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.id === params.get("view"))?.id ??
    "all") as View;
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const needsSupplier = (p: (typeof products)[number]) =>
    p.managed && p.suppliers.length === 0;
  const inView = (p: (typeof products)[number], v: View) =>
    v === "managed"
      ? p.managed
      : v === "none"
        ? p.suppliers.length === 0
        : true;
  const shown = products.filter((p) => inView(p, view));
  const count = (v: View) => products.filter((p) => inView(p, v)).length;

  return (
    <s-stack gap="base">
      {supplierCount === 0 && (
        <s-banner tone="info" heading="Add your suppliers first">
          GuardBuy can only buy from suppliers you add, with the PayPal email
          they get paid at.{" "}
          <s-link href="/app/products?tab=suppliers">Add a supplier</s-link>
        </s-banner>
      )}

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {VIEWS.map((v) => (
              <s-button
                key={v.id}
                variant={v.id === view ? "secondary" : "tertiary"}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  if (v.id === "all") next.delete("view");
                  else next.set("view", v.id);
                  setParams(next, { replace: true });
                }}
              >
                {`${v.label} (${count(v.id)})`}
              </s-button>
            ))}
          </s-stack>

          {unavailable ? (
            <Unavailable what="your products" />
          ) : products.length === 0 ? (
            <Empty heading="No products in your store yet">
              Products you add in Shopify show up here automatically, ready to
              switch on for GuardBuy.
            </Empty>
          ) : shown.length === 0 ? (
            <Empty
              heading={
                view === "managed"
                  ? "No products switched on yet"
                  : "Every product has a supplier"
              }
            >
              {view === "managed"
                ? "Switch on a product in All to let GuardBuy restock it."
                : "Nothing to link here."}
            </Empty>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header format="numeric">Stock</s-table-header>
                <s-table-header format="numeric">Days left</s-table-header>
                <s-table-header listSlot="secondary">Suppliers</s-table-header>
                <s-table-header>GuardBuy</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {shown.map((p) => (
                  <s-table-row key={p.variantId}>
                    <s-table-cell>
                      <s-stack gap="none">
                        <s-text
                          type={p.managed ? "strong" : "generic"}
                          tone={p.managed ? "auto" : "neutral"}
                        >
                          {p.title}
                        </s-text>
                        {p.sku && <s-text tone="neutral">{p.sku}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{p.stock}</s-table-cell>
                    <s-table-cell>
                      {p.cover === null ? "–" : p.cover}
                    </s-table-cell>
                    <s-table-cell>
                      {p.suppliers.length === 0 ? (
                        needsSupplier(p) ? (
                          <s-badge tone="caution">Needs a supplier</s-badge>
                        ) : (
                          <s-text tone="neutral">None</s-text>
                        )
                      ) : (
                        <s-stack gap="none">
                          {p.suppliers.map((s) => (
                            <s-stack
                              key={s.name}
                              direction="inline"
                              gap="small-200"
                              alignItems="center"
                            >
                              <s-text type={s.preferred ? "strong" : "generic"}>
                                {s.name}
                              </s-text>
                              <s-text tone="neutral">{s.price}</s-text>
                              {s.preferred && (
                                <s-badge tone="info">Preferred</s-badge>
                              )}
                              {!s.approved && (
                                <s-badge tone="caution">
                                  Not approved in rules
                                </s-badge>
                              )}
                            </s-stack>
                          ))}
                        </s-stack>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-switch
                        label="Restock with GuardBuy"
                        labelAccessibilityVisibility="exclusive"
                        checked={p.managed}
                        disabled={busy}
                        onChange={() =>
                          fetcher.submit(
                            {
                              intent: "toggle",
                              variantId: p.variantId,
                              sku: p.sku ?? "",
                              title: p.title,
                              managed: String(!p.managed),
                            },
                            { method: "POST", action: "/app/products" },
                          )
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        href={`/app/products/${p.variantId}`}
                      >
                        {p.suppliers.length ? "Manage" : "Link supplier"}
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-stack>
  );
}
