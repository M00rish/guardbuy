import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { captureApprovalOrder, closeOrder, ExecutionRefused, openOrder } from "../agent/execute.server";
import { runPayPalTool } from "./toolkit.server";
import { unresolvedPayments } from "../payments/attempts";

// Background check of PayPal orders (approval in PayPal), so nothing depends on PayPal's redirect
// reaching GuardBuy:
//   approved in PayPal -> captured (payer check + rules re-check happen inside capture)
//   confirmed cancelled / expired -> closed, which frees the purchase
//   already captured -> watched for refunds (spending stops counting refunded money)
// Runs when Approvals loads and from the reconcile job.

// PayPal stops accepting approval of an unapproved order after a few hours; after this we treat it as expired.
const UNAPPROVED_ORDER_TTL_MS = 3 * 60 * 60_000;

type Order = {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { status: string }[]; refunds?: { amount?: { value: string } }[] } }[];
};


export async function sweepPayPalOrders(shop: string, options: { readOnly?: boolean } = {}): Promise<string[]> {
  const notes: string[] = [];
  const log = await auditEntries(shop);
  const decisions = [...new Set(log.flatMap((e) => ((e.event.type === "order_created" || e.event.type === "order_captured") ? [e.event.decisionSeq] : [])))];

  for (const decisionSeq of decisions) {
    const open = openOrder(log, decisionSeq);
    const captured = log.find((e) => e.event.type === "order_captured" && e.event.decisionSeq === decisionSeq);

    // 1. Orders still waiting: capture, close or leave.
    if (open?.event.type === "order_created" && !captured) {
      if (options.readOnly) continue; // Delivery refresh never captures or closes an approval Order.
      const { orderId } = open.event;
      let order: Order;
      try {
        order = await runPayPalTool<Order>("get_order", { id: orderId });
      } catch {
        notes.push(`#${decisionSeq} ${orderId}: PayPal status unavailable; reservation retained`);
        continue;
      }
      if (order.status === "APPROVED" || order.status === "COMPLETED") {
        if (unresolvedPayments(log).some((s) => s.attempt.decisionSeq === decisionSeq)) {
          notes.push(`#${decisionSeq} ${orderId}: original capture needs confirmation; explicit resumption required`);
          continue;
        }
        try {
          const entry = await captureApprovalOrder(shop, decisionSeq);
          notes.push(`#${decisionSeq} ${orderId}: captured (entry #${entry.seq})`);
        } catch (e) {
          notes.push(`#${decisionSeq} ${orderId}: not captured: ${e instanceof ExecutionRefused ? e.message : "PayPal error, will retry"}`);
        }
      } else if (order.status === "VOIDED" || ["CREATED", "PAYER_ACTION_REQUIRED"].includes(order.status) && Date.now() - Date.parse(open.at) > UNAPPROVED_ORDER_TTL_MS) {
        await closeOrder(shop, decisionSeq, orderId, "expired");
        notes.push(`#${decisionSeq} ${orderId}: expired without approval, closed`);
      }
      continue;
    }

    // 2. Captured orders: record status changes (refunds).
    if (captured?.event.type === "order_captured") {
      const { orderId } = captured.event;
      const last = log.filter((e) => e.event.type === "order_status" && e.event.orderId === orderId).at(-1);
      const known = last?.event.type === "order_status" ? last.event.status : captured.event.status;
      if (known === "REFUNDED") continue;
      const order = await runPayPalTool<Order>("get_order", { id: orderId }).catch(() => null);
      const unit = order?.purchase_units?.[0];
      const status = unit?.payments?.captures?.[0]?.status;
      if (!status || order?.id !== orderId) continue;
      const refundedCents = Math.round((unit?.payments?.refunds ?? []).reduce((sum, r) => sum + Number(r.amount?.value ?? 0), 0) * 100);
      const amount = status === "REFUNDED" ? captured.event.amountCents : refundedCents;
      if (status === known && amount === (last?.event.type === "order_status" ? last.event.refundedCents : 0)) continue;
      await appendAuditWhen(shop, { type: "order_status", decisionSeq, orderId, status, refundedCents: amount }, (current) => {
        const latest = current.filter((e) => e.event.type === "order_status" && e.event.orderId === orderId).at(-1)?.event;
        return latest?.type !== "order_status" || latest.status !== status || latest.refundedCents !== amount;
      });
      notes.push(`#${decisionSeq} ${orderId}: ${known} -> ${status}`);
    }
  }
  return notes;
}
