import { resetRestockBlock, resetRestockCooldown } from "../lib/merchant/reset-restock-cooldown.server";
import { restockBlock, restockCooldown } from "../lib/agent/restock-cooldown";
import { manageProduct } from "../lib/merchant/manage-product.server";
import { LoadingState } from "../components/loading-state";
import { homeWorkspace } from "../lib/insights/workspace";
import { deliveries } from "../lib/inventory/deliveries";
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
import { approvalCount } from "../lib/agent/approval-state";
import { agentOn, currentRuleSet, setAgentState, spending } from "../lib/agent/restock.server";
import { scoreboard } from "../lib/agent/scoreboard.server";
import { cachedBalanceCents, feedNames, productOverview, productStatus } from "../lib/merchant/dashboard.server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { setupStatus, supplierRoster } from "../lib/suppliers/directory.server";
import { plural } from "../components/ui";

// Home: what the agent is doing, what it spent, which products need attention, and what changed.
// While setup isn't finished, the setup checklist takes the place of the numbers.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, actor } = await adminWithStaff(request);
  const shop = session.shop;
  const log = await auditEntries(shop);
  const rules = currentRuleSet(log);
  const [setup, chain, score, balanceCents, products, names, suppliers] = await Promise.all([
    setupStatus(shop), verifyChain(shop), scoreboard(shop, log), cachedBalanceCents(),
    // Shopify's API can be briefly unreachable: show the rest of Home and a retry for the product list.
    productOverview(admin, shop).catch((e) => { console.warn(`[home] products unavailable: ${(e as Error).message}`); return null; }),
    feedNames(shop),
    supplierRoster(shop).catch(() => null),
  ]);
  const ready = setup.managedProducts > 0 && setup.suppliers > 0 && setup.managedWithSuppliers > 0 && !!rules;
  const running = ready && agentOn(log);
  const signed = log.filter((e) => e.event.type === "ruleset_signed").at(-1);
  const firstPurchase = log.some((e) => e.event.type === "payout" || e.event.type === "order_captured");
  const checkedAt = new Date();
  const totals = spending(log, checkedAt);
  const problems = currentProblems(log, checkedAt);

  const incoming = deliveries(log, checkedAt).filter((delivery) => delivery.payment !== "failed" || delivery.pending);
  const data = {
    suppliers,
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
    waiting: approvalCount(log, checkedAt),
    blocked: { count: score.real.blocked, cents: score.real.blockedCents },
    attacksBlocked: score.attacks.blocked + score.attacks.flagged,
    chain,
    head: log.at(-1)?.hash ?? null,
    problems,
    firstPurchase,
    products: products && products.map((p) => ({ ...p, cooldown: restockCooldown(p, log), block: restockBlock(p, log), incoming: incoming.filter((delivery) => delivery.variantId === p.variantId).reduce((sum, delivery) => sum + delivery.remaining, 0), cover: Number.isFinite(p.cover) ? Number(p.cover.toFixed(1)) : null, status: productStatus(log, p, rules, running) })),
    recent: toFeed(log, actor, names).filter((f) => f.kind !== "status").slice(0, 100),
  };
  return {...data, workspace: homeWorkspace(data)};
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, actor } = await adminWithStaff(request);
  const f = await request.formData();
  if (f.get("intent") === "reset-restock-cooldown") {
    const rejected = String(f.get("rejectedSeq") ?? "");
    if (!/^\d+$/.test(rejected)) return { ok: false, message: "Invalid cooldown" };
    return resetRestockCooldown(admin, session.shop, actor, String(f.get("variantId") ?? ""), Number(rejected));
  }
  if (f.get("intent") === "reset-restock-block") {
    const decision = String(f.get("decisionSeq") ?? "");
    if (!/^\d+$/.test(decision)) return { ok: false, message: "Invalid block" };
    return resetRestockBlock(admin, session.shop, actor, String(f.get("variantId") ?? ""), Number(decision));
  }
  if (f.get("intent") === "agent") {
    await setAgentState(session.shop, f.get("on") === "true", actor);
    return { ok: true, message: f.get("on") === "true" ? "Agent resumed" : "Agent paused" };
  }
  if (f.get("intent") === "manage") {
    const variantId = String(f.get("variantId") ?? "");
    if (!/^\d+$/.test(variantId)) return { ok: false, message: "Unknown product" };
    const on = f.get("managed") === "true";
    return manageProduct(admin,session.shop,{variantId,sku:String(f.get("sku")||"")||null,title:String(f.get("title")??"")},on);
  }
  return { ok: false, message: "Unknown action" };
};

export default function Home() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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
  const lowBalance = d.balanceCents !== null && d.rules !== null && d.balanceCents < d.rules.cashFloorCents * 1.5;

  return (
    <s-page heading="GuardBuy" inlineSize="large">
      {d.ready && (
        <s-button slot="primary-action" variant="primary" disabled={busy}
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
                <LoadingState label="Loading purchasing analysis" height={640}/>
              </s-section>
            }
          >
            <PurchasingDashboard
              key={`${d.shop}:${d.purchasing.snapshot.checkedAt}`}
              {...d.purchasing}
              shop={d.shop}
              workspace={d.workspace}
              busy={busy}
              onManage={(product) => fetcher.submit({ intent: "manage", variantId: product.variantId, sku: product.sku ?? "", title: product.title, managed: String(!product.managed) }, { method: "POST" })}
            />
          </Suspense>
        ) : (
          <s-section>
            <LoadingState label="Loading purchasing analysis" height={640}/>
          </s-section>
        ))}

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
