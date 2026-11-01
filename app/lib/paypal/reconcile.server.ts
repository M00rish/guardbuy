import { appendAudit, auditEntries } from "../audit/log.server";
import { paypal } from "./client.server";
import { runPayPalTool } from "./toolkit.server";
import { createPayoutRefresh, type PayoutBatch } from "./payout-refresh";

// Shared by both pages and the legacy manual job. One run per shop per app process.
export const refreshPayouts = createPayoutRefresh({
  read: auditEntries,
  append: appendAudit,
  batch: (id) => paypal<PayoutBatch>(`/v1/payments/payouts/${encodeURIComponent(id)}`),
  confirmed: async (id) => {
    const found = await runPayPalTool<{ transaction_details?: { transaction_info: { transaction_id: string } }[] }>(
      "list_transactions", { transaction_id: id, search_months: 1 },
    );
    return found.transaction_details?.some((d) => d.transaction_info.transaction_id === id) ?? false;
  },
});

export async function reconcilePayouts(shop: string) {
  const state = await refreshPayouts(shop);
  return [state.running ? "Payout refresh in progress" : state.failed ? "Some payout statuses could not be refreshed" : "Payout status refresh checked"];
}

/** Legacy manual job only; app payout refresh never calls the Orders sweep. */
export async function reconcileShop(shop: string) {
  const { sweepPayPalOrders } = await import("./orders-sweep.server");
  return [...(await reconcilePayouts(shop)), ...(await sweepPayPalOrders(shop))];
}
