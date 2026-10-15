// Reconciliation check against real sandbox payouts (throwaway shop, cleaned up afterwards).
//   npx tsx scripts/check-reconcile.ts
export {};
process.loadEnvFile(".env");
const { default: db } = await import("../app/db.server");
const { appendAudit } = await import("../app/lib/audit/log.server");
const { reconcilePayouts } = await import("../app/lib/paypal/reconcile.server");

const SHOP = "reconcile-check.guardbuy.test";
await db.auditEntry.deleteMany({ where: { shop: SHOP } });
for (const [batch, cents] of [["R24R8JVMV3VFA", 1000], ["MQMMBT27SK3QJ", 1119], ["Q7RQN24KRWJA6", 2238]] as const) {
  await appendAudit(SHOP, { type: "payout", decisionSeq: -1, payoutBatchId: batch, status: "PENDING", amountCents: cents });
}
console.log((await reconcilePayouts(SHOP)).join("\n"));
console.log("--- second run (should only report what is still unconfirmed) ---");
console.log((await reconcilePayouts(SHOP)).join("\n") || "(nothing new)");
await db.auditEntry.deleteMany({ where: { shop: SHOP } });
await db.$disconnect();
