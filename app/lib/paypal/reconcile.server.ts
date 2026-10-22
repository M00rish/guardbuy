import { appendAudit, auditEntries } from "../audit/log.server";
import type { AuditEntry } from "../policy/schema";
import { paypal } from "./client.server";
import { runPayPalTool } from "./toolkit.server";

// Reconciliation adds new audit entries; it never edits the original payout entry.
//  1. Payout status (immediate): GET the payout batch -> item status + transaction id.
//  2. PayPal confirmation (delayed): toolkit list_transactions finds that transaction id.
//     PayPal's transaction search can lag up to ~3 hours, so this runs in the background.

type PayoutBatch = {
  batch_header: { batch_status: string };
  items?: { transaction_id?: string; transaction_status?: string }[];
};

type PayoutState = { payout: AuditEntry; status?: string; transactionId?: string; confirmed: boolean };

function payoutStates(log: AuditEntry[]): PayoutState[] {
  return log
    .filter((e) => e.event.type === "payout")
    .map((payout) => {
      const updates = log.filter((e) => e.event.type === "payout_status" && e.event.payoutSeq === payout.seq);
      const latest = updates.at(-1)?.event;
      return {
        payout,
        status: latest?.type === "payout_status" ? latest.status : undefined,
        transactionId: latest?.type === "payout_status" ? latest.transactionId : undefined,
        confirmed: updates.some((u) => u.event.type === "payout_status" && u.event.confirmedByTransactionSearch),
      };
    });
}

const FINAL = new Set(["SUCCESS", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]);

export async function reconcilePayouts(shop: string) {
  const results: string[] = [];
  for (const s of payoutStates(await auditEntries(shop))) {
    if (s.confirmed || s.payout.event.type !== "payout") continue;
    const { payoutBatchId } = s.payout.event;

    // 1. Payout status from the batch itself.
    const batch = await paypal<PayoutBatch>(`/v1/payments/payouts/${payoutBatchId}`);
    const item = batch.items?.[0];
    const status = item?.transaction_status ?? batch.batch_header.batch_status;
    const transactionId = item?.transaction_id;
    if (status !== s.status || transactionId !== s.transactionId) {
      await appendAudit(shop, { type: "payout_status", payoutSeq: s.payout.seq, status, transactionId, confirmedByTransactionSearch: false });
      results.push(`#${s.payout.seq} ${payoutBatchId}: ${status}${transactionId ? ` (txn ${transactionId})` : ""}`);
    }

    // 2. Independent confirmation from PayPal's transaction records (toolkit).
    if (transactionId && FINAL.has(status)) {
      const found = await runPayPalTool<{ transaction_details?: { transaction_info: { transaction_id: string } }[] }>(
        "list_transactions",
        { transaction_id: transactionId, search_months: 1 },
      );
      if (found.transaction_details?.some((d) => d.transaction_info.transaction_id === transactionId)) {
        await appendAudit(shop, { type: "payout_status", payoutSeq: s.payout.seq, status, transactionId, confirmedByTransactionSearch: true });
        results.push(`#${s.payout.seq} ${payoutBatchId}: confirmed by PayPal transaction search`);
      } else {
        results.push(`#${s.payout.seq} ${payoutBatchId}: not in transaction search yet (can lag ~3h)`);
      }
    }
  }
  return results;
}

/** Everything the hourly job checks for a shop: payout statuses and PayPal orders. */
export async function reconcileShop(shop: string) {
  const { sweepPayPalOrders } = await import("./orders-sweep.server");
  return [...(await reconcilePayouts(shop)), ...(await sweepPayPalOrders(shop))];
}
