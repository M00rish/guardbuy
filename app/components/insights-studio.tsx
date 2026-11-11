import {
  useEffect,
  useMemo,
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
} from "react";
import PurchaseAnalysisGrid, {
  type PurchaseGridData,
} from "./purchase-analysis-grid";
import { createPurchaseGridStore } from "../lib/insights/grid-view";
import { demoSnapshot } from "../lib/insights/demo";
import { ANALYSES, type InsightAnalysis } from "../lib/insights/plan";
import { useAppBridge } from "@shopify/app-bridge-react";
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
  type AgAiHarnessSetup,
  type AgStudioApi,
  type AgDataSourcesDefinition,
} from "ag-studio";
import { createInsightsAgent } from "../lib/insights/agent";
import { InsightPlanSchema } from "../lib/insights/plan";
import {
  INSIGHT_VIEWS,
  VIEW_LABEL,
  inInsightView,
  type InsightsSnapshot,
  type InsightView,
} from "../lib/insights/types";
import { readableTime, usd } from "../lib/format";
import { Metric } from "./ui";
import styles from "./insights.module.css";

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
      minSize: { width: 280, height: 450 },
    },
  ],
});
const ANALYSIS_LABELS = {
  purchases: "Purchase details",
  suppliers: "Supplier comparison",
  status: "Status pivot",
};
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
      widgets: {
        outcomes: {
          type: "column-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "purchases.status" }],
            valueKey: [{ id: "purchases.count", aggregation: "sum" }],
          },
          format: {
            crossFilter: "filter",
            title: {
              enabled: true,
              typography: { fontSize: 16 },
              text: "Purchases by current status",
            },
          },
        },
        trend: {
          type: "column-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "purchases.supplier" }],
            valueKey: [
              { id: "purchases.settled", aggregation: "sum" },
              { id: "purchases.reserved", aggregation: "sum" },
            ],
          },
          format: {
            crossFilter: "filter",
            title: {
              enabled: true,
              typography: { fontSize: 16 },
              text: "Supplier comparison · settled and reserved",
            },
            style: {
              theme: {
                common: { legend: { enabled: true, position: "bottom" } },
              },
            },
          },
        },
        purchases: analysisWidget(),
      },
      widgetLayout: {
        outcomes: { xTrack: 0, yTrack: 34, xSpan: 10, ySpan: 15 },
        trend: { xTrack: 10, yTrack: 34, xSpan: 14, ySpan: 15 },
        purchases: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 34 },
      },
    },
  ],
};
export default function InsightsStudio({
  snapshot: liveSnapshot,
  licenseKey,
  gridLicenseKey,
  aiConfigured,
  shop = "preview",
  home = false,
}: {
  snapshot: InsightsSnapshot;
  licenseKey: string;
  gridLicenseKey: string;
  aiConfigured: boolean;
  shop?: string;
  home?: boolean;
}) {
  const [demo, setDemo] = useState(false);
  const demoData = useMemo(() => demoSnapshot(), []);
  const snapshot = demo ? demoData : liveSnapshot;
  const [days, setDays] = useState(0);
  const datedRows = useMemo(
    () =>
      snapshot.rows.filter(
        (row) =>
          !days ||
          Date.parse(row.proposedAt) >=
            Date.parse(snapshot.checkedAt) - days * 86400000,
      ),
    [snapshot, days],
  );
  const [analysis, setAnalysis] = useState<InsightAnalysis>("purchases");
  const studioApi = useRef<AgStudioApi<GuardRegistry>>();
  const [linked, setLinked] = useState(false);
  const resetLinked = useCallback(() => {
    const api = studioApi.current;
    if (!api) return;
    const state = api.getState();
    if (!state.pages.some((page) => page.crossFilter || page.filter)) return;
    api.setState({
      ...state,
      pages: state.pages.map((page) => ({
        ...page,
        crossFilter: undefined,
        filter: undefined,
      })),
    });
  }, []);
  const analyze = useCallback(
    (next: InsightAnalysis) => {
      setAnalysis(next);
      resetLinked();
    },
    [resetLinked],
  );
  const [view, setView] = useState<InsightView>("all");
  const shopify = useAppBridge();
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 700px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const initialState = useMemo<AgReportState<GuardRegistry>>(
    () =>
      narrow
        ? {
            ...desktopState,
            pages: desktopState.pages.map((page) => ({
              ...page,
              widgetLayout: {
                outcomes: { xTrack: 0, yTrack: 36, xSpan: 24, ySpan: 15 },
                trend: { xTrack: 0, yTrack: 51, xSpan: 24, ySpan: 15 },
                purchases: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 36 },
              },
            })),
          }
        : desktopState,
    [narrow],
  );
  const shown = useMemo(
    () => datedRows.filter((row) => inInsightView(row, view)),
    [datedRows, view],
  );
  const data = useMemo<AgDataSourcesDefinition<GuardRegistry>>(
    () => ({
      sources: [
        {
          id: "purchases",
          name: "Recorded purchases",
          data: shown.map((row) => ({ ...row, count: 1 })),
          fields: [
            {
              id: "purchase",
              name: "Purchase",
              format: "integerFormat",
              createValueFormatter: () => (value) => `#${value}`,
            },
            ...[
              "product",
              "supplier",
              "status",
              "reason",
              "paymentReference",
              "route",
            ].map((id) => ({
              id,
              name: (
                {
                  paymentReference: "Payment reference",
                  reason: "Decision reasons",
                } as Record<string, string>
              )[id],
              format: "textFormat" as const,
            })),
            ...["amount", "settled", "reserved"].map((id) => ({
              id,
              name: (
                {
                  amount: "Proposal value",
                  settled: "Settled (net refunds)",
                  reserved: "Reserved",
                } as Record<string, string>
              )[id],
              format: "integerFormat" as const,
              createValueFormatter: () => (value: number) =>
                usd(Math.round(value * 100)),
            })),
            { id: "count", name: "Purchases", format: "integerFormat" },
          ],
        },
        { id: "trend", name: "Settled spend by UTC day", data: snapshot.trend },
      ],
    }),
    [shown, snapshot.trend],
  );
  const context = useMemo(
    () => ({
      gridLicenseKey,
      rows: shown,
      allRows: snapshot.rows,
      analysis,
      demo,
      checkedAt: snapshot.checkedAt,
      storageKey: `guardbuy-grid:${shop}:${demo ? "demo" : "live"}`,
    }),
    [snapshot, shown, analysis, demo, shop, gridLicenseKey],
  );
  const [purchaseStore] = useState(() => createPurchaseGridStore(context));
  useLayoutEffect(
    () => purchaseStore.update(context),
    [purchaseStore, context],
  );
  const widgetContext = useMemo(() => ({ purchaseStore }), [purchaseStore]);
  // The AI harness is initial-only too: callbacks must read current date-filtered rows.
  const latest = useRef({ datedRows, shopify });
  latest.current = { datedRows, shopify };
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api }) =>
        createAiHarness(api as AgStudioApi, () => ({
          agents: [
            createInsightsAgent(api as AgStudioApi, {
              rows: () => latest.current.datedRows,
              select: (next) => {
                setView(next);
                resetLinked();
              },
              analyze,
              plan: async (prompt, signal) => {
                const token = await latest.current.shopify.idToken();
                const response = await fetch("/app/insights/plan", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({ prompt }),
                  signal,
                });
                if (!response.ok) throw new Error("Assistant unavailable");
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
              label: "Why were proposals blocked?",
              prompt: "Show blocked proposals and their reasons",
            },
            {
              label: "Payment status by supplier",
              prompt: "Show payment status by supplier",
            },
          ],
        })),
    [analyze, resetLinked],
  );
  return (
    <AgStudioProvider
      licenseKey={licenseKey || undefined}
      modules={[AgStudioAiModule]}
    >
      <s-stack gap="base">
        <div className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>GUARDBUY / PURCHASE EXPLORER</span>
            <h2>Your purchasing, in focus.</h2>
            <p>
              Compare suppliers, follow the money, and explore the decisions
              behind it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDemo(!demo);
              setView("all");
              analyze("purchases");
            }}
            aria-pressed={demo}
          >
            {demo ? "Return to live data" : "Explore demo data"}
          </button>
        </div>
        {demo && (
          <s-banner heading="Demo data · fictional purchases" tone="info">
            64 example purchases across four suppliers. This does not create
            products, submit payments or change store records. Return to live
            data to inspect your store. Home’s status and budget totals above
            remain live.
          </s-banner>
        )}
        {!home && (
          <s-section>
            <div className={styles.metrics}>
              <Metric
                label="Spent · last 7 days"
                value={usd(snapshot.summary.spentCents)}
                detail="Settled payments, net of recorded refunds"
              />
              <Metric
                label="Reserved"
                value={usd(snapshot.summary.reservedCents)}
                detail="Pending payments and unexpired approval commitments"
              />
              <Metric
                label="Remaining budget"
                value={usd(snapshot.summary.remainingCents)}
                detail="7-day spending cap minus spent and reserved"
              />
              <Metric
                label="Blocked proposal value · all time"
                value={usd(snapshot.summary.blockedCents)}
                detail={`${snapshot.summary.blockedCount} blocked ${snapshot.summary.blockedCount === 1 ? "proposal" : "proposals"}; not realized savings`}
              />
            </div>
          </s-section>
        )}
        <s-section>
          <s-stack gap="base">
            <s-heading>
              {demo ? "Demo purchasing analysis" : "Purchasing analysis"}
            </s-heading>
            <div className={styles.filters} aria-label="Analysis mode">
              {ANALYSES.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={analysis === id}
                  onClick={() => analyze(id)}
                >
                  {ANALYSIS_LABELS[id]}
                </button>
              ))}
              <button type="button" onClick={resetLinked}>
                Reset chart filters{linked ? " · selection active" : ""}
              </button>
            </div>
            <div className={styles.filters} aria-label="Date range">
              {[0, 7, 30].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={days === value}
                  onClick={() => {
                    setDays(value);
                    resetLinked();
                  }}
                >
                  {value
                    ? `Proposed in last ${value} days`
                    : "All recorded dates"}
                </button>
              ))}
            </div>
            <div className={styles.filters} aria-label="Purchase views">
              {INSIGHT_VIEWS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={view === id}
                  onClick={() => {
                    setView(id);
                    resetLinked();
                  }}
                >
                  {VIEW_LABEL[id]}
                </button>
              ))}
            </div>
            <s-text>
              {days
                ? `Proposed in last ${days} days · `
                : "All recorded dates · "}
              {VIEW_LABEL[view]} · {shown.length}{" "}
              {shown.length === 1 ? "purchase" : "purchases"} before chart
              selections. Sort or cross-filter with a chart selection. Expand
              supplier rows to explore products; use the purchase view for
              decision details.
            </s-text>
            {aiConfigured && (
              <s-text tone="neutral">
                The assistant sends your request to the configured AI provider.
                Do not enter secrets or personal information.
              </s-text>
            )}
            {!aiConfigured && (
              <s-text tone="neutral">
                The assistant is unavailable. You can still explore purchases
                with the filters.
              </s-text>
            )}
            <s-text tone="neutral">
              Recorded snapshot: {readableTime(snapshot.checkedAt)}. This page
              does not refresh PayPal or submit payments.
            </s-text>
            <div className={styles.studio}>
              <AgStudio<GuardRegistry>
                style={{ height: "100%", width: "100%" }}
                key={`${demo ? "demo" : "live"}-${narrow ? "mobile" : "desktop"}`}
                onStudioReady={({ api }) => {
                  studioApi.current = api as AgStudioApi<GuardRegistry>;
                }}
                onStudioPreDestroyed={({ api }) => {
                  if (studioApi.current === api) studioApi.current = undefined;
                }}
                onStateUpdated={({ state }) =>
                  setLinked(
                    state.pages.some((page) =>
                      Object.values(page.crossFilter?.values ?? {}).some(
                        (values) => Array.isArray(values) && values.length > 0,
                      ),
                    ),
                  )
                }
                data={data}
                context={widgetContext}
                initialState={initialState}
                widgets={widgets}
                theme={theme}
                mode="edit"
                ai={aiConfigured ? ai : undefined}
                aiToolDisplay={{
                  show_purchases: {
                    label: () => ({ text: "Update analysis" }),
                  },
                }}
                panels={{
                  edit: { right: aiConfigured ? ["ai"] : [], left: [] },
                }}
                layout={{
                  minWidth: 280,
                  columns: 24,
                  rowHeight: 20,
                  pagePadding: 12,
                  widgetPadding: 12,
                }}
                loadThemeGoogleFonts={false}
              />
            </div>
            {!demo && <s-link href="/app/activity">View all activity</s-link>}
          </s-stack>
        </s-section>
      </s-stack>
    </AgStudioProvider>
  );
}
