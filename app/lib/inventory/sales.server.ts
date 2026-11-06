import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import db from "../../db.server";
import { privacyWriteAllowed } from "../privacy/state.server";
import { TX_OPTIONS } from "../audit/log.server";

// Sales history is kept as net daily totals per variant only: no order IDs, prices or customer data.
export const SALES_WINDOW_DAYS = 30;
export const RETENTION_DAYS = 90;
const WEBHOOK_MEMORY_DAYS = 7;
const DAY_MS = 86_400_000;

const utcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** "gid://shopify/ProductVariant/123" or 123 -> "123" (webhooks send numbers, GraphQL sends GIDs). */
export const variantKey = (id: string | number) => String(id).split("/").pop()!;

type SaleLine = { variantId: string | number | null; units: number };

/**
 * Applies one webhook's sales change exactly once: Shopify may deliver the same event more than once,
 * so the event id is recorded in the same transaction as the totals. Returns false for a duplicate.
 * `units` is negative for refunds.
 */
export async function recordSalesOnce(shop: string, eventId: string, topic: string, at: Date, lines: SaleLine[]) {
  const day = utcDay(at);
  return db.$transaction(async (tx) => {
    if (!await privacyWriteAllowed(tx, shop)) return false;
    const { count } = await tx.processedWebhook.createMany({ data: [{ eventId, topic, shop }], skipDuplicates: true });
    if (count === 0) return false;
    for (const { variantId, units } of lines) {
      if (variantId == null || units === 0) continue;
      const key = { shop, variantId: variantKey(variantId), day };
      await tx.dailySales.upsert({
        where: { shop_variantId_day: key },
        create: { ...key, units },
        update: { units: { increment: units } },
      });
    }
    return true;
  }, TX_OPTIONS);
}

/** Forgets delivered webhook ids after a week (Shopify stops retrying long before that). */
export async function pruneProcessedWebhooks() {
  await db.processedWebhook.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - WEBHOOK_MEMORY_DAYS * DAY_MS) } } });
}

/** Rebuilds the last `days` of daily totals from Shopify orders (on install, or to repair gaps). */
export async function backfillSales(admin: AdminApiContext, shop: string, days = SALES_WINDOW_DAYS) {
  const since = new Date(Date.now() - days * DAY_MS);
  const totals = new Map<string, number>(); // "variantId|YYYY-MM-DD" -> units
  let cursor: string | null = null;
  let orderCount = 0;

  type Page = {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        processedAt: string;
        // currentQuantity = quantity minus refunded / removed units, so refunds are already netted out
        lineItems: { nodes: { currentQuantity: number; variant: { id: string } | null }[] };
      }[];
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
            lineItems(first: 100) { nodes { currentQuantity variant { id } } }
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
        if (!li.variant || li.currentQuantity <= 0) continue;
        const key = `${variantKey(li.variant.id)}|${day}`;
        totals.set(key, (totals.get(key) ?? 0) + li.currentQuantity);
      }
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`[sales] backfill ${shop}: ${orderCount} orders since ${since.toISOString().slice(0, 10)}`);

  const rows = [...totals].map(([key, units]) => {
    const [variantId, day] = key.split("|");
    return { shop, variantId, day: new Date(`${day}T00:00:00Z`), units };
  });

  // Webhooks can arrive twice or concurrently: a per-shop lock serializes backfills, and the
  // completion marker is written with the rows so a half-finished backfill never counts.
  await db.$transaction(async (tx) => {
    if (!await privacyWriteAllowed(tx, shop)) return;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`;
    await tx.dailySales.deleteMany({ where: { shop, day: { gte: utcDay(since) } } });
    await tx.dailySales.createMany({ data: rows });
    await tx.salesBackfill.upsert({
      where: { shop },
      create: { shop, completedAt: new Date() },
      update: { completedAt: new Date() },
    });
  }, TX_OPTIONS);
  await pruneOldSales(shop);
  await pruneProcessedWebhooks();
  return rows.length;
}

/** Enforces the 90-day retention promise. */
export async function pruneOldSales(shop: string) {
  await db.dailySales.deleteMany({
    where: { shop, day: { lt: utcDay(new Date(Date.now() - RETENTION_DAYS * DAY_MS)) } },
  });
}

/**
 * Average net units sold per day. The window is the last 30 days, shortened for a product that is
 * newer than that (or whose first sale in the window came later), so a 5-day-old product isn't
 * divided by 30. Days with no sales inside the window count as zero.
 */
export async function salesPerDay(shop: string, variantId: string, createdAt?: Date, now = new Date()) {
  const windowStart = utcDay(new Date(now.getTime() - SALES_WINDOW_DAYS * DAY_MS));
  const rows = await db.dailySales.findMany({ where: { shop, variantId, day: { gte: windowStart } }, orderBy: { day: "asc" } });
  const units = rows.reduce((sum, r) => sum + r.units, 0);
  if (units <= 0) return 0;

  const daysSince = (d: Date) => (now.getTime() - d.getTime()) / DAY_MS;
  const firstSale = rows.find((r) => r.units > 0)?.day;
  const activeDays = Math.max(createdAt ? daysSince(createdAt) : SALES_WINDOW_DAYS, firstSale ? daysSince(firstSale) : 0);
  return units / Math.min(SALES_WINDOW_DAYS, Math.max(1, activeDays));
}

/** How many days the current stock lasts at the recent sales rate (Infinity if nothing sells). */
export function daysOfCover(available: number, perDay: number) {
  if (perDay <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, available) / perDay;
}
