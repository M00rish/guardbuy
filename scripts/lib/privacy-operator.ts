// Offline database-owner operations. Never imported by the app; no HTTP endpoint can call these.
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { purchaseReservations } from "../../app/lib/payments/attempts";
import { AuditEventSchema } from "../../app/lib/policy/schema";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const referenceHash = (reference: string) => {
  if (!reference.trim() || reference.length > 200) throw new Error("Supply a reference to the completed external privacy review (no personal data).");
  return digest(reference);
};

export async function purgeShopRequest(owner: PrismaClient, id: string, confirmShop: string, reference: string) {
  const ref = referenceHash(reference);
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"privacy:" + confirmShop}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + confirmShop}))`;
    const request = await tx.privacyRequest.findUniqueOrThrow({ where: { id } });
    if (request.topic !== "SHOP_REDACT" || request.shopHash !== digest(confirmShop)) throw new Error("Request/shop confirmation does not match a shop deletion.");
    if (request.status === "completed") return { alreadyCompleted: true, deletedAuditEntries: 0 };
    if (request.status === "legal_hold") throw new Error("Resolve the documented legal hold before erasure.");
    const block = await tx.privacyBlock.findUnique({ where: { shopHash: request.shopHash } });
    if (!block) throw new Error("Shop processing must be suppressed before erasure.");
    if (await tx.session.count({ where: { shop: confirmShop } })) throw new Error("Remove/revoke all shop sessions and stop processing before erasure.");
    const leases = await tx.$queryRaw<{ active: bigint }[]>`SELECT count(*) AS active FROM "PaymentLock" WHERE "lockedUntil" > clock_timestamp()`;
    if (Number(leases[0].active)) throw new Error("Payment/product/approval work is still in flight; wait for leases to expire and reconcile first.");
    const rows = await tx.auditEntry.findMany({ where: { shop: confirmShop }, orderBy: { seq: "asc" } });
    const log = rows.map((r) => ({ ...r, at: r.at.toISOString(), event: AuditEventSchema.parse(r.event) }));
    if (purchaseReservations(log).size) throw new Error("Unresolved payment or commitment remains. Reconcile it with PayPal before erasure; never erase evidence to release funds.");
    // Same privileged exception as the append-only trigger, scoped to this transaction and whole shop only.
    // The restricted app role still has no DELETE privilege and cannot use this exception.
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    const removed = await tx.auditEntry.deleteMany({ where: { shop: confirmShop } });
    await tx.restockJob.deleteMany({ where: { shop: confirmShop } });
    await tx.productSupplier.deleteMany({ where: { shop: confirmShop } });
    await tx.supplier.deleteMany({ where: { shop: confirmShop } });
    await tx.managedProduct.deleteMany({ where: { shop: confirmShop } });
    await tx.dailySales.deleteMany({ where: { shop: confirmShop } });
    await tx.processedWebhook.deleteMany({ where: { shop: confirmShop } });
    await tx.salesBackfill.deleteMany({ where: { shop: confirmShop } });
    await tx.shopSettings.deleteMany({ where: { shop: confirmShop } });
    await tx.paymentLock.deleteMany({ where: { OR: [{ shop: confirmShop }, { shop: { startsWith: `approval:${confirmShop}:` } }, { shop: { startsWith: `restock:${confirmShop}|` } }] } });
    await tx.privacyBlock.update({ where: { shopHash: request.shopHash }, data: { purgedAt: new Date() } });
    await tx.privacyRequest.update({ where: { id }, data: { shop: null, requestId: null, status: "completed", completedAt: new Date(), referenceHash: ref } });
    return { alreadyCompleted: false, deletedAuditEntries: removed.count };
  }, { maxWait: 15_000, timeout: 20_000 });
}

/** Records a human-verified response/redaction, never performs customer matching on aggregate sales. */
export async function completeCustomerRequest(owner: PrismaClient, id: string, reference: string) {
  const request = await owner.privacyRequest.findUniqueOrThrow({ where: { id } });
  if (request.topic === "SHOP_REDACT") throw new Error("Use the whole-shop erasure workflow for shop/redact.");
  if (request.status === "legal_hold") throw new Error("Resolve the documented legal hold first.");
  if (request.status === "completed") return;
  await owner.privacyRequest.update({ where: { id }, data: { shop: null, requestId: null, status: "completed", completedAt: new Date(), referenceHash: referenceHash(reference) } });
}
