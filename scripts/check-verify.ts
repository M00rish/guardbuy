// Checks for the public verify page's logic (database only: no PayPal, no AI).
// Builds a throwaway shop's log with an automatic and an approved payment, then deletes it.
//   npx tsx scripts/check-verify.ts
export {};
process.loadEnvFile(".env");

const { default: db } = await import("../app/db.server");
const { appendAudit } = await import("../app/lib/audit/log.server");
const { verifyPayment, setShareVerifyDetails } = await import("../app/lib/audit/verify.server");
const { defaultRuleSet, signRuleSet } = await import("../app/lib/agent/restock.server");
const { evaluate } = await import("../app/lib/policy/engine");
const { deleteDirectory, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");

const SHOP = "verify-check.guardbuy.test";
const EMAIL = "supplier-for-verify-check@example.com";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const cleanup = async () => {
  await db.auditEntry.deleteMany({ where: { shop: SHOP } });
  await deleteDirectory(SHOP);
  await db.shopSettings.deleteMany({ where: { shop: SHOP } });
};

await cleanup();
await seedDemoCatalog(SHOP, { "COFFEE-HOUSE-1KG": "verify-coffee" }, EMAIL);
const rules = defaultRuleSet(SHOP);
await signRuleSet(SHOP, rules, "shopify-staff:1");
const ctx = { productManaged: true, supplierLinked: true, avgUnitPrice30dCents: 1150, usualQuantity: 40, spentLast7dCents: 0, purchasesLast24h: 0, paypalBalanceCents: 412_345 };

/** proposal -> decision -> (approved) -> payout, with a made-up PayPal batch id. */
async function payment(quantity: number, batchId: string, approve = false) {
  const proposal = { sku: "COFFEE-HOUSE-1KG", variantId: "verify-coffee", supplierId: "atlas-roasters", unitPriceCents: 1150, quantity, reasoning: "test", payeeEmail: EMAIL, model: "google:gemini-3.8-flash" };
  const p = await appendAudit(SHOP, { type: "proposal", proposal });
  const decision = evaluate(proposal, rules, ctx);
  const d = await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision });
  if (approve) await appendAudit(SHOP, { type: "approved", decisionSeq: d.seq, approvedBy: "shopify-staff:1" });
  const pay = await appendAudit(SHOP, { type: "payout", decisionSeq: d.seq, payoutBatchId: batchId, status: "PENDING", amountCents: decision.totalCents });
  await appendAudit(SHOP, { type: "payout_status", payoutSeq: pay.seq, status: "SUCCESS", transactionId: "TXN123", confirmedByTransactionSearch: true });
  return decision.verdict;
}

ok((await payment(30, "VERIFYCHECKAUTO1")) === "auto", "automatic payment logged");
ok((await payment(60, "VERIFYCHECKAPPR1", true)) === "approval", "approved payment logged");

ok(!(await verifyPayment("NOSUCHBATCH0000")).found, "unknown id -> not found");
ok(!(await verifyPayment("'; drop table--")).found, "malformed id -> not found");

const auto = await verifyPayment("VERIFYCHECKAUTO1");
ok(auto.found && auto.chain.valid && auto.how === "automatic" && auto.paidBy === "PayPal Payouts", "automatic payment verified, chain intact");
ok(auto.found && auto.steps.map((s) => s.step).join(" > ") === "Rules signed > AI proposed the purchase > Rules checked it > Paid via PayPal Payouts > PayPal status update", `steps: ${auto.found ? auto.steps.map((s) => s.step).join(" > ") : ""}`);
ok(auto.found && auto.details === null, "details hidden by default");
ok(!JSON.stringify(auto).includes(EMAIL) && !JSON.stringify(auto).includes("4123.45") && !JSON.stringify(auto).includes("4,123"), "no email or balance in the hashes-only result");

const appr = await verifyPayment("VERIFYCHECKAPPR1");
ok(appr.found && appr.how === "approved" && appr.approvedByKind === "a store staff member" && appr.steps.some((s) => s.step === "A person approved it"), "approved payment shows the approval step");

await setShareVerifyDetails(SHOP, true);
const shared = await verifyPayment("VERIFYCHECKAUTO1");
ok(shared.found && shared.details?.product === "House Blend Coffee 1kg" && shared.details.supplier === "Atlas Roasters" && shared.details.amount === "$345.00", `shared details: ${shared.found ? JSON.stringify({ p: shared.details?.product, s: shared.details?.supplier, a: shared.details?.amount }) : ""}`);
const text = JSON.stringify(shared);
ok(!text.includes(EMAIL) && !text.includes("4,123") && !text.includes("4123"), "even when shared: no email, no PayPal balance");

// Tampering with any entry shows up on the verify page.
const victim = await db.auditEntry.findFirstOrThrow({ where: { shop: SHOP, type: "decision" }, orderBy: { seq: "asc" } });
await db.auditEntry.update({ where: { shop_seq: { shop: SHOP, seq: victim.seq } }, data: { event: { ...(victim.event as object), proposalSeq: 999 } } });
const tampered = await verifyPayment("VERIFYCHECKAPPR1");
ok(tampered.found && !tampered.chain.valid, `tampering detected: ${tampered.found && !tampered.chain.valid ? `entry #${tampered.chain.brokenAtSeq}, ${tampered.chain.reason}` : "NOT detected"}`);

await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
