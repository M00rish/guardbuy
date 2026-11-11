import { useMemo } from "react";
import type { CustomCellRendererProps } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { DataGrid, GridBadge } from "./data-grid";
import type { FeedItem } from "../lib/audit/feed.server";
import { ago, FEED_LABEL, FEED_TONE } from "./ui";
import styles from "./activity-grid.module.css";

type EventRow = FeedItem & { when: string; verifyUrl?: string };
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
          <GridBadge tone={FEED_TONE[value] ?? "neutral"}>
            {FEED_LABEL[value] ?? "Activity"}
          </GridBadge>
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
    <DataGrid<EventRow>
      label="Activity"
      rows={rows}
      columns={columns}
      rowId={(row) => `${row.seq}-${row.kind}`}
      height={640}
      emptyMessage="No activity matches these filters."
    />
  );
}
