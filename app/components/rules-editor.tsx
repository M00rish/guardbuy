import styles from "./rules-workspace.module.css";
import { FormField, FormButton } from "./form-design";
import { DataGrid, cell, compareMoney, GridBadge } from "./data-grid";
import { COPY } from "../lib/wording";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { DEFAULT_PRICE_TOLERANCE_CENTS } from "../lib/policy/rules";
import { Empty } from "./ui";
import {
  NUMBER_FIELDS,
  readRulesForm,
  rulesFormErrors,
  rulesSummary,
  sameForm,
  type FormErrors,
  type NumberField,
  type RulesForm,
} from "../lib/policy/rules-form";
import type {
  RulesPageData,
  RulesActionData,
} from "../lib/merchant/rules-editor.server";

const dollars = (cents: number) => (cents / 100).toFixed(2);
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function RulesEditor({ data }: { data: RulesPageData }) {
  const { signed, rules, suppliers, history } = data;
  const fetcher = useFetcher<RulesActionData>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);
  const current = history[0];

  // The form's values as last saved, and as the merchant is typing them (read from the form on every input).
  const saved = useMemo<RulesForm>(
    () => ({
      reorderBelowDaysOfCover: String(rules.reorderBelowDaysOfCover),
      targetDaysOfCover: String(rules.targetDaysOfCover),
      maxQuantityMultiple: String(rules.maxQuantityMultiple),
      approvalAbove: dollars(rules.approvalAboveCents),
      weeklySpendCap: dollars(rules.weeklySpendCapCents),
      cashFloor: dollars(rules.cashFloorCents),
      maxPurchasesPer24h: String(rules.maxPurchasesPer24h),
      priceTolerance: dollars(
        rules.priceToleranceCents ?? DEFAULT_PRICE_TOLERANCE_CENTS,
      ),
      allow: rules.supplierAllowlist.filter((id) =>
        suppliers.some((s) => s.id === id),
      ),
    }),
    [rules, suppliers],
  );
  const [supplierSearch, setSupplierSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState(saved);
  const [formKey, setFormKey] = useState(0); // bumped to put the fields back to the saved values
  useEffect(() => setForm(saved), [saved]);
  const reread = () =>
    formRef.current && setForm(readRulesForm(new FormData(formRef.current)));

  const errors: FormErrors = {
    ...rulesFormErrors(form),
    ...(fetcher.data?.ok === false ? fetcher.data.errors : {}),
  };
  const changed = !sameForm(form, saved);
  const canSign =
    Object.keys(rulesFormErrors(form)).length === 0 && (changed || !signed);
  const names = suppliers
    .filter((s) => form.allow.includes(s.id))
    .map((s) => s.name);

  const moneyFields = new Set<NumberField>([
    "approvalAbove",
    "weeklySpendCap",
    "cashFloor",
    "priceTolerance",
  ]);
  const labels: Record<NumberField, string> = {
    reorderBelowDaysOfCover: "Reorder point",
    targetDaysOfCover: "Target cover",
    maxQuantityMultiple: "Maximum order size",
    approvalAbove: "Approval threshold",
    weeklySpendCap: "7-day spending cap",
    cashFloor: "Minimum PayPal balance",
    priceTolerance: "Price tolerance",
    maxPurchasesPer24h: "Purchases per 24 hours",
  };
  const valueLabel = (name: NumberField, value: string) => {
    const n = value.trim() === "" ? NaN : Number(value);
    if (!Number.isFinite(n)) return "—";
    return moneyFields.has(name)
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(n)
      : `${n}${name.includes("DaysOfCover") ? " days" : name === "maxQuantityMultiple" ? "×" : ""}`;
  };
  const changedFields = NUMBER_FIELDS.filter(
    (name) =>
      Number(form[name]) !== Number(saved[name]) || form[name].trim() === "",
  );
  const changedSuppliers = suppliers.filter(
    (s) => form.allow.includes(s.id) !== saved.allow.includes(s.id),
  );
  const field = (
    name: NumberField,
    label: string,
    details: string,
    props: { min?: number; step: number },
  ) => (
    <FormField
      type="number"
      label={label}
      name={name}
      defaultValue={saved[name]}
      details={details}
      prefix={moneyFields.has(name) ? "$" : undefined}
      suffix={
        name.includes("DaysOfCover")
          ? "days"
          : name === "maxQuantityMultiple"
            ? "× usual"
            : undefined
      }
      {...props}
      error={errors[name]}
    />
  );
  const valid = Object.keys(errors).length === 0;

  return (
    <div className={styles.workspace}>
      <header className={styles.titlebar}>
        <div>
          <h2>Purchasing policy</h2>
          <p>Choose when the agent can buy, and when it must ask.</p>
        </div>
        {signed && current ? (
          <div className={styles.signature}>
            <span className={styles.active}>
              Policy signed · {when(current.at)}
            </span>
            <details>
              <summary>Signature details</summary>
              <p>
                Signed by {current.by}
                <br />
                Fingerprint {current.hash}
                <br />
                Audit log entry #{current.seq}
              </p>
            </details>
          </div>
        ) : (
          <span className={styles.signature}>
            Suggested limits · sign to activate purchasing
          </span>
        )}
      </header>
      <fetcher.Form
        noValidate
        key={formKey}
        method="post"
        action="/app/rules?tab=rules"
        ref={formRef}
        onInput={reread}
        onChange={reread}
        className={styles.layout}
      >
        <input type="hidden" name="intent" value="sign-rules" />
        <div className={styles.editor}>
          <section className={styles.section}>
            <h3>Restock timing</h3>
            <p className={styles.intro}>
              Use days of stock to trigger and size a restock.
            </p>
            <div className={styles.horizon}>
              {field(
                "reorderBelowDaysOfCover",
                "Reorder point",
                "Start proposing a restock below this cover.",
                { min: 1, step: 1 },
              )}
              <span aria-hidden="true">→</span>
              {field(
                "targetDaysOfCover",
                "Target cover",
                "Plan enough stock to reach this cover.",
                { min: 1, step: 1 },
              )}
            </div>
            <p className={styles.basis}>
              Cover is estimated from each product’s recent sales.
            </p>
            <div className={styles.rows}>
              {field(
                "maxQuantityMultiple",
                "Maximum order size",
                "Block orders above this multiple of the supplier’s usual quantity.",
                { min: 1, step: 0.5 },
              )}
            </div>
          </section>
          <section className={styles.section}>
            <h3>Spending limits</h3>
            <p className={styles.intro}>
              Paid and reserved purchases both count toward your limits.
            </p>
            <div className={styles.rows}>
              {field(
                "approvalAbove",
                `${COPY.approvalAbove} (USD)`,
                "Ask you before paying for a larger purchase.",
                { min: 0, step: 0.01 },
              )}
              {field(
                "weeklySpendCap",
                `${COPY.spendingCap} (USD)`,
                "A rolling seven-day limit, across all suppliers.",
                { min: 0.01, step: 0.01 },
              )}
              {field(
                "cashFloor",
                `${COPY.cashFloor} (USD)`,
                "Block purchases that would take the balance below this amount.",
                { min: 0, step: 0.01 },
              )}
              {field(
                "priceTolerance",
                "Price increase without approval (USD / unit)",
                "Compared with the last price you entered or approved.",
                { min: 0, step: 0.01 },
              )}
              {field(
                "maxPurchasesPer24h",
                "Purchases per 24 hours",
                "A whole-number limit across all products.",
                { min: 1, step: 1 },
              )}
            </div>
          </section>
          <section className={styles.section}>
            <h3>Approved suppliers</h3>
            <p className={styles.intro}>
              A linked supplier can only be paid if you approve it here.
            </p>
            {suppliers.length === 0 ? (
              <Empty
                heading="No suppliers yet"
                action={{
                  label: "Add a supplier",
                  href: "/app/products?tab=suppliers",
                }}
              >
                Add your suppliers before authorizing purchases.
              </Empty>
            ) : (
              <>
                <div className={styles.supplierTools}>
                  <input
                    type="search"
                    className={styles.supplierSearch}
                    aria-label="Find a supplier"
                    placeholder="Find a supplier…"
                    value={supplierSearch}
                    onChange={(e) => setSupplierSearch(e.target.value)}
                  />
                  <span>
                    {form.allow.length} of {suppliers.length} approved
                  </span>
                </div>
                <div>
                  {suppliers.map((s) => (
                    <label
                      className={styles.supplierRow}
                      key={s.id}
                      hidden={
                        !s.name
                          .toLowerCase()
                          .includes(supplierSearch.toLowerCase())
                      }
                    >
                      <input
                        type="checkbox"
                        aria-label={`Approve ${s.name}`}
                        name="allow"
                        value={s.id}
                        defaultChecked={saved.allow.includes(s.id)}
                      />
                      <span>
                        <strong>{s.name}</strong>
                        <small>
                          {s.products
                            ? `Linked to ${s.products} ${s.products === 1 ? "product" : "products"}`
                            : "Not linked to a product yet"}
                        </small>
                      </span>
                      <span className={styles.supplierState}>
                        {form.allow.includes(s.id) ? "Allowed" : "Blocked"}
                      </span>
                    </label>
                  ))}
                </div>
                {!suppliers.some((s) =>
                  s.name.toLowerCase().includes(supplierSearch.toLowerCase()),
                ) && (
                  <p className={styles.supplierNote}>
                    No suppliers match. Your approvals are kept.
                  </p>
                )}
              </>
            )}
            {errors.allow ? (
              <p className={styles.error} role="alert">
                {errors.allow}
              </p>
            ) : (
              <p className={styles.supplierNote}>
                Unselected suppliers stay blocked, including those linked to a
                product.
              </p>
            )}
          </section>
        </div>
        <aside className={styles.review} aria-label="Policy review">
          <h3>{changed ? "Review your changes" : "Purchasing limits"}</h3>
          <p className={styles.reviewState} data-dirty={changed}>
            {!valid
              ? "Check the highlighted fields"
              : changed
                ? "Unsaved changes"
                : signed
                  ? "Matches your signed policy"
                  : "Not signed yet"}
          </p>
          <span className={styles.amountLabel}>
            {changed || !signed
              ? "After signing, can pay without asking"
              : "Can pay without asking"}
          </span>
          <strong className={styles.amount}>
            {errors.approvalAbove
              ? "—"
              : valueLabel("approvalAbove", form.approvalAbove)}
          </strong>
          <span className={styles.amountNote}>
            Only when every other rule passes.
          </span>
          <dl className={styles.totals}>
            <div>
              <dt>7-day spending cap</dt>
              <dd>{valueLabel("weeklySpendCap", form.weeklySpendCap)}</dd>
            </div>
            <div>
              <dt>Minimum PayPal balance</dt>
              <dd>{valueLabel("cashFloor", form.cashFloor)}</dd>
            </div>
            <div>
              <dt>Purchases / 24 hours</dt>
              <dd>
                {valueLabel("maxPurchasesPer24h", form.maxPurchasesPer24h)}
              </dd>
            </div>
            <div>
              <dt>Approved suppliers</dt>
              <dd>
                {form.allow.length} of {suppliers.length}
              </dd>
            </div>
          </dl>
          {changed && (
            <div className={styles.changes}>
              <h4>What will change</h4>
              <ul>
                {changedFields.map((name) => (
                  <li key={name}>
                    {labels[name]}
                    <span>
                      <del>{valueLabel(name, saved[name])}</del> →{" "}
                      {valueLabel(name, form[name])}
                    </span>
                  </li>
                ))}
                {changedSuppliers.map((s) => (
                  <li key={s.id}>
                    {form.allow.includes(s.id) ? "Allow" : "Block"} {s.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details className={styles.fullPolicy}>
            <summary>Read the full policy</summary>
            <p>
              {valid
                ? rulesSummary(form, names)
                : "Complete the highlighted fields to review this policy."}
            </p>
          </details>
          <div className={styles.reviewActions}>
            <FormButton type="submit" disabled={busy || !canSign}>
              {busy
                ? "Signing…"
                : signed
                  ? "Sign updated rules"
                  : "Sign these rules"}
            </FormButton>
            {signed && changed && (
              <FormButton
                secondary
                disabled={busy}
                onClick={() => {
                  setFormKey((k) => k + 1);
                  setForm(saved);
                }}
              >
                Discard
              </FormButton>
            )}
          </div>
          <p className={styles.authorization}>
            Signing authorizes automatic purchases within these limits. Flagged
            purchases still need your approval. Your signature is recorded in
            Activity.
          </p>
        </aside>
      </fetcher.Form>

      {history.length > 0 && (
        <details
          className={styles.history}
          open={historyOpen}
          onToggle={(e) => setHistoryOpen(e.currentTarget.open)}
        >
          <summary>
            Signed policy history · {history.length}{" "}
            {history.length === 1 ? "version" : "versions"}
          </summary>
          <div>
            {historyOpen && (
              <DataGrid<RulesPageData["history"][number]>
                label="Rules history"
                rows={history}
                rowId={(h) => String(h.seq)}
                columns={[
                  {
                    field: "at",
                    headerName: "Signed",
                    flex: 1,
                    minWidth: 210,
                    cellRenderer: cell<RulesPageData["history"][number]>(
                      (h) => (
                        <>
                          <s-stack
                            direction="inline"
                            gap="small-200"
                            alignItems="center"
                          >
                            <s-text>{when(h.at)}</s-text>
                            {h.seq === history[0]?.seq && (
                              <GridBadge tone="success">Current</GridBadge>
                            )}
                          </s-stack>
                        </>
                      ),
                    ),
                  },
                  {
                    field: "by",
                    headerName: "By",
                    flex: 1,
                    minWidth: 150,
                    cellRenderer: cell<RulesPageData["history"][number]>(
                      (h) => <>{h.by}</>,
                    ),
                  },
                  {
                    field: "approvalAbove",
                    headerName: COPY.approvalAbove,
                    type: "numericColumn",
                    minWidth: 185,
                    comparator: compareMoney,
                    cellRenderer: cell<RulesPageData["history"][number]>(
                      (h) => <>{h.approvalAbove}</>,
                    ),
                  },
                  {
                    field: "weeklyCap",
                    headerName: COPY.spendingCap,
                    type: "numericColumn",
                    minWidth: 200,
                    comparator: compareMoney,
                    cellRenderer: cell<RulesPageData["history"][number]>(
                      (h) => <>{h.weeklyCap}</>,
                    ),
                  },
                  {
                    field: "hash",
                    headerName: "Fingerprint",
                    flex: 1,
                    minWidth: 200,
                    cellRenderer: cell<RulesPageData["history"][number]>(
                      (h) => (
                        <>
                          <s-text tone="neutral">
                            {h.hash.slice(0, 12)} · #{h.seq}
                          </s-text>
                        </>
                      ),
                    ),
                  },
                ]}
              />
            )}
          </div>
        </details>
      )}
      {data.demoAvailable && (
        <s-section heading="Private demo">
          <s-link href="/app/attack-tests">
            Open private demo attack tests
          </s-link>
        </s-section>
      )}
    </div>
  );
}
