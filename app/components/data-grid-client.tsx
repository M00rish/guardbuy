import { useMatches } from "react-router";
import { MasterDetailModule, LicenseManager } from "ag-grid-enterprise";
import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  type GetRowIdParams,
  type IDetailCellRendererParams,
} from "ag-grid-community";
import { gridTheme } from "./grid-theme";
import { GridLoadingOverlay } from "./loading-state";
import type { DataGridProps } from "./data-grid";
import styles from "./data-grid.module.css";
export default function DataGridClient<T>({
  rows,
  revealRowId,
  renderDetail,
  isExpandable,
  columns,
  label,
  rowId,
  height = 520,
  search = true,
  emptyMessage = "No records match these filters.",
}: DataGridProps<T>) {
  const gridRef = useRef<AgGridReact<T>>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const update = () =>
      element.style.setProperty(
        "--guardbuy-detail-width",
        `${Math.max(0, element.clientWidth - 18)}px`,
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const revealRow = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed() || !revealRowId) return;
    const row = api.getRowNode(revealRowId);
    if (row) {
      row.setExpanded(true);
      api.ensureNodeVisible(row, "top");
    }
  }, [revealRowId]);
  useEffect(revealRow, [revealRow]);
  const matches = useMatches();
  const license = matches
    .map((m) => m.data as { gridLicenseKey?: string } | undefined)
    .find((d) => d?.gridLicenseKey)?.gridLicenseKey;
  if (license) LicenseManager.setLicenseKey(license);
  const gridColumns = useMemo(
    () =>
      columns.map((column, index) =>
        index === 0 && renderDetail
          ? {
              ...column,
              cellRenderer: "agGroupCellRenderer",
              cellRendererParams: {
                suppressCount: true,
                innerRenderer: column.cellRenderer,
              },
            }
          : column,
      ),
    [columns, renderDetail],
  );
  const detail = useCallback(
    ({ data }: IDetailCellRendererParams<T>) =>
      data ? <div className={styles.detail}>{renderDetail?.(data)}</div> : null,
    [renderDetail],
  );
  const idRef = useRef(rowId);
  idRef.current = rowId;
  const getRowId = useCallback(
    ({ data }: GetRowIdParams<T>) => idRef.current(data),
    [],
  );
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(rows.length);
  return (
    <div
      ref={wrapperRef}
      className={styles.wrapper}
      role="region"
      aria-label={label}
    >
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
          ref={gridRef}
          onFirstDataRendered={revealRow}
          modules={[AllCommunityModule, MasterDetailModule]}
          theme={gridTheme}
          rowData={rows}
          columnDefs={gridColumns}
          masterDetail={Boolean(renderDetail)}
          isRowMaster={(data) =>
            Boolean(data && (!isExpandable || isExpandable(data)))
          }
          detailCellRenderer={detail}
          detailRowAutoHeight
          keepDetailRows
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
