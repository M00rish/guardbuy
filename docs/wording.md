# GuardBuy wording

Use the shared browser-safe vocabulary in `app/lib/wording.ts` for approval/payment labels and recurring rule terms. Provider codes, audit event types and signed rule data stay unchanged. Older audit entries receive the same presentation as new ones.

| Concept | Wording |
| --- | --- |
| Combined product page | Products & Suppliers |
| Combined rules page | Rules & Approvals |
| Staff review needed | Needs approval |
| Checkout approval still required | Needs approval in PayPal |
| Submitted payment, provider result pending | Payment pending |
| Payment outcome cannot be confirmed | Payment awaiting confirmation |
| Purchase recovery/review needed | Payment needs attention |
| Confirmed failed provider outcome | Payment failed |
| Confirmed settlement | Paid |
| Rule threshold | Approval required above |
| Rolling spending limit | 7-day spending cap |
| Balance safeguard | Minimum PayPal balance |
| Telegram messages | Alerts |

A purchase is the proposed supplier restock. Approval authorizes it; approval does not confirm payment. Supplier approval **in rules** is separate from approval of an individual purchase. Spent and reserved amounts have different meanings and both count toward the spending cap. Blocked proposal value is not realized savings.

Activity summaries use one short sentence: what happened, with the relevant purchase/product or result. Keep supporting reasons, provider references and AI/supplier text in expandable details. Label AI explanations as unverified. Keep historical events in the past tense and explain current payment status separately where it is projected from later provider evidence.

Use sentence case for controls and headings, with the agreed navigation names above. Actions start with a verb: View details, View activity, Sign rules, Approve and pay, Approve in PayPal, Resume original payment. Keep the two payment routes distinct; explain the funding account, recipient and amount before submission. A refresh must say what it checks: Refresh payout status or Refresh delivery status.

Errors explain the problem and a useful next action without printing raw provider payloads. A page-load failure cannot establish whether money moved. Never describe an uncertain payment as failed, unpaid or safe to replace. Preserve the original payment recovery guidance. Public views use allowlisted redacted facts, even when merchant views have more detail.

Use the app's currency formatting and readable dates; include UTC for explicit server-recorded timestamps. Keep the original date/amount semantics. Check narrow screens and fallback states as well as the successful path when changing copy.

Login and privacy retain their existing store-entry instructions and legal qualifications. Technical identifiers remain in detail views. The public demo remains a shared read-only store view; it must not imply a private judge session or attribute a payment to a particular customer order.
