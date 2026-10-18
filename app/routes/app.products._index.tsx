import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { productOverview } from "../lib/merchant/dashboard.server";
import { setManaged } from "../lib/suppliers/directory.server";
import { usd } from "../lib/format";

// Products & suppliers (index): every product, whether GuardBuy restocks it, and from whom.
// "Manage" opens the product's page to link suppliers and set the preferred one.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [products, links, supplierCount] = await Promise.all([
    productOverview(admin, shop),
    db.productSupplier.findMany({ where: { shop }, include: { supplier: true }, orderBy: [{ preferred: "desc" }, { unitPriceCents: "asc" }] }),
    db.supplier.count({ where: { shop } }),
  ]);
  return {
    supplierCount,
    products: products.map((p) => ({
      variantId: p.variantId,
      title: p.title,
      sku: p.sku,
      stock: p.stock,
      cover: Number.isFinite(p.cover) ? Number(p.cover.toFixed(1)) : null,
      managed: p.managed,
      suppliers: links.filter((l) => l.variantId === p.variantId).map((l) => ({ name: l.supplier.name, price: usd(l.unitPriceCents), preferred: l.preferred })),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const variantId = String(f.get("variantId") ?? "");
  if (f.get("intent") !== "toggle" || !/^\d+$/.test(variantId)) return { ok: false, message: "Unknown action" };
  const on = f.get("managed") === "true";
  await setManaged(session.shop, { variantId, sku: String(f.get("sku") || "") || null, title: String(f.get("title") ?? "") }, on);
  return { ok: true, message: on ? "GuardBuy will restock this product" : "Product switched off" };
};

type View = "all" | "managed" | "needs";
const VIEWS: { id: View; label: string }[] = [
  { id: "all", label: "All" },
  { id: "managed", label: "Managed" },
  { id: "needs", label: "Needs a supplier" },
];

export default function Products() {
  const { products, supplierCount } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.id === params.get("view"))?.id ?? "all") as View;
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const needsSupplier = (p: (typeof products)[number]) => p.managed && p.suppliers.length === 0;
  const shown = products.filter((p) => (view === "managed" ? p.managed : view === "needs" ? needsSupplier(p) : true));
  const count = (v: View) => products.filter((p) => (v === "managed" ? p.managed : v === "needs" ? needsSupplier(p) : true)).length;

  return (
    <s-page heading="Products & suppliers" inlineSize="large">
      <s-button slot="primary-action" variant="primary" href="/app/suppliers">Add supplier</s-button>

      {supplierCount === 0 && (
        <s-banner tone="info" heading="Add your suppliers first">
          GuardBuy can only buy from suppliers you add, with the PayPal email they get paid at.{" "}
          <s-link href="/app/suppliers">Add a supplier</s-link>
        </s-banner>
      )}

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {VIEWS.map((v) => (
              <s-button key={v.id} variant={v.id === view ? "secondary" : "tertiary"}
                onClick={() => setParams(v.id === "all" ? {} : { view: v.id }, { replace: true })}>
                {`${v.label} (${count(v.id)})`}
              </s-button>
            ))}
          </s-stack>

          {shown.length === 0 ? (
            <s-text tone="neutral">
              {products.length === 0 ? "Your Shopify products appear here automatically." : "No products in this view."}
            </s-text>
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
                        <s-text type={p.managed ? "strong" : "generic"} tone={p.managed ? "auto" : "neutral"}>{p.title}</s-text>
                        {p.sku && <s-text tone="neutral">{p.sku}</s-text>}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{p.stock}</s-table-cell>
                    <s-table-cell>{p.cover === null ? "–" : p.cover}</s-table-cell>
                    <s-table-cell>
                      {p.suppliers.length === 0 ? (
                        needsSupplier(p) ? <s-badge tone="caution">Needs a supplier</s-badge> : <s-text tone="neutral">None</s-text>
                      ) : (
                        <s-stack gap="none">
                          {p.suppliers.map((s) => (
                            <s-stack key={s.name} direction="inline" gap="small-200" alignItems="center">
                              <s-text type={s.preferred ? "strong" : "generic"}>{s.name}</s-text>
                              <s-text tone="neutral">{s.price}</s-text>
                              {s.preferred && <s-badge tone="info">Preferred</s-badge>}
                            </s-stack>
                          ))}
                        </s-stack>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-switch label="Restock with GuardBuy" labelAccessibilityVisibility="exclusive" checked={p.managed} disabled={busy}
                        onChange={() => fetcher.submit({ intent: "toggle", variantId: p.variantId, sku: p.sku ?? "", title: p.title, managed: String(!p.managed) }, { method: "POST" })} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button variant="tertiary" href={`/app/products/${p.variantId}`}>
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
