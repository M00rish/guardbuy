import {
  DataGrid,
  cell,
  compareMoney,
  GridBadge,
} from "../components/data-grid";
import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { privateAdmin } from "../lib/merchant/staff.server";
import {
  linkSupplier,
  setManaged,
  setPreferred,
  unlinkSupplier,
} from "../lib/suppliers/directory.server";
import { usd } from "../lib/format";
import { auditEntries } from "../lib/audit/log.server";
import { currentRuleSet } from "../lib/agent/restock.server";
import { daysOfCover, salesPerDay } from "../lib/inventory/sales.server";
import { Empty } from "../components/ui";

// One product: whether GuardBuy restocks it, which suppliers it may buy it from, on what terms,
// and which one is preferred.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await privateAdmin(request);
  const shop = session.shop;
  const variantId = String(params.variantId ?? "");
  if (!/^\d+$/.test(variantId)) throw new Response("Not found", { status: 404 });

  const res = await admin.graphql(
    `#graphql
    query GuardBuyVariant($id: ID!) {
      productVariant(id: $id) { title sku inventoryQuantity createdAt product { title } }
    }`,
    { variables: { id: `gid://shopify/ProductVariant/${variantId}` } },
  );
  const { data } = (await res.json()) as {
    data: { productVariant: { title: string; sku: string | null; inventoryQuantity: number | null; createdAt: string; product: { title: string } } | null };
  };
  const v = data.productVariant;
  if (!v) throw new Response("Product not found", { status: 404 });

  const [managed, links, suppliers, log, perDay] = await Promise.all([
    db.managedProduct.findUnique({ where: { shop_variantId: { shop, variantId } } }),
    db.productSupplier.findMany({ where: { shop, variantId }, include: { supplier: true }, orderBy: [{ preferred: "desc" }, { unitPriceCents: "asc" }] }),
    db.supplier.findMany({ where: { shop }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    auditEntries(shop),
    salesPerDay(shop, variantId, new Date(v.createdAt)),
  ]);
  const allow = currentRuleSet(log)?.supplierAllowlist ?? null;
  const cover = daysOfCover(v.inventoryQuantity ?? 0, perDay);
  return {
    variantId,
    title: v.title === "Default Title" ? v.product.title : `${v.product.title} · ${v.title}`,
    sku: v.sku || null,
    stock: v.inventoryQuantity,
    perDay: Number(perDay.toFixed(2)),
    cover: Number.isFinite(cover) ? Number(cover.toFixed(1)) : null,
    managed: managed?.managed ?? false,
    links: links.map((l) => ({
      supplierId: l.supplierId, name: l.supplier.name, paypalEmail: l.supplier.paypalEmail,
      price: usd(l.unitPriceCents), usualQuantity: l.usualQuantity, leadTimeDays: l.leadTimeDays, preferred: l.preferred,
      approved: allow === null || allow.includes(l.supplierId),
    })),
    available: suppliers.filter((s) => !links.some((l) => l.supplierId === s.id)),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const shop = session.shop;
  const variantId = String(params.variantId ?? "");
  if (!/^\d+$/.test(variantId)) return { ok: false, message: "Unknown product" };
  const f = await request.formData();
  const supplierId = String(f.get("supplierId") ?? "");

  switch (f.get("intent")) {
    case "toggle": {
      const on = f.get("managed") === "true";
      await setManaged(shop, { variantId, sku: String(f.get("sku") || "") || null, title: String(f.get("title") ?? "") }, on);
      return { ok: true, message: on ? "Automatic restocking enabled" : "Automatic restocking disabled" };
    }
    case "link": {
      const price = Math.round(Number(f.get("price")) * 100);
      const usualQuantity = Number(f.get("usualQuantity"));
      const leadTimeDays = Number(f.get("leadTimeDays"));
      if (!supplierId || !(price > 0) || !Number.isInteger(usualQuantity) || usualQuantity < 1 || !Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
        return { ok: false, message: "Pick a supplier and enter a price, usual order size and lead time" };
      }
      if (!(await db.supplier.findUnique({ where: { shop_id: { shop, id: supplierId } } }))) return { ok: false, message: "Unknown supplier" };
      const first = (await db.productSupplier.count({ where: { shop, variantId } })) === 0;
      await linkSupplier(shop, variantId, supplierId, { unitPriceCents: price, usualQuantity, leadTimeDays, preferred: first || f.get("preferred") === "on" });
      return { ok: true, message: "Supplier linked" };
    }
    case "prefer":
      await setPreferred(shop, variantId, supplierId);
      return { ok: true, message: "Preferred supplier updated" };
    case "unlink":
      await unlinkSupplier(shop, variantId, supplierId);
      return { ok: true, message: "Supplier removed from this product" };
    default:
      return { ok: false, message: "Unknown action" };
  }
};

export default function ProductSuppliers() {
  const p = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (data: Record<string, string>) =>
    fetcher.submit(data, { method: "POST" });

  return (
    <s-page heading={p.title} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products & Suppliers
      </s-link>

      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-switch
            label="GuardBuy restocks this product"
            checked={p.managed}
            disabled={busy}
            onChange={() =>
              submit({
                intent: "toggle",
                sku: p.sku ?? "",
                title: p.title,
                managed: String(!p.managed),
              })
            }
          />
          <s-text tone="neutral">
            {p.sku ? `SKU ${p.sku} · ` : ""}
            {p.stock ?? "?"} in stock · {p.perDay} sold/day ·{" "}
            {p.cover === null ? "no recent sales" : `${p.cover} days left`}
          </s-text>
        </s-stack>
        {p.managed && p.links.length === 0 && (
          <s-box paddingBlockStart="base">
            <s-banner tone="warning" heading="Link a supplier">
              GuardBuy can’t restock this product until it has at least one
              supplier.
            </s-banner>
          </s-box>
        )}
      </s-section>

      <s-section heading="Suppliers for this product">
        {p.links.some((l) => !l.approved) && (
          <s-box paddingBlockEnd="base">
            <s-banner
              tone="info"
              heading="Some suppliers aren't approved in your rules"
            >
              The agent may still consider them, but any purchase from them is
              blocked until you approve them in{" "}
              <s-link href="/app/rules?tab=rules">your rules</s-link>.
            </s-banner>
          </s-box>
        )}
        {p.links.length === 0 ? (
          <Empty heading="No suppliers linked yet">
            The agent only ever sees the suppliers you link below, at the prices
            you enter.
          </Empty>
        ) : (
          <DataGrid<Awaited<ReturnType<typeof loader>>["links"][number]>
            label="Linked suppliers"
            rows={p.links}
            rowId={(l) => String(l.supplierId)}
            columns={[
              {
                field: "name",
                headerName: "Supplier",
                flex: 2,
                minWidth: 230,
                autoHeight: true,
                wrapText: true,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["links"][number]
                >((l) => (
                  <>
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-text type="strong">{l.name}</s-text>
                      {l.preferred && (
                        <GridBadge tone="info">Preferred</GridBadge>
                      )}
                      {!l.approved && (
                        <GridBadge tone="caution">
                          Not approved in rules
                        </GridBadge>
                      )}
                    </s-stack>
                  </>
                )),
              },
              {
                field: "price",
                headerName: "Price per unit",
                type: "numericColumn",
                width: 145,
                comparator: compareMoney,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["links"][number]
                >((l) => <>{l.price}</>),
              },
              {
                field: "usualQuantity",
                headerName: "Usual order",
                type: "numericColumn",
                width: 130,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["links"][number]
                >((l) => <>{l.usualQuantity}</>),
              },
              {
                field: "leadTimeDays",
                headerName: "Lead time",
                type: "numericColumn",
                width: 120,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["links"][number]
                >((l) => (
                  <>{`${l.leadTimeDays} ${l.leadTimeDays === 1 ? "day" : "days"}`}</>
                )),
              },
              {
                field: "paypalEmail",
                headerName: "Supplier PayPal email",
                flex: 2,
                minWidth: 235,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["links"][number]
                >((l) => (
                  <>
                    <s-text tone="neutral">{l.paypalEmail}</s-text>
                  </>
                )),
              },
              {
                colId: "actions",
                headerName: "Actions",
                width: 245,
                sortable: false,
                filter: false,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["links"][number]
                >((l) => (
                  <>
                    <s-stack direction="inline" gap="small-200">
                      {!l.preferred && (
                        <s-button
                          variant="tertiary"
                          disabled={busy}
                          onClick={() =>
                            submit({
                              intent: "prefer",
                              supplierId: l.supplierId,
                            })
                          }
                        >
                          Make preferred
                        </s-button>
                      )}
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        disabled={busy}
                        onClick={() =>
                          submit({ intent: "unlink", supplierId: l.supplierId })
                        }
                      >
                        Remove
                      </s-button>
                    </s-stack>
                  </>
                )),
              },
            ]}
          />
        )}
      </s-section>

      <s-section heading="Link a supplier">
        {p.available.length === 0 ? (
          <s-text tone="neutral">
            Every supplier you added is linked already.{" "}
            <s-link href="/app/products?tab=suppliers">
              Add another supplier
            </s-link>
          </s-text>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="link" />
            <s-query-container>
              {/* Responsive values are comma-separated, so the column lists must not contain commas themselves */}
              <s-grid
                gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 2fr 1fr 1fr 1fr"
                gap="base"
              >
                <s-select label="Supplier" name="supplierId">
                  {p.available.map((s) => (
                    <s-option key={s.id} value={s.id}>
                      {s.name}
                    </s-option>
                  ))}
                </s-select>
                <s-number-field
                  label="Price per unit ($)"
                  name="price"
                  min={0.01}
                  step={0.01}
                />
                <s-number-field
                  label="Usual order"
                  name="usualQuantity"
                  min={1}
                  step={1}
                />
                <s-number-field
                  label="Lead time (days)"
                  name="leadTimeDays"
                  min={0}
                  step={1}
                  value="3"
                />
              </s-grid>
            </s-query-container>
            <s-box paddingBlockStart="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-checkbox
                  label="Make this the preferred supplier"
                  name="preferred"
                  value="on"
                />
                <s-button type="submit" variant="primary" disabled={busy}>
                  Link supplier
                </s-button>
              </s-stack>
            </s-box>
          </fetcher.Form>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
