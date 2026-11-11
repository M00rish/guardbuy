import type { GridApi } from "ag-grid-community";
import type { QueryGrid } from "./query";
export const PRODUCT_ANALYTIC_COLUMNS = [
  "automaticRestocks",
  "paidRestocks",
  "purchaseCount",
  "amount",
  "settled",
  "reserved",
  "blocked",
];
/** Presentation only: never calls a merchant action or changes a store record. */
export function applyQueryToGrid(
  api: GridApi<unknown>,
  grid: QueryGrid,
  narrow = false,
) {
  if (api.isDestroyed()) return;
  if (grid.view === "products") {
    api.setColumnsVisible(PRODUCT_ANALYTIC_COLUMNS, false);
    api.setColumnsVisible(["state", "stock"], true);
    if (narrow && grid.columns?.length)
      api.setColumnsVisible(["state", "stock"], false);
  }
  for (const field of grid.columns ?? [])
    if (api.getColumn(field)) {
      api.setColumnsVisible([field], true);
      if (grid.view === "products") api.moveColumns([field], 1);
    }
  if (grid.sort && api.getColumn(grid.sort.field))
    api.applyColumnState({
      defaultState: { sort: null },
      state: [{ colId: grid.sort.field, sort: grid.sort.direction }],
    });
  if (grid.expandPurchase !== undefined)
    api.getRowNode(String(grid.expandPurchase))?.setExpanded(true);
}
