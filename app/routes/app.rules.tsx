import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { auditEntries } from "../lib/audit/log.server";
import { currentRuleSet, defaultRuleSet, signRuleSet } from "../lib/agent/restock.server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { RuleSetSchema } from "../lib/policy/schema";

// The merchant's spending rules. Signing writes the rules and their hash to the audit log; every
// decision records which rule set it used, and the payout note carries the hash too.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const log = await auditEntries(session.shop);
  const signed = log.filter((e) => e.event.type === "ruleset_signed").at(-1);
  const rules = currentRuleSet(log) ?? defaultRuleSet(session.shop);
  const suppliers = await db.supplier.findMany({ where: { shop: session.shop }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return {
    rules,
    suppliers,
    signed: signed?.event.type === "ruleset_signed"
      ? { by: signed.event.ruleSet.signedBy, at: signed.event.ruleSet.signedAt, hash: signed.event.ruleSet.hash, seq: signed.seq }
      : null,
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
    return { ok: false, message: issue.path[0] === "supplierAllowlist" ? "Approve at least one supplier for automatic buying" : `Check "${String(issue.path[0])}": ${issue.message}` };
  }
  const entry = await signRuleSet(session.shop, parsed.data, actor);
  return { ok: true, message: `Rules signed (log entry #${entry.seq})` };
};

const dollars = (cents: number) => (cents / 100).toFixed(2);

export default function Rules() {
  const { rules, suppliers, signed } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  return (
    <s-page heading="Spending rules">
      <s-section>
        {signed ? (
          <s-text tone="neutral">
            Signed by {signed.by.replace("shopify-staff:", "staff member ")} on {new Date(signed.at).toLocaleString()} (log entry #{signed.seq}, fingerprint {signed.hash.slice(0, 12)}).
            Changing anything below and signing again replaces them from the next purchase on.
          </s-text>
        ) : (
          <s-banner tone="info" heading="Not signed yet">
            These are suggested starting rules. Nothing is bought until you sign rules.
          </s-banner>
        )}
      </s-section>
      <fetcher.Form method="post">
        <s-section heading="When to buy, and how much">
          <s-stack direction="inline" gap="base">
            <s-number-field label="Restock when stock lasts fewer than (days)" name="reorderBelowDaysOfCover" value={String(rules.reorderBelowDaysOfCover)} min={1} step={1} />
            <s-number-field label="Buy enough for (days)" name="targetDaysOfCover" value={String(rules.targetDaysOfCover)} min={1} step={1} />
            <s-number-field label="At most this many times the usual order" name="maxQuantityMultiple" value={String(rules.maxQuantityMultiple)} min={1} step={0.5} />
          </s-stack>
        </s-section>
        <s-section heading="Money">
          <s-stack direction="inline" gap="base">
            <s-number-field label="Ask me above ($)" name="approvalAbove" value={dollars(rules.approvalAboveCents)} min={0} step={1} />
            <s-number-field label="Weekly spending cap ($)" name="weeklySpendCap" value={dollars(rules.weeklySpendCapCents)} min={0} step={1} />
            <s-number-field label="Keep at least this in PayPal ($)" name="cashFloor" value={dollars(rules.cashFloorCents)} min={0} step={1} />
            <s-number-field label="Max price above 30-day average (%)" name="maxPriceAboveAvgPct" value={String(rules.maxPriceAboveAvgPct)} min={0} max={100} step={1} />
            <s-number-field label="Max purchases per 24 hours" name="maxPurchasesPer24h" value={String(rules.maxPurchasesPer24h)} min={1} step={1} />
          </s-stack>
        </s-section>
        <s-section heading="Suppliers the agent may buy from">
          <s-stack gap="small-200">
            {suppliers.length === 0 ? (
              <s-text tone="neutral">Add suppliers first.</s-text>
            ) : (
              suppliers.map((s) => (
                <s-checkbox key={s.id} label={s.name} name="allow" value={s.id} {...(rules.supplierAllowlist.includes(s.id) ? { checked: true } : {})} />
              ))
            )}
            <s-text tone="neutral">Any other supplier is blocked, even if it is linked to a product.</s-text>
          </s-stack>
        </s-section>
        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>Sign these rules</s-button>
            {fetcher.data && <s-text tone={fetcher.data.ok ? "success" : "critical"}>{fetcher.data.message}</s-text>}
          </s-stack>
        </s-section>
      </fetcher.Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
