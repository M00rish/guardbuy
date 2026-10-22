// Plain-language names and descriptions for the policy engine's rules (shared by server and
// browser code: no secrets, no database).

/** Plain names for the policy engine's rules (scoreboard, cards). */
export const RULE_LABELS: Record<string, string> = {
  productManaged: "Product switched on",
  supplierLinked: "Supplier linked to the product",
  payeeOnFile: "PayPal email on file",
  supplierAllowlist: "Approved suppliers",
  maxUnitPrice: "Price cap",
  maxPriceAboveAvg: "Price vs 30-day average",
  maxQuantityMultiple: "Quantity limit",
  maxPurchasesPer24h: "Purchases per day",
  weeklySpendCap: "Weekly spending cap",
  cashFloor: "Cash floor",
  approvalAbove: "Approval limit",
  noApprovalClaim: "No approval claimed by the AI",
  payeeChange: "Recent payment-detail change",
};

// What each rule does, in the merchant's words (same order as the policy engine checks them).
export const RULE_HELP: Record<string, string> = {
  productManaged: "Only products you switched on are ever bought",
  supplierLinked: "Only suppliers you linked to that product",
  supplierAllowlist: "Only suppliers approved in your rules",
  payeeOnFile: "The supplier must have a PayPal email on file; the AI never chooses who gets paid",
  maxUnitPrice: "Hard price cap per product (when set)",
  maxPriceAboveAvg: "No sudden price jumps above the 30-day average",
  maxQuantityMultiple: "No orders many times larger than usual",
  maxPurchasesPer24h: "No bursts of purchases in a day",
  weeklySpendCap: "Total spending stays under your weekly cap",
  cashFloor: "Never takes your PayPal balance below the floor",
  payeeChange: "If a supplier's PayPal email changed in the last 14 days, a person confirms every purchase",
  noApprovalClaim: "If the AI's text claims someone already approved, a person must approve",
  approvalAbove: "Bigger purchases wait for you",
};
