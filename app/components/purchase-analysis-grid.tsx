import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import {
  themeQuartz,
  type ColDef,
  type GridApi,
  type ColumnState,
  type FilterModel,
  type IDetailCellRendererParams,
} from "ag-grid-community";
import type {
  AgWidgetData,
  AgWidgetDataFormat,
  AgWidgetParams,
  AgWidgetDataQuery,
  AgWidgetRowsResult,
} from "ag-studio";
import type { InsightRow } from "../lib/insights/types";
import type { InsightAnalysis } from "../lib/insights/plan";
import { usd } from "../lib/format";
import styles from "./purchase-analysis-grid.module.css";

export type PurchaseGridData = AgWidgetData<
  { purchase: { id: string }[] },
  AgWidgetDataFormat<Record<string, never>>
> & { type: "guardbuy-purchases" };
export type PurchaseGridContext = {
  rows: InsightRow[];
  allRows: InsightRow[];
  analysis: InsightAnalysis;
  demo: boolean;
  storageKey: string;
  checkedAt: string;
};
const modules = [AllEnterpriseModule.with(AgChartsEnterpriseModule)];
const gridTheme = themeQuartz.withParams({
  accentColor: "#007f65",
  backgroundColor: "#fff",
  foregroundColor: "#213c35",
  headerBackgroundColor: "#edf5f1",
  borderColor: "#dce7e1",
  fontFamily: "Arial, sans-serif",
  fontSize: 13,
  headerFontSize: 12,
  rowHeight: 54,
  headerHeight: 44,
  wrapperBorderRadius: 12,
  cellHorizontalPadding: 16,
});
function StatusCell({ value }: CustomCellRendererProps<InsightRow>) {
  if (!value) return null;
  const tone =
    value === "Paid"
      ? "paid"
      : String(value).includes("Blocked")
        ? "blocked"
        : "waiting";
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>{String(value)}</span>
  );
}
function MoneyCell({ value, data }: CustomCellRendererProps<InsightRow>) {
  if (typeof value !== "number") return null;
  return (
    <div className={styles.money}>
      <span>{usd(Math.round(value * 100))}</span>
      <i
        style={{
          width: `${Math.min(100, data?.amount ? (value / data.amount) * 100 : 0)}%`,
        }}
      />
    </div>
  );
}
function Detail({
  data,
  context,
}: IDetailCellRendererParams<InsightRow, InsightRow, PurchaseGridContext>) {
  return (
    <div className={styles.detail}>
      <div>
        <span className={styles.kicker}>RECORDED DECISION</span>
        <h3>{data.product}</h3>
        <p>{data.reason || "No decision reason recorded."}</p>
      </div>
      <dl>
        <dt>Supplier</dt>
        <dd>{data.supplier}</dd>
        <dt>Payment reference</dt>
        <dd>{data.paymentReference || "No payment reference recorded"}</dd>
        <dt>Payment route</dt>
        <dd>{data.route}</dd>
      </dl>
      {context.demo ? (
        <span className={styles.demo}>
          Fictional purchase · no payment was sent
        </span>
      ) : (
        <Link
          to={data.activityUrl || `/app/activity?purchase=${data.purchase}`}
        >
          Open full activity →
        </Link>
      )}
    </div>
  );
}
export default function PurchaseAnalysisGrid({
  widgetApi,
  dataMapping,
  context,
}: AgWidgetParams<PurchaseGridData, unknown, PurchaseGridContext>) {
  const [ids, setIds] = useState<Set<number> | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const grid = useRef<GridApi<InsightRow>>();
  const fields = dataMapping.purchase;
  useEffect(() => {
    if (!fields?.length) return;
    const handle = widgetApi.getDataHandle<{
      purchases: { query: AgWidgetDataQuery };
    }>();
    handle.open(({ results }) => {
      const result = results[0]?.response.results as
        AgWidgetRowsResult | undefined;
      if (!result) return;
      setError(!!result.metadata?.error);
      setIds(new Set(result.rows.map((row) => Number(row[fields[0].key]))));
    });
    handle.set("purchases", {
      query: { fields },
      options: { crossFilter: "filter" },
    });
    return () => handle.close();
  }, [widgetApi, fields]);
  const rows = useMemo(
    () => context.rows.filter((row) => ids?.has(row.purchase)),
    [context.rows, ids],
  );
  const history = useMemo(() => {
    const map = new Map<string, number[]>();
    const last = Date.parse(context.checkedAt.slice(0, 10) + "T00:00:00Z");
    for (const row of context.allRows) {
      const day =
        27 -
        Math.floor(
          (last - Date.parse(row.proposedAt.slice(0, 10) + "T00:00:00Z")) /
            86400000,
        );
      if (day < 0 || day > 27) continue;
      const values = map.get(row.supplier) ?? Array<number>(28).fill(0);
      values[day] += row.amount;
      map.set(row.supplier, values);
    }
    return map;
  }, [context.allRows, context.checkedAt]);
  const columns = useMemo<ColDef<InsightRow>[]>(
    () => [
      {
        field: "purchase",
        headerName: "Purchase",
        pinned: "left",
        width: 150,
        cellRenderer: "agGroupCellRenderer",
        valueFormatter: (p) => (p.value == null ? "" : `#${p.value}`),
        chartDataType: "excluded",
      },
      {
        field: "product",
        headerName: "Product",
        minWidth: 190,
        flex: 1,
        enableRowGroup: true,
        chartDataType: "category",
      },
      {
        field: "supplier",
        headerName: "Supplier",
        minWidth: 180,
        enableRowGroup: true,
        chartDataType: "category",
      },
      {
        field: "status",
        headerName: "Payment status",
        width: 220,
        cellRenderer: StatusCell,
        enableRowGroup: true,
        enablePivot: true,
        chartDataType: "category",
      },
      {
        field: "amount",
        headerName: "Proposal value",
        width: 145,
        type: "numericColumn",
        enableValue: true,
        aggFunc: "sum",
        valueFormatter: (p) =>
          typeof p.value === "number" ? usd(Math.round(p.value * 100)) : "",
        chartDataType: "series",
      },
      {
        field: "settled",
        headerName: "Settled",
        width: 145,
        type: "numericColumn",
        enableValue: true,
        aggFunc: "sum",
        cellRenderer: MoneyCell,
        valueFormatter: (p) =>
          typeof p.value === "number" ? usd(Math.round(p.value * 100)) : "",
        chartDataType: "series",
      },
      {
        field: "reserved",
        headerName: "Reserved",
        width: 145,
        type: "numericColumn",
        enableValue: true,
        aggFunc: "sum",
        valueFormatter: (p) =>
          typeof p.value === "number" ? usd(Math.round(p.value * 100)) : "",
        chartDataType: "series",
      },
      {
        colId: "history",
        headerName: "Supplier proposals · 28d",
        width: 200,
        sortable: false,
        filter: false,
        valueGetter: (p) =>
          history.get(p.data?.supplier ?? String(p.node?.key)) ?? [],
        cellRenderer: "agSparklineCellRenderer",
        cellRendererParams: {
          sparklineOptions: {
            type: "area",
            fill: "#ccebe0",
            stroke: "#00896c",
            strokeWidth: 2,
          },
        },
        chartDataType: "excluded",
      },
      {
        field: "proposedAt",
        headerName: "Proposed (UTC)",
        width: 165,
        valueFormatter: (p) =>
          p.value ? String(p.value).slice(0, 16).replace("T", " ") : "",
        chartDataType: "excluded",
      },
    ],
    [history],
  );
  const applyAnalysis = (api: GridApi<InsightRow>) => {
    api.setFilterModel(null);
    api.setGridOption("pivotMode", context.analysis === "status");
    api.applyColumnState({
      defaultState: { rowGroup: false, pivot: false, hide: false },
      state: [
        {
          colId: "supplier",
          rowGroup: context.analysis !== "purchases",
          rowGroupIndex: context.analysis !== "purchases" ? 0 : null,
          hide: context.analysis !== "purchases",
        },
        {
          colId: "product",
          rowGroup: context.analysis === "suppliers",
          rowGroupIndex: context.analysis === "suppliers" ? 1 : null,
          hide: context.analysis !== "purchases",
        },
        {
          colId: "status",
          pivot: context.analysis === "status",
          hide: context.analysis === "suppliers",
        },
        { colId: "purchase", hide: context.analysis !== "purchases" },
        { colId: "history", hide: context.analysis === "status" },
        { colId: "proposedAt", hide: context.analysis !== "purchases" },
      ],
    });
  };
  useEffect(() => {
    if (grid.current) applyAnalysis(grid.current);
    setSearch("");
    setNotice("");
  }, [context.analysis]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    try {
      sessionStorage.setItem(
        context.storageKey,
        JSON.stringify({
          columns: grid.current?.getColumnState(),
          filters: grid.current?.getFilterModel(),
          pivot: grid.current?.isPivotMode(),
          search,
        }),
      );
      setNotice("View saved for this browser session.");
    } catch {
      setNotice("This browser could not save the view.");
    }
  };
  const restore = () => {
    try {
      const raw = sessionStorage.getItem(context.storageKey);
      if (!raw) {
        setNotice("Save a view first.");
        return;
      }
      const saved = JSON.parse(raw) as {
        columns: ColumnState[];
        filters: FilterModel;
        pivot: boolean;
        search: string;
      };
      grid.current?.setGridOption("pivotMode", saved.pivot);
      grid.current?.applyColumnState({
        state: saved.columns,
        applyOrder: true,
      });
      grid.current?.setFilterModel(saved.filters);
      setSearch(saved.search);
      setNotice("Saved grid layout and filters restored.");
    } catch {
      setNotice("The saved view could not be restored.");
    }
  };
  return (
    <div className={styles.shell}>
      <div className={styles.toolbar}>
        <label>
          Find a purchase
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Product, supplier or status…"
          />
        </label>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => {
              grid.current?.createRangeChart({
                cellRange: { columns: ["supplier", "settled", "reserved"] },
                chartType: "groupedColumn",
              });
            }}
          >
            Chart this view
          </button>
          <button type="button" onClick={save}>
            Save view
          </button>
          <button type="button" onClick={restore}>
            Restore view
          </button>
          <button
            type="button"
            onClick={() =>
              grid.current?.exportDataAsExcel({
                fileName: context.demo
                  ? "guardbuy-demo.xlsx"
                  : "guardbuy-purchases.xlsx",
              })
            }
          >
            Export Excel
          </button>
        </div>
      </div>
      <div className={styles.hint}>
        Expand a purchase for its decision. Drag column headings to group.
        Select numeric cells for totals, or right-click a range to chart it.
        Trends show 28 days of proposal value, not sales.
      </div>
      {notice && (
        <div role="status" className={styles.hint}>
          {notice}
        </div>
      )}
      {error ? (
        <div role="alert">
          Purchase data could not be loaded. Refresh Home to retry.
        </div>
      ) : (
        <div className={styles.grid}>
          <AgGridReact<InsightRow>
            modules={modules}
            theme={gridTheme}
            rowData={rows}
            loading={ids === null}
            columnDefs={columns}
            context={context}
            onGridReady={({ api }) => {
              grid.current = api;
              applyAnalysis(api);
            }}
            getRowId={(p) => String(p.data.purchase)}
            defaultColDef={{
              sortable: true,
              filter: true,
              resizable: true,
              minWidth: 100,
            }}
            quickFilterText={search}
            masterDetail
            detailCellRenderer={Detail}
            detailRowHeight={240}
            keepDetailRows
            rowGroupPanelShow="always"
            groupDefaultExpanded={0}
            autoGroupColumnDef={{
              headerName: "Supplier / product",
              minWidth: 250,
              pinned: "left",
            }}
            cellSelection
            enableCharts
            animateRows
            sideBar={{
              toolPanels: ["columns", "filters"],
              defaultToolPanel: undefined,
            }}
            statusBar={{
              statusPanels: [
                {
                  statusPanel: "agTotalAndFilteredRowCountComponent",
                  align: "left",
                },
                { statusPanel: "agAggregationComponent", align: "right" },
              ],
            }}
            grandTotalRow="pinnedBottom"
            suppressAggFuncInHeader
            defaultExcelExportParams={{
              columnKeys: [
                "purchase",
                "product",
                "supplier",
                "status",
                "amount",
                "settled",
                "reserved",
                "proposedAt",
              ],
            }}
          />
        </div>
      )}
    </div>
  );
}
