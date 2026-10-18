import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
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

/** "just now", "5 min ago", "3 h ago", "2 days ago" (computed in the browser, so it's local). */
function ago(iso: string, now: number) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Pill colors follow the architecture page: green = money, brown = AI, blue = information, red = stopped.
const FEED_PILL: Record<string, string> = {
  paid: "gb-pill-money", approved: "gb-pill-money", resisted: "gb-pill-money", auto: "gb-pill-money",
  block: "gb-pill-crit", failed: "gb-pill-crit", slipped: "gb-pill-crit",
  approval: "gb-pill-llm", flagged: "gb-pill-llm", declined: "gb-pill-muted",
  proposed: "gb-pill-llm", attack: "gb-pill-llm", stock: "gb-pill-read", paypal: "gb-pill-read", rules: "gb-pill-muted",
};
const PILL: Record<string, string> = { success: "gb-pill-money", warning: "gb-pill-llm", critical: "gb-pill-crit", info: "gb-pill-read", neutral: "gb-pill-muted" };
const FEED_LABEL: Record<string, string> = {
  paid: "Paid", approved: "Approved", auto: "Allowed", block: "Blocked", failed: "Failed", approval: "Needs you", declined: "Declined",
  stock: "Low stock", proposed: "Proposed", rules: "Rules", paypal: "PayPal", attack: "Attack test", resisted: "Resisted", flagged: "Flagged", slipped: "Gap",
};

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

      {/* Status, attention banners (only when needed) and the key numbers, in one card */}
      <s-section>
        <s-stack gap="base">
          <div className="gb-brand">
            <span className="gb-wordmark">GuardBuy</span>
            <span className="gb-eyebrow">AI restocking · your rules decide · every step on a verifiable log</span>
          </div>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <span className={`gb-pill ${d.running ? "gb-pill-money" : d.paused ? "gb-pill-llm" : "gb-pill-read"}`}>{d.running ? "Running" : d.paused ? "Paused" : "Setup needed"}</span>
            <s-text tone="neutral">
              {d.running
                ? `Restocks your switched-on products within your signed rules. Purchases above ${d.rules?.approvalAbove} wait for you.`
                : d.paused ? "Nothing is proposed or bought until you resume it." : `${doneSteps} of 4 setup steps done. Nothing is bought before setup is finished.`}
            </s-text>
          </s-stack>
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
          {!d.chain.valid && (
            <s-banner tone="critical" heading="The audit log failed verification">
              Entry #{d.chain.brokenAtSeq}: {d.chain.reason}. <s-link href="/app/activity">Open activity</s-link>
            </s-banner>
          )}
          {d.ready && (
            <div className="gb-metrics">
              <Metric accent="money" label="Spent this week" value={usd(d.spentCents)} detail={capCents ? `of ${usd(capCents)} weekly cap` : undefined}>
                {capCents > 0 && (
                  <div className={`gb-bar${d.spentCents > capCents * 0.8 ? " gb-bar-hot" : ""}`} role="progressbar" aria-label="Weekly spending" aria-valuenow={d.spentCents} aria-valuemax={capCents}>
                    <span style={{ width: `${Math.min(100, (d.spentCents / capCents) * 100)}%` }} />
                  </div>
                )}
              </Metric>
              <Metric accent={lowBalance ? "llm" : "ink"} label="PayPal balance" value={d.balanceCents === null ? "Unavailable" : usd(d.balanceCents)} detail={d.rules ? `Floor ${usd(d.rules.cashFloorCents)}` : undefined} />
              <Metric accent={d.waiting ? "llm" : "ink"} label="Waiting for you" value={String(d.waiting)} detail={d.waiting ? "Open Approvals" : "Nothing to approve"} href={d.waiting ? "/app/approvals" : undefined} />
              <Metric accent="money" label="Stopped by your rules" value={String(d.blocked.count)} detail={d.blocked.count ? `${usd(d.blocked.cents)} not spent` : "Nothing blocked yet"} href="/app/protection" />
            </div>
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
          <div className="gb-cards">
            <div className="gb-card">
              <h3>Your rules</h3>
              {d.rules && (
                <dl>
                  <dt>Ask me above</dt><dd>{d.rules.approvalAbove}</dd>
                  <dt>Weekly cap</dt><dd>{usd(d.rules.weeklyCapCents)}</dd>
                  <dt>Keep in PayPal</dt><dd>{usd(d.rules.cashFloorCents)}</dd>
                  <dt>Restock below</dt><dd>{plural(d.rules.reorderBelow, "day")} of stock</dd>
                  <dt>May buy from</dt><dd>{d.rules.allowlist.join(", ")}</dd>
                </dl>
              )}
              <div className="gb-foot">
                {d.signed && <>Signed by {d.signed.by} · {new Date(d.signed.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · </>}
                <Link to="/app/rules">Edit rules</Link>
              </div>
            </div>
            <div className="gb-card">
              <h3>Protection</h3>
              <dl>
                <dt>Audit log</dt>
                <dd>{d.chain.valid ? <span className="gb-pill gb-pill-money">intact · {d.chain.length} {d.chain.length === 1 ? "entry" : "entries"}</span> : <span className="gb-pill gb-pill-crit">broken at #{d.chain.brokenAtSeq}</span>}</dd>
                <dt>Fingerprint</dt><dd><span className="gb-mono">{d.head ? d.head.slice(0, 16) : "none yet"}</span></dd>
                <dt>Blocked</dt><dd>{plural(d.blocked.count, "purchase")}{d.attacksBlocked > 0 ? ` · ${plural(d.attacksBlocked, "attack")} stopped in tests` : ""}</dd>
              </dl>
              <div className="gb-foot"><Link to="/app/protection">Protection details</Link> · <Link to="/app/activity">Verify the log</Link></div>
            </div>
          </div>
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
                  <div className={`gb-name${p.managed ? "" : " gb-off"}`}>{p.title}</div>
                  {p.sku && <div className="gb-mono">{p.sku}</div>}
                </s-table-cell>
                <s-table-cell><span className="gb-num">{p.stock}</span></s-table-cell>
                <s-table-cell><span className="gb-num">{p.cover === null ? "–" : p.cover}</span></s-table-cell>
                <s-table-cell>{p.supplier ? <span className="gb-event">{p.supplier}</span> : <s-link href="/app/products">Link a supplier</s-link>}</s-table-cell>
                <s-table-cell>
                  <span className={`gb-pill ${PILL[p.status.tone]}`}>{p.status.label}</span>
                  {p.status.at && <span className="gb-when"> · {ago(p.status.at, now)}</span>}
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
                  <s-table-cell><span className={`gb-pill ${FEED_PILL[f.kind] ?? "gb-pill-muted"}`}>{FEED_LABEL[f.kind] ?? f.kind}</span></s-table-cell>
                  <s-table-cell><span className="gb-event">{f.title}</span></s-table-cell>
                  <s-table-cell><span className="gb-when">{ago(f.at, now)}</span></s-table-cell>
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

function Metric({ label, value, detail, href, accent, children }: { label: string; value: string; detail?: string; href?: string; accent: "money" | "ink" | "llm" | "crit"; children?: React.ReactNode }) {
  return (
    <div className={`gb-metric gb-accent-${accent}`}>
      <div className="gb-label">{label}</div>
      <div className="gb-value">{value}</div>
      {children}
      {detail && (href ? <Link className="gb-detail" to={href}>{detail}</Link> : <div className="gb-detail">{detail}</div>)}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
