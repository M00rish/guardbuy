// End-to-end check of the restock loop: low stock -> Gemini proposal -> policy -> sandbox payout -> audit.
// Uses a throwaway shop and deletes its audit rows at the end.
//   npx tsx scripts/check-restock.ts
export {};
process.loadEnvFile(".env");

const { default: db } = await import("../app/db.server");
const { auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { runRestock } = await import("../app/lib/agent/restock.server");

const SHOP = "restock-check.guardbuy.test";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

await db.auditEntry.deleteMany({ where: { shop: SHOP } });

// Same numbers as the dev store after seeding: 16 bags left, ~4 sold per day.
const check = { sku: "COFFEE-HOUSE-1KG", available: 16, perDay: 4.03, daysOfCover: 16 / 4.03, needsRestock: true };

// Two webhooks at once: only one restock may run.
const [first, second] = await Promise.all([runRestock(SHOP, check), runRestock(SHOP, check)]);
console.log("first: ", JSON.stringify(first));
console.log("second:", JSON.stringify(second));
ok(first.outcome !== "skipped", `restock ran: ${first.outcome}`);
ok(second.outcome === "skipped", "concurrent webhook was skipped");
if (first.outcome === "auto") ok(first.payoutSeq !== undefined && !first.error, `paid (payout entry #${first.payoutSeq})${first.error ? ` error: ${first.error}` : ""}`);

const later = await runRestock(SHOP, check);
ok(later.outcome === "skipped", `next webhook skipped: ${later.outcome === "skipped" ? later.reason : later.outcome}`);

for (const e of await auditEntries(SHOP)) {
  const ev = e.event;
  const line =
    ev.type === "proposal" ? `${ev.proposal.quantity} x ${ev.proposal.sku} from ${ev.proposal.supplierId} @ $${(ev.proposal.unitPriceCents / 100).toFixed(2)} | ${ev.proposal.reasoning}` :
    ev.type === "decision" ? `${ev.decision.verdict} $${(ev.decision.totalCents / 100).toFixed(2)} | ` + ev.decision.checks.filter((c) => c.outcome !== "auto").map((c) => `${c.rule}: ${c.detail}`).join("; ") :
    ev.type === "payout" ? `batch ${ev.payoutBatchId} ${ev.status} $${(ev.amountCents / 100).toFixed(2)}` :
    ev.type === "ruleset_signed" ? `rules ${ev.ruleSet.hash.slice(0, 12)} by ${ev.ruleSet.signedBy}` : "";
  console.log(`  #${e.seq} ${ev.type.padEnd(14)} ${line}`);
}
ok((await verifyChain(SHOP)).valid, "audit chain valid");

await db.auditEntry.deleteMany({ where: { shop: SHOP } });
await db.$disconnect();
process.exit(failed ? 1 : 0);
