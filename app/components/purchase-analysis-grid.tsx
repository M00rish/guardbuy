import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link } from "react-router";
import {
  AgGridProvider,
  AgGridReact,
  type CustomCellRendererProps,
} from "ag-grid-react";
import { AllEnterpriseModule } from "ag-grid-enterprise";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import {
  themeQuartz,
  type ColDef,
  type GridApi,
  type IDetailCellRendererParams,
} from "ag-grid-community";
import type {
  AgWidgetData,
  AgWidgetDataFormat,
  AgWidgetParams,
  AgWidgetDataQuery,
  AgDataHandleDefinition,
  AgWidgetRowsResult,
} from "ag-studio";
import type { InsightRow } from "../lib/insights/types";
import { usd } from "../lib/format";
import {
  parseSavedGridView,
  supplierProposalHistory,
  type PurchaseGridStore,
} from "../lib/insights/grid-view";
import styles from "./purchase-analysis-grid.module.css";

export type PurchaseGridData = AgWidgetData<
  { purchase: { id: string }[] },
  AgWidgetDataFormat<Record<string, never>>
> & { type: "guardbuy-purchases" };
export type PurchaseGridContext = { purchaseStore: PurchaseGridStore };
export const purchaseGridModules = [
  AllEnterpriseModule.with(AgChartsEnterpriseModule),
];
export const gridTheme = themeQuartz.withParams({
  accentColor: "#007f65",
  backgroundColor: "#fff",
  foregroundColor: "#213c35",
  headerBackgroundColor: "#edf5f1",
  borderColor: "#dce7e1",
  fontFamily: "Arial, sans-serif",
  fontSize: 13,
  headerFontSize: 12,
  rowHeight: 44,
  headerHeight: 44,
  wrapperBorderRadius: 12,
  cellHorizontalPadding: 16,
});
function StatusCell({ value }: CustomCellRendererProps<InsightRow>) {
  if (!value) return null;
  const tone =
    value === "Paid"
      ? "paid"
      : /blocked|failed|returned/i.test(String(value))
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
        aria-hidden="true"
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
}: Omit<IDetailCellRendererParams<InsightRow, InsightRow>, "context"> & {
  context: { demo: boolean };
}) {
  if (!data) return null;
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
  context: initialContext,
}: AgWidgetParams<PurchaseGridData, unknown, PurchaseGridContext>) {
  const context = useSyncExternalStore(
    initialContext.purchaseStore.subscribe,
    initialContext.purchaseStore.getSnapshot,
  );
  // A saved layout belongs to this shop, data mode AND analysis preset.
  const viewKey = `${context.storageKey}:${context.analysis}:v1`;
  const [ids, setIds] = useState<Set<number> | null>(null);
  const [error, setError] = useState(false);
  const [ownSearch, setSearch] = useState("");
  const search = context.search ?? ownSearch;
  const [notice, setNotice] = useState("");
  const grid = useRef<GridApi<InsightRow>>();
  const fields = dataMapping.purchase;
  useEffect(() => {
    setIds(null);
    if (!fields?.length) return;
    const handle = widgetApi.getDataHandle<{
      purchases: AgDataHandleDefinition<AgWidgetDataQuery>;
    }>();
    handle.open(({ results }) => {
      const result = results.find((result) => result.key === "purchases")
        ?.response.results as AgWidgetRowsResult | undefined;
      if (!result) return;
      setError(!!result.metadata?.error);
      setIds(
        new Set(
          result.metadata?.error
            ? []
            : result.rows.map((row) => Number(row[fields[0].key])),
        ),
      );
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
  const history = useMemo(
    () => supplierProposalHistory(context.allRows, context.checkedAt),
    [context.allRows, context.checkedAt],
  );
  const columns = useMemo<ColDef<InsightRow>[]>(
    () => [
      {
        field: "purchase",
        headerName: "Purchase",
        pinned: context.narrow ? null : "left",
        width: context.narrow ? 100 : 135,
        hide: context.narrow,
        cellRenderer: "agGroupCellRenderer",
        valueFormatter: (p) =>
          p.node?.footer
            ? "Total (filtered)"
            : p.value == null
              ? ""
              : `#${p.value}`,
        chartDataType: "excluded",
      },
      {
        field: "product",
        headerName: "Product",
        minWidth: context.narrow ? 145 : 230,
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
        headerName: "Purchase status",
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
        allowedAggFuncs: ["sum"],
        cellClass: "currency",
        useValueFormatterForExport: false,
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
        allowedAggFuncs: ["sum"],
        cellClass: "currency",
        useValueFormatterForExport: false,
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
        allowedAggFuncs: ["sum"],
        cellClass: "currency",
        useValueFormatterForExport: false,
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
        valueGetter: (p) => {
          if (!p.node?.group || p.node.field !== "supplier") return [];
          return history.get(String(p.node.key)) ?? [];
        },
        tooltipValueGetter: () =>
          "28 UTC days of supplier proposal value, including today; independent of view filters.",
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
        filter: "agDateColumnFilter",
        filterParams: {
          comparator: (date: Date, value: string) =>
            Math.sign(
              new Date(value.slice(0, 10) + "T00:00:00").getTime() -
                date.getTime(),
            ),
        },
        headerName: "Proposed (UTC)",
        width: 165,
        valueFormatter: (p) =>
          p.value ? String(p.value).slice(0, 16).replace("T", " ") : "",
        chartDataType: "excluded",
      },
    ],
    [history, context.narrow],
  );
  const applyAnalysis = (api: GridApi<InsightRow>) => {
    api.setFilterModel(null);
    api.setGridOption("pivotMode", context.analysis === "status");
    api.applyColumnState({
      defaultState: { rowGroup: false, pivot: false, hide: false },
      state: [
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
        {
          colId: "purchase",
          hide: context.analysis !== "purchases" || !!context.narrow,
        },
        { colId: "history", hide: context.analysis !== "suppliers" },
        {
          colId: "proposedAt",
          hide: context.analysis !== "purchases" || !!context.narrow,
        },
        {
          colId: "supplier",
          hide: context.analysis !== "purchases" || !!context.narrow,
          rowGroup: context.analysis !== "purchases",
          rowGroupIndex: context.analysis !== "purchases" ? 0 : null,
        },
        {
          colId: "settled",
          hide: !!context.narrow && context.analysis === "purchases",
        },
        {
          colId: "reserved",
          hide: !!context.narrow && context.analysis === "purchases",
        },
      ],
    });
  };
  useEffect(() => {
    if (grid.current && !grid.current.isDestroyed())
      applyAnalysis(grid.current);
    setSearch("");
    setNotice("");
  }, [context.analysis, context.narrow]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    try {
      sessionStorage.setItem(
        viewKey,
        JSON.stringify({
          version: 1,
          columns: grid.current?.getColumnState(),
          filters: grid.current?.getFilterModel(),
          pivot: grid.current?.isPivotMode(),
          search,
        }),
      );
      setNotice(
        "View saved for this analysis, store and data mode in this browser session.",
      );
    } catch {
      setNotice("This browser could not save the view.");
    }
  };
  const restore = () => {
    try {
      const raw = sessionStorage.getItem(viewKey);
      if (!raw) {
        setNotice("Save a view first.");
        return;
      }
      const saved = parseSavedGridView(raw);
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
      {!context.compact && (
        <div className={styles.toolbar}>
          <label>
            Find a purchase
            <input
              value={search}
              maxLength={800}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Product, supplier or status…"
            />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => {
                const api = grid.current;
                const range = api?.getCellRanges()?.at(-1);
                if (
                  !range?.startRow ||
                  !range.endRow ||
                  !range.columns.some((col) =>
                    ["amount", "settled", "reserved"].includes(col.getColId()),
                  )
                ) {
                  setNotice(
                    "Select a range including numeric cells, then chart the selection.",
                  );
                  return;
                }
                api?.createRangeChart({
                  cellRange: {
                    rowStartIndex: range.startRow.rowIndex,
                    rowEndIndex: range.endRow.rowIndex,
                    columns: range.columns,
                  },
                  chartType: "groupedColumn",
                });
              }}
            >
              Chart selection
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
                  columnKeys: grid.current
                    .getAllDisplayedColumns()
                    .filter((column) => column.getColId() !== "history"),
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
      )}
      {!context.compact && (
        <div className={styles.hint}>
          Expand a purchase for its decision. Drag column headings to group.
          Select numeric cells for totals, or right-click a range to chart it.
          Trends show 28 UTC days of supplier proposal value, independent of
          filters. Excel exports filtered, sorted rows and the current
          grouping/pivot; it is not a payment statement.
        </div>
      )}
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
          <AgGridProvider
            modules={purchaseGridModules}
            licenseKey={context.gridLicenseKey || undefined}
          >
            <AgGridReact<InsightRow>
              theme={gridTheme}
              rowData={rows}
              loading={ids === null}
              columnDefs={columns}
              context={context}
              onGridReady={({ api }) => {
                grid.current = api;
                applyAnalysis(api);
                context.onReady?.(api);
              }}
              onGridPreDestroyed={({ api }) => {
                if (grid.current === api) {
                  grid.current = undefined;
                  context.onReady?.(undefined);
                }
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
              rowGroupPanelShow="onlyWhenGrouping"
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
              grandTotalRow="bottom"
              suppressStickyTotalRow
              suppressAggFuncInHeader
              excelStyles={[
                {
                  id: "currency",
                  numberFormat: { format: '"$"#,##0.00' },
                  dataType: "Number",
                },
              ]}
              defaultExcelExportParams={{
                exportedRows: "filteredAndSorted",
                autoConvertFormulas: false,
                sheetName: context.demo
                  ? "Fictional demo"
                  : "Recorded purchases",
              }}
            />
          </AgGridProvider>
        </div>
      )}
    </div>
  );
}
