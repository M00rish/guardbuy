import { useEffect } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { ago, Empty } from "./ui";
import type {
  SuppliersPageData,
  AddSupplierData,
} from "../lib/merchant/suppliers-page.server";
export function SuppliersPanel({ data }: { data: SuppliersPageData }) {
  const { suppliers } = data;
  const add = useFetcher<AddSupplierData>();
  const shopify = useAppBridge();
  const now = Date.now();
  useEffect(() => {
    if (add.state === "idle" && add.data)
      shopify.toast.show(add.data.message, { isError: !add.data.ok });
  }, [add.state, add.data, shopify]);

  return (
    <>
      <s-section heading="Add a supplier">
        <add.Form method="post" action="/app/products?tab=suppliers">
          <input type="hidden" name="intent" value="add-supplier" />
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr auto"
              gap="base"
              alignItems="end"
            >
              <s-text-field label="Name" name="name" />
              <s-email-field
                label="PayPal email (where they get paid)"
                name="paypalEmail"
              />
              <s-button
                type="submit"
                variant="primary"
                disabled={add.state !== "idle"}
              >
                Add supplier
              </s-button>
            </s-grid>
          </s-query-container>
        </add.Form>
      </s-section>

      <s-section heading="Your suppliers">
        {suppliers.length === 0 ? (
          <Empty heading="No suppliers yet">
            Add the suppliers you buy from above, with the PayPal email they get
            paid at. Then link them to products.
          </Empty>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">
                Supplier · paid at (PayPal)
              </s-table-header>
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
                      {s.approved === true && (
                        <s-badge tone="success">Approved in rules</s-badge>
                      )}
                      {s.approved === false && (
                        <s-badge tone="caution">Not approved in rules</s-badge>
                      )}
                      {s.emailChangedAt && (
                        <s-badge tone="warning">{`PayPal email changed ${ago(s.emailChangedAt, now)}`}</s-badge>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      href={`/app/suppliers/${s.id}`}
                    >
                      Manage
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </>
  );
}
