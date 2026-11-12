import { createHash } from "node:crypto";
import db from "../../db.server";

/** Shop-scoped change token. No Shopify, AI or payment provider requests. */
export async function liveRevision(shop: string) {
  const where = { shop };
  const changes = await Promise.all([
    db.auditEntry.findFirst({
      where,
      orderBy: { seq: "desc" },
      select: { hash: true },
    }),
    // Inventory webhooks enqueue a generation even before the agent finishes its decision.
    db.restockJob.aggregate({ where, _max: { updatedAt: true }, _count: true }),
    db.processedWebhook.aggregate({
      where,
      _max: { receivedAt: true },
      _count: true,
    }),
    db.managedProduct.aggregate({
      where,
      _max: { updatedAt: true },
      _count: true,
    }),
  ]);
  return createHash("sha256").update(JSON.stringify(changes)).digest("hex");
}
