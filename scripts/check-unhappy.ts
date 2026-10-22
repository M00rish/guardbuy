// Unhappy paths for approval in PayPal, against the PayPal sandbox. No new money moves:
// GUARDBUY_PAYMENTS_DISABLED is set, so nothing is paid out or captured. The one PayPal transfer
// is a supplier refund of the Oct 16 test capture (money back to the merchant account).
// Throwaway shop, deleted at the end.
//   npx tsx scripts/check-unhappy.ts
export {};
process.loadEnvFile(".env");

const { deleteAuditEntries } = await import("./lib/audit-admin");
process.env.GUARDBUY_PAYMENTS_DISABLED = "1";

const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { defaultRuleSet, policyContext, signRuleSet, spending } = await import("../app/lib/agent/restock.server");
const { allowedApprover, checkCapture, closeOrder, createApprovalOrder, ExecutionRefused, openOrder } = await import("../app/lib/agent/execute.server");
const { approvalQueue, approvePurchase } = await import("../app/lib/agent/approvals.server");
const { sweepPayPalOrders } = await import("../app/lib/paypal/orders-sweep.server");
const { paypal } = await import("../app/lib/paypal/client.server");
const { evaluate } = await import("../app/lib/policy/engine");
const { deleteDirectory, offersForVariant, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");
const { loader: paypalReturn } = await import("../app/routes/paypal.return");

const SHOP = "unhappy-check.guardbuy.test";
const RETURN = "https://example.com/paypal/return";
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const outcome = (p: Promise<unknown>) => p.then(() => "done", (e) => (e instanceof ExecutionRefused ? e.message : `other: ${(e as Error).message}`));
const cleanup = async () => { await deleteAuditEntries({ shop: SHOP }); await deleteDirectory(SHOP); await db.paymentLock.deleteMany({ where: { shop: SHOP } }); };

await cleanup();
await seedDemoCatalog(SHOP, { "COFFEE-HOUSE-1KG": "uh-coffee" }, process.env.SUPPLIER_EMAIL!);
const rules = defaultRuleSet(SHOP);
await signRuleSet(SHOP, rules, "unhappy-check");
const offers = await offersForVariant(SHOP, "uh-coffee");
const atlas = offers.find((o) => o.supplierId === "atlas-roasters")!;

async function overLimit() {
  const proposal = { sku: "COFFEE-HOUSE-1KG", variantId: "uh-coffee", supplierId: "atlas-roasters", unitPriceCents: atlas.unitPriceTodayCents, quantity: 46, reasoning: "check", payeeEmail: atlas.paypalEmail };
  const p = await appendAudit(SHOP, { type: "proposal", proposal });
  const decision = evaluate(proposal, rules, policyContext(proposal, await auditEntries(SHOP), 1_000_000, { managed: true, offers }));
  return (await appendAudit(SHOP, { type: "decision", proposalSeq: p.seq, decision })).seq;
}

// ---------- 1. Cancelled checkout ----------
const d = await overLimit();
const first = await createApprovalOrder(SHOP, d, RETURN);
const firstId = first.event.type === "order_created" ? first.event.orderId : "";
ok((await approvalQueue(SHOP))[0]?.status === "paypal_pending", `PayPal order ${firstId} created, card waits for PayPal`);
const res = await paypalReturn({ request: new Request(`${RETURN}?token=${firstId}&cancelled=1`), params: {}, context: {} } as never) as Response;
const page = await res.text();
ok(page.includes("Not approved") && !openOrder(await auditEntries(SHOP), d), "cancel in PayPal -> order closed, nothing paid");
ok((await approvalQueue(SHOP))[0]?.status === "waiting", "the purchase is back in Approvals");
const second = await createApprovalOrder(SHOP, d, RETURN);
const secondId = second.event.type === "order_created" ? second.event.orderId : "";
ok(!!secondId && secondId !== firstId, `trying PayPal again creates a new order (${secondId})`);

// ---------- 2. While a PayPal order is open, in-app approval is refused; after closing it, allowed ----------
ok((await outcome(approvePurchase(SHOP, d, "shopify-staff:1"))).includes("PayPal"), "in-app approval refused while a PayPal order is open");
const notes = await sweepPayPalOrders(SHOP);
ok(!!openOrder(await auditEntries(SHOP), d), `sweep leaves a fresh unapproved order open (${notes.join("; ") || "no change"})`);
await closeOrder(SHOP, d, secondId, "expired");
const inApp = await approvePurchase(SHOP, d, "shopify-staff:1").then((r) => r.message, (e) => `refused: ${(e as Error).message}`);
const paidOut = (await auditEntries(SHOP)).some((e) => e.event.type === "payout");
ok(inApp.includes("GUARDBUY_PAYMENTS_DISABLED") && !paidOut, `after it expired, in-app approval reaches payment (stopped by the test kill switch, nothing paid): ${inApp}`);

// ---------- 3. An order PayPal doesn't know is closed by the sweep ----------
const d2 = await overLimit();
await appendAudit(SHOP, { type: "order_created", decisionSeq: d2, orderId: "0AB12345CD6789012", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=0AB12345CD6789012", amountCents: 1000 });
const sweep2 = await sweepPayPalOrders(SHOP);
ok(!openOrder(await auditEntries(SHOP), d2), `order unknown to PayPal -> closed by the sweep (${sweep2.join("; ")})`);

// ---------- 4. Only the store's PayPal accounts may approve ----------
ok(allowedApprover("W2SM3R38Q6CD6") && allowedApprover("6JDT8ZFAAAC9G"), "the store's PayPal accounts may approve");
ok(!allowedApprover("STRANGER12345") && !allowedApprover(undefined), "any other PayPal account may not");

// ---------- 5. A capture must pay the recorded supplier the recorded amount ----------
const order = (value: string, email: string) => ({ id: "X", status: "COMPLETED", purchase_units: [{ payee: { email_address: email }, payments: { captures: [{ id: "C", status: "COMPLETED", amount: { value } }] } }] });
const capRes = (o: ReturnType<typeof order>, cents: number) => { try { checkCapture(o, cents, process.env.SUPPLIER_EMAIL); return "ok"; } catch (e) { return (e as Error).message; } };
ok(capRes(order("549.70", process.env.SUPPLIER_EMAIL!), 54970) === "ok", "matching capture accepted");
ok(capRes(order("5497.00", process.env.SUPPLIER_EMAIL!), 54970).includes("expected"), "wrong amount refused");
ok(capRes(order("549.70", "someone-else@example.com"), 54970).includes("unexpected payee"), "wrong payee refused");

// ---------- 6. Supplier refunds a captured order: GuardBuy records it and stops counting it as spent ----------
const supplier = { clientId: process.env.SUPPLIER_PAYPAL_CLIENT_ID!, clientSecret: process.env.SUPPLIER_PAYPAL_CLIENT_SECRET! };
const refund = await paypal<{ id: string; status: string }>("/v2/payments/captures/8LN36233HS0626641/refund", { method: "POST", creds: supplier, requestId: "gb-check-refund-8LN36233HS0626641", body: {} })
  .then((r) => `refund ${r.id} ${r.status}`, (e) => `refund call: ${String(e).slice(0, 120)}`);
console.log(`      supplier ${refund}`);
const d3 = await overLimit();
await appendAudit(SHOP, { type: "order_created", decisionSeq: d3, orderId: "5L627375XA754215L", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5L627375XA754215L", amountCents: 54970 });
await appendAudit(SHOP, { type: "order_captured", decisionSeq: d3, orderId: "5L627375XA754215L", captureId: "8LN36233HS0626641", status: "COMPLETED", amountCents: 54970, confirmedByGetOrder: true });
const spentBefore = spending(await auditEntries(SHOP)).spentLast7dCents;
const sweep3 = await sweepPayPalOrders(SHOP);
const status = (await auditEntries(SHOP)).filter((e) => e.event.type === "order_status").at(-1);
ok(status?.event.type === "order_status" && status.event.status === "REFUNDED", `refund recorded: ${sweep3.join("; ")}`);
ok(spentBefore >= 54970 && spending(await auditEntries(SHOP)).spentLast7dCents === spentBefore - 54970, "refunded money no longer counts toward the weekly cap");

ok((await verifyChain(SHOP)).valid, "audit chain valid");
console.log("      (low balance and unknown supplier email: covered by check-policy's cashFloor and payeeOnFile scenarios)");
await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
