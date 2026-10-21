import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { scoreboard } from "../lib/agent/scoreboard.server";
import { RULE_HELP, RULE_LABELS } from "../lib/policy/rules";
import { usd } from "../lib/format";
import { Metric, Metrics } from "../components/ui";

// What protects the merchant's money: every rule and how often it fired, what was blocked or sent
// to a person, and the results of attack tests. Computed from the hash-chained log only.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const log = await auditEntries(session.shop);
  const [score, chain] = await Promise.all([scoreboard(session.shop, log), verifyChain(session.shop)]);
  return { ...score, chain };
};

export default function Protection() {
  const { real, attacks, stoppedBy, chain } = useLoaderData<typeof loader>();
  const fired = new Map(stoppedBy.map((r) => [r.rule, r.count]));
  const answered = attacks.tried - attacks.failed;
  const fooled = attacks.blocked + attacks.flagged + attacks.slipped;

  return (
    <s-page heading="Protection" inlineSize="large">
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

      <s-section heading="Attack tests">
        {attacks.tried + attacks.simulated.tried === 0 ? (
          <s-text tone="neutral">
            No attack tests on this store. They run in the demo console, where a dishonest supplier tries prompt injection,
            fake urgency, a changed payee and more against the real AI and these rules.
          </s-text>
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
