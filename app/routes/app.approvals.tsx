import { purchaseParam } from "../lib/alerts/projection";
import { refreshPayouts } from "../lib/paypal/reconcile.server";
import { PayoutRefresh } from "../components/payout-refresh";
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { privateAdmin } from "../lib/merchant/staff.server";
import { approvalQueue, approveInPayPal, approvePurchase, rejectPurchase, retryPurchase, type ApprovalCard } from "../lib/agent/approvals.server";
import { ApprovalRefused } from "../lib/agent/approval-actions";
import { PaymentLockBusy } from "../lib/agent/payment-lock.server";
import { PaymentPending, PaymentRouteRefused } from "../lib/payments/attempts";
import { ExecutionRefused, resumePayment } from "../lib/agent/execute.server";
import { feedNames } from "../lib/merchant/dashboard.server";
import { sweepPayPalOrders } from "../lib/paypal/orders-sweep.server";
import { usd } from "../lib/format";
import { ago, Empty, plural, Row } from "../components/ui";

// Purchases waiting for a person. Only a signed-in staff member (verified Shopify session token)
// can act, and their staff id is written to the audit log with the decision.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const purchase = purchaseParam(request.url);
  // Settle PayPal orders first (capture approved ones, close expired or cancelled ones), so the queue is current.
  // A status-only refresh must not capture an approved Order.
  if (purchase === null && new URL(request.url).searchParams.get("payoutRefresh") !== "1") {
    await sweepPayPalOrders(session.shop).catch(() => console.warn("[approvals] PayPal sweep failed"));
  }
  const payoutRefresh = await refreshPayouts(session.shop);
  const [cards, names] = await Promise.all([approvalQueue(session.shop), feedNames(session.shop)]);
  return { payoutRefresh, purchase, cards: cards.filter(c => purchase === null || c.decisionSeq === purchase).map((c) => ({ ...c, productTitle: names.product(c.sku) ?? c.sku })) };
};

type ActionResult = { ok: boolean; message: string; approveUrl?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, sessionToken } = await privateAdmin(request);
  const staffId = sessionToken?.sub;
  if (!staffId) throw new Response("A signed-in staff member is required", { status: 403 });

  const form = await request.formData();
  const decisionSeq = Number(form.get("decisionSeq"));
  if (!Number.isInteger(decisionSeq)) return { ok: false, message: "Unknown purchase" };

  try {
    switch (form.get("intent")) {
      case "resume": {
        const entry = await resumePayment(session.shop, decisionSeq);
        return entry.event.type === "order_created" ? { ok: true, message: "Original PayPal Order recovered. Continue approval in PayPal.", approveUrl: entry.event.approveUrl }
          : { ok: true, message: "Original payment outcome recorded. Refresh its status in Activity." };
      }
      case "retry": {
        const result = await retryPurchase(session.shop, decisionSeq, `shopify-staff:${staffId}`);
        return { ok: result.paid, ...result };
      }
      case "approve": {
        const result = await approvePurchase(session.shop, decisionSeq, `shopify-staff:${staffId}`);
        return { ok: result.paid, ...result };
      }
      case "reject":
        return { ok: true, ...(await rejectPurchase(session.shop, decisionSeq, `shopify-staff:${staffId}`, String(form.get("reason") ?? ""))) };
      case "paypal": {
        const { approveUrl } = await approveInPayPal(session.shop, decisionSeq, `${process.env.SHOPIFY_APP_URL}/paypal/return`);
        return { ok: true, message: "PayPal order ready: approve it in PayPal", approveUrl };
      }
      default:
        return { ok: false, message: "Unknown action" };
    }
  } catch (e) {
    if (e instanceof ApprovalRefused || e instanceof PaymentLockBusy || e instanceof ExecutionRefused || e instanceof PaymentPending || e instanceof PaymentRouteRefused) return { ok: false, message: e.message };
    console.error("[approvals] Payment action could not be confirmed");
    return { ok: false, message: "Payment status could not be confirmed. Refresh and check the original purchase before retrying." };
  }
};

/** "expires in 5 h" / "expires in 20 min" */
const expiresIn = (iso: string) => {
  const min = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return min >= 120 ? `expires in ${Math.round(min / 60)} h` : `expires in ${min} min`;
};
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}%`;

type Card = ApprovalCard & { productTitle: string };

export default function Approvals() {
  const { cards, payoutRefresh, purchase } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Approvals" inlineSize="large">
      <PayoutRefresh state={payoutRefresh} />
      {purchase !== null && <s-section><s-banner tone="info" heading={`Purchase #${purchase}`}>{cards.length ? "Current approval and recovery state for this purchase." : "This purchase no longer needs action here. It may be settled, declined, or expired."} <s-link href={`/app/activity?purchase=${purchase}`}>View purchase history</s-link> · <s-link href="/app/approvals">Show all approvals</s-link></s-banner></s-section>}
      <s-section><s-text>After payment, track incoming stock and record received goods in </s-text><s-link href="/app/deliveries">Deliveries</s-link><s-text>.</s-text></s-section>
      {cards.length === 0 ? (
        <s-section>
          <Empty heading="Nothing is waiting for you">
            Purchases needing approval or payment attention appear here. New approvals expire after 48 hours; uncertain payments stay reserved until confirmed.
          </Empty>
        </s-section>
      ) : (
        <>
          <s-section>
            <s-text tone="neutral">
              {plural(cards.length, "purchase")} needing approval or payment attention. GuardBuy computed the facts below itself; the AI’s explanation comes last and isn’t verified.
            </s-text>
          </s-section>
          {cards.map((card) => <CardView key={card.decisionSeq} card={card} />)}
        </>
      )}
    </s-page>
  );
}

function CardView({ card }: { card: Card }) {
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const busyWith = fetcher.formData?.get("intent");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent: string) => fetcher.submit({ intent, decisionSeq: card.decisionSeq }, { method: "POST" });
  const priceDelta = card.acceptedUnitPriceCents ? (card.unitPriceCents / card.acceptedUnitPriceCents - 1) * 100 : null;
  const qtyMultiple = card.usualQuantity ? card.quantity / card.usualQuantity : null;
  const passed = card.otherChecks.filter((c) => c.outcome === "auto").length;

  const statusLabel = { waiting: "Needs you", paypal_pending: "Waiting for PayPal", payment_unknown: "Awaiting PayPal confirmation", payment_pending: "Payment submitted · pending", payment_failed: card.canRetry ? "Approved · unpaid" : "Payment needs attention" }[card.status];
  return (
    <s-section heading={`${card.quantity} × ${card.productTitle}`}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge tone={card.status === "paypal_pending" || card.status === "payment_pending" ? "info" : "caution"}>{statusLabel}</s-badge>
          <s-heading>{usd(card.totalCents)}</s-heading>
          <s-text tone="neutral">from {card.supplierName} · proposed {ago(card.proposedAt, Date.now())} · {card.status === "payment_unknown" || card.status === "payment_pending" ? "Original payment remains reserved" : card.expired ? "Approval expired" : expiresIn(card.expiresAt)}</s-text>
        </s-stack>

        <s-stack gap="small-200">
          {card.needsApprovalBecause.map((c) => (
            <s-banner key={c.rule} tone="warning">{c.detail}</s-banner>
          ))}
        </s-stack>

        <s-stack gap="small-200">
          <Row label="Price per unit">
            <s-text>{usd(card.unitPriceCents)}{priceDelta !== null && ` · ${pct(priceDelta)} vs the ${usd(card.acceptedUnitPriceCents!)} you accepted`}</s-text>
          </Row>
          <Row label="Quantity">
            <s-text>{card.quantity}{qtyMultiple !== null && ` · ${qtyMultiple.toFixed(1)}× the usual ${card.usualQuantity}`}</s-text>
          </Row>
          <Row label="Pays">
            <s-text>{card.payeeEmail ?? "No PayPal email on file"}</s-text>
          </Row>
          <Row label="Other rules">
            <s-text tone="neutral">{`${passed} passed`}</s-text>
          </Row>
        </s-stack>

        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack gap="small-200">
            <s-text type="strong">The AI’s explanation (not verified)</s-text>
            <s-text>{card.aiExplanation}</s-text>
          </s-stack>
        </s-box>

        {card.status === "payment_unknown" ? (
          <s-stack gap="base">
            <s-text>{card.canResume ? "The original payment outcome is uncertain. Resuming may submit that original payment if PayPal has not processed it. It uses the same request ID and cannot switch payment routes." : card.paymentReason}</s-text>
            {card.canResume && <s-button disabled={busy} loading={busy && busyWith === "resume"} onClick={() => submit("resume")}>Resume original payment</s-button>}
            <s-link href="/app/activity">View payment evidence in Activity</s-link>
            {fetcher.data?.approveUrl && <s-link href={fetcher.data.approveUrl} target="_blank">Continue in PayPal</s-link>}
          </s-stack>
        ) : card.status === "payment_pending" ? (
          <s-stack gap="base">
            <s-text>PayPal has the original payment. Its outcome is still pending; do not submit another payment. Use Refresh payout status above to check for confirmation.</s-text>
            <s-link href="/app/activity">View payment evidence in Activity</s-link>
          </s-stack>
        ) : card.status === "payment_failed" ? (
          <s-stack gap="base">
            <s-banner tone="warning">{card.paymentReason ?? "Payment was not submitted successfully."}</s-banner>
            <s-text>{card.canRetry ? "Retry pays the same supplier and amount for this approved purchase, after checking your current rules." : card.canCancel ? "This purchase cannot be retried here. Cancel it to let the agent propose a fresh purchase with current numbers." : "This payment already has a provider result. Review its evidence in Activity; retrying or cancelling it here could misrepresent what PayPal processed."}</s-text>
            <s-stack direction="inline" gap="base">
              {card.canRetry && <s-button variant="primary" disabled={busy} loading={busy && busyWith === "retry"} onClick={() => submit("retry")}>{`Retry payment of ${usd(card.totalCents)}`}</s-button>}
              {card.canCancel && <s-button tone="critical" variant="tertiary" disabled={busy} loading={busy && busyWith === "reject"} onClick={() => submit("reject")}>Cancel unpaid purchase</s-button>}
              <s-link href="/app/activity">View payment evidence</s-link>
            </s-stack>
          </s-stack>
        ) : card.status === "paypal_pending" && card.paypalApproveUrl ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button variant="primary" href={card.paypalApproveUrl} target="_blank">Open PayPal to approve</s-button>
            <s-text tone="neutral">GuardBuy records the payment when PayPal sends you back.</s-text>
          </s-stack>
        ) : (
          <s-stack gap="base">
            <s-text>{`Approve and pay submits a PayPal Payout from the configured merchant funding account to ${card.payeeEmail ?? "the recorded supplier"} for exactly ${usd(card.totalCents)}. Approve in PayPal opens an Order: the approving merchant pays that supplier from their PayPal account. The demo uses sandbox accounts. Submission is not confirmation of payment.`}</s-text>
            <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={() => submit("approve")} disabled={busy} {...(busyWith === "approve" ? { loading: true } : {})}>
              {`Approve and pay ${usd(card.totalCents)}`}
            </s-button>
            <s-button onClick={() => submit("paypal")} disabled={busy} {...(busyWith === "paypal" ? { loading: true } : {})}>Approve in PayPal</s-button>
            <s-button tone="critical" variant="tertiary" onClick={() => submit("reject")} disabled={busy} {...(busyWith === "reject" ? { loading: true } : {})}>Decline</s-button>
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export { PageError as ErrorBoundary } from "../components/page-error";
