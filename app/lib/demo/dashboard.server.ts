import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../../db.server";
import { privacyBlocked } from "../privacy/state.server";
import { auditEntries } from "../audit/log.server";
import { agentOn, currentRuleSet } from "../agent/restock.server";
import { incomingFor } from "../inventory/deliveries";
import { salesPerDay } from "../inventory/sales.server";
import { demoEnabled, publicAudit } from "./public-dashboard";

export function requirePublicDemo(shop: string) {
  if (!demoEnabled(shop, { enabled: process.env.GUARDBUY_PUBLIC_DEMO_ENABLED, shop: process.env.GUARDBUY_DEMO_STORE, paypalBase: process.env.PAYPAL_API_BASE })) {
    throw new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}

export const DEMO_STOCK_QUERY = `#graphql
  query PublicDemoStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id displayName inventoryQuantity createdAt product { handle } }
    }
  }
`;
export const DEMO_ORDERS_QUERY = `#graphql
  query PublicDemoOrders($query: String!) {
    ordersCount(query: $query) { count precision }
  }
`;
type Variant = { id: string; displayName: string; inventoryQuantity: number | null; createdAt: string; product: { handle: string } };

async function snapshot(admin: AdminApiContext, shop: string) {
  const log = await auditEntries(shop);
  const rules = currentRuleSet(log);
  const [stockResult, orderResult] = await Promise.allSettled([
    (async () => {
      const managed = await db.managedProduct.findMany({ where: { shop, managed: true }, select: { variantId: true }, orderBy: { variantId: "asc" }, take: 51 });
      const ids = managed.slice(0, 50).map((p) => `gid://shopify/ProductVariant/${p.variantId}`);
      if (!ids.length) return { products: [], truncated: false };
      const response = await admin.graphql(DEMO_STOCK_QUERY, { variables: { ids } });
      const body = await response.json() as { data?: { nodes: (Variant | null)[] }; errors?: unknown[] };
      if (body.errors?.length || !body.data) throw new Error("Stock unavailable");
      const products = await Promise.all(body.data.nodes.filter((v): v is Variant => !!v).map(async (v) => {
        const perDay = await salesPerDay(shop, v.id.split("/").at(-1)!, new Date(v.createdAt));
        const threshold = rules && perDay > 0 ? rules.reorderBelowDaysOfCover * perDay : null;
        return {
          title: v.displayName,
          href: `/products/${encodeURIComponent(v.product.handle)}`,
          available: v.inventoryQuantity,
          incoming: incomingFor(log, v.id.split("/").at(-1)!),
          reorderBelowUnits: threshold === null ? null : Math.ceil(threshold),
          low: v.inventoryQuantity !== null && threshold !== null && v.inventoryQuantity < threshold,
        };
      }));
      return { products, truncated: managed.length > 50 };
    })(),
    (async () => {
      const since = new Date().toISOString().slice(0, 10);
      const response = await admin.graphql(DEMO_ORDERS_QUERY, { variables: { query: `test:true created_at:>=${since}T00:00:00Z` } });
      const body = await response.json() as { data?: { ordersCount: { count: number; precision: string } }; errors?: unknown[] };
      if (body.errors?.length || !body.data?.ordersCount) throw new Error("Orders unavailable");
      return { ...body.data.ordersCount, since };
    })(),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    agentRunning: !!rules && agentOn(log),
    stock: stockResult.status === "fulfilled" ? stockResult.value : null,
    orders: orderResult.status === "fulfilled" ? orderResult.value : null,
    ...publicAudit(log),
  };
}

// A short shared snapshot limits Shopify traffic from public tabs. Failed reads are retried.
let cached: { shop: string; expires: number; pending: ReturnType<typeof snapshot> } | undefined;
export async function publicDashboard(admin: AdminApiContext, shop: string) {
  requirePublicDemo(shop); // Check on every request, including cache hits.
  if (await privacyBlocked(shop)) throw new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (cached?.shop === shop && cached.expires > Date.now()) return cached.pending;
  const pending = snapshot(admin, shop);
  cached = { shop, expires: Date.now() + 15_000, pending };
  void pending.catch(() => { if (cached?.pending === pending) cached = undefined; });
  return pending;
}
