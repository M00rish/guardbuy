import { Link } from "react-router";
import styles from "./view-tabs.module.css";
export function ViewTabs<T extends string>({
  label,
  options,
  value,
  onChange,
  panelId,
}: {
  label: string;
  options: { id: T; label: string; href?: string }[];
  value: T;
  onChange?: (id: T) => void;
  panelId?: string;
}) {
  const links = options.every((o) => o.href);
  return (
    <nav className={styles.navigation} aria-label={label}>
      <div
        className={styles.track}
        role={links ? undefined : "tablist"}
        aria-label={links ? undefined : label}
      >
        {options.map((o) =>
          o.href ? (
            <Link
              key={o.id}
              to={o.href}
              className={styles.item}
              aria-current={value === o.id ? "page" : undefined}
            >
              {o.label}
            </Link>
          ) : (
            <button
              key={o.id}
              id={`tab-${o.id}`}
              className={styles.item}
              type="button"
              role="tab"
              aria-selected={value === o.id}
              aria-controls={panelId}
              tabIndex={value === o.id ? 0 : -1}
              onClick={() => onChange?.(o.id)}
              onKeyDown={(e) => {
                const index = options.findIndex((item) => item.id === o.id);
                const next =
                  e.key === "ArrowRight"
                    ? (index + 1) % options.length
                    : e.key === "ArrowLeft"
                      ? (index + options.length - 1) % options.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? options.length - 1
                          : -1;
                if (next < 0) return;
                e.preventDefault();
                onChange?.(options[next].id);
                const buttons =
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  );
                buttons?.[next]?.focus();
              }}
            >
              {o.label}
            </button>
          ),
        )}
      </div>
    </nav>
  );
}
export function ViewFilter<T extends string>({
  options,
  value,
  onChange,
  label = "Show",
}: {
  options: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  return (
    <label className={styles.filter}>
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {o.count === undefined ? "" : ` (${o.count})`}
          </option>
        ))}
      </select>
    </label>
  );
}
