import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { variantKey } from "../lib/inventory/sales.server";
import { linkSupplier, setManaged, unlinkSupplier } from "../lib/suppliers/directory.server";

// Products & suppliers: which products GuardBuy may restock, and from whom, on what terms.

type ProductsQuery = {
  products: {
    nodes: { title: string; variants: { nodes: { id: string; title: string; sku: string | null; inventoryQuantity: number | null }[] } }[];
  };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const res = await admin.graphql(`#graphql
    query GuardBuyProducts {
      products(first: 50, sortKey: TITLE) {
        nodes { title variants(first: 20) { nodes { id title sku inventoryQuantity } } }
      }
    }`);
  const { data } = (await res.json()) as { data: ProductsQuery };
  const [managed, links, suppliers] = await Promise.all([
    db.managedProduct.findMany({ where: { shop } }),
    db.productSupplier.findMany({ where: { shop }, include: { supplier: true } }),
    db.supplier.findMany({ where: { shop }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const isOn = new Map(managed.map((m) => [m.variantId, m.managed]));

  const variants = data.products.nodes.flatMap((p) =>
    p.variants.nodes.map((v) => {
      const variantId = variantKey(v.id);
      return {
        variantId,
        title: v.title === "Default Title" ? p.title : `${p.title} · ${v.title}`,
        sku: v.sku || null,
        stock: v.inventoryQuantity,
        managed: isOn.get(variantId) ?? false,
        links: links
          .filter((l) => l.variantId === variantId)
          .map((l) => ({ supplierId: l.supplierId, name: l.supplier.name, priceCents: l.unitPriceCents, usualQuantity: l.usualQuantity, leadTimeDays: l.leadTimeDays, preferred: l.preferred })),
      };
    }),
  );
  return { variants, suppliers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const f = await request.formData();
  const variantId = String(f.get("variantId") ?? "");
  if (!/^\d+$/.test(variantId)) return { ok: false, message: "Unknown product" };

  switch (f.get("intent")) {
    case "toggle":
      await setManaged(shop, { variantId, sku: String(f.get("sku") || "") || null, title: String(f.get("title") ?? "") }, f.get("managed") === "true");
      return { ok: true, message: f.get("managed") === "true" ? "Switched on for GuardBuy" : "Switched off" };
    case "link": {
      const supplierId = String(f.get("supplierId") ?? "");
      const price = Math.round(Number(f.get("price")) * 100);
      const usualQuantity = Number(f.get("usualQuantity"));
      const leadTimeDays = Number(f.get("leadTimeDays"));
      if (!supplierId || !(price > 0) || !Number.isInteger(usualQuantity) || usualQuantity < 1 || !Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
        return { ok: false, message: "Pick a supplier and enter a price, usual order size and lead time" };
      }
      const exists = await db.supplier.findUnique({ where: { shop_id: { shop, id: supplierId } } });
      if (!exists) return { ok: false, message: "Unknown supplier" };
      await linkSupplier(shop, variantId, supplierId, { unitPriceCents: price, usualQuantity, leadTimeDays, preferred: f.get("preferred") === "on" });
      return { ok: true, message: "Supplier linked" };
    }
    case "unlink":
      await unlinkSupplier(shop, variantId, String(f.get("supplierId") ?? ""));
      return { ok: true, message: "Supplier removed from this product" };
    default:
      return { ok: false, message: "Unknown action" };
  }
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function Products() {
  const { variants, suppliers } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Products & suppliers">
      <s-section>
        <s-paragraph>
          Switch on the products GuardBuy may restock and link the suppliers it may buy them from. The agent only ever sees the
          suppliers you link here.
        </s-paragraph>
        {suppliers.length === 0 && (
          <s-banner tone="info" heading="Add a supplier first">
            <s-link href="/app/suppliers">Add your suppliers and their PayPal emails</s-link>, then link them to products here.
          </s-banner>
        )}
      </s-section>
      {variants.map((v) => (
        <ProductCard key={v.variantId} v={v} suppliers={suppliers} />
      ))}
    </s-page>
  );
}

type Variant = ReturnType<typeof useLoaderData<typeof loader>>["variants"][number];

function ProductCard({ v, suppliers }: { v: Variant; suppliers: { id: string; name: string }[] }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const unlinked = suppliers.filter((s) => !v.links.some((l) => l.supplierId === s.id));

  return (
    <s-section heading={v.title}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={v.managed ? "success" : "neutral"}>{v.managed ? "GuardBuy restocks this" : "Not managed"}</s-badge>
          <s-text tone="neutral">
            SKU {v.sku ?? "none"} · {v.stock ?? "?"} in stock
          </s-text>
          <s-button
            variant={v.managed ? "tertiary" : "secondary"}
            disabled={busy}
            onClick={() => fetcher.submit({ intent: "toggle", variantId: v.variantId, sku: v.sku ?? "", title: v.title, managed: String(!v.managed) }, { method: "POST" })}
          >
            {v.managed ? "Switch off" : "Switch on"}
          </s-button>
        </s-stack>

        {v.links.length > 0 && (
          <s-stack gap="small-200">
            {v.links.map((l) => (
              <s-stack key={l.supplierId} direction="inline" gap="small-200" alignItems="center">
                <s-text type="strong">{l.name}</s-text>
                {l.preferred && <s-badge tone="info">Preferred</s-badge>}
                <s-text tone="neutral">
                  {usd(l.priceCents)} per unit · usually {l.usualQuantity} · {l.leadTimeDays} days lead time
                </s-text>
                <s-button variant="tertiary" tone="critical" disabled={busy}
                  onClick={() => fetcher.submit({ intent: "unlink", variantId: v.variantId, supplierId: l.supplierId }, { method: "POST" })}>
                  Remove
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        )}

        {unlinked.length > 0 && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="link" />
            <input type="hidden" name="variantId" value={v.variantId} />
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <s-select label="Link a supplier" name="supplierId">
                {unlinked.map((s) => (
                  <s-option key={s.id} value={s.id}>{s.name}</s-option>
                ))}
              </s-select>
              <s-number-field label="Price per unit ($)" name="price" min={0.01} step={0.01} />
              <s-number-field label="Usual order" name="usualQuantity" min={1} step={1} />
              <s-number-field label="Lead time (days)" name="leadTimeDays" min={0} step={1} value="3" />
              <s-checkbox label="Preferred" name="preferred" value="on" />
              <s-button type="submit" disabled={busy}>Link</s-button>
            </s-stack>
          </fetcher.Form>
        )}
        {fetcher.data && <s-text tone={fetcher.data.ok ? "success" : "critical"}>{fetcher.data.message}</s-text>}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
