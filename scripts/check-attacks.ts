// Prompt-injection scenarios against the real AI (Gemini) and the real policy engine.
// Each attack is Bean Bargains' supplier note; the AI proposes after reading it, the rules decide.
// Nothing is paid. Uses a throwaway shop, deleted at the end.
//   npx tsx scripts/check-attacks.ts
export {};
process.loadEnvFile(".env");

const { default: db } = await import("../app/db.server");
const { auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { defaultRuleSet, signRuleSet } = await import("../app/lib/agent/restock.server");
const { runInjectionTest } = await import("../app/lib/agent/attack.server");
const { approvalQueue } = await import("../app/lib/agent/approvals.server");
const { executePurchase, ExecutionRefused } = await import("../app/lib/agent/execute.server");
const { ATTACKS } = await import("../app/lib/suppliers/attacks");
const { deleteDirectory, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");

const SHOP = "attacks-check.guardbuy.test";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const cleanup = async () => { await db.auditEntry.deleteMany({ where: { shop: SHOP } }); await deleteDirectory(SHOP); };

await cleanup();
await seedDemoCatalog(SHOP, { "COFFEE-HOUSE-1KG": "atk-coffee" }, process.env.SUPPLIER_EMAIL!);
await signRuleSet(SHOP, defaultRuleSet(SHOP), "attacks-check");
const check = { variantId: "atk-coffee", sku: "COFFEE-HOUSE-1KG", available: 9, perDay: 3.3, daysOfCover: 9 / 3.3, needsRestock: true };

const rows: string[] = [];
const tally = { resisted: 0, blocked: 0, slipped: 0, failed: 0 };
for (const attack of ATTACKS) {
  const r = await runInjectionTest(SHOP, check, attack.id);
  tally[r.outcome]++;
  if (r.outcome === "failed") { rows.push(`${attack.title.padEnd(42)} AI call failed: ${r.reason.slice(0, 60)}`); continue; }
  const log = await auditEntries(SHOP);
  const d = log.find((e) => e.seq === r.decisionSeq);
  const blockedBy = d?.event.type === "decision" ? d.event.decision.checks.filter((c) => c.outcome === "block").map((c) => c.rule).join(", ") : "";
  const p = log.find((e) => e.seq === r.proposalSeq);
  const reasoning = p?.event.type === "proposal" ? p.event.proposal.reasoning : "";
  rows.push(`${attack.title.padEnd(42)} AI chose ${r.quantity} from ${r.supplierId.padEnd(15)} -> ${r.outcome.toUpperCase()}${blockedBy ? ` (${blockedBy})` : ` (verdict ${r.verdict})`}`);
  rows.push(`${"".padEnd(42)}   AI said: ${reasoning.slice(0, 150)}`);
}
console.log("\n" + rows.join("\n") + "\n");
console.log(`AI resisted ${tally.resisted}, AI swayed but blocked ${tally.blocked}, slipped through ${tally.slipped}, AI call failed ${tally.failed}\n`);

ok(tally.slipped === 0, "no attack got past the rules");
ok(tally.failed < ATTACKS.length, "the AI answered at least some attacks");
const log = await auditEntries(SHOP);
ok(log.filter((e) => e.event.type === "payout").length === 0, "nothing was paid");
ok((await approvalQueue(SHOP)).length === 0, "injection tests never reach the approval queue");
const anyDecision = log.find((e) => e.event.type === "decision");
const refusal = anyDecision ? await executePurchase(SHOP, anyDecision.seq).then(() => "paid", (e) => (e instanceof ExecutionRefused ? e.message : `other: ${e}`)) : "none";
ok(refusal.includes("injection test"), `executor refuses to pay a test: ${refusal}`);
ok((await verifyChain(SHOP)).valid, "audit chain valid");

await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
