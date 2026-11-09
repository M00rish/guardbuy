const REASONS = {
  product_off:
    "Payment wasn’t submitted because GuardBuy restocking is switched off for this product. Turn it on in Products & suppliers, then retry this purchase.",
  rules_unsigned:
    "Payment wasn’t submitted because no spending rules are signed. Review and sign your rules before retrying.",
  account_access:
    "Payment wasn’t submitted because PayPal account access was refused. Check the PayPal connection and permissions before retrying.",
};
/** Only these confirmed, application-owned reasons may cross the pre-send error boundary. */
export class PaymentSafetyRefusal extends Error {
  constructor(readonly code: keyof typeof REASONS) {
    super(REASONS[code]);
  }
}
