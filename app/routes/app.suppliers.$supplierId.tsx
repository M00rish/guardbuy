import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { auditEntries } from "../lib/audit/log.server";
import { currentRuleSet } from "../lib/agent/restock.server";
import { removeSupplier, saveSupplier } from "../lib/suppliers/directory.server";
import { usd } from "../lib/format";
import { Empty, Row } from "../components/ui";

// One supplier: where it's paid, which products it supplies, and whether the rules approve it.
// Changing the PayPal email is the sensitive edit here, so the page says what it does.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
  const { session } = await authenticate.admin(request);
  const id = String(params.supplierId ?? "");
  const existing = await db.supplier.findUnique({ where: { shop_id: { shop: session.shop, id } } });
  if (!existing) return { ok: false, message: "Supplier not found" };
  const f = await request.formData();
  if (f.get("intent") === "remove") {
    await removeSupplier(session.shop, id);
    return redirect("/app/suppliers");
  }
  const name = String(f.get("name") ?? "").trim();
  const paypalEmail = String(f.get("paypalEmail") ?? "").trim();
  if (!name) return { ok: false, message: "Enter the supplier's name" };
  if (!z.email().safeParse(paypalEmail).success) return { ok: false, message: "Enter a valid PayPal email" };
  await saveSupplier(session.shop, { id, name, paypalEmail });
  const emailChanged = existing.paypalEmail.toLowerCase() !== paypalEmail.toLowerCase();
  return { ok: true, message: emailChanged ? "Saved. Purchases proposed before this change won't be paid to the new address." : "Saved" };
};

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default function Supplier() {
  const s = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading={s.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/suppliers">Suppliers</s-link>

      {s.emailChangedAt && (
        <s-banner tone="warning" heading={`PayPal email changed on ${date(s.emailChangedAt)}`}>
          If you didn't expect this, call the supplier on a number you already have before approving purchases.
          "Please update our payment details" is the most common supplier fraud.
        </s-banner>
      )}

      <s-section heading="Details">
        <s-stack gap="base">
          <Row label="In your rules">
            {s.approved === null ? <s-text tone="neutral">No rules signed yet</s-text>
              : s.approved ? <s-badge tone="success">Approved: the agent may buy from them</s-badge>
              : <s-stack direction="inline" gap="small-200" alignItems="center"><s-badge tone="caution">Not approved: purchases are blocked</s-badge><s-link href="/app/rules">Edit rules</s-link></s-stack>}
          </Row>
          <Row label="Added"><s-text>{date(s.addedAt)}</s-text></Row>
          <fetcher.Form method="post">
            <s-query-container>
              <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr auto" gap="base" alignItems="end">
                <s-text-field label="Name" name="name" value={s.name} />
                <s-email-field label="PayPal email (where they get paid)" name="paypalEmail" value={s.paypalEmail} />
                <s-button type="submit" disabled={busy}>Save</s-button>
              </s-grid>
            </s-query-container>
          </fetcher.Form>
        </s-stack>
      </s-section>

      <s-section heading="Products they supply">
        {s.products.length === 0 ? (
          <Empty heading="Not linked to any product yet" action={{ label: "Link to a product", href: "/app/products" }}>
            The agent only buys from this supplier for products you link it to, at the price you enter.
          </Empty>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header format="numeric">Price per unit</s-table-header>
              <s-table-header format="numeric">Usual order</s-table-header>
              <s-table-header format="numeric">Lead time</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {s.products.map((p) => (
                <s-table-row key={p.variantId}>
                  <s-table-cell><s-link href={`/app/products/${p.variantId}`}>{p.title}</s-link></s-table-cell>
                  <s-table-cell>{p.price}</s-table-cell>
                  <s-table-cell>{p.usualQuantity}</s-table-cell>
                  <s-table-cell>{`${p.leadTimeDays} ${p.leadTimeDays === 1 ? "day" : "days"}`}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {p.preferred && <s-badge tone="info">Preferred</s-badge>}
                      <s-badge tone={p.managed ? "success" : "neutral"}>{p.managed ? "Managed" : "Not managed"}</s-badge>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Remove supplier">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text tone="neutral">Unlinks them from every product. Past purchases stay in the audit log.</s-text>
          <s-button tone="critical" disabled={busy}
            onClick={() => { if (window.confirm(`Remove ${s.name}?`)) fetcher.submit({ intent: "remove" }, { method: "POST" }); }}>
            Remove supplier
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
