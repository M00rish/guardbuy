// Offline privacy/aggregation and public-route boundary checks. No secrets or services.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { demoEnabled, publicAudit } from "../app/lib/demo/public-dashboard";
import type { AuditEntry, AuditEvent } from "../app/lib/policy/schema";

assert.equal(demoEnabled("demo.myshopify.com", {}), false);
const config = { enabled: "true", shop: "demo.myshopify.com" };
assert.equal(demoEnabled("demo.myshopify.com", config), true);
assert.equal(demoEnabled("other.myshopify.com", config), false);
assert.equal(demoEnabled("demo.myshopify.com#judge-12345678", config), false);
assert.equal(demoEnabled("demo.myshopify.com", { ...config, enabled: "false" }), false);
assert.equal(demoEnabled("demo.myshopify.com", { ...config, paypalBase: "https://api-m.paypal.com" }), false);
assert.equal(demoEnabled("demo.myshopify.com", { ...config, paypalBase: "https://api-m.sandbox.paypal.com.evil.test" }), false);

const log: AuditEntry[] = [];
function add(event: AuditEvent) {
  const entry = { event, shop: "private-shop", seq: log.length, at: "2026-11-01T14:00:00.000Z", hash: "private-hash", prevHash: "private-prev" };
  log.push(entry);
  return entry.seq;
}
const proposal = (scenario?: string): AuditEvent => ({ type: "proposal", scenario, proposal: { sku: "private-sku", supplierId: "private-supplier", reasoning: "private-reasoning <script>alert(1)</script>", payeeEmail: "private@example.test", quantity: 1, unitPriceCents: 100 } });
const decision = (proposalSeq: number): AuditEvent => ({ type: "decision", proposalSeq, decision: { verdict: "auto", totalCents: 100, ruleSetHash: "private-rules", checks: [{ rule: "private-rule", detail: "private-detail", outcome: "auto" }] } });
const p = add(proposal());
const d = add(decision(p));
const payout = add({ type: "payout", decisionSeq: d, payoutBatchId: "private-batch", status: "SUCCESS", amountCents: 100 });
assert.equal(publicAudit(log).payments.pending, 1, "batch SUCCESS cannot prove recipient success");
add({ type: "payout_status", payoutSeq: payout, status: "SUCCESS", transactionId: "private-transaction", confirmedByTransactionSearch: false });
assert.equal(publicAudit(log).payments.successful, 1);
add({ type: "payout_status", payoutSeq: payout, status: "SUCCESS", transactionId: "private-transaction", confirmedByTransactionSearch: true });
assert.equal(publicAudit(log).payments.total, 1, "confirmation does not double-count payments");
add({ type: "payout_status", payoutSeq: payout, status: "RETURNED", confirmedByTransactionSearch: true });
assert.equal(publicAudit(log).payments.successful, 0);
assert.equal(publicAudit(log).payments.refunded, 1, "latest status wins");
const attack = add(proposal("injection-test"));
const attackDecision = add(decision(attack));
add({ type: "payout", decisionSeq: attackDecision, payoutBatchId: "private-attack", status: "SUCCESS", amountCents: 100 });
add({ type: "approved", decisionSeq: d, approvedBy: "private-staff" });
add({ type: "payment_failed", decisionSeq: d, reason: "private-provider-error" });
add({ type: "order_created", decisionSeq: d, orderId: "private-order", approveUrl: "https://example.test/private-token", amountCents: 100 });
add({ type: "order_captured", decisionSeq: d, orderId: "private-order", captureId: "private-capture", payerId: "private-payer", amountCents: 100, status: "COMPLETED", confirmedByGetOrder: true });
add({ type: "order_status", decisionSeq: d, orderId: "private-order", status: "PARTIALLY_REFUNDED", refundedCents: 20 });
const view = publicAudit(log);
assert.equal(view.decisions.proposals, 1, "attack simulations are excluded");
assert.equal(view.decisions.automatic, 1);
assert.equal(view.payments.total, 2);
assert.equal(view.payments.refunded, 2);
assert.ok(!JSON.stringify(view).includes("private"), "public view must not leak private audit fields");
assert.ok(!JSON.stringify(view).includes("<script>"));
assert.equal(publicAudit([]).payments.total, 0);
for (let i = 0; i < 40; i++) add({ type: "approved", decisionSeq: d, approvedBy: "private-staff" });
assert.equal(publicAudit(log).timeline.length, 30);

// Public code must stay read-only, authenticated through the proxy, and explicitly opt-in.
const api = readFileSync("app/routes/proxy_.api.tsx", "utf8");
const shell = readFileSync("app/routes/proxy.tsx", "utf8");
const server = readFileSync("app/lib/demo/dashboard.server.ts", "utf8");
for (const code of [api, shell]) {
  assert.ok(code.includes("authenticate.public.appProxy(request)"));
  assert.ok(code.includes("requirePublicDemo(session.shop)"));
  assert.ok(!/judgeApprove|judgeRestock|judgeAttack|judgeDecline|refreshPayouts|reconcileShop|sweepPayPalOrders/.test(code));
}
assert.ok(/export const action = \(\) => new Response\("Read-only dashboard", \{ status: 405/.test(api));
assert.ok(!/appendAudit|runRestock|runPayPalTool|refreshPayouts|reconcileShop|sweepPayPalOrders/.test(server));
assert.ok(!/innerHTML|localStorage|data-action=|method: "POST"/.test(shell));
assert.ok(server.includes("test:true created_at:"));
// Compile the exact JavaScript served inside the static template (without importing Shopify).
const rawShell = shell.match(/export const SHELL = `([\s\S]*?)`;/)![1];
const html = new Script("`" + rawShell + "`").runInNewContext() as string;
new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
const privateTests = readFileSync("app/routes/app.attack-tests.tsx", "utf8");
assert.ok(privateTests.includes("adminWithStaff(request)"));
assert.ok(privateTests.includes("sha256Hex(actor)"));
assert.ok(!/judgeApprove|judgeRestock|judgeDecline/.test(privateTests));
console.log("Public demo checks passed: opt-in, sandbox restriction, privacy, latest statuses, simulation exclusion, read-only route boundaries and browser script syntax.");
