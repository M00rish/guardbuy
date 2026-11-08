import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { paymentStatus } from "../payments/status";
import db from "../../db.server";
import { approvalStates } from "../agent/approval-state";
import { unknownPaymentDecisions } from "../payments/attempts";
import { deliveries } from "../inventory/deliveries";
import type { AuditEntry, RuleSet } from "../policy/schema";
import { paypalBalanceCents } from "../agent/restock.server";
import { daysOfCover, salesPerDay, variantKey } from "../inventory/sales.server";

// Data for the merchant Home page: the PayPal balance (cached), and every product with its stock,
// days of cover, preferred supplier and what the agent is doing about it.

const BALANCE_TTL_MS = 60_000;
let balanceCache: { cents: number | null; at: number } | null = null;

/** PayPal balance, cached for a minute so reloading Home doesn't call PayPal every time. */
export async function cachedBalanceCents() {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.cents;
  balanceCache = { cents: await paypalBalanceCents(), at: Date.now() };
  return balanceCache.cents;
}

export type ProductStatus = { label: string; tone: "success" | "warning" | "critical" | "info" | "neutral"; at?: string };

const DAY_MS = 86_400_000;
const OPEN_MS = 3 * DAY_MS;

/** What the agent is doing about one product, from its latest (non-test) proposal in the log. */
export function productStatus(
  log: AuditEntry[],
  p: { variantId: string; sku: string | null; managed: boolean; cover: number },
  rules: RuleSet | null,
  agentRunning: boolean,
  now = new Date(),
): ProductStatus {
  for (const seq of unknownPaymentDecisions(log)) {
    const d = log.find((e) => e.seq === seq)?.event;
    const proposal = d?.type === "decision" ? log.find((e) => e.seq === d.proposalSeq)?.event : undefined;
    if (proposal?.type === "proposal" && proposal.proposal.variantId === p.variantId) return { label: "Payment reserved · check Approvals", tone: "warning" };
  }
  for (const state of approvalStates(log, now).filter((s) => s.status === "payment_failed")) {
    const d = log.find((e) => e.seq === state.decisionSeq)?.event;
    const proposalEntry = d?.type === "decision" ? log.find((e) => e.seq === d.proposalSeq) : undefined;
    const proposal = proposalEntry?.event;
    const newer = log.some((e) => e.seq > (proposalEntry?.seq ?? -1) && e.event.type === "proposal" && !e.event.scenario && e.event.proposal.variantId === p.variantId);
    if (!newer && proposal?.type === "proposal" && proposal.proposal.variantId === p.variantId) {
      const payment = log.find((e) => (e.event.type === "payout" || e.event.type === "order_captured") && e.event.decisionSeq === state.decisionSeq);
      return { label: `${payment ? paymentStatus(log, payment).label : "Payment failed"} · check Approvals`, tone: "critical" };
    }
  }
  const delivery = deliveries(log, now).find((d) => d.variantId === p.variantId && (d.remaining > 0 || d.pending) && (d.payment !== "failed" || d.pending));
  if (delivery) return { label: delivery.pending ? "Receipt needs confirmation" : delivery.payment === "pending" ? `Payment pending · ${delivery.remaining} on order` : `${delivery.remaining} incoming · ${delivery.overdue ? "overdue" : delivery.partialRefund ? "partial refund · review delivery" : "awaiting delivery"}`, tone: delivery.overdue || delivery.partialRefund ? "warning" : "info" };
  if (!p.managed) return { label: "Not managed", tone: "neutral" };
  const last = log
    .filter((e) => e.event.type === "proposal" && !e.event.scenario && (e.event.proposal.variantId ? e.event.proposal.variantId === p.variantId : e.event.proposal.sku === p.sku))
    .at(-1);
  if (last && now.getTime() - Date.parse(last.at) < OPEN_MS) {
    const decision = log.find((e) => e.event.type === "decision" && e.event.proposalSeq === last.seq);
    const d = decision?.event.type === "decision" ? decision : null;
    const of = (type: string) => (d ? log.filter((e) => e.event.type === type && "decisionSeq" in e.event && e.event.decisionSeq === d.seq).at(-1) : undefined);
    const paid = of("payout") ?? of("order_captured");
    const total = d?.event.type === "decision" ? `$${(d.event.decision.totalCents / 100).toFixed(2)}` : "";
    if (paid) { const state = paymentStatus(log, paid); return { label: `${state.label} · ${total}`, tone: state.tone, at: paid.at }; }
    if (of("rejected")) return { label: "You declined the restock", tone: "neutral", at: of("rejected")!.at };
    if (of("payment_failed")) return { label: "Payment failed · check Activity", tone: "critical", at: of("payment_failed")!.at };
    const created = of("order_created");
    const closed = created?.event.type === "order_created" && log.some((e) => e.event.type === "order_closed" && created.event.type === "order_created" && e.event.orderId === created.event.orderId);
    if (created && !closed) return { label: "Waiting for PayPal approval", tone: "warning", at: last.at };
    if (d?.event.type === "decision" && d.event.decision.verdict === "approval") return { label: `Waiting for your approval · ${total}`, tone: "warning", at: last.at };
    if (d?.event.type === "decision" && d.event.decision.verdict === "block") return { label: "Blocked by your rules", tone: "critical", at: last.at };
  }
  if (rules && p.cover < rules.reorderBelowDaysOfCover) {
    return agentRunning ? { label: "Low · restock on next stock change", tone: "info" } : { label: "Low · agent is off", tone: "warning" };
  }
  return { label: "OK", tone: "success" };
}

type VariantsQuery = {
  products: {
    nodes: { title: string; variants: { nodes: { id: string; title: string; sku: string | null; inventoryQuantity: number | null; createdAt: string }[] } }[];
  };
};

/** Every product variant in the store with stock, sales rate, days of cover and preferred supplier. */
export async function productOverview(admin: AdminApiContext, shop: string) {
  const res = await admin.graphql(`#graphql
    query GuardBuyOverview {
      products(first: 50, sortKey: TITLE) {
        nodes { title variants(first: 20) { nodes { id title sku inventoryQuantity createdAt } } }
      }
    }`);
  const { data } = (await res.json()) as { data: VariantsQuery };
  const [managed, preferred] = await Promise.all([
    db.managedProduct.findMany({ where: { shop } }),
    db.productSupplier.findMany({ where: { shop }, include: { supplier: true }, orderBy: { preferred: "desc" } }),
  ]);
  const isOn = new Map(managed.map((m) => [m.variantId, m.managed]));

  const rows = await Promise.all(
    data.products.nodes.flatMap((p) =>
      p.variants.nodes.map(async (v) => {
        const variantId = variantKey(v.id);
        const stock = v.inventoryQuantity ?? 0;
        const perDay = await salesPerDay(shop, variantId, new Date(v.createdAt));
        const supplier = preferred.find((l) => l.variantId === variantId);
        return {
          variantId,
          title: v.title === "Default Title" ? p.title : `${p.title} · ${v.title}`,
          sku: v.sku || null,
          stock,
          perDay,
          cover: daysOfCover(stock, perDay),
          managed: isOn.get(variantId) ?? false,
          supplier: supplier?.supplier.name ?? null,
        };
      }),
    ),
  );
  // Most urgent first: managed products by days of cover, then the rest.
  return rows.sort((a, b) => Number(b.managed) - Number(a.managed) || a.cover - b.cover);
}

/** Product and supplier names for the activity feed (instead of SKUs and ids). */
export async function feedNames(shop: string) {
  const [products, suppliers] = await Promise.all([
    db.managedProduct.findMany({ where: { shop }, select: { variantId: true, sku: true, title: true } }),
    db.supplier.findMany({ where: { shop }, select: { id: true, name: true } }),
  ]);
  const byVariant = new Map(products.map((p) => [p.variantId, p.title]));
  const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!, p.title]));
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  return {
    product: (sku: string, variantId?: string) => (variantId && byVariant.get(variantId)) || bySku.get(sku),
    supplier: (id: string) => supplierName.get(id),
  };
}
