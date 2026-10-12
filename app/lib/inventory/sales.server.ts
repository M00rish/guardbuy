import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import db from "../../db.server";

// Sales history is kept as daily totals per SKU only: no order IDs, prices or customer data.
export const SALES_WINDOW_DAYS = 30;
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

const utcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** Adds units sold to a SKU's daily total (called from the orders/create webhook). */
export async function recordSale(shop: string, sku: string, at: Date, units: number) {
  const day = utcDay(at);
  await db.dailySales.upsert({
    where: { shop_sku_day: { shop, sku, day } },
    create: { shop, sku, day, units },
    update: { units: { increment: units } },
  });
}

/** Rebuilds the last `days` of daily totals from Shopify orders (on install, or to repair gaps). */
export async function backfillSales(admin: AdminApiContext, shop: string, days = SALES_WINDOW_DAYS) {
  const since = new Date(Date.now() - days * DAY_MS);
  const totals = new Map<string, number>(); // "sku|YYYY-MM-DD" -> units
  let cursor: string | null = null;
  let orderCount = 0;

  type Page = {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { processedAt: string; lineItems: { nodes: { sku: string | null; quantity: number }[] } }[];
    };
  };

  do {
    const res: Response = await admin.graphql(
      `#graphql
      query SalesHistory($cursor: String, $query: String!) {
        orders(first: 100, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            processedAt
            lineItems(first: 50) { nodes { sku quantity } }
          }
        }
      }`,
      { variables: { cursor, query: `processed_at:>=${since.toISOString()}` } },
    );
    const { data }: { data: Page } = await res.json();
    orderCount += data.orders.nodes.length;
    for (const order of data.orders.nodes) {
      const day = order.processedAt.slice(0, 10);
      for (const li of order.lineItems.nodes) {
        if (!li.sku) continue;
        const key = `${li.sku}|${day}`;
        totals.set(key, (totals.get(key) ?? 0) + li.quantity);
      }
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`[sales] backfill ${shop}: ${orderCount} orders since ${since.toISOString().slice(0, 10)}`);

  const rows = [...totals].map(([key, units]) => {
    const [sku, day] = key.split("|");
    return { shop, sku, day: new Date(`${day}T00:00:00Z`), units };
  });

  // Webhooks can arrive twice or concurrently: a per-shop lock serializes backfills, and the
  // completion marker is written with the rows so a half-finished backfill never counts.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`;
    await tx.dailySales.deleteMany({ where: { shop, day: { gte: utcDay(since) } } });
    await tx.dailySales.createMany({ data: rows });
    await tx.salesBackfill.upsert({
      where: { shop },
      create: { shop, completedAt: new Date() },
      update: { completedAt: new Date() },
    });
  });
  await pruneOldSales(shop);
  return rows.length;
}

/** Enforces the 90-day retention promise. */
export async function pruneOldSales(shop: string) {
  await db.dailySales.deleteMany({
    where: { shop, day: { lt: utcDay(new Date(Date.now() - RETENTION_DAYS * DAY_MS)) } },
  });
}

/** Average units sold per day over the window, counting days with no sales as zero. */
export async function salesPerDay(shop: string, sku: string, days = SALES_WINDOW_DAYS) {
  const { _sum } = await db.dailySales.aggregate({
    where: { shop, sku, day: { gte: utcDay(new Date(Date.now() - days * DAY_MS)) } },
    _sum: { units: true },
  });
  return (_sum.units ?? 0) / days;
}

/** How many days the current stock lasts at the recent sales rate (Infinity if nothing sells). */
export function daysOfCover(available: number, perDay: number) {
  if (perDay <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, available) / perDay;
}
