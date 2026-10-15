// End-to-end check of the payout step + hash-chained audit log against the PayPal SANDBOX.
// Uses a throwaway shop name and deletes its audit rows at the end.
//   npx tsx scripts/check-payout-chain.ts
process.loadEnvFile(".env");

const { default: db } = await import("../app/db.server");
const { appendAudit, verifyChain } = await import("../app/lib/audit/log.server");
const { executePurchase, ExecutionRefused } = await import("../app/lib/agent/execute.server");
const { evaluate } = await import("../app/lib/policy/engine");
const { RuleSetSchema } = await import("../app/lib/policy/schema");

const SHOP = "chain-check.guardbuy.test";
const rules = RuleSetSchema.parse({
  version: 1, shop: SHOP, currency: "USD",
  reorderBelowDaysOfCover: 7, targetDaysOfCover: 30, maxPriceAboveAvgPct: 10,
  approvalAboveCents: 2_000, // $20 so the second purchase needs approval
  weeklySpendCapCents: 200_000, cashFloorCents: 100_000,
  supplierAllowlist: ["atlas-roasters", "kiln-co", "paperworks"],
  maxQuantityMultiple: 3, maxPurchasesPer24h: 5,
});
const ctx = { avgUnitPrice30dCents: 1148, usualQuantity: 40, spentLast7dCents: 0, purchasesLast24h: 0, paypalBalanceCents: 496_742 };

let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

async function propose(supplierId: string, quantity: number, unitPriceCents: number) {
  const proposal = { sku: "COFFEE-HOUSE-1KG", supplierId, unitPriceCents, quantity, reasoning: "chain check" };
  const p = await appendAudit(SHOP, { type: "proposal", proposal });
  const decision = evaluate(proposal, rules, ctx);
  const d = await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision });
  return { seq: d.seq, verdict: decision.verdict };
}

await db.auditEntry.deleteMany({ where: { shop: SHOP } });
await appendAudit(SHOP, { type: "ruleset_signed", ruleSet: { rules, hash: (await import("../app/lib/policy/hash")).hashOf(rules), signedBy: "chain-check", signedAt: new Date().toISOString() } });

// 1. auto
const a = await propose("atlas-roasters", 1, 1119);
ok(a.verdict === "auto", `1 unit ($11.19) -> ${a.verdict}`);
const pay1 = await executePurchase(SHOP, a.seq);
ok(pay1.event.type === "payout", `paid: batch ${pay1.event.type === "payout" ? pay1.event.payoutBatchId : "-"} (${pay1.event.type === "payout" ? pay1.event.status : ""})`);
const again = await executePurchase(SHOP, a.seq);
ok(again.seq === pay1.seq, "running it again returns the same payout (no double payment)");

// 2. approval
const b = await propose("atlas-roasters", 2, 1119);
ok(b.verdict === "approval", `2 units ($22.38) -> ${b.verdict}`);
try { await executePurchase(SHOP, b.seq); ok(false, "paid without approval"); }
catch (e) { ok(e instanceof ExecutionRefused, `refused before approval: ${(e as Error).message}`); }
await appendAudit(SHOP, { type: "approved", decisionSeq: b.seq, approvedBy: "chain-check" });
const pay2 = await executePurchase(SHOP, b.seq);
ok(pay2.event.type === "payout", `paid after approval: batch ${pay2.event.type === "payout" ? pay2.event.payoutBatchId : "-"}`);

// 3. blocked
const c = await propose("bean-bargains", 500, 690);
ok(c.verdict === "block", `Bean Bargains x500 -> ${c.verdict}`);
try { await executePurchase(SHOP, c.seq); ok(false, "blocked purchase was paid"); }
catch (e) { ok(e instanceof ExecutionRefused, `refused: ${(e as Error).message}`); }

// 4. chain integrity
const v1 = await verifyChain(SHOP);
ok(v1.valid, `chain valid (${v1.valid ? v1.length : 0} entries)`);
const victim = await db.auditEntry.findUniqueOrThrow({ where: { shop_seq: { shop: SHOP, seq: pay1.seq } } });
const tampered = { ...(victim.event as any), amountCents: 1 };
await db.auditEntry.update({ where: { shop_seq: { shop: SHOP, seq: pay1.seq } }, data: { event: tampered } });
const v2 = await verifyChain(SHOP);
ok(!v2.valid, `tampering detected: ${v2.valid ? "NOT detected" : `seq ${v2.brokenAtSeq}, ${v2.reason}`}`);
await db.auditEntry.update({ where: { shop_seq: { shop: SHOP, seq: pay1.seq } }, data: { event: victim.event as any } });
ok((await verifyChain(SHOP)).valid, "chain valid again after restoring the row");

await db.auditEntry.deleteMany({ where: { shop: SHOP } });
await db.$disconnect();
process.exit(failed ? 1 : 0);
