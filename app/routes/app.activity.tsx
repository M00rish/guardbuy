import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { toFeed } from "../lib/audit/feed.server";
import { adminWithStaff } from "../lib/merchant/staff.server";

// Everything the agent did, from the hash-chained log. "Verify the log" recomputes every hash
// from the first entry, so an edited, deleted or reordered row shows up as broken.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const log = await auditEntries(session.shop);
  return { feed: toFeed(log, actor), chain: await verifyChain(session.shop), head: log.at(-1)?.hash ?? null };
};

const TONE: Record<string, "success" | "critical" | "warning" | "info" | "neutral"> = {
  paid: "success", approved: "success", resisted: "success", auto: "success",
  block: "critical", failed: "critical", slipped: "critical",
  approval: "warning", flagged: "warning", declined: "warning",
  attack: "info", stock: "info", proposed: "info", rules: "neutral", status: "neutral", paypal: "info",
};

export default function Activity() {
  const { feed, chain, head } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <s-page heading="Activity">
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={chain.valid ? "success" : "critical"}>
            {chain.valid ? `Audit log intact: ${chain.length} entries` : `BROKEN at entry #${chain.brokenAtSeq}: ${chain.reason}`}
          </s-badge>
          <s-button onClick={() => revalidator.revalidate()} {...(revalidator.state !== "idle" ? { loading: true } : {})}>
            Verify the log
          </s-button>
          {head && <s-text tone="neutral">Latest fingerprint {head.slice(0, 16)}</s-text>}
        </s-stack>
      </s-section>
      <s-section>
        <s-stack gap="base">
          {feed.length === 0 && <s-text tone="neutral">Nothing yet.</s-text>}
          {feed.map((f) => (
            <s-box key={`${f.seq}-${f.kind}`} padding="small-200" borderWidth="base" borderRadius="base">
              <s-stack gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={TONE[f.kind] ?? "neutral"}>{f.kind}</s-badge>
                  <s-text type="strong">{f.title}</s-text>
                </s-stack>
                {f.detail && <s-text tone="neutral">{f.detail}</s-text>}
                {f.untrusted && (
                  <s-box padding="small-200" background="subdued" borderRadius="base">
                    <s-text type="strong">{f.untrustedLabel ?? "Untrusted text"}</s-text>
                    <s-paragraph>{f.untrusted}</s-paragraph>
                  </s-box>
                )}
                <s-text tone="neutral">#{f.seq} · {new Date(f.at).toLocaleString()}</s-text>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
