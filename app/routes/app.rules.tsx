import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { auditEntries } from "../lib/audit/log.server";
import { currentRuleSet, defaultRuleSet, signRuleSet } from "../lib/agent/restock.server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { RuleSetSchema } from "../lib/policy/schema";
import { usd } from "../lib/format";

// The merchant's spending rules. Signing writes the rules and their fingerprint (hash) to the
// audit log with the staff member who signed; every decision records which rule set it used.

const FIELD_NAMES: Record<string, string> = {
  reorderBelowDaysOfCover: "Restock when stock lasts fewer than", targetDaysOfCover: "Buy enough for",
  maxQuantityMultiple: "Largest order", approvalAboveCents: "Ask me above", weeklySpendCapCents: "Weekly spending cap",
  cashFloorCents: "Keep at least this in PayPal", maxPriceAboveAvgPct: "Highest price above average", maxPurchasesPer24h: "Purchases per 24 hours",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const log = await auditEntries(session.shop);
  const rules = currentRuleSet(log) ?? defaultRuleSet(session.shop);
  const suppliers = await db.supplier.findMany({
    where: { shop: session.shop }, orderBy: { name: "asc" }, select: { id: true, name: true, _count: { select: { products: true } } },
  });
  const signer = (by: string) => (by === actor ? "you" : by.replace("shopify-staff:", "staff member "));
  const history = log.flatMap((e) =>
    e.event.type === "ruleset_signed"
      ? [{ seq: e.seq, by: signer(e.event.ruleSet.signedBy), at: e.event.ruleSet.signedAt, hash: e.event.ruleSet.hash, approvalAbove: usd(e.event.ruleSet.rules.approvalAboveCents), weeklyCap: usd(e.event.ruleSet.rules.weeklySpendCapCents) }]
      : [],
  ).reverse();
  return {
    signed: currentRuleSet(log) !== null,
    rules,
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, products: s._count.products })),
    history,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const f = await request.formData();
  const num = (k: string) => Number(f.get(k));
  const cents = (k: string) => Math.round(num(k) * 100);
  const parsed = RuleSetSchema.safeParse({
    version: 1,
    shop: session.shop,
    currency: "USD",
    reorderBelowDaysOfCover: num("reorderBelowDaysOfCover"),
    targetDaysOfCover: num("targetDaysOfCover"),
    maxPriceAboveAvgPct: num("maxPriceAboveAvgPct"),
    approvalAboveCents: cents("approvalAbove"),
    weeklySpendCapCents: cents("weeklySpendCap"),
    cashFloorCents: cents("cashFloor"),
    supplierAllowlist: f.getAll("allow").map(String),
    maxQuantityMultiple: num("maxQuantityMultiple"),
    maxPurchasesPer24h: num("maxPurchasesPer24h"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue.path[0]);
    return { ok: false, message: field === "supplierAllowlist" ? "Approve at least one supplier" : `Check "${FIELD_NAMES[field] ?? field}"` };
  }
  const entry = await signRuleSet(session.shop, parsed.data, actor);
  return { ok: true, message: `Rules signed (audit log entry #${entry.seq})` };
};

const dollars = (cents: number) => (cents / 100).toFixed(2);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Rules() {
  const { signed, rules, suppliers, history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);
  const current = history[0];

  return (
    <s-page heading="Spending rules" inlineSize="large">
      <s-section>
        {signed && current ? (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone="success">Signed</s-badge>
            <s-text tone="neutral">
              by {current.by} · {when(current.at)} · fingerprint {current.hash.slice(0, 12)} · audit log entry #{current.seq}
            </s-text>
          </s-stack>
        ) : (
          <s-banner tone="info" heading="These are suggested starting rules">Nothing is bought until you sign rules.</s-banner>
        )}
      </s-section>

      <fetcher.Form method="post">
        <s-section heading="When to buy, and how much">
          <s-query-container>
            <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr 1fr" gap="base">
              <s-number-field label="Restock when stock lasts fewer than (days)" name="reorderBelowDaysOfCover" value={String(rules.reorderBelowDaysOfCover)} min={1} step={1}
                details="Based on each product's recent sales" />
              <s-number-field label="Buy enough for (days)" name="targetDaysOfCover" value={String(rules.targetDaysOfCover)} min={1} step={1}
                details="The agent's suggested quantity aims for this" />
              <s-number-field label="Largest order (times the usual)" name="maxQuantityMultiple" value={String(rules.maxQuantityMultiple)} min={1} step={0.5}
                details="Blocks orders this many times above a supplier's usual order" />
            </s-grid>
          </s-query-container>
        </s-section>

        <s-section heading="Money">
          <s-query-container>
            <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr 1fr" gap="base">
              <s-number-field label="Ask me above ($)" name="approvalAbove" value={dollars(rules.approvalAboveCents)} min={0} step={1}
                details="Bigger purchases wait in Approvals" />
              <s-number-field label="Weekly spending cap ($)" name="weeklySpendCap" value={dollars(rules.weeklySpendCapCents)} min={0} step={1}
                details="Rolling 7 days, all suppliers" />
              <s-number-field label="Keep at least this in PayPal ($)" name="cashFloor" value={dollars(rules.cashFloorCents)} min={0} step={1}
                details="Purchases that would go below are blocked" />
              <s-number-field label="Highest price above 30-day average (%)" name="maxPriceAboveAvgPct" value={String(rules.maxPriceAboveAvgPct)} min={0} max={100} step={1}
                details="Stops sudden price jumps" />
              <s-number-field label="Purchases per 24 hours" name="maxPurchasesPer24h" value={String(rules.maxPurchasesPer24h)} min={1} step={1}
                details="Across all products" />
            </s-grid>
          </s-query-container>
        </s-section>

        <s-section heading="Approved suppliers">
          <s-stack gap="small-200">
            {suppliers.length === 0 ? (
              <s-text tone="neutral">Add suppliers first. <s-link href="/app/suppliers">Add a supplier</s-link></s-text>
            ) : (
              suppliers.map((s) => (
                <s-checkbox key={s.id} name="allow" value={s.id} label={s.name}
                  details={s.products ? `Linked to ${s.products} ${s.products === 1 ? "product" : "products"}` : "Not linked to any product yet"}
                  {...(rules.supplierAllowlist.includes(s.id) ? { checked: true } : {})} />
              ))
            )}
            <s-text tone="neutral">Purchases from any supplier you don't tick are blocked, even if it's linked to a product.</s-text>
          </s-stack>
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button type="submit" variant="primary" disabled={busy}>{signed ? "Sign updated rules" : "Sign these rules"}</s-button>
            <s-text tone="neutral">Signing records these rules, their fingerprint and your name in the audit log. They apply from the next purchase.</s-text>
          </s-stack>
        </s-section>
      </fetcher.Form>

      {history.length > 0 && (
        <s-section heading="History">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Signed</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header format="numeric">Ask me above</s-table-header>
              <s-table-header format="numeric">Weekly cap</s-table-header>
              <s-table-header listSlot="secondary">Fingerprint</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((h, i) => (
                <s-table-row key={h.seq}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-text>{when(h.at)}</s-text>
                      {i === 0 && <s-badge tone="success">Current</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{h.by}</s-table-cell>
                  <s-table-cell>{h.approvalAbove}</s-table-cell>
                  <s-table-cell>{h.weeklyCap}</s-table-cell>
                  <s-table-cell><s-text tone="neutral">{h.hash.slice(0, 12)} · #{h.seq}</s-text></s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
