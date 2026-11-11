import { coverLabel, coverExplanation } from "../lib/inventory/cover-label";
import { GridBadge } from "./data-grid";
import { useMemo } from "react";
import { Link } from "react-router";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import type {
  ColDef,
  GridApi,
  IDetailCellRendererParams,
} from "ag-grid-community";
import { gridTheme } from "./grid-theme";
import {
  purchasesForProduct,
  type HomeWorkspaceData,
  type WorkspaceProduct,
  type WorkspaceDetail,
  type WorkspaceActivity,
} from "../lib/insights/workspace";
import type { InsightRow } from "../lib/insights/types";
import { usd } from "../lib/format";
import { PRODUCT_ANALYTIC_COLUMNS } from "../lib/insights/grid-query";
import styles from "./home-workspace.module.css";

export type DataView = "products" | "purchases" | "activity" | "details";
type ProductContext = {
  demo: boolean;
  purchases: InsightRow[];
  busy: boolean;
  onManage?: (product: WorkspaceProduct) => void;
};
function ProductName({
  value,
  data,
}: CustomCellRendererProps<WorkspaceProduct>) {
  return (
    <div className={styles.productName}>
      <strong>{value}</strong>
      <small>{data?.sku}</small>
    </div>
  );
}
function ProductState({ data }: CustomCellRendererProps<WorkspaceProduct>) {
  if (!data) return null;
  return (
    <GridBadge tone={data.status.tone} title={data.status.label}>
      {data.status.label}
    </GridBadge>
  );
}
function ManageCell({
  data,
  context,
}: CustomCellRendererProps<WorkspaceProduct, unknown, ProductContext>) {
  if (!data) return null;
  return (
    <input
      type="checkbox"
      aria-label={`Restock ${data.title} automatically`}
      checked={data.managed}
      disabled={context.demo || context.busy}
      onClick={(event) => event.stopPropagation()}
      onChange={() => {
        if (!context.demo) context.onManage?.(data);
      }}
    />
  );
}
function ProductDetail({
  data,
  context,
}: Omit<IDetailCellRendererParams<WorkspaceProduct, InsightRow>, "context"> & {
  context: ProductContext;
}) {
  if (!data) return null;
  const rows = purchasesForProduct(context.purchases, data.variantId);
  return (
    <div className={styles.productDetail}>
      <div className={styles.detailHeading}>
        <strong>{data.title} · purchase history</strong>
        {!context.demo && (
          <Link to={`/app/products/${encodeURIComponent(data.variantId)}`}>
            Product & supplier settings →
          </Link>
        )}
      </div>
      <div className={styles.history}>
        <AgGridReact<InsightRow>
          theme={gridTheme}
          rowData={rows}
          getRowId={(p) => String(p.data.purchase)}
          defaultColDef={{
            sortable: true,
            resizable: true,
            minWidth: 100,
            flex: 1,
          }}
          columnDefs={[
            {
              field: "purchase",
              headerName: "Purchase",
              cellRenderer: ({
                data: row,
              }: CustomCellRendererProps<InsightRow>) =>
                row &&
                (context.demo ? (
                  `#${row.purchase}`
                ) : (
                  <Link to={row.activityUrl}>#{row.purchase}</Link>
                )),
            },
            { field: "status", headerName: "Status", minWidth: 180 },
            ...(["amount", "settled", "reserved"] as const).map((field) => ({
              field,
              headerName:
                field === "amount"
                  ? "Proposal value"
                  : field === "settled"
                    ? "Settled"
                    : "Reserved",
              type: "numericColumn",
              valueFormatter: ({ value }: { value: number }) =>
                usd(Math.round(value * 100)),
            })),
            {
              field: "proposedAt",
              headerName: "Proposed (UTC)",
              valueFormatter: ({ value }) =>
                String(value).slice(0, 16).replace("T", " "),
            },
          ]}
          overlayNoRowsTemplate="No recorded purchases for this product."
        />
      </div>
    </div>
  );
}
export function ProductsGrid({
  workspace,
  purchases,
  demo,
  busy,
  onManage,
  search,
  narrow,
  onReady,
}: {
  workspace: HomeWorkspaceData;
  purchases: InsightRow[];
  demo: boolean;
  busy: boolean;
  onManage?: (product: WorkspaceProduct) => void;
  search: string;
  narrow: boolean;
  onReady: (api: GridApi<unknown> | undefined) => void;
}) {
  const columns = useMemo<ColDef<WorkspaceProduct>[]>(
    () => [
      {
        field: "title",
        headerName: "Product",
        cellRenderer: "agGroupCellRenderer",
        cellRendererParams: { innerRenderer: ProductName },
        width: narrow ? 145 : 280,
        minWidth: narrow ? 130 : 200,
        flex: narrow ? 0 : 1,
        pinned: narrow ? null : "left",
        chartDataType: "category",
      },
      {
        colId: "state",
        headerName: "Status",
        valueGetter: (p) => p.data?.status.label,
        cellRenderer: ProductState,
        width: narrow ? 115 : 235,
        enableRowGroup: true,
      },
      {
        field: "stock",
        headerName: "Stock",
        type: "numericColumn",
        width: narrow ? 70 : 115,
        filter: "agNumberColumnFilter",
        chartDataType: "series",
      },
      {
        field: "incoming",
        headerName: "Incoming",
        type: "numericColumn",
        width: 130,
        hide: narrow,
        filter: "agNumberColumnFilter",
        chartDataType: "series",
      },
      {
        field: "cover",
        headerName: "Days of cover",
        type: "numericColumn",
        width: 165,
        hide: narrow,
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => coverLabel(p.value, p.data?.perDay),
        tooltipValueGetter: (p) => coverExplanation(p.value, p.data?.perDay),
        getQuickFilterText: (p) => coverLabel(p.value, p.data?.perDay),
      },
      {
        field: "supplier",
        headerName: "Supplier",
        width: 190,
        hide: narrow,
        enableRowGroup: true,
        filter: "agSetColumnFilter",
        valueFormatter: (p) => p.value || "No supplier linked",
        chartDataType: "category",
      },
      {
        field: "managed",
        headerName: "Auto restock",
        width: 150,
        hide: narrow,
        cellRenderer: ManageCell,
        filter: "agSetColumnFilter",
      },
      ...PRODUCT_ANALYTIC_COLUMNS.map((field): ColDef<WorkspaceProduct> => ({
        field: field as keyof WorkspaceProduct,
        headerName: (
          {
            automaticRestocks: "Auto restock count",
            paidRestocks: "Paid purchases",
            purchaseCount: "Proposals",
            amount: "Proposal value",
            settled: "Settled",
            reserved: "Reserved",
            blocked: "Blocked value",
          } as Record<string, string>
        )[field],
        width: narrow ? 170 : 210,
        hide: true,
        type: "numericColumn",
        filter: "agNumberColumnFilter",
        chartDataType: "series",
        valueFormatter: (p) =>
          p.value == null
            ? "Unavailable"
            : ["amount", "settled", "reserved", "blocked"].includes(field)
              ? usd(Math.round(p.value * 100))
              : String(p.value),
        useValueFormatterForExport: false,
      })),
      { field: "sku", headerName: "SKU", hide: true },
    ],
    [narrow],
  );
  if (workspace.products === null)
    return (
      <div role="status" className={styles.empty}>
        Products are unavailable. Refresh Home to retry; the other views remain
        available.
      </div>
    );
  return (
    <AgGridReact<WorkspaceProduct>
      theme={gridTheme}
      rowData={workspace.products}
      columnDefs={columns}
      context={{ purchases, demo, busy, onManage } satisfies ProductContext}
      defaultColDef={{
        sortable: true,
        resizable: true,
        filter: true,
        suppressHeaderMenuButton: narrow,
        suppressHeaderFilterButton: narrow,
      }}
      quickFilterText={search}
      getRowId={(p) => p.data.variantId}
      masterDetail
      detailCellRenderer={ProductDetail}
      detailRowHeight={310}
      keepDetailRows
      rowGroupPanelShow="onlyWhenGrouping"
      autoGroupColumnDef={{ headerName: "Supplier / product", minWidth: 220 }}
      cellSelection
      enableCharts
      sideBar={{ toolPanels: ["columns", "filters"] }}
      statusBar={{
        statusPanels: [
          { statusPanel: "agTotalAndFilteredRowCountComponent" },
          { statusPanel: "agAggregationComponent" },
        ],
      }}
      onNewColumnsLoaded={({ api }) => onReady(api as GridApi<unknown>)}
      onGridReady={({ api }) => onReady(api as GridApi<unknown>)}
      onGridPreDestroyed={() => onReady(undefined)}
      overlayNoRowsTemplate="No products yet. Add products in Shopify to get started."
    />
  );
}
export function RecordsGrid({
  directory = false,
  view,
  workspace,
  demo,
  search,
  onReady,
}: {
  view: "activity" | "details";
  directory?: boolean;
  workspace: HomeWorkspaceData;
  demo: boolean;
  search: string;
  onReady: (api: GridApi<unknown> | undefined) => void;
}) {
  const cols: ColDef<WorkspaceActivity | WorkspaceDetail>[] =
    view === "activity"
      ? [
          {
            field: "at",
            headerName: "When (UTC)",
            width: 175,
            valueFormatter: (p) =>
              String(p.value).slice(0, 19).replace("T", " "),
            filter: "agDateColumnFilter",
            filterParams: {
              comparator: (date: Date, value: string) => {
                const day = new Date(
                  value.slice(0, 10) + "T00:00:00",
                ).getTime();
                return Math.sign(day - date.getTime());
              },
            },
          },
          {
            field: "kind",
            headerName: "Event type",
            width: 160,
            filter: "agSetColumnFilter",
            enableRowGroup: true,
          },
          {
            field: "title",
            headerName: "Event",
            flex: 1,
            minWidth: 220,
            wrapText: true,
            autoHeight: true,
          },
        ]
      : [
          {
            field: "category",
            headerName: "Category",
            hide: directory,
            width: 160,
            enableRowGroup: true,
            filter: "agSetColumnFilter",
          },
          {
            field: "setting",
            headerName: directory ? "Supplier" : "Setting",
            minWidth: 190,
            flex: 1,
          },
          {
            field: "value",
            headerName: directory ? "Added (UTC)" : "Recorded value",
            minWidth: 230,
            flex: 2,
            wrapText: true,
            autoHeight: true,
            cellRenderer: ({
              data,
            }: CustomCellRendererProps<WorkspaceDetail>) =>
              data &&
              (data.href && !demo ? (
                <Link to={data.href}>{data.value}</Link>
              ) : (
                data.value
              )),
          },
        ];
  return (
    <AgGridReact<WorkspaceActivity | WorkspaceDetail>
      theme={gridTheme}
      rowData={view === "activity" ? workspace.activity : workspace.details}
      columnDefs={cols}
      quickFilterText={search}
      defaultColDef={{ sortable: true, resizable: true, filter: true }}
      getRowId={({ data }) =>
        "id" in data ? data.id : `${data.seq}:${data.kind}`
      }
      sideBar={{ toolPanels: ["columns", "filters"] }}
      rowGroupPanelShow="onlyWhenGrouping"
      cellSelection
      statusBar={{
        statusPanels: [{ statusPanel: "agTotalAndFilteredRowCountComponent" }],
      }}
      onGridReady={({ api }) => onReady(api as GridApi<unknown>)}
      onGridPreDestroyed={() => onReady(undefined)}
    />
  );
}
