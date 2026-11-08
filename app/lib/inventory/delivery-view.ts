import type { Delivery } from "./deliveries";

export const DELIVERY_VIEWS = [
  { id: "all", label: "All" },
  { id: "ready", label: "To receive" },
  { id: "pending", label: "Payment pending" },
  { id: "attention", label: "Needs attention" },
  { id: "received", label: "Received" },
  { id: "closed", label: "Closed" },
] as const;
export type DeliveryView = typeof DELIVERY_VIEWS[number]["id"];

export function inDeliveryView(d: Pick<Delivery, "remaining" | "pending" | "payment" | "closed" | "overdue" | "partialRefund">, view: DeliveryView) {
  if (view === "all") return true;
  if (view === "attention") return !!d.pending || d.remaining > 0 && (d.payment === "failed" || d.overdue || d.partialRefund);
  if (view === "closed") return d.closed > 0 && d.remaining === 0 && !d.pending;
  if (view === "received") return d.remaining === 0 && d.closed === 0 && !d.pending;
  if (view === "ready") return d.remaining > 0 && d.payment === "paid" && !d.pending;
  return d.remaining > 0 && d.payment === "pending" && !d.pending;
}
