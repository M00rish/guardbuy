import type { InsightsSnapshot } from "./types";
import type { HomeWorkspaceData, WorkspaceProduct } from "./workspace";
import {
  ATTENTION_LANES,
  ATTENTION_LABEL,
  type AttentionLane,
} from "./attention";
export type OverviewSelection =
  | { view: "products"; variantIds: string[]; label: string }
  | { view: "purchases"; purchaseIds: number[]; label: string }
  | { view: "details"; label: string };
export type RiskRow = WorkspaceProduct & { days: number; caption: string };
export type AttentionCell = {
  supplier: string;
  lane: AttentionLane;
  label: string;
  count: number;
  amountCents: number;
  purchaseIds: number[];
  oldestAt: string | null;
};
export function overviewModel(
  snapshot: InsightsSnapshot,
  workspace: HomeWorkspaceData,
) {
  const { capCents, spentCents, reservedCents } = workspace.summary;
  const headroomCents = capCents - spentCents - reservedCents;
  const now = Date.parse(snapshot.checkedAt);
  const spentIds = snapshot.rows
    .filter(
      (r) =>
        r.settled > 0 &&
        r.settledAt &&
        Date.parse(r.settledAt) > now - 7 * 86400000 &&
        Date.parse(r.settledAt) <= now,
    )
    .map((r) => r.purchase);
  const reservedIds = snapshot.rows
    .filter((r) => r.reserved > 0)
    .map((r) => r.purchase);
  const managed = workspace.products?.filter((p) => p.managed) ?? [];
  const threshold = workspace.policy?.reorderBelowDays ?? null;
  const known = managed.filter((p) => p.stock <= 0 || p.cover !== null);
  const urgent = known.filter(
    (p) =>
      p.stock <= 0 ||
      (threshold !== null && p.cover !== null && p.cover < threshold),
  );
  const risk: RiskRow[] = [...known]
    .sort(
      (a, b) =>
        (a.stock <= 0 ? 0 : 1) - (b.stock <= 0 ? 0 : 1) ||
        (a.cover ?? 0) - (b.cover ?? 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 8)
    .map((p) => ({
      ...p,
      days: p.stock <= 0 ? 0 : Math.max(0, p.cover ?? 0),
      caption: p.title,
    }));
  const unknown = managed.filter((p) => p.stock > 0 && p.cover === null);
  const outstanding = snapshot.rows.filter((r) => !!r.attentionState);
  const suppliers = [...new Set(outstanding.map((r) => r.supplier))].sort(
    (a, b) =>
      outstanding.filter((r) => r.supplier === b).length -
        outstanding.filter((r) => r.supplier === a).length ||
      a.localeCompare(b),
  );
  const visibleSuppliers = suppliers.slice(0, 6);
  const cells: AttentionCell[] = visibleSuppliers.flatMap((supplier) =>
    ATTENTION_LANES.map((lane) => {
      const rows = outstanding.filter(
        (r) => r.supplier === supplier && r.attentionState === lane,
      );
      return {
        supplier,
        lane,
        label: ATTENTION_LABEL[lane],
        count: rows.length,
        amountCents: rows.reduce((s, r) => s + Math.round(r.amount * 100), 0),
        purchaseIds: rows.map((r) => r.purchase),
        oldestAt: rows.map((r) => r.proposedAt).sort()[0] ?? null,
      };
    }),
  );
  return {
    budget: {
      capCents,
      spentCents,
      reservedCents,
      headroomCents,
      configured: !!workspace.policy,
      spentIds,
      reservedIds,
      steps: [
        { label: "Cap", value: capCents / 100, key: "cap" },
        { label: "Spent · 7d", value: -spentCents / 100, key: "spent" },
        { label: "Reserved", value: -reservedCents / 100, key: "reserved" },
      ],
    },
    stock: {
      risk,
      urgent,
      unknown,
      threshold,
      managedCount: managed.length,
      disabledCount: (workspace.products ?? []).filter((p) => !p.managed)
        .length,
      unavailable: workspace.products === null,
    },
    attention: {
      cells,
      total: outstanding.length,
      suppliers: suppliers.length,
      hiddenSuppliers: Math.max(0, suppliers.length - visibleSuppliers.length),
      purchaseIds: outstanding.map((r) => r.purchase),
      byLane: ATTENTION_LANES.map((lane) => ({
        lane,
        label: ATTENTION_LABEL[lane],
        purchaseIds: outstanding
          .filter((r) => r.attentionState === lane)
          .map((r) => r.purchase),
      })),
    },
  };
}
export type OverviewModel = ReturnType<typeof overviewModel>;
