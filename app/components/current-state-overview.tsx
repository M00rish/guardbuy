import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRevalidator } from "react-router";
import {
  AgCharts,
  ModuleRegistry,
  AllEnterpriseModule,
  LicenseManager,
  type AgChartOptions,
} from "ag-charts-enterprise";
import {
  AgStudio,
  createWidgets,
  type AgWidgetDefinition,
} from "ag-studio-react";
import {
  studioTheme,
  type AgCoreDefaultRegistry,
  type AgReportState,
  type AgWidgetData,
  type AgWidgetDataFormat,
  type AgWidgetParams,
} from "ag-studio";
import {
  overviewModel,
  type OverviewModel,
  type OverviewSelection,
  type AttentionCell,
} from "../lib/insights/overview";
import type { InsightsSnapshot } from "../lib/insights/types";
import type { HomeWorkspaceData } from "../lib/insights/workspace";
import { usd, readableTime } from "../lib/format";
import styles from "./current-state-overview.module.css";

ModuleRegistry.registerModules([AllEnterpriseModule]);
type OverviewContext = {
  model: OverviewModel;
  narrow: boolean;
  gridLicenseKey: string;
  snapshot: InsightsSnapshot;
  workspace: HomeWorkspaceData;
  demo: boolean;
  onSelect: (selection: OverviewSelection) => void;
};
function createStore(initial: OverviewContext) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: OverviewContext) => {
      value = next;
      listeners.forEach((l) => l());
    },
  };
}
type OverviewStore = ReturnType<typeof createStore>;
type OverviewData = AgWidgetData<
  Record<string, never>,
  AgWidgetDataFormat<Record<string, never>>
> & { type: "guardbuy-overview" };
interface OverviewRegistry extends Omit<AgCoreDefaultRegistry, "widgets"> {
  widgets: readonly (
    | AgCoreDefaultRegistry["widgets"][number]
    | AgWidgetDefinition<"guardbuy-overview", OverviewData>
  )[];
}
const palette = {
  ink: "#183e35",
  muted: "#6a7c73",
  green: "#007f65",
  amber: "#bc7914",
  red: "#bc4149",
  line: "#e5ece7",
};
const base: AgChartOptions = {
  background: { fill: "transparent" },
  padding: { top: 20, right: 20, bottom: 8, left: 8 },
  animation: { enabled: false },
  legend: { enabled: false },
  theme: {
    baseTheme: "ag-default",
    params: {
      fontFamily: "Arial, sans-serif",
      foregroundColor: palette.ink,
      backgroundColor: "#ffffff",
      accentColor: palette.green,
    },
  },
};
function Chart({
  options,
  label,
  license,
}: {
  options: AgChartOptions;
  label: string;
  license: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let chart: ReturnType<typeof AgCharts.create> | undefined;
    let disposed = false;
    let width = Math.max(1, element.clientWidth),
      height = Math.max(1, element.clientHeight);
    try {
      if (license) LicenseManager.setLicenseKey(license);
      chart = AgCharts.create({
        ...options,
        container: element,
        width,
        height,
      });
      setFailed(false);
    } catch {
      setFailed(true);
    }
    const observer = new ResizeObserver(() => {
      const nextWidth = Math.max(1, element.clientWidth),
        nextHeight = Math.max(1, element.clientHeight);
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      void chart
        ?.update({ ...options, container: element, width, height })
        .catch(() => {
          if (!disposed) setFailed(true);
        });
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      chart?.destroy();
    };
  }, [options, license]);
  return (
    <div
      className={styles.plot}
      role="group"
      aria-label={label}
      ref={container}
    >
      {failed && (
        <p className={styles.empty}>
          Chart unavailable. Use the records below.
        </p>
      )}
    </div>
  );
}
function shortMoney(dollars: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(dollars);
}
const colours: Record<AttentionCell["lane"], string> = {
  approval: palette.amber,
  pending: palette.amber,
  uncertain: palette.red,
  failed: palette.red,
  blocked: palette.red,
};
function cellFill(cell: AttentionCell, max: number) {
  if (!cell.count) return "#f0f4f1";
  const t = 0.25 + (0.65 * cell.count) / Math.max(1, max);
  const rgb = colours[cell.lane]
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16));
  return `rgb(${rgb.map((v) => Math.round(255 + (v - 255) * t)).join(",")})`;
}
function OverviewWidget({
  context,
}: AgWidgetParams<OverviewData, unknown, { store: OverviewStore }>) {
  const c = useSyncExternalStore(
    context.store.subscribe,
    context.store.getSnapshot,
  );
  const { budget, stock, attention } = c.model;
  const choose = c.onSelect;
  const budgetOptions = useMemo<AgChartOptions>(
    () => ({
      ...base,
      data: budget.steps,
      axes: {
        x: { type: "category", position: "bottom", label: { fontSize: 11 } },
        y: {
          type: "number",
          position: "left",
          label: {
            fontSize: 10,
            formatter: ({ value }) => shortMoney(Number(value)),
          },
          gridLine: { style: [{ stroke: palette.line, lineDash: [3, 3] }] },
        },
      },
      series: [
        {
          type: "waterfall",
          xKey: "label",
          yKey: "value",
          totals: [
            {
              totalType: "total",
              index: 2,
              axisLabel: budget.headroomCents < 0 ? "Over cap" : "Available",
              itemId: "headroom",
            },
          ],
          item: {
            positive: { fill: "#b8cec4", strokeWidth: 0 },
            negative: {
              fill: "#cfdfd6",
              strokeWidth: 0,
              itemStyler: ({ datum }) => ({
                fill: datum.key === "reserved" ? "#d9a34e" : "#5b9e89",
              }),
            },
            total: {
              fill: budget.headroomCents < 0 ? palette.red : palette.green,
              strokeWidth: 0,
            },
          },
          label: {
            enabled: true,
            fontSize: 11,
            color: palette.ink,
            placement: ["outside-end", "inside-center"],
            formatter: ({ value, totalValue }) =>
              shortMoney(Number(totalValue ?? value)),
          },
          tooltip: {
            renderer: ({ datum, totalValue, itemType }) => ({
              title: itemType === "total" ? "Budget headroom" : datum.label,
              data: [
                {
                  label:
                    itemType === "total" ? "Cap − spent − reserved" : "Amount",
                  value: usd(
                    Math.round(Number(totalValue ?? datum.value) * 100),
                  ),
                },
              ],
            }),
          },
          listeners: {
            seriesNodeClick: ({ datum, itemId }) => {
              if (itemId === "headroom" || datum?.key === "cap")
                choose({ view: "details", label: "Signed spending rules" });
              else
                choose({
                  view: "purchases",
                  purchaseIds:
                    datum?.key === "spent"
                      ? budget.spentIds
                      : budget.reservedIds,
                  label:
                    datum?.key === "spent"
                      ? "Settled in the last 7 days"
                      : "Current reservations",
                });
            },
          },
        },
      ],
    }),
    [budget, choose],
  );
  const stockOptions = useMemo<AgChartOptions>(
    () => ({
      ...base,
      data: stock.risk,
      padding: { top: 18, right: 30, bottom: 8, left: 0 },
      axes: {
        x: {
          type: "number",
          position: "bottom",
          min: 0,
          max:
            Math.max(
              1,
              ...stock.risk.map((p) => p.days),
              stock.threshold ?? 0,
            ) * 1.16,
          label: { fontSize: 10, formatter: ({ value }) => `${value}d` },
          gridLine: { style: [{ stroke: palette.line, lineDash: [3, 3] }] },
          crossLines:
            stock.threshold === null
              ? []
              : [
                  {
                    type: "line",
                    value: stock.threshold,
                    stroke: palette.amber,
                    strokeWidth: 1.5,
                    lineDash: [4, 3],
                    label: {
                      text: `Restock < ${stock.threshold}d`,
                      placement: "top",
                      fontSize: 10,
                      color: palette.amber,
                    },
                  },
                ],
        },
        y: {
          type: "category",
          position: "left",
          label: {
            fontSize: 11,
            maxWidth: c.narrow ? 112 : 155,
            formatter: ({ value }) =>
              stock.risk.find((p) => p.variantId === value)?.title ??
              String(value),
          },
        },
      },
      series: [
        {
          type: "bar",
          direction: "horizontal",
          xKey: "variantId",
          yKey: "days",
          cornerRadius: 4,
          itemStyler: ({ datum }) => ({
            fill:
              datum.stock <= 0
                ? palette.red
                : stock.threshold !== null && datum.days < stock.threshold
                  ? "#d9a34e"
                  : "#6fa994",
            strokeWidth: 0,
          }),
          label: {
            enabled: true,
            placement: "outside-end",
            fontSize: 11,
            formatter: ({ datum }) =>
              datum.stock <= 0 ? "Out" : `${datum.days}d`,
          },
          tooltip: {
            renderer: ({ datum }) => ({
              title: datum.title,
              data: [
                {
                  label: "Days of cover",
                  value:
                    datum.stock <= 0 ? "Out of stock" : `${datum.days} days`,
                },
                { label: "On hand", value: String(datum.stock) },
                { label: "Incoming", value: `${datum.incoming} units` },
                { label: "Product", value: datum.sku ?? datum.variantId },
                { label: "Restock status", value: datum.cooldown ? `Declined purchase #${datum.cooldown.decisionSeq}; paused until you reset it` : datum.status.label },
              ],
            }),
          },
          listeners: {
            seriesNodeClick: ({ datum }) =>
              choose({
                view: "products",
                variantIds: [datum.variantId],
                label: `Stock: ${datum.title}`,
              }),
          },
        },
      ],
    }),
    [stock, c.narrow, choose],
  );
  const heatmapOptions = useMemo<AgChartOptions>(() => {
    const max = Math.max(1, ...attention.cells.map((cell) => cell.count));
    return {
      ...base,
      data: attention.cells,
      padding: { top: 12, right: 8, bottom: 8, left: 0 },
      gradientLegend: { enabled: false },
      axes: {
        x: {
          type: "category",
          position: "bottom",
          label: {
            fontSize: c.narrow ? 9 : 10,
            autoRotate: false,
            avoidCollisions: false,
            minSpacing: 0,
            maxWidth: c.narrow ? 42 : 100,
            wrapping: "always",
          },
        },
        y: {
          type: "category",
          position: "left",
          label: { fontSize: 11, maxWidth: c.narrow ? 95 : 140 },
        },
      },
      series: [
        {
          type: "heatmap",
          xKey: "label",
          yKey: "supplier",
          colorKey: "count",
          colorName: "Items",
          stroke: "#ffffff",
          strokeWidth: 5,
          cornerRadius: 6,
          itemStyler: ({ datum }) => ({ fill: cellFill(datum, max) }),
          label: {
            enabled: true,
            fontSize: 15,
            fontWeight: 600,
            formatter: ({ datum }) => String(datum.count),
            itemStyler: ({ datum }) => ({
              color: datum.count / max > 0.65 ? "#ffffff" : palette.ink,
            }),
          },
          tooltip: {
            renderer: ({ datum }) => ({
              title: `${datum.supplier} · ${datum.label}`,
              data: [
                { label: "Items", value: String(datum.count) },
                { label: "Proposal value", value: usd(datum.amountCents) },
                ...(datum.oldestAt
                  ? [
                      {
                        label: "Oldest proposal",
                        value: readableTime(datum.oldestAt),
                      },
                    ]
                  : []),
              ],
            }),
          },
          listeners: {
            seriesNodeClick: ({ datum }) => {
              if (datum.count)
                choose({
                  view: "purchases",
                  purchaseIds: datum.purchaseIds,
                  label: `${datum.supplier} · ${datum.label}`,
                });
            },
          },
        },
      ],
    };
  }, [attention, c.narrow, choose]);
  return (
    <div className={styles.overview}>
      <section
        className={`${styles.panel} ${styles.budget}`}
        aria-labelledby="budget-title"
      >
        <div className={styles.budgetCopy}>
          <span className={styles.eyebrow}>PURCHASING POWER</span>
          <h3 id="budget-title">
            {!budget.configured
              ? "Set your purchasing budget"
              : budget.headroomCents < 0
                ? "Spending cap exceeded"
                : "Room for the next restock"}
          </h3>
          <strong
            className={`${styles.headline} ${budget.headroomCents < 0 ? styles.danger : ""}`}
          >
            {budget.configured
              ? usd(Math.abs(budget.headroomCents))
              : "Not configured"}
          </strong>
          <p>
            {budget.configured
              ? budget.headroomCents < 0
                ? "over your signed cap"
                : "available after current commitments"
              : "Sign your spending rules to set a budget."}
          </p>
          <div className={styles.cash}>
            PayPal after commitments{" "}
            <b>
              {c.workspace.summary.balanceCents === null
                ? "Unavailable"
                : usd(c.workspace.summary.balanceCents)}
            </b>
          </div>
          <button
            type="button"
            onClick={() =>
              choose({ view: "details", label: "Signed spending rules" })
            }
          >
            View spending rules
          </button>
        </div>
        <div className={styles.budgetChart}>
          {budget.configured ? (
            <Chart
              options={budgetOptions}
              label="Budget waterfall: cap minus settled spending and current reservations"
              license={c.gridLicenseKey}
            />
          ) : (
            <p className={styles.empty}>No signed spending cap</p>
          )}
          <div className={styles.legend}>
            <span>
              <i style={{ background: "#5b9e89" }} />
              Settled · rolling 7 days
            </span>
            <span>
              <i style={{ background: "#d9a34e" }} />
              Reserved · current
            </span>
          </div>
        </div>
      </section>
      <section className={styles.panel} aria-labelledby="stock-title">
        <div className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>INVENTORY HEALTH</span>
            <h3 id="stock-title">
              {stock.unavailable
                ? "Stock data unavailable"
                : stock.urgent.length
                  ? `${stock.urgent.length} ${stock.urgent.length === 1 ? "product needs" : "products need"} restocking`
                  : "Stock cover, at a glance"}
            </h3>
          </div>
          <span className={styles.tag}>{stock.managedCount} on</span>
        </div>
        <p className={styles.description}>
          Lowest cover first ·{" "}
          {stock.threshold === null
            ? "restock threshold not configured"
            : `restock below ${stock.threshold} days`}{" "}
          · up to 8 products
        </p>
        <div className={styles.stockChart}>
          {stock.risk.length ? (
            <Chart
              options={stockOptions}
              label="Managed products ranked by days of stock cover"
              license={c.gridLicenseKey}
            />
          ) : (
            <p className={styles.empty}>
              {stock.unavailable
                ? "Refresh to retry the product snapshot."
                : stock.unknown.length
                  ? "Sales velocity is unavailable for these products."
                  : "No products with automatic restocking switched on."}
            </p>
          )}
        </div>
        <div className={styles.panelFooter}>
          <button
            type="button"
            disabled={!stock.urgent.length}
            onClick={() =>
              choose({
                view: "products",
                variantIds: stock.urgent.map((p) => p.variantId),
                label: "Products below the restock threshold",
              })
            }
          >
            View {stock.urgent.length} at risk
          </button>
          {stock.cooldowns.length > 0 ? (
            <button type="button" onClick={() => choose({ view: "products", variantIds: stock.cooldowns.map(p => p.variantId), label: "Restocking paused after a decline · expand a product to reset its cooldown" })}>
              {stock.cooldowns.length} restock{stock.cooldowns.length === 1 ? "" : "s"} paused · review cooldown
            </button>
          ) : stock.unknown.length > 0 ? (
            <button
              type="button"
              onClick={() =>
                choose({
                  view: "products",
                  variantIds: stock.unknown.map((p) => p.variantId),
                  label: "Products with unknown stock cover",
                })
              }
            >
              {stock.unknown.length} unknown cover
            </button>
          ) : (
            <span>{stock.disabledCount} switched off</span>
          )}
        </div>
      </section>
      <section className={styles.panel} aria-labelledby="attention-title">
        <div className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>WHAT NEEDS ATTENTION</span>
            <h3 id="attention-title">
              {attention.total
                ? `${attention.total} ${attention.total === 1 ? "item" : "items"} to review`
                : "No outstanding purchase issues"}
            </h3>
          </div>
          <span
            className={`${styles.tag} ${attention.total ? styles.warning : ""}`}
          >
            {attention.suppliers}{" "}
            {attention.suppliers === 1 ? "supplier" : "suppliers"}
          </span>
        </div>
        <p className={styles.description}>
          Open approvals & payments · latest recorded blocks · darker = more
          items
        </p>
        <div className={styles.attentionChart}>
          {attention.total ? (
            <Chart
              options={heatmapOptions}
              label="Outstanding purchases by supplier and current action; numbers are item counts"
              license={c.gridLicenseKey}
            />
          ) : (
            <div className={styles.empty}>
              <span className={styles.check} aria-hidden="true">
                ✓
              </span>
              <strong>Nothing waiting on you</strong>
              <p>Resolved and historical issues stay in Activity.</p>
            </div>
          )}
        </div>
        <div className={styles.panelFooter}>
          <button
            type="button"
            disabled={!attention.total}
            onClick={() =>
              choose({
                view: "purchases",
                purchaseIds: attention.purchaseIds,
                label: "Outstanding purchases and latest blocks",
              })
            }
          >
            View all {attention.total}{" "}
            {attention.total === 1 ? "item" : "items"}
          </button>
          {attention.total > 0 && (
            <select
              aria-label="Show attention category in grid"
              defaultValue=""
              onChange={(e) => {
                const lane = attention.byLane.find(
                  (l) => l.lane === e.target.value,
                );
                if (lane)
                  choose({
                    view: "purchases",
                    purchaseIds: lane.purchaseIds,
                    label: `Current ${lane.label.toLowerCase()} purchases`,
                  });
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                By action…
              </option>
              {attention.byLane.map((l) => (
                <option key={l.lane} value={l.lane}>
                  {l.label} ({l.purchaseIds.length})
                </option>
              ))}
            </select>
          )}
        </div>
        {attention.hiddenSuppliers > 0 && (
          <p className={styles.more}>
            Top 6 suppliers shown · View all includes{" "}
            {attention.hiddenSuppliers} more.
          </p>
        )}
      </section>
    </div>
  );
}
const widgets = createWidgets<OverviewRegistry>({
  additionalTypes: [
    {
      id: "guardbuy-overview",
      label: "Current store overview",
      comp: OverviewWidget,
      dataMapping: {},
      form: (p) => p.createDefaults({ dataMappingItems: [] }),
      defaultSize: { width: 1200, height: 610 },
      minSize: { width: 260, height: 610 },
    },
  ],
});
const theme = studioTheme.withParams({
  backgroundColor: "#ffffff",
  foregroundColor: palette.ink,
  accentColor: palette.green,
  borderColor: "#ffffff",
  spacing: 0,
  fontFamily: "Arial, sans-serif",
});
export default function CurrentStateOverview(
  props: Omit<OverviewContext, "model">,
) {
  const revalidator = useRevalidator();
  const refreshing = revalidator.state !== "idle";
  const model = useMemo(
    () => overviewModel(props.snapshot, props.workspace),
    [props.snapshot, props.workspace],
  );
  const value = { ...props, model };
  const [store] = useState(() => createStore(value));
  useLayoutEffect(() => store.update(value));
  const height = props.narrow ? 1100 : 640;
  const state = useMemo<AgReportState<OverviewRegistry>>(
    () => ({
      selectedPageId: "now",
      panels: {
        ai: { collapsed: true },
        edit: { collapsed: true },
        data: { collapsed: true },
        filters: { collapsed: true },
      },
      pages: [
        {
          id: "now",
          layout: {
            minWidth: 260,
            rowHeight: 20,
            columns: 24,
            pagePadding: 0,
            widgetPadding: 0,
            widgetBorderEnabled: false,
            backgroundColor: "#ffffff",
          },
          widgets: { overview: { type: "guardbuy-overview", dataMapping: {} } },
          widgetLayout: {
            overview: {
              xTrack: 0,
              yTrack: 0,
              xSpan: 24,
              ySpan: (height - 20) / 20,
            },
          },
        },
      ],
    }),
    [height],
  );
  return (
    <section
      id="store-overview"
      className={styles.wrapper}
      aria-label="Current store overview"
    >
      <div className={styles.scope}>
        <span>
          {props.demo ? "Fictional demo" : "Live snapshot"} ·{" "}
          {readableTime(props.snapshot.checkedAt)} · store-wide totals
        </span>
        {!props.demo && (
          <button type="button" disabled={refreshing} aria-busy={refreshing} onClick={() => revalidator.revalidate()}>
            {refreshing ? "Refreshing…" : "Refresh snapshot"}
          </button>
        )}
      </div>
      <div style={{ height }}>
        <AgStudio<OverviewRegistry>
          key={props.narrow ? "narrow" : "wide"}
          data={{ sources: [] }}
          context={{ store }}
          widgets={widgets}
          initialState={state}
          theme={theme}
          mode="view"
          style={{ height: "100%", width: "100%" }}
        />
      </div>
    </section>
  );
}
