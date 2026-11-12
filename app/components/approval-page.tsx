import { DataGrid, cell, GridBadge } from "./data-grid";
import { useEffect } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { PayoutRefresh } from "./payout-refresh";
import type { ApprovalCard } from "../lib/agent/approvals.server";
import type {
  ApprovalPageData,
  ApprovalActionData,
} from "../lib/merchant/approval-page.server";
import styles from "./approval-page.module.css";
import { APPROVAL_LABEL, COPY } from "../lib/wording";
import { usd } from "../lib/format";
import { ago, Empty, plural, Row } from "./ui";

/** "expires in 5 h" / "expires in 20 min" */
const expiresIn = (iso: string) => {
  const min = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return min >= 120
    ? `expires in ${Math.round(min / 60)} h`
    : `expires in ${min} min`;
};
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}%`;

type Card = ApprovalCard & { productTitle: string };

function Status({ card }: { card: Card }) {
  const label = APPROVAL_LABEL[card.status];
  return (
    <GridBadge
      tone={
        card.status === "paypal_pending" || card.status === "payment_pending"
          ? "info"
          : "caution"
      }
    >
      {label}
    </GridBadge>
  );
}

export function ApprovalsPanel({ data }: { data: ApprovalPageData }) {
  const { cards, payoutRefresh, purchase } = data;
  return (
    <s-stack gap="base">
      <PayoutRefresh
        state={payoutRefresh}
        watch={cards.some((card) => card.status === "payment_pending")}
      />
      {purchase !== null && (
        <s-section>
          <s-banner tone="info" heading={`Purchase #${purchase}`}>
            {cards.length
              ? "Current approval and recovery state for this purchase."
              : "This purchase no longer needs action here. It may be settled, declined, or expired."}{" "}
            <s-link href={`/app/activity?purchase=${purchase}`}>
              View purchase history
            </s-link>{" "}
            ·{" "}
            <s-link href="/app/rules?tab=approvals">Show all approvals</s-link>
          </s-banner>
        </s-section>
      )}
      <s-section heading="Purchases needing attention">
        <s-stack gap="base">
          {cards.length === 0 ? (
            <Empty heading="No purchases need attention">
              Purchases needing approval or payment attention appear here. New
              approvals expire after 48 hours; uncertain payments stay reserved
              until confirmed.
            </Empty>
          ) : (
            <>
              <s-text tone="neutral">
                {plural(cards.length, "purchase")} needing approval or payment
                attention. Expand a row to review the facts and available
                actions.
              </s-text>
              <DataGrid<Card>
                label="Purchases needing attention"
                rows={cards}
                rowId={(card) => String(card.decisionSeq)}
                height={640}
                revealRowId={purchase === null ? undefined : String(purchase)}
                renderDetail={ApprovalRowDetails}
                columns={[
                  {
                    colId: "purchase",
                    headerName: "Purchase",
                    flex: 2,
                    minWidth: 265,
                    autoHeight: true,
                    wrapText: true,
                    valueGetter: ({ data }) =>
                      data
                        ? `#${data.decisionSeq} · ${data.quantity} × ${data.productTitle}`
                        : "",
                  },
                  {
                    field: "supplierName",
                    headerName: "Supplier",
                    minWidth: 180,
                    flex: 1,
                  },
                  {
                    field: "totalCents",
                    headerName: "Total",
                    type: "numericColumn",
                    width: 130,
                    valueFormatter: ({ value }) => usd(value),
                  },
                  {
                    field: "status",
                    headerName: "Status",
                    minWidth: 210,
                    valueGetter: ({ data }) =>
                      data ? APPROVAL_LABEL[data.status] : "",
                    cellRenderer: cell<Card>((card) => <Status card={card} />),
                  },
                  {
                    field: "proposedAt",
                    headerName: "Proposed",
                    width: 160,
                    valueFormatter: ({ value }) => ago(value, Date.now()),
                  },
                ]}
              />
            </>
          )}
          <s-text>
            After payment, track incoming stock and record received goods in{" "}
            <s-link href="/app/deliveries">Deliveries</s-link>.
          </s-text>
        </s-stack>
      </s-section>
    </s-stack>
  );
}

function ApprovalRowDetails(card: Card) {
  return (
    <div
      className={styles.detailsContent}
      role="region"
      aria-label={`Details for purchase #${card.decisionSeq}`}
    >
      <ApprovalDetails card={card} />
    </div>
  );
}

function ApprovalDetails({ card }: { card: Card }) {
  const fetcher = useFetcher<ApprovalActionData>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const busyWith = fetcher.formData?.get("intent");

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.state, fetcher.data, shopify]);

  const submit = (intent: string) =>
    fetcher.submit(
      { intent, decisionSeq: card.decisionSeq },
      { method: "POST", action: "/app/rules?tab=approvals" },
    );
  const priceDelta = card.acceptedUnitPriceCents
    ? (card.unitPriceCents / card.acceptedUnitPriceCents - 1) * 100
    : null;
  const qtyMultiple = card.usualQuantity
    ? card.quantity / card.usualQuantity
    : null;
  const passed = card.otherChecks.filter((c) => c.outcome === "auto").length;

  return (
    <s-stack gap="base">
      <s-heading>{`${card.quantity} × ${card.productTitle}`}</s-heading>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <Status card={card} />
        <s-heading>{usd(card.totalCents)}</s-heading>
        <s-text tone="neutral">
          from {card.supplierName} · proposed {ago(card.proposedAt, Date.now())}{" "}
          ·{" "}
          {card.status === "payment_unknown" ||
          card.status === "payment_pending"
            ? "Original payment remains reserved"
            : card.expired
              ? "Approval expired"
              : expiresIn(card.expiresAt)}
        </s-text>
      </s-stack>

      <s-stack gap="small-200">
        {card.needsApprovalBecause.map((c) => (
          <s-banner key={c.rule} tone="warning">
            {c.detail}
          </s-banner>
        ))}
      </s-stack>

      <s-stack gap="small-200">
        <Row label="Price per unit">
          <s-text>
            {usd(card.unitPriceCents)}
            {priceDelta !== null &&
              ` · ${pct(priceDelta)} vs the ${usd(card.acceptedUnitPriceCents!)} you accepted`}
          </s-text>
        </Row>
        <Row label="Quantity">
          <s-text>
            {card.quantity}
            {qtyMultiple !== null &&
              ` · ${qtyMultiple.toFixed(1)}× the usual ${card.usualQuantity}`}
          </s-text>
        </Row>
        <Row label="Supplier PayPal email">
          <s-text>{card.payeeEmail ?? "No PayPal email on file"}</s-text>
        </Row>
        <Row label="Other rules">
          <s-text tone="neutral">{`${passed} passed`}</s-text>
        </Row>
      </s-stack>

      <s-box padding="base" background="subdued" borderRadius="base">
        <s-stack gap="small-200">
          <s-text type="strong">{COPY.aiExplanation}</s-text>
          <s-text>{card.aiExplanation}</s-text>
        </s-stack>
      </s-box>

      {card.status === "payment_unknown" ? (
        <s-stack gap="base">
          <s-text>
            {card.canResume
              ? "The original payment outcome is uncertain. Resuming may submit that original payment if PayPal has not processed it. It uses the same request ID and cannot switch payment routes."
              : card.paymentReason}
          </s-text>
          {card.canResume && (
            <s-button
              disabled={busy}
              loading={busy && busyWith === "resume"}
              onClick={() => submit("resume")}
            >
              Resume original payment
            </s-button>
          )}
          <s-link href={`/app/activity?purchase=${card.decisionSeq}`}>
            View payment details in Activity
          </s-link>
          {fetcher.data?.approveUrl && (
            <s-link href={fetcher.data.approveUrl} target="_blank">
              Continue in PayPal
            </s-link>
          )}
        </s-stack>
      ) : card.status === "payment_pending" ? (
        <s-stack gap="base">
          <s-text>
            PayPal has the original payment. Its outcome is still pending; do
            not submit another payment. Use the payout status refresh above to
            check for confirmation.
          </s-text>
          <s-link href={`/app/activity?purchase=${card.decisionSeq}`}>
            View payment details in Activity
          </s-link>
        </s-stack>
      ) : card.status === "payment_failed" ? (
        <s-stack gap="base">
          <s-banner tone="warning">
            {card.paymentReason ?? "Payment was not submitted successfully."}
          </s-banner>
          <s-text>
            {card.canRetry
              ? "Retry pays the same supplier and amount for this approved purchase, after checking your current rules."
              : card.canCancel
                ? "This purchase cannot be retried here. Cancel it to let the agent propose a fresh purchase with current numbers."
                : "This payment already has a provider result. Review its evidence in Activity; retrying or cancelling it here could misrepresent what PayPal processed."}
          </s-text>
          <s-stack direction="inline" gap="base">
            {card.canRetry && (
              <s-button
                variant="primary"
                disabled={busy}
                loading={busy && busyWith === "retry"}
                onClick={() => submit("retry")}
              >{`Retry payment of ${usd(card.totalCents)}`}</s-button>
            )}
            {card.canCancel && (
              <s-button
                tone="critical"
                variant="tertiary"
                disabled={busy}
                loading={busy && busyWith === "reject"}
                onClick={() => submit("reject")}
              >
                Cancel unpaid purchase
              </s-button>
            )}
            <s-link href={`/app/activity?purchase=${card.decisionSeq}`}>
              View payment details in Activity
            </s-link>
          </s-stack>
        </s-stack>
      ) : card.status === "paypal_pending" && card.paypalApproveUrl ? (
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button
            variant="primary"
            href={card.paypalApproveUrl}
            target="_blank"
          >
            Continue in PayPal
          </s-button>
          <s-text tone="neutral">
            GuardBuy records the payment when PayPal sends you back.
          </s-text>
        </s-stack>
      ) : (
        <s-stack gap="base">
          <s-text>{`Approve and pay submits a PayPal Payout from the configured merchant funding account to ${card.payeeEmail ?? "the recorded supplier"} for exactly ${usd(card.totalCents)}. Approve in PayPal opens an Order: the approving merchant pays that supplier from their PayPal account. The demo uses sandbox accounts. Submission is not confirmation of payment. Declining pauses automatic restocking for this product for 24 hours; you can reset its cooldown from Home or product settings.`}</s-text>
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={() => submit("approve")}
              disabled={busy}
              {...(busyWith === "approve" ? { loading: true } : {})}
            >
              {`Approve and pay ${usd(card.totalCents)}`}
            </s-button>
            <s-button
              onClick={() => submit("paypal")}
              disabled={busy}
              {...(busyWith === "paypal" ? { loading: true } : {})}
            >
              Approve in PayPal
            </s-button>
            <s-button
              tone="critical"
              variant="tertiary"
              onClick={() => submit("reject")}
              disabled={busy}
              {...(busyWith === "reject" ? { loading: true } : {})}
            >
              Decline
            </s-button>
          </s-stack>
        </s-stack>
      )}
    </s-stack>
  );
}
