import { useMemo, useState } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import {
  AllCommunityModule,
  themeQuartz,
  type ColDef,
} from "ag-grid-community";
import type { FeedItem } from "../lib/audit/feed.server";
import { ago, FEED_LABEL, FEED_TONE } from "./ui";
import styles from "./activity-grid.module.css";

type EventRow = FeedItem & { when: string; verifyUrl?: string };
const theme = themeQuartz.withParams({
  fontFamily: "Arial, sans-serif",
  fontSize: 13,
  accentColor: "#007f5f",
  borderColor: "#dedede",
  backgroundColor: "#ffffff",
  headerBackgroundColor: "#f7f7f7",
  cellHorizontalPadding: 12,
});
function EventCell({ data }: CustomCellRendererProps<EventRow>) {
  if (!data) return null;
  return (
    <div className={styles.event}>
      <span>{data.title}</span>
      {(data.detail || data.verifyId || data.untrusted) && (
        <details>
          <summary>View details</summary>
          <div className={styles.details}>
            {data.detail && <p>{data.detail}</p>}
            {data.verifyId && (
              <a href={data.verifyUrl} target="_blank" rel="noreferrer">
                Verify this payment publicly
              </a>
            )}
            {data.untrusted && (
              <div className={styles.untrusted}>
                <strong>{data.untrustedLabel ?? "Untrusted text"}</strong>
                <p>{data.untrusted}</p>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
export default function ActivityGrid({
  feed,
  verifyBase,
}: {
  feed: FeedItem[];
  verifyBase: string | null;
}) {
  const [search, setSearch] = useState("");
  const rows = useMemo(
    () =>
      feed.map((item) => ({
        ...item,
        verifyId: verifyBase ? item.verifyId : undefined,
        verifyUrl:
          verifyBase && item.verifyId
            ? verifyBase + encodeURIComponent(item.verifyId)
            : undefined,
        when: ago(item.at, Date.now()),
      })),
    [feed, verifyBase],
  );
  const columns = useMemo<ColDef<EventRow>[]>(
    () => [
      {
        field: "title",
        getQuickFilterText: (p) =>
          [p.data?.title, p.data?.detail, p.data?.untrusted, p.data?.verifyId]
            .filter(Boolean)
            .join(" "),
        headerName: "Event",
        flex: 3,
        minWidth: 260,
        autoHeight: true,
        wrapText: true,
        cellRenderer: EventCell,
      },
      {
        field: "kind",
        headerName: "Type",
        width: 155,
        valueFormatter: (p) => FEED_LABEL[p.value] ?? "Activity",
        filterValueGetter: (p) => FEED_LABEL[p.data?.kind ?? ""] ?? "Activity",
        cellRenderer: ({ value }: CustomCellRendererProps<EventRow>) => (
          <s-badge tone={FEED_TONE[value] ?? "neutral"}>
            {FEED_LABEL[value] ?? "Activity"}
          </s-badge>
        ),
      },
      {
        field: "seq",
        headerName: "Entry",
        width: 95,
        valueFormatter: (p) => `#${p.value}`,
      },
      {
        field: "at",
        headerName: "When",
        width: 145,
        valueFormatter: (p) => ago(p.value, Date.now()),
      },
    ],
    [],
  );
  return (
    <div className={styles.wrap}>
      <label className={styles.search}>
        Search activity
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search events, reasons or payment references"
        />
      </label>
      <div className={styles.grid}>
        <AgGridReact<EventRow>
          modules={[AllCommunityModule]}
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          quickFilterText={search}
          getRowId={(p) => `${p.data.seq}-${p.data.kind}`}
          rowHeight={68}
          suppressCellFocus={false}
          ensureDomOrder={true}
          overlayNoRowsTemplate="No activity matches this search."
        />
      </div>
      <span className={styles.note}>
        Sort or filter column headings. Scroll across on smaller screens to see
        every column.
      </span>
    </div>
  );
}
