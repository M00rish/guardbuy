import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColDef } from "ag-grid-community";
import type { CustomCellRendererProps } from "ag-grid-react";
import { LoadingState } from "./loading-state";
import styles from "./data-grid.module.css";
export type DataGridProps<T> = {
  rows: T[];
  columns: ColDef<T>[];
  label: string;
  rowId: (row: T) => string;
  height?: number;
  search?: boolean;
  renderDetail?: (row: T) => ReactNode;
  isExpandable?: (row: T) => boolean;
  emptyMessage?: string;
};
const Client = lazy(() => import("./data-grid-client")) as <T>(
  props: DataGridProps<T>,
) => ReactElement;
export function DataGrid<T>(props: DataGridProps<T>) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const height =
    props.height ?? Math.max(280, Math.min(640, props.rows.length * 44 + 106));
  return mounted ? (
    <Suspense
      fallback={
        <LoadingState
          height={height + (props.search === false ? 0 : 58)}
          label={`Loading ${props.label.toLowerCase()}`}
        />
      }
    >
      <Client {...props} height={height} />
    </Suspense>
  ) : (
    <LoadingState
      height={height + (props.search === false ? 0 : 58)}
      label={`Loading ${props.label.toLowerCase()}`}
    />
  );
}
export const cell =
  <T,>(render: (row: T) => ReactNode) =>
  (params: CustomCellRendererProps<T>) =>
    params.data ? render(params.data) : null;
/** Server-formatted USD strings remain display strings but sort by monetary value. */
export const compareMoney = (a: string, b: string) =>
  Number(a.replace(/[^\d.-]/g, "")) - Number(b.replace(/[^\d.-]/g, ""));
export function GridBadge({
  tone = "neutral",
  children,
  title,
}: {
  title?: string;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <span className={styles.badge} data-tone={tone} title={title}>
      {children}
    </span>
  );
}
