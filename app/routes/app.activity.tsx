import { refreshPayouts } from "../lib/paypal/reconcile.server";
import { PayoutRefresh } from "../components/payout-refresh";
import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { toFeed } from "../lib/audit/feed.server";
import { feedNames } from "../lib/merchant/dashboard.server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { ago, Empty, FEED_LABEL, FEED_TONE, Filters } from "../components/ui";

// Everything the agent did, from the hash-chained log. "Verify the log" recomputes every hash from
// the first entry, so an edited, deleted or reordered row shows up as broken.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const payoutRefresh = await refreshPayouts(session.shop);
  const [log, names] = await Promise.all([auditEntries(session.shop), feedNames(session.shop)]);
  return {
    payoutRefresh,
    feed: toFeed(log, actor, names),
    chain: await verifyChain(session.shop),
    head: log.at(-1)?.hash ?? null,
    checkedAt: new Date().toISOString(),
    verifyBase: process.env.SHOPIFY_APP_URL ? `${process.env.SHOPIFY_APP_URL}/verify?id=` : null,
  };
};

type View = "all" | "money" | "you" | "blocked" | "ai";
const IN_VIEW: Record<View, (kind: string) => boolean> = {
  all: () => true,
  money: (k) => k === "paid" || k === "paypal" || k === "status",
  you: (k) => k === "approval" || k === "approved" || k === "declined" || k === "rules",
  blocked: (k) => k === "block" || k === "failed" || k === "slipped",
  ai: (k) => k === "proposed" || k === "attack" || k === "resisted" || k === "flagged",
};

export default function Activity() {
  const { feed, chain, head, checkedAt, verifyBase, payoutRefresh } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [view, setView] = useState<View>("all");
  const now = Date.now();
  const shown = feed.filter((f) => IN_VIEW[view](f.kind)).slice(0, 200);

  return (
    <s-page heading="Activity" inlineSize="large">
      <PayoutRefresh state={payoutRefresh} />
      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={chain.valid ? "success" : "critical"}>
              {chain.valid ? `Audit log intact · ${chain.length} ${chain.length === 1 ? "entry" : "entries"}` : `Broken at entry #${chain.brokenAtSeq}`}
            </s-badge>
            <s-button onClick={() => revalidator.revalidate()} {...(revalidator.state !== "idle" ? { loading: true } : {})}>Verify the log</s-button>
            <s-text tone="neutral">Checked {ago(checkedAt, now)}{head ? ` · latest fingerprint ${head.slice(0, 16)}` : ""}</s-text>
          </s-stack>
          {!chain.valid && <s-banner tone="critical" heading="The audit log failed verification">{chain.reason}</s-banner>}
          <s-text tone="neutral">
            Every entry’s fingerprint includes the one before it, so changing, deleting or reordering any past entry breaks every fingerprint after it.
          </s-text>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
          <Filters<View>
            value={view}
            onChange={setView}
            options={[
              { id: "all", label: "All", count: feed.length },
              { id: "money", label: "Money", count: feed.filter((f) => IN_VIEW.money(f.kind)).length },
              { id: "you", label: "You", count: feed.filter((f) => IN_VIEW.you(f.kind)).length },
              { id: "blocked", label: "Blocked", count: feed.filter((f) => IN_VIEW.blocked(f.kind)).length },
              { id: "ai", label: "AI & tests", count: feed.filter((f) => IN_VIEW.ai(f.kind)).length },
            ]}
          />
          {shown.length === 0 ? (
            <Empty heading={view === "all" ? "No activity yet" : "Nothing in this view yet"}>
              {view === "all" ? "Low stock, the agent's proposals, your rules' decisions and payments show up here as they happen." : "Try All to see everything that happened."}
            </Empty>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Type</s-table-header>
                <s-table-header listSlot="primary">Event</s-table-header>
                <s-table-header format="numeric">Entry</s-table-header>
                <s-table-header listSlot="secondary">When</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {shown.map((f) => (
                  <s-table-row key={`${f.seq}-${f.kind}`}>
                    <s-table-cell><s-badge tone={FEED_TONE[f.kind] ?? "neutral"}>{FEED_LABEL[f.kind] ?? f.kind}</s-badge></s-table-cell>
                    <s-table-cell>
                      <s-stack gap="small-200">
                        <s-text>{f.title}</s-text>
                        {f.detail && <s-text tone="neutral">{f.detail}</s-text>}
                        {f.verifyId && verifyBase && <s-link href={verifyBase + encodeURIComponent(f.verifyId)} target="_blank">Verify this payment publicly</s-link>}
                        {f.untrusted && (
                          <s-box padding="small-200" background="subdued" borderRadius="base">
                            <s-text type="strong">{f.untrustedLabel ?? "Untrusted text"}</s-text>
                            <s-paragraph>{f.untrusted}</s-paragraph>
                          </s-box>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell><s-text tone="neutral">#{f.seq}</s-text></s-table-cell>
                    <s-table-cell><s-text tone="neutral">{ago(f.at, now)}</s-text></s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
