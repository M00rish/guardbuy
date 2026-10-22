// Checks for the approval queue against the PayPal sandbox (one real sandbox payout).
// Uses a throwaway shop and deletes its rows at the end.
//   npx tsx scripts/check-approvals.ts
export {};
process.loadEnvFile(".env");

const { deleteAuditEntries } = await import("./lib/audit-admin");
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { defaultRuleSet, paypalBalanceCents, policyContext, signRuleSet, skipReason } = await import("../app/lib/agent/restock.server");
const { approvalQueue, approveInPayPal, approvePurchase, rejectPurchase } = await import("../app/lib/agent/approvals.server");
const { evaluate } = await import("../app/lib/policy/engine");
const { deleteDirectory, offersForVariant, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");

const SHOP = "approvals-check.guardbuy.test";
const VARIANT = "test-coffee";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const outcome = (p: Promise<{ message: string }>) => p.then((r) => r.message, (e) => `refused: ${(e as Error).message}`);
const cleanup = async () => { await deleteAuditEntries({ shop: SHOP }); await deleteDirectory(SHOP); };

await cleanup();
await seedDemoCatalog(SHOP, { "COFFEE-HOUSE-1KG": VARIANT }, process.env.SUPPLIER_EMAIL!);
const rules = defaultRuleSet(SHOP);
await signRuleSet(SHOP, rules, "approvals-check");
const offers = await offersForVariant(SHOP, VARIANT);
const atlas = offers.find((o) => o.supplierId === "atlas-roasters")!;
const balance = await paypalBalanceCents();

/** A purchase over the $500 limit, so the policy sends it to a person. */
async function overLimitPurchase(reasoning: string) {
  const proposal = { sku: "COFFEE-HOUSE-1KG", variantId: VARIANT, supplierId: "atlas-roasters", unitPriceCents: atlas.unitPriceTodayCents, quantity: 46, reasoning, payeeEmail: atlas.paypalEmail };
  const p = await appendAudit(SHOP, { type: "proposal", proposal });
  const decision = evaluate(proposal, rules, policyContext(proposal, await auditEntries(SHOP), balance, { managed: true, offers }));
  return (await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision })).seq;
}

// 1. The card
const first = await overLimitPurchase("Atlas is the preferred supplier; 46 bags covers 14 days.");
let queue = await approvalQueue(SHOP);
const card = queue[0];
ok(queue.length === 1 && card.decisionSeq === first, `queue shows the purchase (#${first})`);
ok(card.needsApprovalBecause.some((c) => c.rule === "approvalAbove"), `reason: ${card.needsApprovalBecause.map((c) => c.detail).join("; ")}`);
ok(card.supplierName === "Atlas Roasters" && card.payeeEmail === process.env.SUPPLIER_EMAIL, "card names the supplier and who gets paid");
ok(card.acceptedUnitPriceCents !== null && card.usualQuantity === 40, `facts: ${card.unitPriceCents}c vs accepted ${card.acceptedUnitPriceCents}c, qty ${card.quantity} vs usual ${card.usualQuantity}`);

// 2. Double click on Approve: paid once
const [a, b] = await Promise.all([outcome(approvePurchase(SHOP, first, "shopify-staff:staff-1")), outcome(approvePurchase(SHOP, first, "shopify-staff:staff-1"))]);
console.log("      first click: ", a);
console.log("      second click:", b);
ok(a.startsWith("Approved and paid") && b.startsWith("refused"), "double click pays once");
const log = await auditEntries(SHOP);
ok(log.filter((e) => e.event.type === "payout").length === 1 && log.filter((e) => e.event.type === "approved").length === 1, "one approval and one payout in the log");
ok(log.some((e) => e.event.type === "approved" && e.event.approvedBy === "shopify-staff:staff-1"), "staff id recorded");
ok((await outcome(approvePurchase(SHOP, first, "shopify-staff:staff-1"))).includes("not waiting"), "approving again later is refused");
ok((await approvalQueue(SHOP)).length === 0, "queue is empty after paying");

// 3. Decline
const second = await overLimitPurchase("second");
ok((await outcome(rejectPurchase(SHOP, second, "shopify-staff:staff-2", "too much stock already"))).startsWith("Declined"), "decline recorded");
ok((await approvalQueue(SHOP)).length === 0, "declined purchase leaves the queue");
const skip = skipReason({ variantId: VARIANT, sku: "COFFEE-HOUSE-1KG" }, await auditEntries(SHOP));
ok(!!skip?.includes("declined"), `no new proposal right after a decline: ${skip}`);

// 4. Approve in PayPal
const third = await overLimitPurchase("third");
const { approveUrl } = await approveInPayPal(SHOP, third, "https://example.com/paypal/return");
ok(approveUrl.includes("paypal.com"), `PayPal order created: ${approveUrl.slice(0, 60)}...`);
queue = await approvalQueue(SHOP);
ok(queue[0]?.status === "paypal_pending" && queue[0].paypalApproveUrl === approveUrl, "card switches to 'waiting for PayPal'");
ok((await outcome(approvePurchase(SHOP, third, "shopify-staff:staff-1"))).includes("PayPal"), "in-app approval refused once a PayPal order exists");

ok((await verifyChain(SHOP)).valid, "audit chain valid");
await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
