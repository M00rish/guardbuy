import type { AuditEntry, AuditEvent } from "../policy/schema";

export class DeliveryRefused extends Error {}
const FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "DECLINED", "CANCELED", "CANCELLED"]);
export type Delivery = {
  decisionSeq: number; variantId: string; sku: string; supplierId: string; ordered: number;
  received: number; closed: number; remaining: number; revision: number; partialRefund: boolean;
  expectedAt: string | null; estimateSource: "supplier" | "merchant" | null; overdue: boolean;
  payment: "pending" | "paid" | "failed";
  pending?: AuditEntry & { event: Extract<AuditEvent, { type: "receipt_started" }> };
};

/** Physical receipts are independent of payment status; refunds never erase received goods. */
export function deliveries(log: AuditEntry[], now = new Date()): Delivery[] {
  return log.flatMap((decision): Delivery[] => {
    if (decision.event.type !== "decision") return [];
    const proposal = log.find((e) => e.seq === (decision.event.type === "decision" ? decision.event.proposalSeq : -1))?.event;
    if (proposal?.type !== "proposal" || proposal.scenario || !proposal.proposal.variantId) return [];
    const forDecision = log.filter((e) => "decisionSeq" in e.event && e.event.decisionSeq === decision.seq);
    const payout = forDecision.find((e) => e.event.type === "payout");
    const capture = forDecision.find((e) => e.event.type === "order_captured");
    if (!payout && !capture) return [];
    let status = "PENDING";
    if (payout?.event.type === "payout") {
      const update = [...log].reverse().find((e) => e.event.type === "payout_status" && e.event.payoutSeq === payout.seq)?.event;
      status = update?.type === "payout_status" ? update.status : FAILED.has(payout.event.status) ? payout.event.status : "PENDING";
    } else if (capture?.event.type === "order_captured") {
      const orderId = capture.event.orderId;
      const update = [...log].reverse().find((e) => e.event.type === "order_status" && e.event.orderId === orderId)?.event;
      status = update?.type === "order_status" ? update.status : capture.event.status;
    }
    const completedIds = new Set(forDecision.flatMap((e) => e.event.type === "receipt_received" || e.event.type === "receipt_rejected" ? [e.event.receiptId] : []));
    const receipts = forDecision.filter((e) => e.event.type === "receipt_received");
    const unique = new Map(receipts.map((e) => [e.event.type === "receipt_received" ? e.event.receiptId : "", e]));
    const received = [...unique.values()].reduce((sum, e) => sum + (e.event.type === "receipt_received" ? e.event.quantity : 0), 0);
    const pending = forDecision.find((e): e is NonNullable<Delivery["pending"]> => e.event.type === "receipt_started" && !completedIds.has(e.event.receiptId));
    const p = proposal.proposal;
    const changes = forDecision.filter((e) => ["receipt_started", "receipt_received", "receipt_rejected", "delivery_estimate_updated", "delivery_remainder_closed"].includes(e.event.type));
    const closed = [...new Map(forDecision.filter((e) => e.event.type === "delivery_remainder_closed").map((e) => [e.event.type === "delivery_remainder_closed" ? e.event.updateId : "", e])).values()]
      .reduce((sum, e) => sum + (e.event.type === "delivery_remainder_closed" ? e.event.quantity : 0), 0);
    const remaining = Math.max(0, p.quantity - received - closed);
    const override = changes.filter((e) => e.event.type === "delivery_estimate_updated").at(-1)?.event;
    // Start supplier lead time at first positive settlement, not at an unconfirmed batch response.
    const settled = capture?.event.type === "order_captured" && capture.event.status === "COMPLETED" ? capture
      : log.find((e) => e.event.type === "payout_status" && e.event.payoutSeq === payout?.seq && e.event.status === "SUCCESS"
        || e.event.type === "order_status" && capture?.event.type === "order_captured" && e.event.orderId === capture.event.orderId && e.event.status === "COMPLETED");
    let expectedAt: string | null = null;
    let estimateSource: Delivery["estimateSource"] = null;
    if (override?.type === "delivery_estimate_updated") { expectedAt = override.expectedAt; estimateSource = "merchant"; }
    else if (settled && p.supplierLeadTimeDays !== undefined) {
      const day = Date.parse(settled.at.slice(0, 10) + "T00:00:00Z") + (p.supplierLeadTimeDays + 1) * 86_400_000 - 1;
      if (Number.isFinite(day) && Math.abs(day) <= 8.64e15) { expectedAt = new Date(day).toISOString(); estimateSource = "supplier"; }
    }
    const partialRefund = status === "PARTIALLY_REFUNDED";
    const payment = status === "SUCCESS" || status === "COMPLETED" || partialRefund ? "paid" : FAILED.has(status) || status.includes("REFUND") ? "failed" : "pending";
    return [{ decisionSeq: decision.seq, variantId: p.variantId!, sku: p.sku, supplierId: p.supplierId, ordered: p.quantity,
      received, closed, remaining, revision: changes.at(-1)?.seq ?? (payout ?? capture)!.seq, partialRefund,
      expectedAt, estimateSource, overdue: remaining > 0 && payment === "paid" && !!expectedAt && now.getTime() > Date.parse(expectedAt), payment, pending }];
  });
}

export function incomingFor(log: AuditEntry[], variantId: string) {
  return deliveries(log).filter((d) => d.variantId === variantId && (d.payment !== "failed" || d.pending)).reduce((sum, d) => sum + d.remaining, 0);
}

type ReceiptInput = { decisionSeq: number; receiptId: string; quantity: number; expectedReceived: number; locationId: string };
type ReceiptStarted = Extract<AuditEvent, { type: "receipt_started" }>;
type Ports = {
  read: (shop: string) => Promise<AuditEntry[]>;
  append: (shop: string, event: AuditEvent) => Promise<unknown>;
  lock: <T>(shop: string, fn: () => Promise<T>) => Promise<T>;
  resolveItem: (variantId: string, locationId: string) => Promise<string>;
  adjust: (event: ReceiptStarted) => Promise<"received" | "rejected">;
  now?: () => number;
};

/** Durable intent + Shopify's idempotency key bridge the database/API transaction boundary. */
export function createReceiveDelivery(ports: Ports) {
  return (shop: string, actor: string, input: ReceiptInput) => ports.lock(shop, async () => {
    if (!Number.isSafeInteger(input.decisionSeq) || !Number.isSafeInteger(input.quantity) || input.quantity <= 0 || !Number.isSafeInteger(input.expectedReceived) || input.expectedReceived < 0 || !/^[0-9a-f-]{36}$/i.test(input.receiptId) || !/^gid:\/\/shopify\/Location\/\d+$/.test(input.locationId)) throw new DeliveryRefused("Invalid receipt details");
    let log = await ports.read(shop);
    const previous = log.find((e) => "receiptId" in e.event && e.event.receiptId === input.receiptId && e.event.type === "receipt_started");
    if (previous?.event.type === "receipt_started" && (previous.event.decisionSeq !== input.decisionSeq || previous.event.quantity !== input.quantity || previous.event.locationId !== input.locationId || previous.event.expectedReceived !== input.expectedReceived)) throw new DeliveryRefused("This receipt was already submitted with different details");
    if (log.some((e) => e.event.type === "receipt_received" && e.event.receiptId === input.receiptId)) return "This delivery was already received. Stock was not added again.";
    if (log.some((e) => e.event.type === "receipt_rejected" && e.event.receiptId === input.receiptId)) throw new DeliveryRefused("This receipt was rejected by Shopify. Reload and create a new receipt.");
    const delivery = deliveries(log).find((d) => d.decisionSeq === input.decisionSeq);
    if (!delivery) throw new DeliveryRefused("No supplier delivery exists for this purchase");
    if (delivery.pending && delivery.pending.event.receiptId !== input.receiptId) throw new DeliveryRefused("Resolve the pending receipt before recording another delivery");
    let intent = delivery.pending;
    if (!intent) {
      if (delivery.payment !== "paid") throw new DeliveryRefused("Confirm successful payment in Activity before receiving this delivery");
      if (delivery.received !== input.expectedReceived) throw new DeliveryRefused("Another receipt changed this purchase. Reload before receiving more units.");
      if (input.quantity > delivery.remaining) throw new DeliveryRefused("Received quantity exceeds the outstanding order");
      const inventoryItemId = await ports.resolveItem(delivery.variantId, input.locationId);
      const event: ReceiptStarted = { type: "receipt_started", ...input, variantId: delivery.variantId, inventoryItemId, receivedBy: actor };
      await ports.append(shop, event);
      log = await ports.read(shop);
      intent = deliveries(log).find((d) => d.decisionSeq === input.decisionSeq)?.pending;
      if (!intent || intent.event.receiptId !== input.receiptId) throw new DeliveryRefused("Receipt reservation could not be verified. Reload before retrying.");
    }
    // Shopify expires idempotency keys after 24h. Never replay ambiguous writes beyond 23h.
    if ((ports.now ?? Date.now)() - Date.parse(intent.at) >= 23 * 60 * 60_000) throw new DeliveryRefused("This receipt needs manual reconciliation against Shopify inventory history. Do not add stock again.");
    const outcome = await ports.adjust(intent.event);
    if (outcome === "rejected") {
      await ports.append(shop, { type: "receipt_rejected", decisionSeq: input.decisionSeq, receiptId: input.receiptId });
      throw new DeliveryRefused("Shopify rejected the stock adjustment. Check the location and inventory permissions, then reload.");
    }
    await ports.append(shop, { type: "receipt_received", decisionSeq: input.decisionSeq, receiptId: input.receiptId, quantity: intent.event.quantity, variantId: intent.event.variantId, locationId: intent.event.locationId, receivedBy: actor });
    return `Received ${intent.event.quantity} units. Shopify stock updated.`;
  });
}

/** Used under the audit database lock, independent of the outer expiring coordination lease. */
export function canAppendReceipt(log: AuditEntry[], event: AuditEvent): boolean {
  if (event.type === "receipt_started") {
    const d = deliveries(log).find((row) => row.decisionSeq === event.decisionSeq);
    return !!d && !d.pending && d.payment === "paid" && d.received === event.expectedReceived
      && event.quantity <= d.remaining && d.variantId === event.variantId
      && !log.some((e) => "receiptId" in e.event && e.event.receiptId === event.receiptId);
  }
  if (event.type === "receipt_received" || event.type === "receipt_rejected") {
    return deliveries(log).some((d) => d.decisionSeq === event.decisionSeq && d.pending?.event.receiptId === event.receiptId
      && (event.type === "receipt_rejected" || event.quantity === d.pending.event.quantity && event.variantId === d.pending.event.variantId && event.locationId === d.pending.event.locationId));
  }
  return false;
}
