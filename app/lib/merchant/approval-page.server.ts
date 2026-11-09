import { purchaseParam } from "../alerts/projection";
import { refreshPayouts } from "../paypal/reconcile.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { privateAdmin } from "../merchant/staff.server";
import {
  approvalQueue,
  approveInPayPal,
  approvePurchase,
  rejectPurchase,
  retryPurchase,
} from "../agent/approvals.server";
import { ApprovalRefused } from "../agent/approval-actions";
import { PaymentLockBusy } from "../agent/payment-lock.server";
import { PaymentPending, PaymentRouteRefused } from "../payments/attempts";
import { ExecutionRefused, resumePayment } from "../agent/execute.server";
import { feedNames } from "../merchant/dashboard.server";
import { sweepPayPalOrders } from "../paypal/orders-sweep.server";

// Purchases waiting for a person. Only a signed-in staff member (verified Shopify session token)
// can act, and their staff id is written to the audit log with the decision.

export const loadApprovals = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const purchase = purchaseParam(request.url);
  // Settle PayPal orders first (capture approved ones, close expired or cancelled ones), so the queue is current.
  // A status-only refresh must not capture an approved Order.
  if (
    purchase === null &&
    new URL(request.url).searchParams.get("payoutRefresh") !== "1"
  ) {
    await sweepPayPalOrders(session.shop).catch(() =>
      console.warn("[approvals] PayPal sweep failed"),
    );
  }
  const payoutRefresh = await refreshPayouts(session.shop);
  const [cards, names] = await Promise.all([
    approvalQueue(session.shop),
    feedNames(session.shop),
  ]);
  return {
    payoutRefresh,
    purchase,
    cards: cards
      .filter((c) => purchase === null || c.decisionSeq === purchase)
      .map((c) => ({ ...c, productTitle: names.product(c.sku) ?? c.sku })),
  };
};

export type ApprovalActionData = {
  ok: boolean;
  message: string;
  approveUrl?: string;
};

export const approvalAction = async ({
  request,
}: ActionFunctionArgs): Promise<ApprovalActionData> => {
  const { session, sessionToken } = await privateAdmin(request);
  const staffId = sessionToken?.sub;
  if (!staffId)
    throw new Response("A signed-in staff member is required", { status: 403 });

  const form = await request.formData();
  const decisionSeq = Number(form.get("decisionSeq"));
  if (!Number.isInteger(decisionSeq))
    return { ok: false, message: "Unknown purchase" };

  try {
    switch (form.get("intent")) {
      case "resume": {
        const entry = await resumePayment(session.shop, decisionSeq);
        return entry.event.type === "order_created"
          ? {
              ok: true,
              message:
                "Original PayPal Order recovered. Continue approval in PayPal.",
              approveUrl: entry.event.approveUrl,
            }
          : {
              ok: true,
              message:
                "Original payment outcome recorded. Refresh its status in Activity.",
            };
      }
      case "retry": {
        const result = await retryPurchase(
          session.shop,
          decisionSeq,
          `shopify-staff:${staffId}`,
        );
        return { ok: result.paid, ...result };
      }
      case "approve": {
        const result = await approvePurchase(
          session.shop,
          decisionSeq,
          `shopify-staff:${staffId}`,
        );
        return { ok: result.paid, ...result };
      }
      case "reject":
        return {
          ok: true,
          ...(await rejectPurchase(
            session.shop,
            decisionSeq,
            `shopify-staff:${staffId}`,
            String(form.get("reason") ?? ""),
          )),
        };
      case "paypal": {
        const { approveUrl } = await approveInPayPal(
          session.shop,
          decisionSeq,
          `${process.env.SHOPIFY_APP_URL}/paypal/return`,
        );
        return {
          ok: true,
          message: "PayPal order ready: approve it in PayPal",
          approveUrl,
        };
      }
      default:
        return { ok: false, message: "Unknown action" };
    }
  } catch (e) {
    if (
      e instanceof ApprovalRefused ||
      e instanceof PaymentLockBusy ||
      e instanceof ExecutionRefused ||
      e instanceof PaymentPending ||
      e instanceof PaymentRouteRefused
    )
      return { ok: false, message: e.message };
    console.error("[approvals] Payment action could not be confirmed");
    return {
      ok: false,
      message:
        "Payment status could not be confirmed. Refresh and check the original purchase before retrying.",
    };
  }
};

export type ApprovalPageData = Awaited<ReturnType<typeof loadApprovals>>;
