import { useState, useCallback, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, type GetRowIdParams } from "ag-grid-community";
import { gridTheme } from "./grid-theme";
import { GridLoadingOverlay } from "./loading-state";
import type { DataGridProps } from "./data-grid";
import styles from "./data-grid.module.css";
export default function DataGridClient<T>({
  rows,
  columns,
  label,
  rowId,
  height = 520,
  search = true,
  emptyMessage = "No records match these filters.",
}: DataGridProps<T>) {
  const idRef = useRef(rowId);
  idRef.current = rowId;
  const getRowId = useCallback(
    ({ data }: GetRowIdParams<T>) => idRef.current(data),
    [],
  );
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(rows.length);
  return (
    <div className={styles.wrapper} role="region" aria-label={label}>
      {search && (
        <div className={styles.toolbar}>
          <input
            type="search"
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span>
            {shown === rows.length
              ? `${rows.length} records`
              : `${shown} of ${rows.length} records`}
          </span>
        </div>
      )}
      <div style={{ height, minWidth: 0 }}>
        <AgGridReact<T>
          modules={[AllCommunityModule]}
          theme={gridTheme}
          rowData={rows}
          columnDefs={columns}
          getRowId={getRowId}
          quickFilterText={query}
          defaultColDef={{
            sortable: true,
            filter: true,
            resizable: true,
            minWidth: 110,
            wrapHeaderText: true,
            autoHeaderHeight: true,
          }}
          ensureDomOrder
          loadingOverlayComponent={GridLoadingOverlay}
          onFilterChanged={({ api }) => setShown(api.getDisplayedRowCount())}
          onRowDataUpdated={({ api }) => setShown(api.getDisplayedRowCount())}
          overlayNoRowsTemplate={emptyMessage}
        />
      </div>
    </div>
  );
}
