import {
  useId,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type ButtonHTMLAttributes,
} from "react";
import styles from "./form-design.module.css";
export { styles as formStyles };
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <header className={styles.heading}>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
type Meta = {
  label: string;
  details?: string;
  error?: string;
  prefix?: string;
  suffix?: string;
};
export function FormField({
  label,
  details,
  error,
  prefix,
  suffix,
  ...props
}: Meta & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.control} data-error={Boolean(error)}>
        {prefix && <span className={styles.unit}>{prefix}</span>}
        <input
          {...props}
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={
            error ? `${id}-error` : details ? `${id}-hint` : undefined
          }
        />
        {suffix && <span className={styles.unit}>{suffix}</span>}
      </span>
      {details && (
        <span id={`${id}-hint`} className={styles.hint}>
          {details}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
export function FormSelect({
  label,
  details,
  error,
  children,
  ...props
}: Meta & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.control} data-error={Boolean(error)}>
        <select
          {...props}
          aria-label={label}
          aria-invalid={Boolean(error)}
          aria-describedby={
            error ? `${id}-error` : details ? `${id}-hint` : undefined
          }
        >
          {children}
        </select>
      </span>
      {details && (
        <span id={`${id}-hint`} className={styles.hint}>
          {details}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
export function FormCheck({
  label,
  details,
  ...props
}: {
  label: string;
  details?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.check}>
      <input {...props} type="checkbox" />
      <span>
        <strong>{label}</strong>
        {details && <small className={styles.hint}>{details}</small>}
      </span>
    </label>
  );
}
export function FormButton({
  secondary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className={styles.button}
      data-secondary={secondary}
    />
  );
}
