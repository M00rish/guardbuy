import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { removeSupplier, saveSupplier } from "../lib/suppliers/directory.server";

// Suppliers and where GuardBuy pays them. A changed PayPal email is timestamped and shown, because
// "please update our payment details" is the classic supplier fraud.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const suppliers = await db.supplier.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
    include: { _count: { select: { products: true } } },
  });
  return {
    suppliers: suppliers.map((s) => ({
      id: s.id, name: s.name, paypalEmail: s.paypalEmail, products: s._count.products,
      emailChangedAt: s.emailChangedAt.getTime() - s.createdAt.getTime() > 1000 ? s.emailChangedAt.toISOString() : null,
    })),
  };
};

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  if (f.get("intent") === "remove") {
    await removeSupplier(session.shop, String(f.get("id") ?? ""));
    return { ok: true, message: "Supplier removed (and unlinked from its products)" };
  }
  const name = String(f.get("name") ?? "").trim();
  const paypalEmail = String(f.get("paypalEmail") ?? "").trim();
  const id = String(f.get("id") || slug(name));
  if (!name || !id) return { ok: false, message: "Enter the supplier's name" };
  if (!z.email().safeParse(paypalEmail).success) return { ok: false, message: "Enter the PayPal email the supplier is paid at" };
  await saveSupplier(session.shop, { id, name, paypalEmail });
  return { ok: true, message: `Saved ${name}` };
};

export default function Suppliers() {
  const { suppliers } = useLoaderData<typeof loader>();
  const add = useFetcher<typeof action>();
  return (
    <s-page heading="Suppliers">
      <s-section heading="Add a supplier">
        <add.Form method="post">
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-text-field label="Name" name="name" />
            <s-email-field label="PayPal email (where they get paid)" name="paypalEmail" />
            <s-button type="submit" variant="primary" disabled={add.state !== "idle"}>Add</s-button>
          </s-stack>
        </add.Form>
        {add.data && <s-text tone={add.data.ok ? "success" : "critical"}>{add.data.message}</s-text>}
      </s-section>
      {suppliers.length === 0 ? (
        <s-section><s-text tone="neutral">No suppliers yet.</s-text></s-section>
      ) : (
        suppliers.map((s) => <SupplierRow key={s.id} s={s} />)
      )}
    </s-page>
  );
}

type Row = ReturnType<typeof useLoaderData<typeof loader>>["suppliers"][number];

function SupplierRow({ s }: { s: Row }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  return (
    <s-section heading={s.name}>
      <s-stack gap="small-200">
        <s-text tone="neutral">Linked to {s.products} products</s-text>
        {s.emailChangedAt && (
          <s-banner tone="warning" heading="PayPal email changed">
            Changed on {new Date(s.emailChangedAt).toLocaleString()}. If you didn't expect this, check with the supplier by phone
            before approving purchases.
          </s-banner>
        )}
        <fetcher.Form method="post">
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="name" value={s.name} />
          <s-stack direction="inline" gap="small-200" alignItems="end">
            <s-email-field label="PayPal email" name="paypalEmail" value={s.paypalEmail} />
            <s-button type="submit" disabled={busy}>Save</s-button>
            <s-button tone="critical" variant="tertiary" disabled={busy}
              onClick={() => fetcher.submit({ intent: "remove", id: s.id }, { method: "POST" })}>
              Remove supplier
            </s-button>
          </s-stack>
        </fetcher.Form>
        {fetcher.data && <s-text tone={fetcher.data.ok ? "success" : "critical"}>{fetcher.data.message}</s-text>}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
