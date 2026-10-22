import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { auditEntries } from "../lib/audit/log.server";
import { currentRuleSet } from "../lib/agent/restock.server";
import { saveSupplier } from "../lib/suppliers/directory.server";
import { ago, Empty } from "../components/ui";

// Suppliers (index): who GuardBuy may pay, at which PayPal address, for how many products, and
// whether the merchant's rules approve them. Editing happens on each supplier's page.

const RECENT_CHANGE_MS = 14 * 86_400_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [suppliers, log] = await Promise.all([
    db.supplier.findMany({ where: { shop: session.shop }, orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } }),
    auditEntries(session.shop),
  ]);
  const allow = currentRuleSet(log)?.supplierAllowlist ?? null;
  return {
    suppliers: suppliers.map((s) => {
      const changed = s.emailChangedAt.getTime() - s.createdAt.getTime() > 1000;
      return {
        id: s.id, name: s.name, paypalEmail: s.paypalEmail, products: s._count.products,
        approved: allow === null ? null : allow.includes(s.id),
        emailChangedAt: changed && Date.now() - s.emailChangedAt.getTime() < RECENT_CHANGE_MS ? s.emailChangedAt.toISOString() : null,
      };
    }),
  };
};

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const name = String(f.get("name") ?? "").trim();
  const paypalEmail = String(f.get("paypalEmail") ?? "").trim();
  const id = slug(name);
  if (!name || !id) return { ok: false, message: "Enter the supplier's name" };
  if (!z.email().safeParse(paypalEmail).success) return { ok: false, message: "Enter the PayPal email the supplier is paid at" };
  // Never overwrite an existing supplier from here: changing where a supplier is paid is a deliberate edit on its page.
  if (await db.supplier.findUnique({ where: { shop_id: { shop: session.shop, id } } })) {
    return { ok: false, message: `${name} already exists. Open it to change its PayPal email.` };
  }
  await saveSupplier(session.shop, { id, name, paypalEmail });
  return { ok: true, message: `Added ${name}` };
};

export default function Suppliers() {
  const { suppliers } = useLoaderData<typeof loader>();
  const add = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const now = Date.now();
  useEffect(() => {
    if (add.state === "idle" && add.data) shopify.toast.show(add.data.message, { isError: !add.data.ok });
  }, [add.state, add.data, shopify]);

  return (
    <s-page heading="Suppliers" inlineSize="large">
      <s-section heading="Add a supplier">
        <add.Form method="post">
          <s-query-container>
            <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr auto" gap="base" alignItems="end">
              <s-text-field label="Name" name="name" />
              <s-email-field label="PayPal email (where they get paid)" name="paypalEmail" />
              <s-button type="submit" variant="primary" disabled={add.state !== "idle"}>Add supplier</s-button>
            </s-grid>
          </s-query-container>
        </add.Form>
      </s-section>

      <s-section heading="Your suppliers">
        {suppliers.length === 0 ? (
          <Empty heading="No suppliers yet">Add the suppliers you buy from above, with the PayPal email they get paid at. Then link them to products.</Empty>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Supplier · paid at (PayPal)</s-table-header>
              <s-table-header format="numeric">Products</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {suppliers.map((s) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-stack gap="none">
                      <s-text type="strong">{s.name}</s-text>
                      <s-text tone="neutral">{s.paypalEmail}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{s.products}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {s.approved === true && <s-badge tone="success">Approved in rules</s-badge>}
                      {s.approved === false && <s-badge tone="caution">Not approved in rules</s-badge>}
                      {s.emailChangedAt && <s-badge tone="warning">{`PayPal email changed ${ago(s.emailChangedAt, now)}`}</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell><s-button variant="tertiary" href={`/app/suppliers/${s.id}`}>Manage</s-button></s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
