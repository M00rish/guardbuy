// Checks for the restock loop.
//  1. Offline: when a SKU counts as covered, and when failures free it again (no network).
//  2. Live: rules gate, Gemini proposal with recorded payee, sandbox payout, duplicate webhooks,
//     payee change refused, Gemini failure logged. Uses a throwaway shop, deleted at the end.
//   npx tsx scripts/check-restock.ts
export {};
process.loadEnvFile(".env");

const { deleteAuditEntries } = await import("./lib/audit-admin");
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { agentOn, defaultRuleSet, policyContext, runRestock, signRuleSet, skipReason } = await import("../app/lib/agent/restock.server");
const { executePurchase, ExecutionRefused } = await import("../app/lib/agent/execute.server");
const { deleteDirectory, offersForVariant, saveSupplier, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");
const { evaluate } = await import("../app/lib/policy/engine");
type AuditEntry = import("../app/lib/policy/schema").AuditEntry;
type AuditEvent = import("../app/lib/policy/schema").AuditEvent;

let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

// ---------- 1. Offline: restock states ----------
console.log("-- restock states (offline)");
const NOW = new Date("2026-10-16T12:00:00Z");
const SKU = "COFFEE-HOUSE-1KG";
const proposal = { sku: SKU, supplierId: "atlas-roasters", unitPriceCents: 1195, quantity: 30, reasoning: "x", payeeEmail: "s@example.com" };
const decision = (verdict: "auto" | "approval" | "block") => ({ verdict, totalCents: 35_850, checks: [], ruleSetHash: "h" });

/** Builds a log from [minutes ago, event] pairs (seq = position). */
const logOf = (...items: [number, AuditEvent][]): AuditEntry[] =>
  items.map(([minAgo, event], seq) => ({ seq, shop: "x", at: new Date(NOW.getTime() - minAgo * 60_000).toISOString(), event, prevHash: "", hash: "" }));
const restockWith = (minAgo: number, verdict: "auto" | "approval" | "block", ...after: [number, AuditEvent][]) =>
  logOf([minAgo, { type: "proposal", proposal }], [minAgo, { type: "decision", proposalSeq: 0, decision: decision(verdict) }], ...after);
const payout = (minAgo: number, status: string): [number, AuditEvent] => [minAgo, { type: "payout", decisionSeq: 1, payoutBatchId: "B", status, amountCents: 35_850 }];
const payoutStatus = (minAgo: number, status: string): [number, AuditEvent] => [minAgo, { type: "payout_status", payoutSeq: 2, status, confirmedByTransactionSearch: false }];

const states: [string, AuditEntry[], boolean][] = [
  ["nothing yet -> propose", [], false],
  ["AI failed 5 min ago -> wait", logOf([5, { type: "proposal_failed", sku: SKU, reason: "timeout" }]), true],
  ["AI failed 20 min ago -> retry", logOf([20, { type: "proposal_failed", sku: SKU, reason: "timeout" }]), false],
  ["blocked 30 min ago -> wait", restockWith(30, "block"), true],
  ["blocked 2h ago -> retry", restockWith(120, "block"), false],
  ["paid 1 day ago -> covered", restockWith(1440, "auto", payout(1440, "PENDING")), true],
  ["paid 4 days ago -> propose again", restockWith(5760, "auto", payout(5760, "SUCCESS")), false],
  ["payout RETURNED 2h ago -> retry", restockWith(1440, "auto", payout(1440, "PENDING"), payoutStatus(120, "RETURNED")), false],
  ["payout UNCLAIMED 10 min ago -> wait", restockWith(1440, "auto", payout(1440, "PENDING"), payoutStatus(10, "UNCLAIMED")), true],
  ["payout went PENDING -> SUCCESS -> covered", restockWith(1440, "auto", payout(1440, "PENDING"), payoutStatus(600, "SUCCESS")), true],
  ["payment failed 10 min ago -> wait", restockWith(15, "auto", [10, { type: "payment_failed", decisionSeq: 1, reason: "PayPal 500" }]), true],
  ["payment failed 2h ago -> retry", restockWith(130, "auto", [120, { type: "payment_failed", decisionSeq: 1, reason: "PayPal 500" }]), false],
  ["waiting for approval 1 day -> covered", restockWith(1440, "approval"), true],
  ["auto, still paying (2 min) -> wait", restockWith(2, "auto"), true],
  ["auto, never paid (30 min) -> retry", restockWith(30, "auto"), false],
];
for (const [name, log, skip] of states) {
  const reason = skipReason({ variantId: "v-coffee", sku: SKU }, log, NOW);
  ok(!!reason === skip, `${name.padEnd(44)} ${reason ?? "(propose)"}`);
}
const ctx = policyContext(proposal, restockWith(1440, "auto", payout(1440, "PENDING"), payoutStatus(120, "RETURNED")), 500_000, { managed: true, offers: [] }, NOW);
ok(ctx.spentLast7dCents === 0 && ctx.purchasesLast24h === 0, "a returned payout doesn't count toward spend caps");

ok(agentOn([]) && !agentOn(logOf([1, { type: "agent_state", on: false, by: "staff" }])) && agentOn(logOf([2, { type: "agent_state", on: false, by: "s" }], [1, { type: "agent_state", on: true, by: "s" }])), "pause and resume");

// ---------- 2. Live ----------
console.log("-- live (Gemini + PayPal sandbox)");
const SHOP = "restock-check.guardbuy.test";
const cleanup = async () => { await deleteAuditEntries({ shop: SHOP }); await deleteDirectory(SHOP); };
await cleanup();
// The merchant's products & suppliers: the demo catalog, with the dripper left switched off.
await seedDemoCatalog(SHOP, { [SKU]: "test-coffee", "MUG-STONE": "test-mug", "DRIPPER-CERAMIC": "test-dripper" }, process.env.SUPPLIER_EMAIL!);
const check = { variantId: "test-coffee", sku: SKU, available: 16, perDay: 4.03, daysOfCover: 16 / 4.03, needsRestock: true };

const off = await runRestock(SHOP, check);
ok(off.outcome === "skipped" && off.reason.includes("agent is off"), `no signed rules -> ${off.outcome === "skipped" ? off.reason : off.outcome}`);
await signRuleSet(SHOP, defaultRuleSet(SHOP), "restock-check");

// A product the merchant didn't switch on: skipped before the AI is even asked.
const dripper = await runRestock(SHOP, { variantId: "test-dripper", sku: "DRIPPER-CERAMIC", available: 1, perDay: 0.7, daysOfCover: 1.4, needsRestock: true });
ok(dripper.outcome === "skipped" && dripper.reason.includes("not switched on"), `unmanaged product -> ${dripper.outcome === "skipped" ? dripper.reason : dripper.outcome}`);

// Two webhooks at once: only one restock may run.
const [first, second] = await Promise.all([runRestock(SHOP, check), runRestock(SHOP, check)]);
console.log("first: ", JSON.stringify(first));
ok(first.outcome === "auto" && first.payoutSeq !== undefined && !first.error, `restock ran and paid: ${first.outcome}${"error" in first && first.error ? ` (${first.error})` : ""}`);
ok(second.outcome === "skipped", "concurrent webhook was skipped");
const log = await auditEntries(SHOP);
const recorded = log.find((e) => e.event.type === "proposal");
ok(recorded?.event.type === "proposal" && recorded.event.proposal.payeeEmail === process.env.SUPPLIER_EMAIL && recorded.event.proposal.variantId === "test-coffee", "payee and variant recorded with the proposal");

const later = await runRestock(SHOP, check);
ok(later.outcome === "skipped" && later.reason.includes("already open"), `next webhook skipped: ${later.outcome === "skipped" ? later.reason : later.outcome}`);

// Supplier's PayPal email changes after a purchase was proposed: the executor refuses to pay.
const coffeeOffers = await offersForVariant(SHOP, "test-coffee");
const small = { ...proposal, quantity: 1, variantId: "test-coffee", payeeEmail: process.env.SUPPLIER_EMAIL };
const p = await appendAudit(SHOP, { type: "proposal", proposal: small });
const d = await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision: evaluate(small, defaultRuleSet(SHOP), policyContext(small, [], 500_000, { managed: true, offers: coffeeOffers })) });
await saveSupplier(SHOP, { id: "atlas-roasters", name: "Atlas Roasters", paypalEmail: "new-address@example.com" });
const refusal = await executePurchase(SHOP, d.seq).then(() => "paid", (e) => (e instanceof ExecutionRefused ? e.message : `other: ${e}`));
await saveSupplier(SHOP, { id: "atlas-roasters", name: "Atlas Roasters", paypalEmail: process.env.SUPPLIER_EMAIL! });
ok(refusal.includes("changed"), `payee changed -> refused: ${refusal}`);

// Gemini fails: logged as proposal_failed, and the SKU waits before retrying.
const realKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "invalid-key-for-check";
const mugs = { variantId: "test-mug", sku: "MUG-STONE", available: 3, perDay: 1.5, daysOfCover: 2, needsRestock: true };
const broken = await runRestock(SHOP, mugs);
process.env.GOOGLE_GENERATIVE_AI_API_KEY = realKey;
ok(broken.outcome === "failed", `Gemini failure -> ${broken.outcome}`);
ok((await auditEntries(SHOP)).some((e) => e.event.type === "proposal_failed" && e.event.sku === "MUG-STONE"), "failure written to the audit log");
const retry = await runRestock(SHOP, mugs);
ok(retry.outcome === "skipped" && retry.reason.includes("failed"), `right after a failure -> ${retry.outcome === "skipped" ? retry.reason : retry.outcome}`);

ok((await verifyChain(SHOP)).valid, "audit chain valid");
await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
