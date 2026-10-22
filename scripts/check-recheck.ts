// Checks for re-checking the rules at payment time: the per-shop payment lock, spending caps under
// concurrency, pending approvals counted as spent, an auto purchase that now needs a person, a
// paused agent, and approval expiry. No money moves: every refusal happens before PayPal is called
// (the only PayPal traffic is reading the balance), and GUARDBUY_PAYMENTS_DISABLED is set as a
// safety net. Throwaway shop, deleted at the end.
//   npx tsx scripts/check-recheck.ts
export {};
process.loadEnvFile(".env");

const { deleteAuditEntries } = await import("./lib/audit-admin");
// Safety net: if a check below unexpectedly passes the rules, the payment is refused instead of sent.
process.env.GUARDBUY_PAYMENTS_DISABLED = "1";

const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries } = await import("../app/lib/audit/log.server");
const { approvalExpired, defaultRuleSet, pendingApprovalCents, setAgentState, signRuleSet, skipReason, spending } = await import("../app/lib/agent/restock.server");
const { executePurchase, ExecutionRefused } = await import("../app/lib/agent/execute.server");
const { withPaymentLock } = await import("../app/lib/agent/payment-lock.server");
const { evaluate } = await import("../app/lib/policy/engine");
const { RuleSetSchema } = await import("../app/lib/policy/schema");
const { deleteDirectory, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");
type AuditEntry = import("../app/lib/policy/schema").AuditEntry;
type AuditEvent = import("../app/lib/policy/schema").AuditEvent;

const SHOP = "recheck-check.guardbuy.test";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const refusal = (p: Promise<unknown>) => p.then(() => "PAID (should not happen)", (e) => (e instanceof ExecutionRefused ? e.message : `other: ${(e as Error).message}`));
const notJustDisabled = (msg: string) => !msg.includes("GUARDBUY_PAYMENTS_DISABLED"); // refused by the rules, not by the safety net
const cleanup = async () => {
  await deleteAuditEntries({ shop: SHOP });
  await db.paymentLock.deleteMany({ where: { shop: SHOP } });
  await deleteDirectory(SHOP);
};

// ---------- the lock ----------
await cleanup();
const spans: [number, number][] = [];
await Promise.all([1, 2].map(() => withPaymentLock(SHOP, async () => { const a = Date.now(); await new Promise((r) => setTimeout(r, 400)); spans.push([a, Date.now()]); })));
ok(spans.length === 2 && (spans[0][1] <= spans[1][0] || spans[1][1] <= spans[0][0]), "two payments at once run one after the other");
await db.paymentLock.create({ data: { shop: SHOP, holder: "crashed-server", lockedUntil: new Date(Date.now() - 1000) } });
const t = Date.now();
await withPaymentLock(SHOP, async () => {});
ok(Date.now() - t < 2000, "a lock left by a crashed server expires and is taken over");

// ---------- re-check at payment time ----------
await seedDemoCatalog(SHOP, { "COFFEE-HOUSE-1KG": "rc-coffee" }, process.env.SUPPLIER_EMAIL!);
const rules = RuleSetSchema.parse({ ...defaultRuleSet(SHOP), weeklySpendCapCents: 1_500, cashFloorCents: 0 }); // $15 weekly cap
await signRuleSet(SHOP, rules, "recheck-check");
const fresh = { productManaged: true, supplierLinked: true, usualQuantity: 40, spentLast7dCents: 0, purchasesLast24h: 0, paypalBalanceCents: 1_000_000 };

/** A purchase decided against a clean slate (as if decided before the others happened). */
async function decided(unitPriceCents: number, quantity: number, ctx = fresh, r = rules) {
  const proposal = { sku: "COFFEE-HOUSE-1KG", variantId: "rc-coffee", supplierId: "atlas-roasters", unitPriceCents, quantity, reasoning: "check", payeeEmail: process.env.SUPPLIER_EMAIL };
  const p = await appendAudit(SHOP, { type: "proposal", proposal });
  const decision = evaluate(proposal, r, ctx);
  return { seq: (await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision })).seq, verdict: decision.verdict };
}

// Two $10 purchases decided at the same moment: each fits the $15 cap alone. The first one pays
// (simulated payout entry), so re-checking the second at payment time must block it.
const first = await decided(1000, 1);
const second = await decided(1000, 1);
ok(first.verdict === "auto" && second.verdict === "auto", "both $10 purchases pass on their own");
await appendAudit(SHOP, { type: "payout", decisionSeq: first.seq, payoutBatchId: "SIMULATED-FIRST", status: "SUCCESS", amountCents: 1000 });
const capRefusal = await refusal(executePurchase(SHOP, second.seq));
ok(notJustDisabled(capRefusal) && capRefusal.includes("re-checked") && capRefusal.includes("cap"), `second purchase refused at payment time: ${capRefusal}`);

// A $10 purchase waiting for approval counts as committed: a $10 auto purchase now breaks the $15 cap.
await deleteAuditEntries({ shop: SHOP, seq: { gt: 0 } }); // keep only the signed rules
const waiting = await decided(1000, 1, fresh, RuleSetSchema.parse({ ...rules, approvalAboveCents: 500 }));
ok(waiting.verdict === "approval", "$10 purchase waits for approval");
ok(pendingApprovalCents(await auditEntries(SHOP)) === 1000, "pending approvals total $10");
const small = await decided(1000, 1);
const pendingRefusal = await refusal(executePurchase(SHOP, small.seq));
ok(notJustDisabled(pendingRefusal) && pendingRefusal.includes("cap"), `auto purchase refused, pending approval counted: ${pendingRefusal}`);

// The merchant tightens the rules after a purchase was decided: an auto purchase that now needs a person isn't paid.
await deleteAuditEntries({ shop: SHOP, seq: { gt: 0 } });
const auto = await decided(1000, 1);
await signRuleSet(SHOP, RuleSetSchema.parse({ ...rules, approvalAboveCents: 500 }), "recheck-check"); // ask above $5 now
const nowNeedsPerson = await refusal(executePurchase(SHOP, auto.seq));
ok(nowNeedsPerson.includes("now needs a person"), `rules tightened -> not paid automatically: ${nowNeedsPerson}`);

// Paused agent: nothing is paid automatically.
await signRuleSet(SHOP, rules, "recheck-check");
const auto2 = await decided(1000, 1);
await setAgentState(SHOP, false, "recheck-check");
ok((await refusal(executePurchase(SHOP, auto2.seq))).includes("paused"), "paused agent -> automatic payment refused");

// ---------- payee change: a supplier's PayPal email changed -> a person must approve ----------
await setAgentState(SHOP, true, "recheck-check");
const { offersForVariant, saveSupplier } = await import("../app/lib/suppliers/directory.server");
const { policyContext } = await import("../app/lib/agent/restock.server");
await saveSupplier(SHOP, { id: "atlas-roasters", name: "Atlas Roasters", paypalEmail: "new-billing@example.com" });
const changedOffers = await offersForVariant(SHOP, "rc-coffee");
const changedProposal = { sku: "COFFEE-HOUSE-1KG", variantId: "rc-coffee", supplierId: "atlas-roasters", unitPriceCents: 1000, quantity: 1, reasoning: "check", payeeEmail: "new-billing@example.com" };
const afterChange = evaluate(changedProposal, rules, policyContext(changedProposal, await auditEntries(SHOP), 1_000_000, { managed: true, offers: changedOffers }));
ok(afterChange.verdict === "approval" && afterChange.checks.some((c) => c.rule === "payeeChange" && c.outcome === "approval"),
  `PayPal email changed today -> needs a person: ${afterChange.checks.find((c) => c.rule === "payeeChange")?.detail}`);

// ---------- expiry (offline, synthetic times) ----------
const NOW = new Date("2026-10-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
ok(!approvalExpired(hoursAgo(47), NOW) && approvalExpired(hoursAgo(49), NOW), "approvals expire after 48 h");
const old: AuditEntry[] = ([[49, { type: "proposal", proposal: { sku: "S", variantId: "v", supplierId: "x", unitPriceCents: 100, quantity: 5, reasoning: "r" } }],
  [49, { type: "decision", proposalSeq: 0, decision: { verdict: "approval", totalCents: 500, checks: [], ruleSetHash: "h" } }]] as [number, AuditEvent][])
  .map(([h, event], seq) => ({ seq, shop: "x", at: hoursAgo(h), event, prevHash: "", hash: "" }));
ok(skipReason({ variantId: "v", sku: "S" }, old, NOW) === null, "an expired approval frees the product to be re-proposed");
ok(pendingApprovalCents(old, NOW) === 0 && spending(old, NOW).pendingCents === 0, "an expired approval no longer counts as committed");

await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
