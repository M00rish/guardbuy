import { FormField, FormSection, FormButton } from "./form-design";
import { DataGrid, cell, GridBadge } from "./data-grid";
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
    <s-stack gap="base">
      <FormSection title="Add a supplier">
        <add.Form method="post" action="/app/products?tab=suppliers">
          <input type="hidden" name="intent" value="add-supplier" />
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr auto"
              gap="base"
              alignItems="end"
            >
              <FormField label="Name" name="name" />
              <FormField
                type="email"
                label="Supplier PayPal email"
                name="paypalEmail"
              />
              <FormButton type="submit" disabled={add.state !== "idle"}>
                Add supplier
              </FormButton>
            </s-grid>
          </s-query-container>
        </add.Form>
      </FormSection>

      <s-section heading="Your suppliers">
        {suppliers.length === 0 ? (
          <Empty heading="No suppliers yet">
            Add the suppliers you buy from above, with the PayPal email they get
            paid at. Then link them to products.
          </Empty>
        ) : (
          <DataGrid<SuppliersPageData["suppliers"][number]>
            label="Suppliers"
            rows={suppliers}
            rowId={(s) => String(s.id)}
            columns={[
              {
                field: "name",
                headerName: "Supplier",
                flex: 2,
                minWidth: 250,
                autoHeight: true,
                wrapText: true,
                getQuickFilterText: ({ data }) =>
                  [data?.name, data?.paypalEmail].join(" "),
                cellRenderer: cell<SuppliersPageData["suppliers"][number]>(
                  (s) => (
                    <>
                      <s-stack gap="none">
                        <s-text type="strong">{s.name}</s-text>
                        <s-text tone="neutral">{s.paypalEmail}</s-text>
                      </s-stack>
                    </>
                  ),
                ),
              },
              {
                field: "products",
                headerName: "Products",
                type: "numericColumn",
                width: 120,
                cellRenderer: cell<SuppliersPageData["suppliers"][number]>(
                  (s) => <>{s.products}</>,
                ),
              },
              {
                colId: "status",
                headerName: "Status",
                flex: 2,
                minWidth: 250,
                autoHeight: true,
                wrapText: true,
                valueGetter: ({ data }) =>
                  data?.approved === true
                    ? "Approved in rules"
                    : data?.approved === false
                      ? "Not approved in rules"
                      : "",
                cellRenderer: cell<SuppliersPageData["suppliers"][number]>(
                  (s) => (
                    <>
                      <s-stack direction="inline" gap="small-200">
                        {s.approved === true && (
                          <GridBadge tone="success">
                            Approved in rules
                          </GridBadge>
                        )}
                        {s.approved === false && (
                          <GridBadge tone="caution">
                            Not approved in rules
                          </GridBadge>
                        )}
                        {s.emailChangedAt && (
                          <GridBadge tone="warning">{`PayPal email changed ${ago(s.emailChangedAt, now)}`}</GridBadge>
                        )}
                      </s-stack>
                    </>
                  ),
                ),
              },
              {
                colId: "actions",
                headerName: "Actions",
                width: 120,
                sortable: false,
                filter: false,
                cellRenderer: cell<SuppliersPageData["suppliers"][number]>(
                  (s) => (
                    <>
                      <s-button
                        variant="tertiary"
                        href={`/app/suppliers/${s.id}`}
                      >
                        Manage
                      </s-button>
                    </>
                  ),
                ),
              },
            ]}
          />
        )}
      </s-section>
    </s-stack>
  );
}
