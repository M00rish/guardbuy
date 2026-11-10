import { COPY } from "../lib/wording";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { DEFAULT_PRICE_TOLERANCE_CENTS } from "../lib/policy/rules";
import { Empty } from "./ui";
import {
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

  const field = (
    name: NumberField,
    label: string,
    details: string,
    props: { min?: number; max?: number; step: number },
  ) => (
    <s-number-field
      label={label}
      name={name}
      value={saved[name]}
      details={details}
      {...props}
      {...(errors[name] ? { error: errors[name] } : {})}
    />
  );

  return (
    <s-stack gap="base">
      <s-section>
        {signed && current ? (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone="success">Signed</s-badge>
            <s-text tone="neutral">
              by {current.by} · {when(current.at)} · fingerprint{" "}
              {current.hash.slice(0, 12)} · audit log entry #{current.seq}
            </s-text>
          </s-stack>
        ) : (
          <s-banner tone="info" heading="These are suggested starting rules">
            Nothing is bought until you sign rules. Adjust them, then sign at
            the bottom.
          </s-banner>
        )}
      </s-section>

      <fetcher.Form
        key={formKey}
        method="post"
        action="/app/rules?tab=rules"
        ref={formRef}
        onInput={reread}
        onChange={reread}
      >
        <input type="hidden" name="intent" value="sign-rules" />
        <s-stack gap="base">
          <s-section heading="When to buy, and how much">
            <s-query-container>
              <s-grid
                gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr 1fr"
                gap="base"
              >
                {field(
                  "reorderBelowDaysOfCover",
                  "Restock when stock lasts fewer than (days)",
                  "Based on each product's recent sales",
                  { min: 1, step: 1 },
                )}
                {field(
                  "targetDaysOfCover",
                  "Buy enough for (days)",
                  "The agent's suggested quantity aims for this",
                  { min: 1, step: 1 },
                )}
                {field(
                  "maxQuantityMultiple",
                  "Largest order (times the usual)",
                  "Blocks orders this many times above a supplier’s usual order",
                  { min: 1, step: 0.5 },
                )}
              </s-grid>
            </s-query-container>
          </s-section>

          <s-section heading="Money">
            <s-query-container>
              <s-grid
                gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr 1fr"
                gap="base"
              >
                {field(
                  "approvalAbove",
                  `${COPY.approvalAbove} ($)`,
                  "Larger purchases need approval in Rules & Approvals",
                  { min: 0, step: 1 },
                )}
                {field(
                  "weeklySpendCap",
                  `${COPY.spendingCap} ($)`,
                  "Rolling 7 days, all suppliers",
                  { min: 0, step: 1 },
                )}
                {field(
                  "cashFloor",
                  `${COPY.cashFloor} ($)`,
                  "Purchases that would go below are blocked",
                  { min: 0, step: 1 },
                )}
                {field(
                  "priceTolerance",
                  "Price increase without asking ($ per unit)",
                  "Above the price you entered or last approved",
                  { min: 0, step: 0.05 },
                )}
                {field(
                  "maxPurchasesPer24h",
                  "Purchases per 24 hours",
                  "Across all products",
                  { min: 1, step: 1 },
                )}
              </s-grid>
            </s-query-container>
          </s-section>

          <s-section heading="Approved suppliers">
            <s-stack gap="small-200">
              {suppliers.length === 0 ? (
                <Empty
                  heading="No suppliers yet"
                  action={{
                    label: "Add a supplier",
                    href: "/app/products?tab=suppliers",
                  }}
                >
                  GuardBuy can only buy from suppliers you add and approve here.
                </Empty>
              ) : (
                suppliers.map((s) => (
                  <s-checkbox
                    key={s.id}
                    name="allow"
                    value={s.id}
                    label={s.name}
                    details={
                      s.products
                        ? `Linked to ${s.products} ${s.products === 1 ? "product" : "products"}`
                        : "Not linked to any product yet"
                    }
                    {...(saved.allow.includes(s.id) ? { checked: true } : {})}
                  />
                ))
              )}
              {errors.allow && suppliers.length > 0 ? (
                <s-text tone="critical">{errors.allow}</s-text>
              ) : (
                <s-text tone="neutral">
                  Purchases from any supplier you do not select are blocked,
                  even if it is linked to a product.
                </s-text>
              )}
            </s-stack>
          </s-section>

          <s-section heading="In plain words">
            <s-stack gap="base">
              <s-text>{rulesSummary(form, names)}</s-text>
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button
                  type="submit"
                  variant="primary"
                  disabled={busy || !canSign}
                  {...(busy ? { loading: true } : {})}
                >
                  {signed ? "Sign updated rules" : "Sign these rules"}
                </s-button>
                {changed && signed && (
                  <s-badge tone="caution">Unsaved changes</s-badge>
                )}
                {signed && changed && (
                  <s-button
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => {
                      setFormKey((k) => k + 1);
                      setForm(saved);
                    }}
                  >
                    Discard
                  </s-button>
                )}
              </s-stack>
              <s-text tone="neutral">
                Signing activates automatic purchases within these limits.
                Flagged purchases still need approval. These rules, their
                fingerprint and your staff identity are recorded in the audit
                log.
              </s-text>
            </s-stack>
          </s-section>
        </s-stack>
      </fetcher.Form>

      {history.length > 0 && (
        <s-section heading="History">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Signed</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header format="numeric">{COPY.approvalAbove}</s-table-header>
              <s-table-header format="numeric">{COPY.spendingCap}</s-table-header>
              <s-table-header listSlot="secondary">Fingerprint</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((h, i) => (
                <s-table-row key={h.seq}>
                  <s-table-cell>
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-text>{when(h.at)}</s-text>
                      {i === 0 && <s-badge tone="success">Current</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{h.by}</s-table-cell>
                  <s-table-cell>{h.approvalAbove}</s-table-cell>
                  <s-table-cell>{h.weeklyCap}</s-table-cell>
                  <s-table-cell>
                    <s-text tone="neutral">
                      {h.hash.slice(0, 12)} · #{h.seq}
                    </s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
      {data.demoAvailable && (
        <s-section heading="Private demo">
          <s-link href="/app/attack-tests">
            Open private demo attack tests
          </s-link>
        </s-section>
      )}
    </s-stack>
  );
}
