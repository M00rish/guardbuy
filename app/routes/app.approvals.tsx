import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { approvalQueue, approveInPayPal, approvePurchase, rejectPurchase, type ApprovalCard } from "../lib/agent/approvals.server";
import { ExecutionRefused } from "../lib/agent/execute.server";

// Purchases waiting for a person. Only a signed-in staff member (verified Shopify session token)
// can act, and their staff id is written to the audit log with the decision.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { cards: await approvalQueue(session.shop) };
};

type ActionResult = { ok: boolean; message: string; approveUrl?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, sessionToken } = await authenticate.admin(request);
  const staffId = sessionToken?.sub;
  if (!staffId) throw new Response("A signed-in staff member is required", { status: 403 });

  const form = await request.formData();
  const decisionSeq = Number(form.get("decisionSeq"));
  if (!Number.isInteger(decisionSeq)) return { ok: false, message: "Unknown purchase" };

  try {
    switch (form.get("intent")) {
      case "approve":
        return { ok: true, ...(await approvePurchase(session.shop, decisionSeq, `shopify-staff:${staffId}`)) };
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
    if (e instanceof ExecutionRefused) return { ok: false, message: e.message };
    console.error(`[approvals] ${session.shop} #${decisionSeq}:`, e);
    return { ok: false, message: "Something went wrong. Nothing was paid twice; try again." };
  }
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}%`;

export default function Approvals() {
  const { cards } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Approvals">
      {cards.length === 0 ? (
        <s-section>
          <s-paragraph>
            Nothing is waiting for you. Purchases over your approval limit, or that a rule flags, show up here.
          </s-paragraph>
        </s-section>
      ) : (
        cards.map((card) => <Card key={card.decisionSeq} card={card} />)
      )}
    </s-page>
  );
}

function Card({ card }: { card: ApprovalCard }) {
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const busyWith = fetcher.formData?.get("intent");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent: string) => fetcher.submit({ intent, decisionSeq: card.decisionSeq }, { method: "POST" });
  const priceDelta = card.avgUnitPrice30dCents ? (card.unitPriceCents / card.avgUnitPrice30dCents - 1) * 100 : null;
  const qtyMultiple = card.usualQuantity ? card.quantity / card.usualQuantity : null;
  const passed = card.otherChecks.filter((c) => c.outcome === "auto").length;

  return (
    <s-section heading={`${card.quantity} × ${card.sku} from ${card.supplierName}`}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200">
          <s-badge tone="warning">Needs approval</s-badge>
          {card.status === "paypal_pending" && <s-badge tone="info">Waiting for PayPal approval</s-badge>}
          <s-text type="strong">{usd(card.totalCents)}</s-text>
        </s-stack>

        {/* Facts GuardBuy computed itself */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack gap="small-200">
            <s-text>
              Price: {usd(card.unitPriceCents)} per unit
              {priceDelta !== null && ` (${pct(priceDelta)} vs 30-day average ${usd(card.avgUnitPrice30dCents!)})`}
            </s-text>
            <s-text>
              Quantity: {card.quantity}
              {qtyMultiple !== null && ` (${qtyMultiple.toFixed(1)}× the usual ${card.usualQuantity})`}
            </s-text>
            <s-text>Pays: {card.payeeEmail ?? "no PayPal email on file"} (PayPal)</s-text>
          </s-stack>
        </s-box>

        <s-stack gap="small-200">
          <s-heading>Why it needs you</s-heading>
          <s-unordered-list>
            {card.needsApprovalBecause.map((c) => (
              <s-list-item key={c.rule}>{c.detail}</s-list-item>
            ))}
          </s-unordered-list>
          <s-text tone="neutral">{passed} other rules passed.</s-text>
        </s-stack>

        {/* Written by the AI: shown last and labelled, because supplier text can steer it */}
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack gap="small-200">
            <s-text type="strong">The AI's explanation (not verified)</s-text>
            <s-text>{card.aiExplanation}</s-text>
          </s-stack>
        </s-box>

        {card.status === "paypal_pending" && card.paypalApproveUrl ? (
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" href={card.paypalApproveUrl} target="_blank">
              Open PayPal to approve
            </s-button>
            <s-text tone="neutral">GuardBuy records the payment when PayPal sends you back.</s-text>
          </s-stack>
        ) : (
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={() => submit("approve")} disabled={busy} {...(busyWith === "approve" ? { loading: true } : {})}>
              Approve and pay {usd(card.totalCents)}
            </s-button>
            <s-button onClick={() => submit("paypal")} disabled={busy} {...(busyWith === "paypal" ? { loading: true } : {})}>
              Approve in PayPal
            </s-button>
            <s-button tone="critical" variant="tertiary" onClick={() => submit("reject")} disabled={busy} {...(busyWith === "reject" ? { loading: true } : {})}>
              Decline
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
