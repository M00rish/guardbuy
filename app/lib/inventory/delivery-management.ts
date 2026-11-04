import type { AuditEntry, AuditEvent } from "../policy/schema";
import { deliveries, DeliveryRefused } from "./deliveries";

type Change = Extract<AuditEvent, { type: "delivery_estimate_updated" | "delivery_remainder_closed" }>;
type Input = { decisionSeq: number; updateId: string; expectedRevision: number } & (
  { intent: "estimate"; date: string } | { intent: "close"; reason: "supplier_cancelled" | "not_arriving"; confirmed: boolean }
);
export function canManageDelivery(log: AuditEntry[], event: Change) {
  const d = deliveries(log).find((row) => row.decisionSeq === event.decisionSeq);
  return !!d && !d.pending && d.payment !== "pending" && d.remaining > 0 && d.revision === event.expectedRevision
    && !log.some((e) => "updateId" in e.event && e.event.updateId === event.updateId)
    && (event.type !== "delivery_remainder_closed" || event.quantity === d.remaining)
    && (event.type !== "delivery_estimate_updated" || d.payment === "paid");
}

/** Estimates and closing a remainder never move money or write Shopify inventory. */
export function createManageDelivery(ports: {
  read: (shop: string) => Promise<AuditEntry[]>;
  append: (shop: string, event: Change) => Promise<boolean>;
  lock: <T>(shop: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}) {
  return (shop: string, actor: string, input: Input) => ports.lock(shop, async () => {
    if (!Number.isSafeInteger(input.decisionSeq) || !Number.isSafeInteger(input.expectedRevision) || !/^[0-9a-f-]{36}$/i.test(input.updateId)) throw new DeliveryRefused("Invalid delivery update");
    const log = await ports.read(shop);
    const prior = log.find((e) => "updateId" in e.event && e.event.updateId === input.updateId)?.event;
    if (prior && "updateId" in prior) {
      if (prior.decisionSeq !== input.decisionSeq || prior.expectedRevision !== input.expectedRevision
        || input.intent === "estimate" && (prior.type !== "delivery_estimate_updated" || prior.expectedAt.slice(0, 10) !== input.date)
        || input.intent === "close" && (prior.type !== "delivery_remainder_closed" || prior.reason !== input.reason || !input.confirmed)) throw new DeliveryRefused("This delivery update was already submitted with different details");
      return "This delivery update was already recorded.";
    }
    const d = deliveries(log).find((row) => row.decisionSeq === input.decisionSeq);
    if (!d || d.pending || d.payment === "pending" || d.remaining === 0) throw new DeliveryRefused("Resolve payment and any pending receipt before changing an outstanding delivery");
    let event: Change;
    if (input.intent === "estimate") {
      const today = new Date((ports.now ?? Date.now)()).toISOString().slice(0, 10);
      const date = new Date(input.date + "T23:59:59.999Z");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date || input.date < today) throw new DeliveryRefused("Enter a valid expected arrival date today or later (UTC)");
      event = { type: "delivery_estimate_updated", decisionSeq: input.decisionSeq, updateId: input.updateId, expectedRevision: input.expectedRevision, expectedAt: date.toISOString(), updatedBy: actor };
    } else {
      if (!input.confirmed || !["supplier_cancelled", "not_arriving"].includes(input.reason)) throw new DeliveryRefused("Confirm with the supplier that no more goods will arrive before closing the remainder");
      event = { type: "delivery_remainder_closed", decisionSeq: input.decisionSeq, updateId: input.updateId, expectedRevision: input.expectedRevision, quantity: d.remaining, reason: input.reason, closedBy: actor };
    }
    if (!canManageDelivery(log, event) || !await ports.append(shop, event)) throw new DeliveryRefused("This delivery changed in another tab. Reload before updating it.");
    return event.type === "delivery_estimate_updated" ? "Expected arrival updated. The outstanding quantity remains incoming."
      : "Remaining delivery closed. No stock or payment was changed; the agent may propose a replacement within your rules.";
  });
}
