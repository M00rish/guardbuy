import { useEffect, useMemo, useState } from "react";
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
    <a href={`/app/activity?purchase=${seq}`}>#{seq} · View activity</a>
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
            categoryKey: [{ id: "trend.day" }],
            valueKey: [{ id: "trend.spent", aggregation: "sum" }],
          },
          format: {
            title: {
              enabled: true,
              typography: { fontSize: 16 },
              text: "Settled spend · last 7 days (UTC)",
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
            title: {
              enabled: true,
              typography: { fontSize: 16 },
              text: "Recorded purchases · open a purchase in Activity",
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
  snapshot,
  licenseKey,
  aiConfigured,
}: {
  snapshot: InsightsSnapshot;
  licenseKey: string;
  aiConfigured: boolean;
}) {
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
    () => snapshot.rows.filter((row) => inInsightView(row, view)),
    [snapshot.rows, view],
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
              rows: () => snapshot.rows,
              select: setView,
              plan: async (prompt, signal) => {
                const token = await shopify.idToken();
                const response = await fetch("/app/insights", {
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
              label: "Show pending purchases",
              prompt: "Show pending purchases",
            },
            {
              label: "Why were proposals blocked?",
              prompt: "Show blocked proposals and their reasons",
            },
            {
              label: "Show purchases needing attention",
              prompt: "Show purchases needing attention",
            },
          ],
        })),
    [snapshot.rows, shopify],
  );
  return (
    <AgStudioProvider
      licenseKey={licenseKey || undefined}
      modules={[AgStudioAiModule]}
    >
      <s-stack gap="base">
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
            <s-heading>Explore purchases</s-heading>
            <div className={styles.filters} aria-label="Purchase views">
              {INSIGHT_VIEWS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={view === id}
                  onClick={() => setView(id)}
                >
                  {VIEW_LABEL[id]}
                </button>
              ))}
            </div>
            <s-text>
              {VIEW_LABEL[view]} · {shown.length}{" "}
              {shown.length === 1 ? "purchase" : "purchases"}. Sort or
              cross-filter the table; select a purchase link for its full
              Activity history.
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
                key={narrow ? "mobile" : "desktop"}
                data={data}
                context={context}
                initialState={initialState}
                widgets={widgets}
                theme={theme}
                mode="edit"
                ai={aiConfigured ? ai : undefined}
                aiToolDisplay={{
                  show_purchases: { label: () => ({ text: "Show purchases" }) },
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
            <s-link href="/app/activity">View all activity</s-link>
          </s-stack>
        </s-section>
      </s-stack>
    </AgStudioProvider>
  );
}
