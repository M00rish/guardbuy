import db from "../../db.server";
import { auditEntries } from "../audit/log.server";
import { DECLINE_COOLDOWN_MS, restockCooldown } from "../agent/restock-cooldown";
import { enqueueRestockInTransaction } from "./restock-queue.server";

/** Recover pre-deployment declines whose stock webhook was already acknowledged without a retry. */
export async function recoverRestockCooldowns() {
  const shops = await db.auditEntry.findMany({
    where: { type: "rejected", at: { gt: new Date(Date.now() - DECLINE_COOLDOWN_MS) } },
    distinct: ["shop"], select: { shop: true },
  });
  for (const { shop } of shops) {
    const log = await auditEntries(shop);
    for (const entry of log) {
      const p = entry.event;
      if (p.type !== "proposal" || p.scenario || !p.proposal.variantId || !p.restockJobId) continue;
      const cooldown = restockCooldown({ variantId: p.proposal.variantId, sku: p.proposal.sku }, log);
      const decision = log.find(e => e.seq === cooldown?.decisionSeq)?.event;
      if (!cooldown || decision?.type !== "decision" || decision.proposalSeq !== entry.seq) continue;
      const jobId = p.restockJobId.split(":")[0];
      await db.$transaction(async tx => {
        const job = await tx.restockJob.findFirst({ where: { id: jobId, shop } });
        if (!job || job.generation > job.completedGeneration) return;
        const queued = await enqueueRestockInTransaction(tx, shop, job.inventoryItemId);
        if (queued) await tx.restockJob.update({ where: { id: queued.id }, data: { availableAt: new Date(cooldown.until) } });
      });
    }
  }
}
