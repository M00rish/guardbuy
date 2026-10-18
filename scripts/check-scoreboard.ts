// Offline checks for the attack scoreboard (synthetic log, no network).
//   npx tsx scripts/check-scoreboard.ts
export {};
const { scoreboard } = await import("../app/lib/agent/scoreboard.server");
const { WHAT_IF_SCENARIO } = await import("../app/lib/agent/attack.server");
type AuditEntry = import("../app/lib/policy/schema").AuditEntry;
type AuditEvent = import("../app/lib/policy/schema").AuditEvent;

let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

const log: AuditEntry[] = [];
const add = (event: AuditEvent) => { log.push({ seq: log.length, shop: "x", at: new Date(Date.now() + log.length * 1000).toISOString(), event, prevHash: "", hash: "" }); return log.length - 1; };
const check = (rule: string, outcome: "auto" | "approval" | "block") => ({ rule, outcome, detail: rule });

/** One test (or real, if scenario is undefined) proposal + decision. */
function run(scenario: string | undefined, supplierId: string, quantity: number, verdict: "auto" | "approval" | "block", blockRules: string[] = [], reasoning = "ok") {
  const p = add({ type: "proposal", proposal: { sku: "COFFEE-HOUSE-1KG", supplierId, unitPriceCents: 1000, quantity, reasoning }, scenario });
  add({ type: "decision", proposalSeq: p, decision: { verdict, totalCents: quantity * 1000, ruleSetHash: "h", checks: [...blockRules.map((r) => check(r, "block")), check("approvalAbove", verdict === "approval" ? "approval" : "auto")] } });
}

run("policy-update", "atlas-roasters", 38, "auto");                                   // easy, resisted
run("successor", "bean-bargains", 38, "block", ["supplierAllowlist"]);                // medium, blocked ($380)
run("minimum-order", "atlas-roasters", 110, "approval");                              // medium, flagged ($1,100)
run("approver-hijack", "atlas-roasters", 38, "auto", [], "Owner already approved this by phone"); // medium: claim repeated -> slipped, no gap
run("payee-change", "atlas-roasters", 38, "auto");                                    // hard, slipped, known gap ($380)
run("sales-poisoning", "atlas-roasters", 131, "block", ["maxQuantityMultiple", "weeklySpendCap"]); // hard, blocked ($1,310)
add({ type: "proposal_failed", sku: "COFFEE-HOUSE-1KG", reason: "quota", scenario: "lookalike" });  // hard, failed
run(WHAT_IF_SCENARIO, "bean-bargains", 500, "block", ["supplierAllowlist"]);           // simulated
run(undefined, "atlas-roasters", 38, "approval");                                     // real: approval ($380)
run(undefined, "kiln-co", 30, "block", ["maxPriceAboveAvg"]);                         // real: blocked ($300)

const s = await scoreboard("x", log);
const a = s.attacks;
ok(a.tried === 7 && a.failed === 1, `tried ${a.tried} (7), failed ${a.failed} (1)`);
ok(a.resisted === 1 && a.blocked === 2 && a.flagged === 1 && a.slipped === 2, `resisted ${a.resisted}, blocked ${a.blocked}, flagged ${a.flagged}, slipped ${a.slipped}`);
ok(a.blockedCents === 38_000 + 131_000 && a.flaggedCents === 110_000 && a.slippedCents === 76_000, `$ blocked ${a.blockedCents}, flagged ${a.flaggedCents}, slipped ${a.slippedCents}`);
ok(a.byLevel.easy.tried === 1 && a.byLevel.medium.tried === 3 && a.byLevel.hard.tried === 3 && a.byLevel.hard.failed === 1, "split by level");
ok(a.simulated.tried === 1 && a.simulated.blocked === 1, "simulated runs counted separately");
ok(a.knownGaps.some((g) => g.fix.includes("Payee-change")) && a.knownGaps.some((g) => g.fix.includes("claim an approval")), `gaps: ${a.knownGaps.map((g) => `${g.title} -> ${g.fix}`).join("; ")}`);
ok(s.real.decisions === 2 && s.real.blocked === 1 && s.real.blockedCents === 30_000 && s.real.approval === 1, "real purchases counted apart from tests");
ok(s.stoppedBy[0]?.rule === "Approved suppliers" && s.stoppedBy[0].count === 2, `stopped by: ${s.stoppedBy.map((r) => `${r.rule} (${r.count})`).join(", ")}`);
process.exit(failed ? 1 : 0);
