import type { AuditEntry } from "../policy/schema";

/** Recipient/capture evidence, never batch acceptance alone, establishes settlement. */
export function paymentStatus(log: AuditEntry[], payment: AuditEntry) {
  const ev = payment.event;
  let status = "PENDING";
  if (ev.type === "payout") {
    const latest = log.filter((e) => e.event.type === "payout_status" && e.event.payoutSeq === payment.seq).at(-1)?.event;
    status = latest?.type === "payout_status" ? latest.status : ev.status === "SUCCESS" ? "PENDING" : ev.status;
  } else if (ev.type === "order_captured") {
    const latest = log.filter((e) => e.event.type === "order_status" && e.event.orderId === ev.orderId).at(-1)?.event;
    status = latest?.type === "order_status" ? latest.status : ev.status;
  }
  if (["SUCCESS", "COMPLETED"].includes(status)) return { label: "Paid", tone: "success" as const, settled: true };
  if (["REFUNDED", "PARTIALLY_REFUNDED"].includes(status)) return { label: status === "PARTIALLY_REFUNDED" ? "Partially refunded" : "Refunded", tone: "warning" as const, settled: false };
  if (["RETURNED", "REVERSED"].includes(status)) return { label: "Returned", tone: "warning" as const, settled: false };
  if (["FAILED", "DENIED", "DECLINED", "BLOCKED", "CANCELED", "CANCELLED"].includes(status)) return { label: "Failed", tone: "critical" as const, settled: false };
  return { label: "Payment pending", tone: "info" as const, settled: false };
}

export function budgetSummary(spent: number, reserved: number, cap: number) {
  return { spent, reserved, committed: spent + reserved, remaining: Math.max(0, cap - spent - reserved), over: Math.max(0, spent + reserved - cap) };
}
