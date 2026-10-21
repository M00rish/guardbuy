import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { auditEntries, verifyChain } from "../lib/audit/log.server";
import { toFeed } from "../lib/audit/feed.server";
import { usd } from "../lib/format";
import { approvalQueue } from "../lib/agent/approvals.server";
import { agentOn, currentRuleSet, setAgentState, spending } from "../lib/agent/restock.server";
import { scoreboard } from "../lib/agent/scoreboard.server";
import { cachedBalanceCents, feedNames, productOverview, productStatus } from "../lib/merchant/dashboard.server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { setManaged, setupStatus } from "../lib/suppliers/directory.server";
import { ago, FEED_LABEL, FEED_TONE, Metric, plural, Row, type Tone } from "../components/ui";

// Home: what the agent is doing, what it spent, which products need attention, and what changed.
// While setup isn't finished, the setup checklist takes the place of the numbers.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, actor } = await adminWithStaff(request);
  const shop = session.shop;
  const log = await auditEntries(shop);
  const rules = currentRuleSet(log);
  const [setup, queue, chain, score, balanceCents, products, names] = await Promise.all([
    setupStatus(shop), approvalQueue(shop), verifyChain(shop), scoreboard(shop, log), cachedBalanceCents(), productOverview(admin, shop), feedNames(shop),
  ]);
  const ready = setup.managedProducts > 0 && setup.suppliers > 0 && setup.managedWithSuppliers > 0 && !!rules;
  const running = ready && agentOn(log);
  const signed = log.filter((e) => e.event.type === "ruleset_signed").at(-1);
  const recentFailure = log.filter((e) => e.event.type === "payment_failed" || e.event.type === "proposal_failed").filter((e) => Date.now() - Date.parse(e.at) < 86_400_000 && !("scenario" in e.event && e.event.scenario));

  return {
    ready,
    running,
    paused: ready && !running,
    setup,
    rules: rules && {
      approvalAbove: usd(rules.approvalAboveCents),
      weeklyCapCents: rules.weeklySpendCapCents,
      cashFloorCents: rules.cashFloorCents,
      reorderBelow: rules.reorderBelowDaysOfCover,
      allowlist: rules.supplierAllowlist.map((id) => names.supplier(id) ?? id),
    },
    signed: signed?.event.type === "ruleset_signed" ? { by: signed.event.ruleSet.signedBy === actor ? "you" : signed.event.ruleSet.signedBy.replace("shopify-staff:", "staff member "), at: signed.event.ruleSet.signedAt } : null,
    spentCents: spending(log).spentLast7dCents,
    balanceCents,
    waiting: queue.length,
    blocked: { count: score.real.blocked, cents: score.real.blockedCents },
    attacksBlocked: score.attacks.blocked + score.attacks.flagged,
    chain,
    head: log.at(-1)?.hash ?? null,
    failures: recentFailure.length,
    products: products.map((p) => ({ ...p, cover: Number.isFinite(p.cover) ? Number(p.cover.toFixed(1)) : null, status: productStatus(log, p, rules, running) })),
    recent: toFeed(log, actor, names).filter((f) => f.kind !== "status").slice(0, 6),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const f = await request.formData();
  if (f.get("intent") === "agent") {
    await setAgentState(session.shop, f.get("on") === "true", actor);
    return { ok: true, message: f.get("on") === "true" ? "Agent resumed" : "Agent paused" };
  }
  if (f.get("intent") === "manage") {
    const variantId = String(f.get("variantId") ?? "");
    if (!/^\d+$/.test(variantId)) return { ok: false, message: "Unknown product" };
    const on = f.get("managed") === "true";
    await setManaged(session.shop, { variantId, sku: String(f.get("sku") || "") || null, title: String(f.get("title") ?? "") }, on);
    return { ok: true, message: on ? "GuardBuy will restock this product" : "Product switched off" };
  }
  return { ok: false, message: "Unknown action" };
};

const STATUS_TONE: Record<string, Tone> = { success: "success", warning: "caution", critical: "critical", info: "info", neutral: "neutral" };
export default function Home() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const busy = fetcher.state !== "idle";
  const steps = [
    { done: d.setup.managedProducts > 0, label: "Switch on the products GuardBuy may restock", href: "/app/products" },
    { done: d.setup.suppliers > 0, label: "Add your suppliers and their PayPal emails", href: "/app/suppliers" },
    { done: d.setup.managedWithSuppliers > 0, label: "Link suppliers to those products", href: "/app/products" },
    { done: !!d.rules, label: "Set and sign your spending rules", href: "/app/rules" },
  ];
  const doneSteps = steps.filter((s) => s.done).length;
  const capCents = d.rules?.weeklyCapCents ?? 0;
  const lowBalance = d.balanceCents !== null && d.rules !== null && d.balanceCents < d.rules.cashFloorCents * 1.5;

  return (
    <s-page heading="GuardBuy" inlineSize="large">
      {d.ready && (
        <s-button slot="primary-action" variant={d.running ? "secondary" : "primary"} disabled={busy}
          onClick={() => fetcher.submit({ intent: "agent", on: String(!d.running) }, { method: "POST" })}>
          {d.running ? "Pause agent" : "Resume agent"}
        </s-button>
      )}
      <s-button slot="secondary-actions" href="/app/rules">Edit rules</s-button>

      {/* Status, alerts (only when needed) and the key numbers */}
      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={d.running ? "success" : d.paused ? "caution" : "info"}>{d.running ? "Running" : d.paused ? "Paused" : "Setup needed"}</s-badge>
            <s-text tone="neutral">
              {d.running
                ? `Restocks your switched-on products within your signed rules. Purchases above ${d.rules?.approvalAbove} wait for you.`
                : d.paused ? "Nothing is proposed or bought until you resume it." : `${doneSteps} of 4 setup steps done. Nothing is bought before setup is finished.`}
            </s-text>
          </s-stack>
          {!d.chain.valid && (
            <s-banner tone="critical" heading="The audit log failed verification">
              Entry #{d.chain.brokenAtSeq}: {d.chain.reason}. <s-link href="/app/activity">Open activity</s-link>
            </s-banner>
          )}
          {d.waiting > 0 && (
            <s-banner tone="warning" heading={`${plural(d.waiting, "purchase")} waiting for your approval`}>
              <s-link href="/app/approvals">Review now</s-link>
            </s-banner>
          )}
          {d.failures > 0 && (
            <s-banner tone="critical" heading={`${plural(d.failures, "problem")} in the last 24 hours`}>
              A payment or an AI call failed; GuardBuy retries automatically. <s-link href="/app/activity">See activity</s-link>
            </s-banner>
          )}
          {lowBalance && (
            <s-banner tone="warning" heading="PayPal balance is close to your cash floor">
              Purchases that would take the balance below {usd(d.rules!.cashFloorCents)} are blocked.
            </s-banner>
          )}
          {d.ready && (
            <s-query-container>
            <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr 1fr 1fr 1fr" gap="base">
              <Metric label="Spent this week" value={usd(d.spentCents)} detail={capCents ? `of ${usd(capCents)} weekly cap` : undefined}>
                {capCents > 0 && (
                  <s-progress value={Math.min(d.spentCents, capCents)} max={capCents} tone={d.spentCents > capCents * 0.8 ? "critical" : "auto"} accessibilityLabel="Weekly spending" />
                )}
              </Metric>
              <Metric label="PayPal balance" value={d.balanceCents === null ? "Unavailable" : usd(d.balanceCents)} detail={d.rules ? `Floor ${usd(d.rules.cashFloorCents)}` : undefined} badge={lowBalance ? { tone: "caution", label: "Low" } : undefined} />
              <Metric label="Waiting for you" value={String(d.waiting)} detail={d.waiting ? "Open Approvals" : "Nothing to approve"} href={d.waiting ? "/app/approvals" : undefined} />
              <Metric label="Stopped by your rules" value={String(d.blocked.count)} detail={d.blocked.count ? `${usd(d.blocked.cents)} not spent` : "Nothing blocked yet"} href="/app/protection" />
            </s-grid>
            </s-query-container>
          )}
        </s-stack>
      </s-section>

      {!d.ready && (
        <s-section heading={`Set up GuardBuy · ${doneSteps} of 4`}>
          <s-stack gap="base">
            <s-paragraph>
              You choose what to restock and from whom. The agent decides when and how much. Your rules decide whether money moves.
            </s-paragraph>
            {steps.map((s, i) => (
              <s-stack key={s.label} direction="inline" gap="small-200" alignItems="center">
                <s-badge tone={s.done ? "success" : "neutral"}>{s.done ? "Done" : `Step ${i + 1}`}</s-badge>
                <s-link href={s.href}>{s.label}</s-link>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}

      {d.ready && (
        <s-section>
          {/* Responsive values are comma-separated, so the column lists must not contain commas themselves */}
          <s-query-container>
          <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr" gap="large">
            <s-stack gap="small-200">
              <s-heading>Your rules</s-heading>
              {d.rules && (
                <>
                  <Row label="Ask me above"><s-text>{d.rules.approvalAbove}</s-text></Row>
                  <Row label="Weekly cap"><s-text>{usd(d.rules.weeklyCapCents)}</s-text></Row>
                  <Row label="Keep in PayPal"><s-text>{usd(d.rules.cashFloorCents)}</s-text></Row>
                  <Row label="Restock below"><s-text>{`${plural(d.rules.reorderBelow, "day")} of stock`}</s-text></Row>
                  <Row label="May buy from"><s-text>{d.rules.allowlist.join(", ")}</s-text></Row>
                </>
              )}
              <s-text tone="neutral">
                {d.signed ? `Signed by ${d.signed.by} · ${new Date(d.signed.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Not signed yet"}
              </s-text>
              <s-link href="/app/rules">Edit rules</s-link>
            </s-stack>
            <s-stack gap="small-200">
              <s-heading>Protection</s-heading>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text tone="neutral">Audit log</s-text>
                <s-badge tone={d.chain.valid ? "success" : "critical"}>
                  {d.chain.valid ? `Intact · ${d.chain.length} ${d.chain.length === 1 ? "entry" : "entries"}` : `Broken at #${d.chain.brokenAtSeq}`}
                </s-badge>
              </s-stack>
              <Row label="Fingerprint"><s-text>{d.head ? d.head.slice(0, 16) : "None yet"}</s-text></Row>
              <Row label="Blocked"><s-text>{`${plural(d.blocked.count, "purchase")}${d.attacksBlocked > 0 ? ` · ${plural(d.attacksBlocked, "attack")} stopped in tests` : ""}`}</s-text></Row>
              <s-stack direction="inline" gap="base">
                <s-link href="/app/protection">Protection details</s-link>
                <s-link href="/app/activity">Verify the log</s-link>
              </s-stack>
            </s-stack>
          </s-grid>
          </s-query-container>
        </s-section>
      )}

      <s-section heading="Products">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header format="numeric">Stock</s-table-header>
            <s-table-header format="numeric">Days left</s-table-header>
            <s-table-header>Supplier</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header>GuardBuy</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {d.products.map((p) => (
              <s-table-row key={p.variantId}>
                <s-table-cell>
                  <s-stack gap="none">
                    <s-text type={p.managed ? "strong" : "generic"} tone={p.managed ? "auto" : "neutral"}>{p.title}</s-text>
                    {p.sku && <s-text tone="neutral">{p.sku}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{p.stock}</s-table-cell>
                <s-table-cell>{p.cover === null ? "–" : p.cover}</s-table-cell>
                <s-table-cell>{p.supplier ?? <s-link href="/app/products">Link a supplier</s-link>}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-badge tone={STATUS_TONE[p.status.tone]}>{p.status.label}</s-badge>
                    {p.status.at && <s-text tone="neutral">{ago(p.status.at, now)}</s-text>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <s-switch label="Restock with GuardBuy" labelAccessibilityVisibility="exclusive" checked={p.managed} disabled={busy}
                    onChange={() => fetcher.submit({ intent: "manage", variantId: p.variantId, sku: p.sku ?? "", title: p.title, managed: String(!p.managed) }, { method: "POST" })} />
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Recent activity">
        {d.recent.length === 0 ? (
          <s-text tone="neutral">Nothing yet. The agent's work shows up here.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Type</s-table-header>
              <s-table-header listSlot="primary">Event</s-table-header>
              <s-table-header listSlot="secondary">When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.recent.map((f) => (
                <s-table-row key={`${f.seq}-${f.kind}`}>
                  <s-table-cell><s-badge tone={FEED_TONE[f.kind] ?? "neutral"}>{FEED_LABEL[f.kind] ?? f.kind}</s-badge></s-table-cell>
                  <s-table-cell>{f.title}</s-table-cell>
                  <s-table-cell><s-text tone="neutral">{ago(f.at, now)}</s-text></s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-box paddingBlockStart="small-200"><s-link href="/app/activity">All activity</s-link></s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
