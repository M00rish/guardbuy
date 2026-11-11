import { COPY, APPROVAL_LABEL } from "../lib/wording";
import { currentProblems } from "../lib/merchant/current-problems";
import { budgetSummary } from "../lib/payments/status";
import { lazy, Suspense, useEffect, useState } from "react";
import { insightsSnapshot } from "../lib/insights/projection.server";
import { insightsAiConfigured } from "../lib/insights/planner.server";
const PurchasingDashboard = lazy(() => import("../components/insights-studio"));
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
import { ago, Empty, FEED_LABEL, FEED_TONE, Metric, plural, Row, Unavailable, type Tone } from "../components/ui";

// Home: what the agent is doing, what it spent, which products need attention, and what changed.
// While setup isn't finished, the setup checklist takes the place of the numbers.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, actor } = await adminWithStaff(request);
  const shop = session.shop;
  const log = await auditEntries(shop);
  const rules = currentRuleSet(log);
  const [setup, queue, chain, score, balanceCents, products, names] = await Promise.all([
    setupStatus(shop), approvalQueue(shop), verifyChain(shop), scoreboard(shop, log), cachedBalanceCents(),
    // Shopify's API can be briefly unreachable: show the rest of Home and a retry for the product list.
    productOverview(admin, shop).catch((e) => { console.warn(`[home] products unavailable: ${(e as Error).message}`); return null; }),
    feedNames(shop),
  ]);
  const ready = setup.managedProducts > 0 && setup.suppliers > 0 && setup.managedWithSuppliers > 0 && !!rules;
  const running = ready && agentOn(log);
  const signed = log.filter((e) => e.event.type === "ruleset_signed").at(-1);
  const firstPurchase = log.some((e) => e.event.type === "payout" || e.event.type === "order_captured");
  const checkedAt = new Date();
  const totals = spending(log, checkedAt);
  const problems = currentProblems(log, checkedAt);

  return {
    shop,
    purchasing: chain.valid
      ? {
          snapshot: insightsSnapshot(log, names, checkedAt),
          licenseKey: process.env.AG_STUDIO_LICENSE_KEY ?? "",
          gridLicenseKey: process.env.AG_GRID_LICENSE_KEY ?? "",
          enabled:
            process.env.NODE_ENV !== "production" ||
            !!(
              process.env.AG_STUDIO_LICENSE_KEY &&
              process.env.AG_GRID_LICENSE_KEY
            ),
          aiConfigured: insightsAiConfigured(),
        }
      : null,
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
    spentCents: totals.spentLast7dCents,
    budget: budgetSummary(totals.spentLast7dCents, totals.pendingCents, rules?.weeklySpendCapCents ?? 0),
    balanceCents,
    waiting: queue.length,
    blocked: { count: score.real.blocked, cents: score.real.blockedCents },
    attacksBlocked: score.attacks.blocked + score.attacks.flagged,
    chain,
    head: log.at(-1)?.hash ?? null,
    problems,
    firstPurchase,
    products: products && products.map((p) => ({ ...p, cover: Number.isFinite(p.cover) ? Number(p.cover.toFixed(1)) : null, status: productStatus(log, p, rules, running) })),
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
    return { ok: true, message: on ? "Automatic restocking enabled" : "Automatic restocking disabled" };
  }
  return { ok: false, message: "Unknown action" };
};

const STATUS_TONE: Record<string, Tone> = { success: "success", warning: "caution", critical: "critical", info: "info", neutral: "neutral" };
export default function Home() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const busy = fetcher.state !== "idle";
  const steps = [
    { done: d.setup.managedProducts > 0, label: "Switch on the products GuardBuy may restock", why: "GuardBuy only ever buys products you switch on.", action: "Choose products", href: "/app/products" },
    { done: d.setup.suppliers > 0, label: "Add your suppliers", why: "GuardBuy only pays suppliers you add, at the PayPal email you enter.", action: "Add a supplier", href: "/app/products?tab=suppliers" },
    { done: d.setup.managedWithSuppliers > 0, label: "Link a supplier to each product", why: "Tells the agent who sells each product, and at what price.", action: "Link suppliers", href: "/app/products?view=managed" },
    { done: !!d.rules, label: "Sign your spending rules", why: "Signing activates automatic purchases within your limits. Flagged purchases still wait for your approval.", action: "Review and sign rules", href: "/app/rules?tab=rules" },
  ];
  const doneSteps = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done);
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
      <s-button slot="secondary-actions" href="/app/rules?tab=rules">Edit rules</s-button>

      {/* Status, alerts (only when needed) and the key numbers */}
      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={d.running ? "success" : d.paused ? "caution" : "info"}>{d.running ? "Running" : d.paused ? "Paused" : "Setup needed"}</s-badge>
            <s-text tone="neutral">
              {d.running
                ? `Restocks your switched-on products within your signed rules. Purchases above ${d.rules?.approvalAbove} wait for you.`
                : d.paused ? "New restock proposals are paused. Check existing purchases in Rules & Approvals." : `${doneSteps} of 4 setup steps done. Nothing is bought before setup is finished.`}
            </s-text>
          </s-stack>
          {!d.chain.valid && (
            <s-banner tone="critical" heading="The audit log failed verification">
              Entry #{d.chain.brokenAtSeq}: {d.chain.reason}. <s-link href="/app/activity">View activity</s-link>
            </s-banner>
          )}
          {d.waiting > 0 && (
            <s-banner tone="warning" heading={`${plural(d.waiting, "purchase")} waiting for your approval`}>
              <s-link href="/app/rules?tab=approvals">Review now</s-link>
            </s-banner>
          )}
          {d.problems.payments + d.problems.proposals > 0 && (
            <s-banner tone="critical" heading={`${plural(d.problems.payments + d.problems.proposals, "current problem")}`}>
              {d.problems.payments > 0 && <s-paragraph>Review unpaid purchases in <s-link href="/app/rules?tab=approvals">Approvals</s-link>. Check the original payment status before retrying.</s-paragraph>}
              {d.problems.proposals > 0 && <s-paragraph>An AI proposal failed. Review the error in Activity before trying another restock.</s-paragraph>}
              <s-link href="/app/activity">View activity</s-link>
            </s-banner>
          )}
          {lowBalance && (
            <s-banner tone="warning" heading="PayPal balance is close to your minimum">
              Purchases that would take the balance below {usd(d.rules!.cashFloorCents)} are blocked.
            </s-banner>
          )}
          {d.ready && (
            <s-query-container>
            <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr 1fr 1fr 1fr" gap="base">
              <Metric label="Spent · last 7 days" value={usd(d.spentCents)} detail={capCents ? `of ${usd(capCents)} rolling 7-day cap` : undefined}>
                {capCents > 0 && (
                  <s-text>{`Committed: ${usd(d.budget.committed)} of ${usd(capCents)}`}</s-text>
                )}
              </Metric>
              <Metric label="Reserved" value={usd(d.budget.reserved)} detail="Pending payments and unexpired approval commitments" />
              <Metric label="Remaining budget" value={usd(d.budget.remaining)} detail={d.budget.over ? `${usd(d.budget.over)} over the cap; review purchases in Rules & Approvals` : "Cap minus spent and reserved"} />
              <Metric label="PayPal balance after commitments" value={d.balanceCents === null ? "Unavailable" : usd(d.balanceCents)} detail={d.balanceCents === null ? "PayPal unavailable. Refresh this page; check Approvals before retrying a payment." : d.rules ? `Minimum PayPal balance: ${usd(d.rules.cashFloorCents)}` : undefined} badge={lowBalance ? { tone: "caution", label: "Low" } : undefined} />
              <Metric label={APPROVAL_LABEL.waiting} value={String(d.waiting)} detail={d.waiting ? "Review purchases" : "Nothing to approve"} href={d.waiting ? "/app/rules?tab=approvals" : undefined} />
              <Metric label="Blocked purchases" value={String(d.blocked.count)} detail={d.blocked.count ? `${usd(d.blocked.cents)} in blocked proposals` : "Nothing blocked yet"} href="/app/activity" />
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
            <s-progress value={doneSteps} max={4} accessibilityLabel="Setup progress" />
            {steps.map((s, i) =>
              i === next ? (
                <s-box key={s.label} padding="base" background="subdued" borderRadius="base">
                  <s-stack gap="small-200">
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <s-badge tone="info">{`Next · step ${i + 1}`}</s-badge>
                      <s-text type="strong">{s.label}</s-text>
                    </s-stack>
                    <s-text tone="neutral">{s.why}</s-text>
                    <s-box><s-button variant="primary" href={s.href}>{s.action}</s-button></s-box>
                  </s-stack>
                </s-box>
              ) : (
                <s-stack key={s.label} direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={s.done ? "success" : "neutral"}>{s.done ? "Done" : `Step ${i + 1}`}</s-badge>
                  {s.done ? <s-text tone="neutral">{s.label}</s-text> : <s-link href={s.href}>{s.label}</s-link>}
                </s-stack>
              ),
            )}
          </s-stack>
        </s-section>
      )}

      {d.running && !d.firstPurchase && d.rules && (
        <s-section heading="You're live">
          <s-stack gap="small-200">
            <s-text>
              {`When a switched-on product has less than ${plural(d.rules.reorderBelow, "day")} of stock left, the agent proposes a restock. Up to ${d.rules.approvalAbove} it may submit payment through PayPal when all rules allow it; purchases needing approval wait in Rules & Approvals. Payment is confirmed separately.`}
            </s-text>
            <s-text tone="neutral">Stock is checked on every sale and once an hour. Every step is recorded in the audit log, which you can verify in Activity.</s-text>
          </s-stack>
        </s-section>
      )}

      {d.purchasing &&
        (!d.purchasing.enabled ? (
          <s-section>
            <s-banner tone="info" heading="Purchasing analysis is being set up">
              Your dashboard will be available when setup is complete.
            </s-banner>
          </s-section>
        ) : mounted ? (
          <Suspense
            fallback={
              <s-section>
                <s-text>Loading purchasing analysis…</s-text>
              </s-section>
            }
          >
            <PurchasingDashboard
              key={`${d.shop}:${d.purchasing.snapshot.checkedAt}`}
              {...d.purchasing}
              shop={d.shop}
              home
            />
          </Suspense>
        ) : (
          <s-section>
            <s-text>Loading purchasing analysis…</s-text>
          </s-section>
        ))}

      {d.ready && (
        <s-section>
          {/* Responsive values are comma-separated, so the column lists must not contain commas themselves */}
          <s-query-container>
          <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr" gap="large">
            <s-stack gap="small-200">
              <s-heading>Your rules</s-heading>
              {d.rules && (
                <>
                  <Row label={COPY.approvalAbove}><s-text>{d.rules.approvalAbove}</s-text></Row>
                  <Row label={COPY.spendingCap}><s-text>{usd(d.rules.weeklyCapCents)}</s-text></Row>
                  <Row label={COPY.cashFloor}><s-text>{usd(d.rules.cashFloorCents)}</s-text></Row>
                  <Row label="Restock below"><s-text>{`${plural(d.rules.reorderBelow, "day")} of stock`}</s-text></Row>
                  <Row label="May buy from"><s-text>{d.rules.allowlist.join(", ")}</s-text></Row>
                </>
              )}
              <s-text tone="neutral">
                {d.signed ? `Signed by ${d.signed.by} · ${new Date(d.signed.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Not signed yet"}
              </s-text>
              <s-link href="/app/rules?tab=rules">Edit rules</s-link>
            </s-stack>
            <s-stack gap="small-200">
              <s-heading>Audit trail</s-heading>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-text tone="neutral">Audit log</s-text>
                <s-badge tone={d.chain.valid ? "success" : "critical"}>
                  {d.chain.valid ? `Audit log intact · ${d.chain.length} ${d.chain.length === 1 ? "entry" : "entries"}` : `Broken at entry #${d.chain.brokenAtSeq}`}
                </s-badge>
              </s-stack>
              <Row label="Fingerprint"><s-text>{d.head ? d.head.slice(0, 16) : "None yet"}</s-text></Row>
              <Row label="Blocked"><s-text>{`${plural(d.blocked.count, "purchase")}${d.attacksBlocked > 0 ? ` · ${plural(d.attacksBlocked, "attack")} stopped in tests` : ""}`}</s-text></Row>
              <s-stack direction="inline" gap="base">
                <s-link href="/app/activity">Verify the log</s-link>
              </s-stack>
            </s-stack>
          </s-grid>
          </s-query-container>
        </s-section>
      )}

      <s-section heading="Products">
        {d.products === null ? (
          <Unavailable what="your products" />
        ) : d.products.length === 0 ? (
          <Empty heading="No products in your store yet">Products you add in Shopify show up here, ready to switch on for GuardBuy.</Empty>
        ) : (
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
                <s-table-cell>{p.supplier ?? <s-link href={`/app/products/${p.variantId}`}>Link a supplier</s-link>}</s-table-cell>
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
        )}
      </s-section>

      <s-section heading="Recent activity">
        {d.recent.length === 0 ? (
          <Empty heading="No activity yet">Low stock, the agent’s proposals, decisions from your rules and payments show up here as they happen.</Empty>
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
        <s-box paddingBlockStart="small-200"><s-link href="/app/activity">View all activity</s-link></s-box>
      </s-section>
      <s-section><s-paragraph><s-link href="/privacy" target="_blank">Privacy policy</s-link> · What GuardBuy reads, shares and retains.</s-paragraph></s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => {
  const headers = new Headers(boundary.headers(args));
  headers.set("Cache-Control", "private, no-store");
  return headers;
};

export { PageError as ErrorBoundary } from "../components/page-error";
