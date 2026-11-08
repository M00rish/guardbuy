import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { privateAdmin } from "../lib/merchant/staff.server";
import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { scoreboard } from "../lib/agent/scoreboard.server";
import { RULE_HELP, RULE_LABELS } from "../lib/policy/rules";
import { usd } from "../lib/format";
import { setShareVerifyDetails, shareVerifyDetails } from "../lib/audit/verify.server";
import { demoEnabled } from "../lib/demo/public-dashboard";
import { Empty, Metric, Metrics } from "../components/ui";

// What protects the merchant's money: every rule and how often it fired, what was blocked or sent
// to a person, and the results of attack tests. Computed from the hash-chained log only.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const chain = await verifyChain(session.shop);
  const log = chain.valid ? await auditEntries(session.shop) : [];
  const [score, share] = await Promise.all([scoreboard(session.shop, log), shareVerifyDetails(session.shop)]);
  const lastPayment = log.filter((e) => e.event.type === "payout" || e.event.type === "order_captured").at(-1);
  const lastId = lastPayment?.event.type === "payout" ? lastPayment.event.payoutBatchId : lastPayment?.event.type === "order_captured" ? lastPayment.event.orderId : null;
  return { demoAvailable: demoEnabled(session.shop, { enabled: process.env.GUARDBUY_PUBLIC_DEMO_ENABLED, shop: process.env.GUARDBUY_DEMO_STORE, paypalBase: process.env.PAYPAL_API_BASE }), ...score, chain, share, verifyUrl: process.env.SHOPIFY_APP_URL ? `${process.env.SHOPIFY_APP_URL}/verify${lastId ? `?id=${lastId}` : ""}` : null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const f = await request.formData();
  await setShareVerifyDetails(session.shop, f.get("share") === "true");
  return { ok: true };
};

export default function Protection() {
  const { real, attacks, stoppedBy, chain, share, verifyUrl, demoAvailable } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const fired = new Map(stoppedBy.map((r) => [r.rule, r.count]));
  const answered = attacks.tried - attacks.failed;
  const fooled = attacks.blocked + attacks.flagged + attacks.slipped;

  return (
    <s-page heading="Protection" inlineSize="large">
      {!chain.valid && <s-section><s-banner tone="critical" heading="Audit-log verification failed">Entry #{chain.brokenAtSeq}: {chain.reason}. Purchase metrics below are unavailable and shown as zero. Investigate before approving any purchases.</s-banner></s-section>}
      <s-section>
        <Metrics>
          <Metric label="Purchases checked" value={String(real.decisions)} detail="Every one by every rule" />
          <Metric label="Blocked by your rules" value={String(real.blocked)} detail={`${usd(real.blockedCents)} not spent`} />
          <Metric label="Sent to you" value={String(real.approval)} detail={`${usd(real.approvalCents)} waited for approval`} href="/app/approvals" />
          <Metric label="Audit log" value={chain.valid ? "Intact" : "Broken"} detail={chain.valid ? `${chain.length} entries verified` : `at entry #${chain.brokenAtSeq}`} href="/app/activity"
            badge={chain.valid ? undefined : { tone: "critical", label: "Check" }} />
        </Metrics>
      </s-section>

      <s-section heading="Your rules at work">
        <s-stack gap="base">
          <s-text tone="neutral">
            The AI only proposes. Every purchase passes these checks in order before any money moves; the strictest result wins.
          </s-text>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Rule</s-table-header>
              <s-table-header listSlot="secondary">What it does</s-table-header>
              <s-table-header format="numeric">Times it stopped something</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {Object.entries(RULE_HELP).map(([rule, help]) => {
                const label = RULE_LABELS[rule] ?? rule;
                const n = fired.get(label) ?? 0;
                return (
                  <s-table-row key={rule}>
                    <s-table-cell><s-text type="strong">{label}</s-text></s-table-cell>
                    <s-table-cell><s-text tone="neutral">{help}</s-text></s-table-cell>
                    <s-table-cell>{n > 0 ? <s-badge tone="success">{String(n)}</s-badge> : <s-text tone="neutral">0</s-text>}</s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>

      <s-section heading="Public verification">
        <s-stack gap="base">
          <s-text tone="neutral">
            Anyone with a PayPal payment ID can check it on GuardBuy’s verify page: that it’s on your audit log, which signed
            rules allowed it, and that the log is intact. By default the page shows fingerprints and outcomes only.
          </s-text>
          <s-switch label="Also show the product, supplier and amount" checked={share} disabled={fetcher.state !== "idle"}
            details="Emails, PayPal links and your balance are never shown"
            onChange={() => fetcher.submit({ share: String(!share) }, { method: "POST" })} />
          {verifyUrl && <s-link href={verifyUrl} target="_blank">Open the verify page{verifyUrl.includes("?id=") ? " for your latest payment" : ""}</s-link>}
        </s-stack>
      </s-section>

      <s-section heading="Attack tests">
        {demoAvailable && <s-link href="/app/attack-tests">Open private demo attack tests</s-link>}
        {attacks.tried + attacks.simulated.tried === 0 ? (
          <Empty heading="No attack tests on this store">
            Demo-store attack tests run in a private staff sandbox. Results there are separate from this store’s history; the public dashboard shows real store activity only.
          </Empty>
        ) : (
          <s-stack gap="base">
            <Metrics>
              <Metric label="Attacks tried" value={String(attacks.tried)} detail={attacks.failed ? `${attacks.failed} AI calls failed` : undefined} />
              <Metric label="AI fooled" value={`${fooled} of ${answered}`} detail="The rules still decide" />
              <Metric label="Blocked by rules" value={usd(attacks.blockedCents)} detail={`${attacks.blocked} attacks`} />
              <Metric label="Held for a person" value={usd(attacks.flaggedCents)} detail={`${attacks.flagged} attacks`} />
            </Metrics>
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Level</s-table-header>
                <s-table-header format="numeric">Tried</s-table-header>
                <s-table-header format="numeric">AI resisted</s-table-header>
                <s-table-header format="numeric">Blocked</s-table-header>
                <s-table-header format="numeric">Held for a person</s-table-header>
                <s-table-header format="numeric">Got through</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {(["easy", "medium", "hard"] as const).map((l) => {
                  const t = attacks.byLevel[l];
                  return (
                    <s-table-row key={l}>
                      <s-table-cell><s-text type="strong">{l[0].toUpperCase() + l.slice(1)}</s-text></s-table-cell>
                      <s-table-cell>{t.tried}</s-table-cell>
                      <s-table-cell>{t.resisted}</s-table-cell>
                      <s-table-cell>{t.blocked}</s-table-cell>
                      <s-table-cell>{t.flagged}</s-table-cell>
                      <s-table-cell>{t.slipped > 0 ? <s-badge tone="critical">{String(t.slipped)}</s-badge> : "0"}</s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
            {attacks.knownGaps.map((g) => (
              <s-banner key={g.title} tone="warning" heading={`Known gap: ${g.title}`}>Fix planned: {g.fix}</s-banner>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
