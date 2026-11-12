import { ViewTabs } from "./view-tabs";
import { commonInsightPlan } from "../lib/insights/common-plan";
import { awaitWithSignal } from "../lib/insights/await-signal";
import CurrentStateOverview from "./current-state-overview";
import type { OverviewSelection } from "../lib/insights/overview";
import { assistantFailureKind } from "../lib/insights/errors";
import {
  useEffect,
  useMemo,
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
} from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { AgGridProvider } from "ag-grid-react";
import type { GridApi } from "ag-grid-community";
import {
  AgStudio,
  AgStudioProvider,
  createWidgets,
  type AgWidgetDefinition,
} from "ag-studio-react";
import {
  AgStudioAiModule,
  createAiHarness,
  studioTheme,
  type AgCoreDefaultRegistry,
  type AgReportState,
  type AgAiHarness,
  type AgStudioApi,
  type AgDataSourcesDefinition,
} from "ag-studio";
import PurchaseAnalysisGrid, {
  purchaseGridModules,
  type PurchaseGridData,
} from "./purchase-analysis-grid";
import { createPurchaseGridStore } from "../lib/insights/grid-view";
import {
  runGuardQuery,
  productAnalytics,
  guardQueryLabel,
} from "../lib/insights/query";
import type { GuardQuery } from "../lib/insights/query-schema";
import {
  applyQueryToGrid,
  PRODUCT_ANALYTIC_COLUMNS,
} from "../lib/insights/grid-query";
import { demoSnapshot } from "../lib/insights/demo";
import {
  demoWorkspace,
  type HomeWorkspaceData,
  type WorkspaceProduct,
} from "../lib/insights/workspace";
import { type InsightAnalysis, InsightPlanSchema } from "../lib/insights/plan";
import {
  createInsightsAgent,
  AssistantRequestError,
} from "../lib/insights/agent";
import {
  VIEW_LABEL,
  inInsightView,
  type InsightsSnapshot,
  type InsightView,
  type InsightRow,
} from "../lib/insights/types";
import { readableTime, usd } from "../lib/format";
import { ProductsGrid, RecordsGrid, type DataView } from "./home-data-grid";
import { WorkspaceAssistant } from "./workspace-assistant";
import styles from "./home-workspace.module.css";
interface GuardRegistry extends Omit<AgCoreDefaultRegistry, "widgets"> {
  widgets: readonly (
    | AgCoreDefaultRegistry["widgets"][number]
    | AgWidgetDefinition<"guardbuy-purchases", PurchaseGridData>
  )[];
}
const widgets = createWidgets<GuardRegistry>({
  additionalTypes: [
    {
      id: "guardbuy-purchases",
      label: "Purchase explorer",
      comp: PurchaseAnalysisGrid,
      dataMapping: {
        purchase: {
          type: "field",
          supportedRoles: ["numeric"],
          required: true,
        },
      },
      form: (p) =>
        p.createDefaults({
          dataMappingItems: [{ key: "purchase", label: "Purchase identifier" }],
        }),
      defaultSize: { width: 1000, height: 650 },
      minSize: { width: 260, height: 280 },
    },
  ],
});
function analysisWidget(): PurchaseGridData {
  return {
    type: "guardbuy-purchases",
    dataMapping: { purchase: [{ id: "purchases.purchase" }] },
    format: { crossFilter: "filter" },
  };
}
const theme = studioTheme.withParams({
  backgroundColor: "#ffffff",
  foregroundColor: "#303030",
  accentColor: "#007f5f",
  borderColor: "#dedede",
  fontFamily: "Arial, sans-serif",
  spacing: 6,
});
const desktopState: AgReportState<GuardRegistry> = {
  selectedPageId: "guardbuy",
  panels: {
    ai: { collapsed: true },
    filters: { collapsed: true },
    edit: { collapsed: true },
    data: { collapsed: true },
  },
  pages: [
    {
      id: "guardbuy",
      layout: {
        rowHeight: 20,
        minWidth: 260,
        pagePadding: 0,
        widgetPadding: 0,
      },
      widgets: { purchases: analysisWidget() },
      widgetLayout: {
        purchases: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 31 },
      },
    },
  ],
};

const viewLabels: Record<DataView, string> = {
  products: "Products",
  purchases: "Purchases",
  activity: "Activity",
  details: "Store details",
};
export default function InsightsStudio({
  snapshot: liveSnapshot,
  workspace: liveWorkspace,
  licenseKey,
  gridLicenseKey,
  aiConfigured,
  shop,
  busy = false,
  onManage,
}: {
  snapshot: InsightsSnapshot;
  workspace: HomeWorkspaceData;
  licenseKey: string;
  gridLicenseKey: string;
  aiConfigured: boolean;
  shop: string;
  busy?: boolean;
  onManage?: (product: WorkspaceProduct) => void;
}) {
  const [demo, setDemo] = useState(false);
  const demoData = useMemo(() => demoSnapshot(), []);
  const snapshot = demo ? demoData : liveSnapshot;
  const workspace = useMemo(
    () => (demo ? demoWorkspace(demoData) : liveWorkspace),
    [demo, demoData, liveWorkspace],
  );
  const [dataView, setDataView] = useState<DataView>("products");
  const viewRef = useRef<DataView>(dataView);
  viewRef.current = dataView;
  const [guardQuery, setGuardQuery] = useState<GuardQuery>();
  const [overviewSelection, setOverviewSelection] =
    useState<OverviewSelection>();
  const queryResult = useMemo(
    () =>
      guardQuery
        ? runGuardQuery(guardQuery, { snapshot, workspace })
        : undefined,
    [guardQuery, snapshot, workspace],
  );
  const resultRef = useRef(queryResult);
  resultRef.current = queryResult;
  const displayedWorkspace = useMemo(
    () => ({
      ...workspace,
      products:
        overviewSelection?.view === "products"
          ? workspace.products
            ? productAnalytics(snapshot.rows, workspace.products).filter((p) =>
                overviewSelection.variantIds.includes(p.variantId),
              )
            : null
          : (queryResult?.products ??
            (workspace.products
              ? productAnalytics(snapshot.rows, workspace.products)
              : null)),
      activity: queryResult?.activity ?? workspace.activity,
      details: queryResult?.details ?? workspace.details,
    }),
    [workspace, snapshot, queryResult, overviewSelection],
  );
  const [analysis, setAnalysis] = useState<InsightAnalysis>("purchases");
  const [selection, setSelection] = useState<InsightView>("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [linked, setLinked] = useState(false);
  const [filtered, setFiltered] = useState(false);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width:700px)").matches,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(640);
  const gridTracks = Math.ceil(panelHeight / 20);
  // Measure from the document top: scrolling must not change the grid's height.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const update = () => {
      const top = panel.getBoundingClientRect().top + window.scrollY;
      const available = Math.round(
        2 *
          Math.max(
            narrow ? 360 : 320,
            Math.min(600, window.innerHeight - top - 56),
          ),
      );
      setPanelHeight((previous) =>
        previous === available ? previous : available,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    if (panel.parentElement) observer.observe(panel.parentElement);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [dataView, narrow, demo]);
  const apiRef = useRef<GridApi<unknown>>();
  const purchaseApiRef = useRef<GridApi<InsightRow>>();
  const [harness, setHarness] = useState<AgAiHarness>();
  const harnessRef = useRef<AgAiHarness>();
  const studioRef = useRef<AgStudioApi<GuardRegistry>>();
  const shopify = useAppBridge();
  useEffect(() => {
    const query = window.matchMedia("(max-width:700px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const boundApis = useRef(new WeakSet<GridApi<unknown>>());
  const bindGrid = useCallback((api: GridApi<unknown> | undefined) => {
    apiRef.current = api;
    const update = () =>
      setFiltered(
        !!api &&
          !api.isDestroyed() &&
          Object.keys(api.getFilterModel()).length > 0,
      );
    if (api && !boundApis.current.has(api)) {
      api.addEventListener("filterChanged", update);
      api.addEventListener("modelUpdated", () => {
        const grid = resultRef.current?.grid;
        if (
          !api.isDestroyed() &&
          grid?.view === viewRef.current &&
          grid.expandPurchase !== undefined
        ) {
          const node = api.getRowNode(String(grid.expandPurchase));
          if (node && !node.expanded) node.setExpanded(true);
        }
      });
      boundApis.current.add(api);
    }
    update();
    if (api && resultRef.current?.grid)
      applyQueryToGrid(
        api,
        resultRef.current.grid,
        window.matchMedia("(max-width:700px)").matches,
      );
  }, []);
  const bindPurchases = useCallback(
    (api: GridApi<InsightRow> | undefined) => {
      purchaseApiRef.current = api;
      if (viewRef.current === "purchases")
        bindGrid(api as GridApi<unknown> | undefined);
    },
    [bindGrid],
  );
  useEffect(() => {
    if (dataView === "purchases")
      bindGrid(purchaseApiRef.current as GridApi<unknown> | undefined);
    const frame = requestAnimationFrame(() => {
      if (apiRef.current && queryResult?.grid)
        applyQueryToGrid(apiRef.current, queryResult.grid, narrow);
    });
    return () => cancelAnimationFrame(frame);
  }, [dataView, queryResult, narrow, bindGrid]);
  const resetLinked = useCallback(() => {
    const api = studioRef.current;
    if (!api) return;
    const state = api.getState();
    if (state.pages.some((page) => page.crossFilter || page.filter))
      api.setState({
        ...state,
        pages: state.pages.map((page) => ({
          ...page,
          crossFilter: undefined,
          filter: undefined,
        })),
      });
  }, []);
  const selectOverview = useCallback(
    (next: OverviewSelection) => {
      apiRef.current?.setFilterModel(null);
      purchaseApiRef.current?.setFilterModel(null);
      setGuardQuery(undefined);
      setOverviewSelection(next);
      setDataView(next.view);
      setSearch("");
      setSelection("all");
      setAnalysis("purchases");
      setNotice("");
      resetLinked();
      requestAnimationFrame(() =>
        document.getElementById("home-grid-panel")?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "start",
        }),
      );
    },
    [resetLinked],
  );
  // Live snapshots update the data without discarding the merchant's chart filter.
  useEffect(() => {
    setOverviewSelection(undefined);
  }, [demo]);
  const resetFilters = () => {
    if (guardQuery && apiRef.current) {
      apiRef.current.applyColumnState({
        defaultState: { sort: null },
        state: [],
      });
      if (dataView === "products") {
        apiRef.current.setColumnsVisible(PRODUCT_ANALYTIC_COLUMNS, false);
        apiRef.current.setColumnsVisible(["state", "stock"], true);
      }
    }
    setGuardQuery(undefined);
    setOverviewSelection(undefined);
    setSearch("");
    setSelection("all");
    apiRef.current?.setFilterModel(null);
    resetLinked();
  };
  const changeView = (view: DataView) => {
    setDataView(view);
    setGuardQuery(undefined);
    setOverviewSelection(undefined);
    setSearch("");
    setNotice("");
    setSelection("all");
    setFiltered(false);
    resetLinked();
  };
  const shown = useMemo(
    () =>
      (queryResult?.purchases ?? snapshot.rows).filter(
        (row) =>
          inInsightView(row, selection) &&
          (overviewSelection?.view !== "purchases" ||
            overviewSelection.purchaseIds.includes(row.purchase)),
      ),
    [snapshot, selection, queryResult, overviewSelection],
  );
  const data = useMemo<AgDataSourcesDefinition<GuardRegistry>>(
    () => ({
      sources: [
        {
          id: "purchases",
          name: "Recorded purchases",
          data: shown.map((row) => ({ ...row, count: 1 })),
          fields: [
            { id: "purchase", name: "Purchase", format: "integerFormat" },
            ...["product", "supplier", "status", "reason"].map((id) => ({
              id,
              name: id,
              format: "textFormat" as const,
            })),
            ...["amount", "settled", "reserved"].map((id) => ({
              id,
              name:
                id === "amount"
                  ? "Proposal value"
                  : id === "settled"
                    ? "Settled (net refunds)"
                    : "Reserved",
              format: "integerFormat" as const,
              createValueFormatter: () => (value: number) =>
                usd(Math.round(value * 100)),
            })),
            { id: "count", name: "Purchases", format: "integerFormat" },
          ],
        },
      ],
    }),
    [shown],
  );
  const context = useMemo(
    () => ({
      rows: shown,
      allRows: snapshot.rows,
      analysis,
      demo,
      checkedAt: snapshot.checkedAt,
      storageKey: `guardbuy-grid:${shop}:${demo ? "demo" : "live"}`,
      gridLicenseKey,
      compact: true,
      search,
      narrow,
      onReady: bindPurchases,
    }),
    [
      shown,
      snapshot,
      analysis,
      demo,
      shop,
      gridLicenseKey,
      search,
      narrow,
      bindPurchases,
    ],
  );
  const [purchaseStore] = useState(() => createPurchaseGridStore(context));
  useLayoutEffect(
    () => purchaseStore.update(context),
    [purchaseStore, context],
  );
  const widgetContext = useMemo(() => ({ purchaseStore }), [purchaseStore]);
  const initialState = useMemo<AgReportState<GuardRegistry>>(
    () => ({
      ...desktopState,
      pages: desktopState.pages.map((page) => ({
        ...page,
        widgetLayout: {
          purchases: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: gridTracks },
        },
      })),
    }),
    [gridTracks],
  );
  // Reflow the fixed report without destroying the grid or its current filters.
  useEffect(() => {
    const api = studioRef.current;
    if (!api) return;
    const state = api.getState();
    api.setState({
      ...state,
      pages: initialState.pages.map((page) => ({
        ...page,
        crossFilter: undefined,
      })),
      panels: state.panels,
    });
  }, [initialState]);
  const latest = useRef({ snapshot, workspace, shopify, aiConfigured });
  latest.current = { snapshot, workspace, shopify, aiConfigured };
  const buildAi = useCallback(
    (api: AgStudioApi) =>
      createAiHarness(api, () => ({
        agents: [
          createInsightsAgent(api as AgStudioApi, {
            rows: () => latest.current.snapshot.rows,
            query: (query) => {
              const result = runGuardQuery(query, latest.current);
              if (result.grid) {
                setOverviewSelection(undefined);
                setGuardQuery(query);
                setDataView(result.grid.view);
                setAnalysis(result.grid.analysis ?? "purchases");
                setSelection("all");
                setSearch("");
                setNotice("");
                apiRef.current?.setFilterModel(null);
                resetLinked();
              }
              return result;
            },
            select: (view) => {
              setGuardQuery(undefined);
              setOverviewSelection(undefined);
              setDataView("purchases");
              setSelection(view);
              setSearch("");
              apiRef.current?.setFilterModel(null);
              resetLinked();
            },
            analyze: (next) => setAnalysis(next),
            plan: async (prompt, signal) => {
              if (signal?.aborted) throw signal.reason;
              const common = commonInsightPlan(prompt, {
                reorderBelowDays:
                  latest.current.workspace.policy?.reorderBelowDays,
              });
              if (common) return common;
              if (!latest.current.aiConfigured)
                throw new AssistantRequestError("configuration");
              const deadline = AbortSignal.any([
                AbortSignal.timeout(30000),
                ...(signal ? [signal] : []),
              ]);
              const token = await awaitWithSignal(
                latest.current.shopify.idToken(),
                deadline,
              );
              const response = await fetch("/app/insights/plan", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ prompt }),
                signal: deadline,
              });
              if (!response.ok) {
                const failure = await response.json().catch(() => null);
                throw new AssistantRequestError(
                  response.status === 429
                    ? "rate_limit"
                    : assistantFailureKind(failure?.code),
                );
              }
              return InsightPlanSchema.parse(await response.json());
            },
          }),
        ],
        primary: "guardbuy-insights",
        promptStarters: [
          {
            label: "Compare suppliers",
            prompt: "Compare suppliers by settled spend",
          },
          {
            label: "Explain blocked purchases",
            prompt: "Show blocked proposals and their reasons",
          },
        ],
      })),
    [resetLinked],
  );
  return (
    <AgStudioProvider
      licenseKey={licenseKey || undefined}
      modules={[AgStudioAiModule]}
    >
      <AgGridProvider
        modules={purchaseGridModules}
        licenseKey={gridLicenseKey || undefined}
      >
        <section className={styles.workspace} aria-label="Home data workspace">
          <div className={styles.overviewHeading}>
            <strong>{demo ? "Demo store overview" : "Store overview"}</strong>
            <label>
              Data{" "}
              <select
                aria-label="Data mode"
                value={demo ? "demo" : "live"}
                onChange={(e) => {
                  setGuardQuery(undefined);
                  setOverviewSelection(undefined);
                  setDemo(e.target.value === "demo");
                  setSearch("");
                  setSelection("all");
                  setNotice("");
                  setFiltered(false);
                }}
              >
                <option value="live">Live store</option>
                <option value="demo">Fictional demo</option>
              </select>
            </label>
          </div>
          {demo && (
            <div className={styles.demo} role="status">
              Fictional demo · all workspace values are examples. Store controls
              above remain live. Product actions and real-record links are
              disabled.
            </div>
          )}
          <CurrentStateOverview
            snapshot={snapshot}
            workspace={workspace}
            gridLicenseKey={gridLicenseKey}
            demo={demo}
            narrow={narrow}
            onSelect={selectOverview}
          />
          <div className={styles.main}>
            <ViewTabs
              label="Home data views"
              value={dataView}
              options={(Object.keys(viewLabels) as DataView[]).map((id) => ({
                id,
                label: viewLabels[id],
              }))}
              onChange={changeView}
              panelId="home-grid-panel"
            />
            <div className={styles.toolbar}>
              <input
                aria-label={`Search ${viewLabels[dataView].toLowerCase()}`}
                placeholder={`Search ${viewLabels[dataView].toLowerCase()}…`}
                value={search}
                maxLength={800}
                onChange={(e) => setSearch(e.target.value)}
              />
              {dataView === "purchases" && (
                <select
                  aria-label="Purchase layout"
                  value={analysis}
                  onChange={(e) => {
                    setGuardQuery(undefined);
                    setOverviewSelection(undefined);
                    setAnalysis(e.target.value as InsightAnalysis);
                    setSearch("");
                    resetLinked();
                  }}
                >
                  <option value="purchases">Purchase details</option>
                  <option value="suppliers">Supplier comparison</option>
                  <option value="status">Status pivot</option>
                </select>
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() =>
                    apiRef.current?.exportDataAsExcel({
                      fileName: `guardbuy-${demo ? "demo-" : ""}${dataView}.xlsx`,
                      columnKeys: apiRef.current
                        .getAllDisplayedColumns()
                        .filter((column) => column.getColId() !== "history"),
                      exportedRows: "filteredAndSorted",
                      autoConvertFormulas: false,
                    })
                  }
                >
                  Export
                </button>
                <button
                  type="button"
                  disabled={!harness}
                  aria-haspopup="dialog"
                  aria-expanded={aiOpen}
                  aria-controls="guardbuy-assistant-panel"
                  onClick={() => setAiOpen(true)}
                >
                  Ask AI
                </button>
              </div>
            </div>
            {(overviewSelection ||
              guardQuery ||
              filtered ||
              search ||
              linked ||
              selection !== "all") && (
              <div className={styles.activeFilters} role="status">
                {overviewSelection
                  ? `Chart: ${overviewSelection.label} · `
                  : ""}
                {guardQuery
                  ? `Assistant result: ${guardQueryLabel(guardQuery)} · `
                  : ""}
                {selection !== "all"
                  ? `Assistant view: ${VIEW_LABEL[selection]} · `
                  : ""}
                {linked ? "Chart selection active · " : ""}
                {filtered ? "Column filters active · " : ""}
                {search ? `Search: ${search} · ` : ""}
                <button type="button" onClick={resetFilters}>
                  Clear filters
                </button>
              </div>
            )}
            {notice && (
              <div className={styles.notice} role="status">
                {notice}
              </div>
            )}
            <div
              id="home-grid-panel"
              role="tabpanel"
              aria-labelledby={`tab-${dataView}`}
              className={styles.gridPanel}
              ref={panelRef}
              style={{
                height:
                  dataView === "purchases" ? gridTracks * 20 : panelHeight,
              }}
            >
              {dataView === "products" && (
                <ProductsGrid
                  key={`${demo}-products`}
                  workspace={displayedWorkspace}
                  purchases={snapshot.rows}
                  demo={demo}
                  busy={busy}
                  onManage={(product) => {
                    if (!demo) onManage?.(product);
                  }}
                  search={search}
                  narrow={narrow}
                  onReady={bindGrid}
                />
              )}
              <div
                hidden={dataView !== "purchases"}
                className={styles.studio}
                style={{ height: "100%" }}
              >
                <AgStudio<GuardRegistry>
                  key={demo ? "demo" : "live"}
                  style={{ height: "100%", width: "100%" }}
                  data={data}
                  context={widgetContext}
                  widgets={widgets}
                  initialState={initialState}
                  theme={theme}
                  mode="view"
                  onStudioReady={({ api }) => {
                    studioRef.current = api as AgStudioApi<GuardRegistry>;
                    harnessRef.current = buildAi(api as AgStudioApi);
                    setHarness(harnessRef.current);
                  }}
                  onStudioPreDestroyed={({ api }) => {
                    if (studioRef.current === api) {
                      studioRef.current = undefined;
                      harnessRef.current?.dispose?.();
                      harnessRef.current = undefined;
                      setHarness(undefined);
                    }
                  }}
                  onStateUpdated={({ state }) =>
                    setLinked(
                      state.pages.some((page) =>
                        Object.values(page.crossFilter?.values ?? {}).some(
                          (values) => values.length > 0,
                        ),
                      ),
                    )
                  }
                  aiToolDisplay={{
                    show_purchases: {
                      label: () => ({ text: "Update purchase view" }),
                    },
                  }}
                  panels={{ view: { right: [], left: [] } }}
                  layout={{
                    columns: 24,
                    rowHeight: 20,
                    minWidth: 260,
                    pagePadding: 0,
                    widgetPadding: 0,
                  }}
                  loadThemeGoogleFonts={false}
                />
              </div>
              {(dataView === "activity" || dataView === "details") && (
                <RecordsGrid
                  directory={guardQuery?.source === "supplierDirectory"}
                  key={`${demo}-${dataView}`}
                  view={dataView}
                  workspace={displayedWorkspace}
                  demo={demo}
                  search={search}
                  onReady={bindGrid}
                />
              )}
            </div>
            {harness && (
              <WorkspaceAssistant
                key={demo ? "demo" : "live"}
                harness={harness}
                open={aiOpen}
                demo={demo}
                checkedAt={snapshot.checkedAt}
                onClose={() => setAiOpen(false)}
              />
            )}
            <div className={styles.footer}>
              <span>
                Snapshot {readableTime(snapshot.checkedAt)} ·{" "}
                {demo
                  ? "Fictional data"
                  : "Store summary is independent of grid filters"}
                {dataView === "activity" ? " · Latest 100 recorded events" : ""}
                {dataView === "purchases"
                  ? " · Row totals cover filtered purchase history"
                  : ""}
              </span>
              <details>
                <summary>Help</summary>
                <p>
                  Use column menus or the Filters panel to narrow records.
                  Expand a product for its purchases, or a purchase for its
                  recorded decision. Select numeric cells for totals and charts.
                  Exports include filtered, sorted rows. For questions needing
                  AI, the assistant sends only your request to the configured AI
                  provider; keep secrets and personal information out of
                  prompts.
                </p>
              </details>
            </div>
          </div>
        </section>
      </AgGridProvider>
    </AgStudioProvider>
  );
}
