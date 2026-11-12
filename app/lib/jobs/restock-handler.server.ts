import db from "../../db.server";
import { privacyBlocked } from "../privacy/state.server";
import { unauthenticated } from "../../shopify.server";
import { runRestock } from "../agent/restock.server";
import { checkStock, ensureSalesHistory, stockForInventoryItem } from "../inventory/trigger.server";
import { restockJobKey, type ClaimedRestockJob } from "./restock-queue.server";

export async function handleRestockJob(job: ClaimedRestockJob) {
  if (await privacyBlocked(job.shop)) return {};
  // Uninstalled stores must never be processed with old credentials or an old stock snapshot.
  if (!await db.session.findFirst({ where: { shop: job.shop, isOnline: false }, select: { id: true } })) return {};
  const { admin } = await unauthenticated.admin(job.shop);
  await ensureSalesHistory(admin, job.shop);
  const item = await stockForInventoryItem(admin, job.inventoryItemId);
  if (!item?.sku) return {};
  const check = await checkStock(job.shop, { ...item, sku: item.sku });
  const result = await runRestock(job.shop, check, { jobId: restockJobKey(job) });
  if (result.outcome === "skipped" && result.retryAt)
    return { retryAfterMs: Math.max(1000, Date.parse(result.retryAt) - Date.now()) };
  // A model failure is transient. Keep the same generation and respect the existing 15-minute cooldown.
  return result.outcome === "failed" ? { retryAfterMs: 15 * 60_000 } : {};
}
