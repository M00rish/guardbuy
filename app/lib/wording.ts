// Shared user-facing vocabulary. Presentation only: provider states and audit events stay unchanged.
export const PAYMENT_LABEL = {
  paid: "Paid",
  pending: "Payment pending",
  unknown: "Payment awaiting confirmation",
  failed: "Payment failed",
  refunded: "Refunded",
  partiallyRefunded: "Partially refunded",
  returned: "Returned",
} as const;

export const APPROVAL_LABEL = {
  waiting: "Needs approval",
  paypal_pending: "Needs approval in PayPal",
  payment_unknown: PAYMENT_LABEL.unknown,
  payment_pending: PAYMENT_LABEL.pending,
  payment_failed: "Payment needs attention",
} as const;

export const COPY = {
  approvalAbove: "Approval required above",
  spendingCap: "7-day spending cap",
  cashFloor: "Minimum PayPal balance",
  refreshPayouts: "Refresh payout status",
  aiExplanation: "AI explanation (not verified)",
  loadError: "This page could not be loaded. Try again. Check the original purchase in Activity before retrying a payment.",
} as const;

/** Unknown provider values stay in details rather than becoming raw status labels. */
export function providerStatusLabel(status: string): string {
  if (["SUCCESS", "COMPLETED"].includes(status)) return PAYMENT_LABEL.paid;
  if (status === "PARTIALLY_REFUNDED") return PAYMENT_LABEL.partiallyRefunded;
  if (status === "REFUNDED") return PAYMENT_LABEL.refunded;
  if (["RETURNED", "REVERSED"].includes(status)) return PAYMENT_LABEL.returned;
  if (["FAILED", "DENIED", "DECLINED", "BLOCKED", "CANCELED", "CANCELLED"].includes(status)) return PAYMENT_LABEL.failed;
  return PAYMENT_LABEL.pending;
}
