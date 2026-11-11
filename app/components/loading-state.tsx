import styles from "./loading-state.module.css";
export function LoadingState({
  label = "Loading data",
  height = 360,
  compact = false,
}: {
  label?: string;
  height?: number;
  compact?: boolean;
}) {
  return (
    <div
      className={`${styles.loading} ${compact ? styles.compact : ""}`}
      style={compact ? undefined : { height }}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className={styles.srOnly}>{label}</span>
      {compact ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : (
        <div className={styles.skeleton} aria-hidden="true">
          <div className={styles.toolbar}>
            <i />
            <i />
          </div>
          <div className={styles.header}>
            {[0, 1, 2, 3].map((i) => (
              <i key={i} />
            ))}
          </div>
          {Array.from({ length: 8 }, (_, i) => (
            <div className={styles.row} key={i}>
              {[0, 1, 2, 3].map((j) => (
                <i
                  key={j}
                  style={{ width: `${(i + j) % 3 === 0 ? 48 : 72}%` }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
export function GridLoadingOverlay() {
  return <LoadingState compact label="Loading table data" />;
}
export function LoadingProgress() {
  return (
    <div
      className={styles.progress}
      role="progressbar"
      aria-label="Loading GuardBuy data"
    >
      <i />
    </div>
  );
}
