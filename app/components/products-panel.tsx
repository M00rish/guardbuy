import { ViewFilter } from "./view-tabs";
import { DataGrid, cell, GridBadge } from "./data-grid";
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
          <ViewFilter
            options={VIEWS.map((v) => ({ ...v, count: count(v.id) }))}
            value={view}
            onChange={(id) => {
              const next = new URLSearchParams(params);
              if (id === "all") next.delete("view");
              else next.set("view", id);
              setParams(next, { replace: true });
            }}
          />

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
            <DataGrid<ProductsPageData["products"][number]>
              label="Products"
              rows={shown}
              rowId={(p) => String(p.variantId)}
              columns={[
                {
                  field: "title",
                  headerName: "Product",
                  flex: 2,
                  minWidth: 230,
                  getQuickFilterText: ({ data }) =>
                    [data?.title, data?.sku].filter(Boolean).join(" "),
                  cellRenderer: cell<ProductsPageData["products"][number]>(
                    (p) => (
                      <>
                        <s-stack gap="none">
                          <s-text
                            type={p.managed ? "strong" : "generic"}
                            tone={p.managed ? "auto" : "neutral"}
                          >
                            {p.title}
                          </s-text>
                          {p.sku && <s-text tone="neutral">{p.sku}</s-text>}
                        </s-stack>
                      </>
                    ),
                  ),
                },
                {
                  field: "stock",
                  headerName: "Stock",
                  type: "numericColumn",
                  width: 100,
                  cellRenderer: cell<ProductsPageData["products"][number]>(
                    (p) => <>{p.stock}</>,
                  ),
                },
                {
                  field: "cover",
                  headerName: "Days of cover",
                  type: "numericColumn",
                  width: 130,
                  cellRenderer: cell<ProductsPageData["products"][number]>(
                    (p) => <>{p.cover === null ? "Unavailable" : p.cover}</>,
                  ),
                },
                {
                  colId: "suppliers",
                  headerName: "Suppliers",
                  flex: 2,
                  minWidth: 245,
                  autoHeight: true,
                  wrapText: true,
                  valueGetter: ({ data }) =>
                    data?.suppliers.map((s) => s.name).join(", ") ?? "None",
                  cellRenderer: cell<ProductsPageData["products"][number]>(
                    (p) => (
                      <span>
                        {p.suppliers.find((s) => s.preferred)?.name ??
                          p.suppliers[0]?.name ??
                          "None"}
                        {p.suppliers.length > 1
                          ? ` +${p.suppliers.length - 1}`
                          : ""}
                      </span>
                    ),
                  ),
                },
                {
                  field: "managed",
                  headerName: "Auto restock",
                  width: 135,
                  valueGetter: ({ data }) => (data?.managed ? "On" : "Off"),
                  cellRenderer: cell<ProductsPageData["products"][number]>(
                    (p) => (
                      <>
                        <input
                          type="checkbox"
                          aria-label={`Restock ${p.title} automatically`}
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
                      </>
                    ),
                  ),
                },
                {
                  colId: "actions",
                  headerName: "Actions",
                  width: 140,
                  sortable: false,
                  filter: false,
                  cellRenderer: cell<ProductsPageData["products"][number]>(
                    (p) => (
                      <>
                        <s-button
                          variant="tertiary"
                          href={`/app/products/${p.variantId}`}
                        >
                          {p.suppliers.length ? "Manage" : "Link supplier"}
                        </s-button>
                      </>
                    ),
                  ),
                },
              ]}
              renderDetail={(p) => (
                <div>
                  <h3>{p.title} · suppliers</h3>
                  {p.suppliers.length ? (
                    <DataGrid
                      label="Linked suppliers"
                      rows={p.suppliers}
                      rowId={(s) => String(p.suppliers.indexOf(s))}
                      height={220}
                      search={false}
                      columns={[
                        {
                          field: "name",
                          headerName: "Supplier",
                          flex: 1,
                          minWidth: 180,
                        },
                        { field: "price", headerName: "Price", width: 120 },
                        {
                          colId: "state",
                          headerName: "Status",
                          flex: 1,
                          minWidth: 180,
                          cellRenderer: cell<(typeof p.suppliers)[number]>(
                            (s) => (
                              <>
                                {s.preferred && (
                                  <GridBadge tone="info">Preferred</GridBadge>
                                )}{" "}
                                {!s.approved && (
                                  <GridBadge tone="caution">
                                    Not approved in rules
                                  </GridBadge>
                                )}
                              </>
                            ),
                          ),
                        },
                      ]}
                    />
                  ) : (
                    <p>No supplier linked yet.</p>
                  )}
                  <p>
                    <s-link href={`/app/products/${p.variantId}`}>
                      Manage product & supplier settings →
                    </s-link>
                  </p>
                </div>
              )}
              height={640}
            />
          )}
        </s-stack>
      </s-section>
    </s-stack>
  );
}
