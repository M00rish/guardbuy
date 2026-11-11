import { FormField, FormSection, FormButton, FormGrid, formStyles } from "../components/form-design";
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
import { redirect, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import db from "../db.server";
import { privateAdmin } from "../lib/merchant/staff.server";
import { auditEntries } from "../lib/audit/log.server";
import { currentRuleSet } from "../lib/agent/restock.server";
import {
  removeSupplier,
  saveSupplier,
} from "../lib/suppliers/directory.server";
import { usd } from "../lib/format";
import { Empty, Row } from "../components/ui";

// One supplier: where it's paid, which products it supplies, and whether the rules approve it.
// Changing the PayPal email is the sensitive edit here, so the page says what it does.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const shop = session.shop;
  const supplier = await db.supplier.findUnique({
    where: { shop_id: { shop, id: String(params.supplierId ?? "") } },
    include: { products: true },
  });
  if (!supplier) throw new Response("Supplier not found", { status: 404 });
  const [products, log] = await Promise.all([
    db.managedProduct.findMany({ where: { shop, variantId: { in: supplier.products.map((p) => p.variantId) } } }),
    auditEntries(shop),
  ]);
  const allow = currentRuleSet(log)?.supplierAllowlist ?? null;
  const changed = supplier.emailChangedAt.getTime() - supplier.createdAt.getTime() > 1000;
  return {
    id: supplier.id,
    name: supplier.name,
    paypalEmail: supplier.paypalEmail,
    approved: allow === null ? null : allow.includes(supplier.id),
    addedAt: supplier.createdAt.toISOString(),
    emailChangedAt: changed ? supplier.emailChangedAt.toISOString() : null,
    products: supplier.products.map((l) => {
      const p = products.find((x) => x.variantId === l.variantId);
      return { variantId: l.variantId, title: p?.title ?? `Variant ${l.variantId}`, managed: p?.managed ?? false, price: usd(l.unitPriceCents), usualQuantity: l.usualQuantity, leadTimeDays: l.leadTimeDays, preferred: l.preferred };
    }),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const id = String(params.supplierId ?? "");
  const existing = await db.supplier.findUnique({ where: { shop_id: { shop: session.shop, id } } });
  if (!existing) return { ok: false, message: "Supplier not found" };
  const f = await request.formData();
  if (f.get("intent") === "remove") {
    await removeSupplier(session.shop, id);
    return redirect("/app/products?tab=suppliers");
  }
  const name = String(f.get("name") ?? "").trim();
  const paypalEmail = String(f.get("paypalEmail") ?? "").trim();
  if (!name) return { ok: false, message: "Enter the supplier's name" };
  if (!z.email().safeParse(paypalEmail).success) return { ok: false, message: "Enter a valid PayPal email" };
  await saveSupplier(session.shop, { id, name, paypalEmail });
  const emailChanged = existing.paypalEmail.toLowerCase() !== paypalEmail.toLowerCase();
  return { ok: true, message: emailChanged ? "Supplier updated. Existing purchases keep their original PayPal recipient." : "Supplier updated." };
};

const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

export default function Supplier() {
  const s = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading={s.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/products?tab=suppliers">
        Suppliers
      </s-link>

      {s.emailChangedAt && (
        <s-banner
          tone="warning"
          heading={`PayPal email changed on ${date(s.emailChangedAt)}`}
        >
          If you didn’t expect this, call the supplier on a number you already
          have before approving purchases. “Please update our payment details”
          is the most common supplier fraud.
        </s-banner>
      )}

      <FormSection title="Payment contact" description="The PayPal address used for this supplier’s payments.">
        <s-stack gap="base">
          <Row label="In your rules">
            {s.approved === null ? (
              <s-text tone="neutral">No rules signed yet</s-text>
            ) : s.approved ? (
              <GridBadge tone="success">Approved in rules</GridBadge>
            ) : (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <GridBadge tone="caution">Not approved in rules</GridBadge>
                <s-link href="/app/rules?tab=rules">Edit rules</s-link>
              </s-stack>
            )}
          </Row>
          <Row label="Added">
            <s-text>{date(s.addedAt)}</s-text>
          </Row>
          <fetcher.Form method="post">
            <FormGrid>
              <FormField label="Name" name="name" defaultValue={s.name}/>
              <FormField type="email" label="Supplier PayPal email" name="paypalEmail" defaultValue={s.paypalEmail}/>
            </FormGrid>
            <div className={formStyles.actions}><FormButton type="submit" disabled={busy}>Save supplier</FormButton></div>
          </fetcher.Form>
        </s-stack>
      </FormSection>

      <s-section heading="Products they supply">
        {s.products.length === 0 ? (
          <Empty
            heading="Not linked to any product yet"
            action={{ label: "Link to a product", href: "/app/products" }}
          >
            The agent only buys from this supplier for products you link it to,
            at the price you enter.
          </Empty>
        ) : (
          <DataGrid<Awaited<ReturnType<typeof loader>>["products"][number]>
            label="Supplier products"
            rows={s.products}
            rowId={(p) => String(p.variantId)}
            columns={[
              {
                field: "title",
                headerName: "Product",
                flex: 2,
                minWidth: 230,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["products"][number]
                >((p) => (
                  <>
                    <s-link href={`/app/products/${p.variantId}`}>
                      {p.title}
                    </s-link>
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
                  Awaited<ReturnType<typeof loader>>["products"][number]
                >((p) => <>{p.price}</>),
              },
              {
                field: "usualQuantity",
                headerName: "Usual order",
                type: "numericColumn",
                width: 130,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["products"][number]
                >((p) => <>{p.usualQuantity}</>),
              },
              {
                field: "leadTimeDays",
                headerName: "Lead time",
                type: "numericColumn",
                width: 130,
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["products"][number]
                >((p) => (
                  <>{`${p.leadTimeDays} ${p.leadTimeDays === 1 ? "day" : "days"}`}</>
                )),
              },
              {
                colId: "status",
                headerName: "Status",
                flex: 1,
                minWidth: 190,
                autoHeight: true,
                wrapText: true,
                valueGetter: ({ data }) =>
                  [
                    data?.preferred ? "Preferred" : "",
                    data?.managed ? "Managed" : "Not managed",
                  ].join(" "),
                cellRenderer: cell<
                  Awaited<ReturnType<typeof loader>>["products"][number]
                >((p) => (
                  <>
                    <s-stack direction="inline" gap="small-200">
                      {p.preferred && (
                        <GridBadge tone="info">Preferred</GridBadge>
                      )}
                      <GridBadge tone={p.managed ? "success" : "neutral"}>
                        {p.managed ? "Managed" : "Not managed"}
                      </GridBadge>
                    </s-stack>
                  </>
                )),
              },
            ]}
          />
        )}
      </s-section>

      <s-section heading="Remove supplier">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text tone="neutral">
            Unlinks them from every product. Past purchases stay in the audit
            log.
          </s-text>
          <s-button
            tone="critical"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Remove ${s.name}?`))
                fetcher.submit({ intent: "remove" }, { method: "POST" });
            }}
          >
            Remove supplier
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
