// Approval through PayPal Orders, against the sandbox (needs a person to approve in PayPal).
//   APP_URL=https://<tunnel> npx tsx scripts/check-paypal-approval.ts create   -> prints the approval link
//   npx tsx scripts/check-paypal-approval.ts status                            -> after approving: shows the log
//   npx tsx scripts/check-paypal-approval.ts clean                             -> deletes the throwaway shop's rows
export {};
process.loadEnvFile(".env");

const { deleteAuditEntries } = await import("./lib/audit-admin");
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { defaultRuleSet, paypalBalanceCents, policyContext, signRuleSet } = await import("../app/lib/agent/restock.server");
const { captureApprovalOrder, createApprovalOrder, executePurchase, ExecutionRefused } = await import("../app/lib/agent/execute.server");
const { evaluate } = await import("../app/lib/policy/engine");
const { deleteDirectory, offersForVariant, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");

const SHOP = "approval-check.guardbuy.test";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const refused = async (fn: () => Promise<unknown>) => { try { await fn(); return "not refused"; } catch (e) { return e instanceof ExecutionRefused ? e.message : `other error: ${(e as Error).message}`; } };
const cmd = process.argv[2];

if (cmd === "create") {
  if (!process.env.APP_URL) throw new Error("Set APP_URL to the dev tunnel URL");
  await deleteAuditEntries({ shop: SHOP });
  await deleteDirectory(SHOP);
  await seedDemoCatalog(SHOP, { "COFFEE-HOUSE-1KG": "test-coffee" }, process.env.SUPPLIER_EMAIL!);
  const rules = defaultRuleSet(SHOP);
  await signRuleSet(SHOP, rules, "approval-check");

  // 46 bags at $11.95 = $549.70: over the $500 limit, so a person must approve.
  const proposal = { sku: "COFFEE-HOUSE-1KG", supplierId: "atlas-roasters", unitPriceCents: 1195, quantity: 46, reasoning: "approval check", variantId: "test-coffee", payeeEmail: process.env.SUPPLIER_EMAIL };
  const p = await appendAudit(SHOP, { type: "proposal", proposal });
  const decision = evaluate(proposal, rules, policyContext(proposal, await auditEntries(SHOP), await paypalBalanceCents(), { managed: true, offers: await offersForVariant(SHOP, "test-coffee") }));
  const d = await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision });
  ok(decision.verdict === "approval", `$${(decision.totalCents / 100).toFixed(2)} -> ${decision.verdict}`);

  ok((await refused(() => executePurchase(SHOP, d.seq))).includes("waiting for approval"), "payout refused before approval");
  ok((await refused(() => captureApprovalOrder(SHOP, d.seq))).includes("no open PayPal order"), "capture refused before an order exists");

  const order = await createApprovalOrder(SHOP, d.seq, `${process.env.APP_URL}/paypal/return`);
  const again = await createApprovalOrder(SHOP, d.seq, `${process.env.APP_URL}/paypal/return`);
  ok(again.seq === order.seq, "creating it again returns the same order");
  ok((await refused(() => captureApprovalOrder(SHOP, d.seq))).includes("not approved yet"), "capture refused before the merchant approves");
  await appendAudit(SHOP, { type: "approved", decisionSeq: d.seq, approvedBy: "approval-check", paymentProtocol: "durable-v1" });
  ok((await refused(() => executePurchase(SHOP, d.seq))).includes("PayPal order"), "payout refused once a PayPal order exists (no double payment)");

  if (order.event.type === "order_created") console.log(`\nApprove as the merchant (personal sandbox buyer) here:\n${order.event.approveUrl}\n`);
} else if (cmd === "status") {
  const log = await auditEntries(SHOP);
  const decision = log.find((e) => e.event.type === "decision");
  if (decision) {
    // Capturing again (e.g. a refreshed return page) must return the same entry.
    const a = await captureApprovalOrder(SHOP, decision.seq).catch((e) => e as Error);
    const b = await captureApprovalOrder(SHOP, decision.seq).catch((e) => e as Error);
    ok(!(a instanceof Error) && !(b instanceof Error) && a.seq === b.seq, `captured once: ${a instanceof Error ? a.message : `entry #${a.seq}`}`);
  }
  for (const e of await auditEntries(SHOP)) console.log(`  #${e.seq} ${e.event.type.padEnd(14)} ${JSON.stringify(e.event).slice(0, 200)}`);
  ok((await verifyChain(SHOP)).valid, "audit chain valid");
} else if (cmd === "clean") {
  await deleteAuditEntries({ shop: SHOP });
  await deleteDirectory(SHOP);
  console.log("cleaned");
}

await db.$disconnect();
process.exit(failed ? 1 : 0);
