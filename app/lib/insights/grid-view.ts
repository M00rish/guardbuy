import type { GridApi } from "ag-grid-community";
import { z } from "zod";
import type { InsightRow } from "./types";
import type { InsightAnalysis } from "./plan";

export type PurchaseGridSnapshot = {
  rows: InsightRow[];
  allRows: InsightRow[];
  analysis: InsightAnalysis;
  demo: boolean;
  storageKey: string;
  checkedAt: string;
  gridLicenseKey: string;
  search?: string;
  compact?: boolean;
  narrow?: boolean;
  onReady?: (api: GridApi<InsightRow> | undefined) => void;
};
// Studio's context is initial-only. The widget subscribes explicitly so date,
// view and AI changes always read the current, correctly scoped snapshot.
export function createPurchaseGridStore(initial: PurchaseGridSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: PurchaseGridSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}
export type PurchaseGridStore = ReturnType<typeof createPurchaseGridStore>;

const columnId = z
  .string()
  .refine(
    (id) =>
      [
        "purchase",
        "product",
        "supplier",
        "status",
        "amount",
        "settled",
        "reserved",
        "history",
        "proposedAt",
        "title",
        "sku",
        "stock",
        "incoming",
        "cover",
        "managed",
        "state",
        "at",
        "kind",
        "category",
        "setting",
        "value",
      ].includes(id) || id.startsWith("ag-Grid-AutoColumn"),
  );
// Persist only presentation state, never rows, payment details or licence keys.
export const SavedGridViewSchema = z.object({
  version: z.literal(1),
  columns: z
    .array(
      z.object({
        colId: columnId,
        hide: z.boolean().nullable().optional(),
        width: z.number().min(40).max(10000).optional(),
        flex: z.number().min(0).max(100).nullable().optional(),
        sort: z.enum(["asc", "desc"]).nullable().optional(),
        sortIndex: z.number().int().min(0).nullable().optional(),
        pinned: z.enum(["left", "right"]).nullable().optional(),
        rowGroup: z.boolean().nullable().optional(),
        rowGroupIndex: z.number().int().min(0).nullable().optional(),
        pivot: z.boolean().nullable().optional(),
        pivotIndex: z.number().int().min(0).nullable().optional(),
        aggFunc: z.literal("sum").nullable().optional(),
      }),
    )
    .min(1)
    .max(30),
  filters: z.record(z.string(), z.unknown()),
  pivot: z.boolean(),
  search: z.string().max(800),
});
export function parseSavedGridView(raw: string) {
  if (raw.length > 100_000) throw new Error("Saved view is too large");
  return SavedGridViewSchema.parse(JSON.parse(raw));
}

// Each series is 28 UTC calendar days including the snapshot day. These are
// proposal values, independent of chart/column filters, never sales or spend.
export function supplierProposalHistory(rows: InsightRow[], checkedAt: string) {
  const map = new Map<string, number[]>();
  const last = Date.parse(checkedAt.slice(0, 10) + "T00:00:00Z");
  for (const row of rows) {
    const day =
      27 -
      Math.floor(
        (last - Date.parse(row.proposedAt.slice(0, 10) + "T00:00:00Z")) /
          86400000,
      );
    if (!Number.isInteger(day) || day < 0 || day > 27) continue;
    const values = map.get(row.supplier) ?? Array<number>(28).fill(0);
    // Sum cents to avoid cumulative floating-point drift in daily values.
    values[day] =
      (Math.round(values[day] * 100) + Math.round(row.amount * 100)) / 100;
    map.set(row.supplier, values);
  }
  return map;
}
