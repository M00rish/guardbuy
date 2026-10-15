import { appendAudit, auditEntries } from "../audit/log.server";
import { paypal } from "../paypal/client.server";
import type { AuditEntry } from "../policy/schema";
import { supplierById } from "../suppliers/catalog";

// The only code path that moves money. It never takes amounts or suppliers from callers:
// everything comes from the hash-chained audit log, so a payout can only happen for a
// proposal the policy engine approved (verdict "auto"), or one a person approved afterwards.

type PayoutResponse = { batch_header: { payout_batch_id: string; batch_status: string } };

export class ExecutionRefused extends Error {}

function supplierPayoutEmail(supplierId: string): string {
  const supplier = supplierById(supplierId);
  if (!supplier?.honest) throw new ExecutionRefused(`Refusing to pay supplier ${supplierId}`);
  const key = `SUPPLIER_EMAIL_${supplierId.toUpperCase().replace(/-/g, "_")}`;
  const email = process.env[key] ?? process.env.SUPPLIER_EMAIL; // demo: one sandbox account plays every honest supplier
  if (!email) throw new Error("SUPPLIER_EMAIL not set");
  return email;
}

export async function executePurchase(shop: string, decisionSeq: number): Promise<AuditEntry> {
  const log = await auditEntries(shop);
  const decisionEntry = log.find((e) => e.seq === decisionSeq);
  if (decisionEntry?.event.type !== "decision") throw new ExecutionRefused(`Entry ${decisionSeq} is not a decision`);
  const { decision, proposalSeq } = decisionEntry.event;

  const proposalEntry = log.find((e) => e.seq === proposalSeq);
  if (proposalEntry?.event.type !== "proposal") throw new ExecutionRefused(`Decision ${decisionSeq} has no proposal`);
  const proposal = proposalEntry.event.proposal;

  const approved = log.some((e) => e.event.type === "approved" && e.event.decisionSeq === decisionSeq);
  if (decision.verdict === "block") throw new ExecutionRefused(`Decision ${decisionSeq} was blocked by policy`);
  if (decision.verdict === "approval" && !approved) throw new ExecutionRefused(`Decision ${decisionSeq} is waiting for approval`);

  const existing = log.find((e) => e.event.type === "payout" && e.event.decisionSeq === decisionSeq);
  if (existing) return existing; // already paid: never pay twice

  if (decision.totalCents !== proposal.unitPriceCents * proposal.quantity) {
    throw new ExecutionRefused(`Decision ${decisionSeq} total does not match its proposal`);
  }

  // Deterministic id per decision: PayPal treats a repeated id as the same payout.
  const batchId = `gb-${decisionSeq}-${decisionEntry.hash.slice(0, 16)}`;
  const res = await paypal<PayoutResponse>("/v1/payments/payouts", {
    method: "POST",
    requestId: batchId,
    body: {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: "GuardBuy purchase order payment",
        email_message: `Payment for ${proposal.quantity} x ${proposal.sku}`,
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: supplierPayoutEmail(proposal.supplierId),
          amount: { value: (decision.totalCents / 100).toFixed(2), currency: "USD" },
          note: `GuardBuy PO ${shop} #${decisionSeq}: ${proposal.quantity} x ${proposal.sku} (rules ${decision.ruleSetHash.slice(0, 12)})`,
          sender_item_id: `po-${decisionSeq}`,
        },
      ],
    },
  });

  return appendAudit(shop, {
    type: "payout",
    decisionSeq,
    payoutBatchId: res.batch_header.payout_batch_id,
    status: res.batch_header.batch_status,
    amountCents: decision.totalCents,
  });
}
