import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { toFeed, usd } from "../lib/audit/feed.server";
import { approvalQueue } from "../lib/agent/approvals.server";
import { agentOn, currentRuleSet, setAgentState } from "../lib/agent/restock.server";
import { scoreboard } from "../lib/agent/scoreboard.server";
import { setupStatus } from "../lib/suppliers/directory.server";
import { adminWithStaff } from "../lib/merchant/staff.server";

// Home: setup checklist until GuardBuy is ready, then the agent's status and what it did lately.
// The pitch, in the app's own words: you choose what and from whom, the agent decides when and how
// much, your rules decide if.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const log = await auditEntries(shop);
  const [setup, queue, chain, score] = await Promise.all([setupStatus(shop), approvalQueue(shop), verifyChain(shop), scoreboard(shop, log)]);
  const rules = currentRuleSet(log);
  return {
    setup,
    rulesSigned: !!rules,
    approvalLimit: rules ? usd(rules.approvalAboveCents) : null,
    agentOn: agentOn(log),
    waiting: queue.length,
    chain,
    real: score.real,
    recent: toFeed(log).filter((f) => f.kind !== "status").slice(0, 6),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const form = await request.formData();
  await setAgentState(session.shop, form.get("on") === "true", actor);
  return { ok: true };
};

export default function Home() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const steps = [
    { done: d.setup.managedProducts > 0, label: "Choose the products GuardBuy may restock", href: "/app/products", detail: `${d.setup.managedProducts} switched on` },
    { done: d.setup.suppliers > 0, label: "Add your suppliers and their PayPal emails", href: "/app/suppliers", detail: `${d.setup.suppliers} suppliers` },
    { done: d.setup.managedWithSuppliers > 0, label: "Link suppliers to those products", href: "/app/products", detail: `${d.setup.managedWithSuppliers} of ${d.setup.managedProducts} products have a supplier` },
    { done: d.rulesSigned, label: "Set and sign your spending rules", href: "/app/rules", detail: d.rulesSigned ? `approval needed above ${d.approvalLimit}` : "not signed yet" },
  ];
  const ready = steps.every((s) => s.done);
  const running = ready && d.agentOn;

  return (
    <s-page heading="GuardBuy">
      <s-section>
        <s-stack gap="base">
          <s-paragraph>
            You choose what to restock and from whom. The agent decides when and how much. Your rules decide whether money moves.
          </s-paragraph>
          {running ? (
            <s-banner tone="success" heading="The agent is running">
              It restocks your switched-on products within your signed rules. Purchases above {d.approvalLimit} wait for you.
            </s-banner>
          ) : ready ? (
            <s-banner tone="warning" heading="The agent is paused">Nothing is proposed or bought until you resume it.</s-banner>
          ) : (
            <s-banner tone="info" heading="The agent is off until setup is done">Finish the steps below; nothing is bought before that.</s-banner>
          )}
          {ready && (
            <s-stack direction="inline" gap="base">
              <s-button
                variant={d.agentOn ? "secondary" : "primary"}
                onClick={() => fetcher.submit({ on: String(!d.agentOn) }, { method: "POST" })}
                {...(fetcher.state !== "idle" ? { loading: true } : {})}
              >
                {d.agentOn ? "Pause the agent" : "Resume the agent"}
              </s-button>
              {d.waiting > 0 && (
                <s-button href="/app/approvals" variant="primary">
                  {`Review ${d.waiting} waiting for approval`}
                </s-button>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading={ready ? "Setup" : "Set up GuardBuy"}>
        <s-stack gap="small-200">
          {steps.map((s, i) => (
            <s-stack key={s.label} direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={s.done ? "success" : "neutral"}>{s.done ? "Done" : `Step ${i + 1}`}</s-badge>
              <s-link href={s.href}>{s.label}</s-link>
              <s-text tone="neutral">{s.detail}</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Recent activity">
        <s-stack gap="small-200">
          {d.recent.length === 0 ? (
            <s-text tone="neutral">Nothing yet. Activity appears here once the agent starts working.</s-text>
          ) : (
            d.recent.map((f) => (
              <s-text key={`${f.seq}-${f.kind}`}>
                #{f.seq} · {f.title}
              </s-text>
            ))
          )}
          <s-link href="/app/activity">See all activity and verify the log</s-link>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="At a glance">
        <s-stack gap="small-200">
          <s-text>{d.real.decisions} purchases checked</s-text>
          <s-text>{d.real.blocked} blocked by your rules</s-text>
          <s-text>{d.waiting} waiting for approval</s-text>
          <s-text tone={d.chain.valid ? "success" : "critical"}>
            {d.chain.valid ? `Audit log intact (${d.chain.length} entries)` : `Audit log BROKEN at entry #${d.chain.brokenAtSeq}`}
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
