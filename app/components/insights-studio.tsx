import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { Link } from "react-router";
import { demoSnapshot } from "../lib/insights/demo";
import { ANALYSES, type InsightAnalysis } from "../lib/insights/plan";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  AgStudio,
  AgStudioProvider,
  createWidgets,
  type AgWidgetDefinition,
  type AgWidgetCustomCellRendererProps,
} from "ag-studio-react";
import {
  AgStudioAiModule,
  createAiHarness,
  studioTheme,
  type AgCoreDefaultRegistry,
  type AgReportState,
  type AgWidgetData,
  type AgWidgetDataFormat,
  type AgWidgetParams,
  type AgAiHarnessSetup,
  type AgStudioApi,
  type AgWidgetField,
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

type BudgetData = AgWidgetData<
  Record<string, never>,
  AgWidgetDataFormat<Record<string, never>>
> & { type: "guardbuy-budget" };
type BudgetDefinition = AgWidgetDefinition<"guardbuy-budget", BudgetData>;
interface GuardRegistry extends Omit<AgCoreDefaultRegistry, "widgets"> {
  widgets: readonly (
    AgCoreDefaultRegistry["widgets"][number] | BudgetDefinition
  )[];
}
function BudgetWidget({
  context,
}: AgWidgetParams<
  BudgetData,
  unknown,
  { summary: InsightsSnapshot["summary"] }
>) {
  const s = context.summary,
    committed = s.spentCents + s.reservedCents;
  return (
    <div className={styles.budget}>
      <strong>Spending guardrail</strong>
      <span className={styles.big}>{usd(s.remainingCents)} remaining</span>
      <progress
        aria-label="Committed share of 7-day spending cap"
        value={Math.min(committed, s.capCents)}
        max={Math.max(1, s.capCents)}
      />
      <span>
        {usd(s.spentCents)} spent + {usd(s.reservedCents)} reserved
      </span>
      <span>
        {s.capCents
          ? `${usd(s.capCents)} 7-day spending cap`
          : "No spending rules signed"}
        {s.overCents ? ` · ${usd(s.overCents)} over cap` : ""}
      </span>
      <span className={styles.note}>
        Store totals; purchase filters do not change the guardrail.
      </span>
    </div>
  );
}
function PurchaseLink({ value }: AgWidgetCustomCellRendererProps) {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq >= 0 ? (
    <Link to={`/app/activity?purchase=${seq}`}>#{seq} · View activity</Link>
  ) : (
    <span>Purchase unavailable</span>
  );
}
const widgets = createWidgets<GuardRegistry>({
  overrides: [
    {
      id: "grid",
      options: {
        createCellRenderer: (field: AgWidgetField) =>
          field.fieldId === "purchases.purchase" ? PurchaseLink : undefined,
      },
    },
  ],
  additionalTypes: [
    {
      id: "guardbuy-budget",
      label: "GuardBuy spending guardrail",
      comp: BudgetWidget,
      dataMapping: {},
      form: (p) => p.createDefaults({ dataMappingItems: [] }),
      defaultSize: { width: 420, height: 230 },
      minSize: { width: 260, height: 200 },
    },
  ],
});
const demoWidgets = createWidgets<GuardRegistry>({
  additionalTypes: [
    {
      id: "guardbuy-budget",
      label: "Demo spending guardrail",
      comp: BudgetWidget,
      dataMapping: {},
      form: (p) => p.createDefaults({ dataMappingItems: [] }),
      defaultSize: { width: 420, height: 230 },
      minSize: { width: 260, height: 200 },
    },
  ],
});
const ANALYSIS_LABELS = {
  purchases: "Purchase details",
  suppliers: "Supplier comparison",
  status: "Status pivot",
};
function analysisWidget(
  analysis: InsightAnalysis,
): NonNullable<
  AgReportState<GuardRegistry>["pages"][number]["widgets"]
>[string] {
  if (analysis === "purchases") return desktopState.pages[0].widgets!.purchases;
  return {
    type: "pivot-grid",
    dataMapping: {
      rows: [
        { id: "purchases.supplier" },
        ...(analysis === "suppliers" ? [{ id: "purchases.product" }] : []),
      ],
      columns: analysis === "status" ? [{ id: "purchases.status" }] : [],
      values: (analysis === "status"
        ? ["amount"]
        : ["settled", "reserved", "count"]
      ).map((id) => ({ id: `purchases.${id}`, aggregation: "sum" as const })),
    },
    format: {
      crossFilter: "filter",
      title: {
        enabled: true,
        text:
          analysis === "status"
            ? "Supplier × status · proposal value"
            : "Supplier → product · expand to explore",
      },
      style: {
        columnWidth: 165,
        grandTotalRow: { enabled: true },
        totalColumns: true,
        theme: { rowHeight: 40 },
      },
    },
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
        guardrail: { type: "guardbuy-budget", dataMapping: {} },
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
        purchases: {
          type: "grid",
          dataMapping: {
            cols: [
              "purchase",
              "product",
              "supplier",
              "status",
              "amount",
              "settled",
              "reserved",
              "reason",
              "paymentReference",
              "route",
            ].map((id) => ({ id: "purchases." + id })),
          },
          format: {
            crossFilter: "filter",
            title: {
              enabled: true,
              typography: { fontSize: 16 },
              text: "Purchases · decision and payment details",
            },
            style: {
              columnWidth: 170,
              columnAutoSize: false,
              headerRow: { wrapText: true },
              theme: { rowHeight: 36 },
            },
          },
        },
      },
      widgetLayout: {
        guardrail: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 12 },
        outcomes: { xTrack: 8, yTrack: 0, xSpan: 16, ySpan: 12 },
        trend: { xTrack: 0, yTrack: 12, xSpan: 24, ySpan: 12 },
        purchases: { xTrack: 0, yTrack: 24, xSpan: 24, ySpan: 23 },
      },
    },
  ],
};
export default function InsightsStudio({
  snapshot: liveSnapshot,
  licenseKey,
  aiConfigured,
}: {
  snapshot: InsightsSnapshot;
  licenseKey: string;
  aiConfigured: boolean;
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
    api.setState({
      ...state,
      pages: state.pages.map((page) => ({
        ...page,
        crossFilter: undefined,
        filter: undefined,
      })),
    });
  }, []);
  const analyze = useCallback((next: InsightAnalysis) => {
    setAnalysis(next);
    const api = studioApi.current;
    if (!api) return;
    const state = api.getState();
    api.setState({
      ...state,
      pages: state.pages.map((page) => ({
        ...page,
        crossFilter: undefined,
        filter: undefined,
        widgets: { ...page.widgets, purchases: analysisWidget(next) },
      })),
    });
  }, []);
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
                guardrail: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 12 },
                outcomes: { xTrack: 0, yTrack: 12, xSpan: 24, ySpan: 12 },
                trend: { xTrack: 0, yTrack: 24, xSpan: 24, ySpan: 12 },
                purchases: { xTrack: 0, yTrack: 36, xSpan: 24, ySpan: 23 },
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
    () => ({ summary: snapshot.summary }),
    [snapshot.summary],
  );
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      ({ api }) =>
        createAiHarness(api as AgStudioApi, () => ({
          agents: [
            createInsightsAgent(api as AgStudioApi, {
              rows: () => datedRows,
              select: (next) => {
                setView(next);
                resetLinked();
              },
              analyze,
              plan: async (prompt, signal) => {
                const token = await shopify.idToken();
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
    [datedRows, shopify, analyze, resetLinked],
  );
  return (
    <AgStudioProvider
      licenseKey={licenseKey || undefined}
      modules={[AgStudioAiModule]}
    >
      <s-stack gap="base">
        <div className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>GUARDBUY / INSIGHTS</span>
            <h2>Every purchase. A clear explanation.</h2>
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
            data to inspect your store.
          </s-banner>
        )}
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
                Reset chart filters{linked ? " · active" : ""}
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
                  analyze(analysis);
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
                context={context}
                initialState={initialState}
                widgets={demo ? demoWidgets : widgets}
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
