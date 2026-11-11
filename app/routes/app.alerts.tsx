import { FormCheck, FormField } from "../components/form-design";
import { DataGrid, cell, GridBadge } from "../components/data-grid";
import { readableTime } from "../lib/format";
import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminWithStaff } from "../lib/merchant/staff.server";
import {
  beginPairing,
  confirmPairing,
  disconnectAlerts,
  retryAlert,
} from "../lib/alerts/service.server";
import { telegramConfig } from "../lib/alerts/config.server";
import { ALERT_TEXT } from "../lib/alerts/projection";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await adminWithStaff(request);
  const channel = await db.alertChannel.findUnique({
    where: { shop: session.shop },
  });
  const messages = await db.merchantAlert.findMany({
    where: { shop: session.shop, kind: { not: "pairing" } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      kind: true,
      status: true,
      decisionSeq: true,
      createdAt: true,
    },
  });
  return {
    configured: !!telegramConfig(),
    enabled: !!channel?.enabled,
    chatSuffix: channel?.chatId?.slice(-4),
    pairing: !!channel?.expiresAt && channel.expiresAt.getTime() > Date.now(),
    messages,
  };
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await adminWithStaff(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "disconnect") {
    await disconnectAlerts(session.shop);
    return { message: "Telegram disconnected. Queued alerts were removed." };
  }
  if (!telegramConfig())
    return { message: "Telegram alerts are not configured yet." };
  if (intent === "connect")
    return {
      link: await beginPairing(session.shop),
      message:
        "Open Telegram, press Start, then enter the connection code here. This link expires in ten minutes.",
    };
  if (intent === "confirm")
    return {
      message: (await confirmPairing(
        session.shop,
        String(form.get("code") ?? ""),
      ))
        ? "Telegram connected. Alerts are enabled."
        : "Code could not be confirmed. Check the code and expiry, or start a new connection.",
    };
  if (intent === "retry")
    return {
      message: (await retryAlert(
        session.shop,
        String(form.get("id") ?? ""),
        form.get("acceptDuplicate") === "yes",
      ))
        ? "Alert queued again. Its current purchase state will be checked before sending."
        : "Confirm the duplicate-alert warning before retrying an eligible alert.",
    };
  return { message: "This action is not available. Refresh the page and try again." };
};
const STATUS: Record<string, string> = {
  pending: "Queued",
  sending: "Sending",
  sent: "Sent",
  uncertain: "Delivery unconfirmed",
  failed: "Delivery failed",
  cancelled: "No longer needed",
};
export default function Alerts() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [code, setCode] = useState("");
  const [acceptDuplicate, setAcceptDuplicate] = useState(false);
  const busy = fetcher.state !== "idle";
  const submit = (intent: string) =>
    fetcher.submit({ intent, code }, { method: "POST" });
  return (
    <s-page heading="Alerts">
      <s-section heading="Telegram">
        <s-stack gap="base">
          <s-text>
            Get alerts when a purchase needs approval, a payment needs
            attention, a restock fails, or the audit log fails verification.
            Review and approve purchases only in GuardBuy and PayPal.
          </s-text>
          <s-text>
            Messages include a short status and a link to GuardBuy. Your
            Telegram chat ID is saved for delivery. Telegram keeps its own
            copies of messages.
          </s-text>
          {!data.configured && (
            <s-banner heading="Telegram alerts are not configured" tone="info">
              Ask your GuardBuy operator to finish Telegram setup.
            </s-banner>
          )}
          {fetcher.data?.message && (
            <s-banner tone="info">{fetcher.data.message}</s-banner>
          )}
          {data.enabled ? (
            <s-stack gap="base">
              <GridBadge tone="success">
                Connected · chat ending {data.chatSuffix}
              </GridBadge>
              <s-button onClick={() => submit("disconnect")} disabled={busy}>
                Disconnect Telegram
              </s-button>
            </s-stack>
          ) : (
            data.configured && (
              <s-stack gap="base">
                <s-button
                  variant="primary"
                  onClick={() => submit("connect")}
                  disabled={busy}
                >
                  {data.pairing ? "Start a new connection" : "Connect Telegram"}
                </s-button>
                {fetcher.data &&
                  "link" in fetcher.data &&
                  fetcher.data.link && (
                    <s-link href={fetcher.data.link} target="_blank">
                      Open Telegram to get your code
                    </s-link>
                  )}
                {data.pairing && (
                  <s-stack gap="base">
                    <FormField
                      label="Connection code from Telegram"
                      value={code}
                      onInput={(e) => setCode(e.currentTarget.value)}
                      maxLength={6}
                      autoComplete="off"
                    />
                    <s-button
                      onClick={() => submit("confirm")}
                      disabled={busy || code.length !== 6}
                    >
                      Confirm and enable alerts
                    </s-button>
                    <s-button
                      onClick={() => submit("disconnect")}
                      disabled={busy}
                    >
                      Cancel connection
                    </s-button>
                  </s-stack>
                )}
              </s-stack>
            )
          )}
          <s-text>
            Alerts run in the background while GuardBuy’s server is running.
            Disconnecting removes the routing and queued alerts; a message
            already being sent may still arrive.
          </s-text>
        </s-stack>
      </s-section>
      <s-section heading="Recent alerts">
        <s-stack gap="base">
          <s-text>
            A delivery marked unconfirmed may already have arrived. Retrying can
            send a duplicate alert. Alert delivery never changes payment state.
          </s-text>
          <FormCheck
            label="I understand retrying may send a duplicate alert"
            checked={acceptDuplicate}
            onChange={(e) => setAcceptDuplicate(e.currentTarget.checked)}
          />
          {data.messages.length === 0 && (
            <s-text>
              No alerts yet. Delivery history is kept for up to 30 days.
            </s-text>
          )}
          {data.messages.length > 0 && (
            <DataGrid<(typeof data.messages)[number]>
              label="Recent alerts"
              rows={data.messages}
              rowId={(m) => m.id}
              columns={[
                {
                  field: "kind",
                  headerName: "Alert",
                  flex: 2,
                  minWidth: 250,
                  valueGetter: ({ data: m }) =>
                    m
                      ? `${m.decisionSeq === null ? "" : `Purchase #${m.decisionSeq} · `}${ALERT_TEXT[m.kind] ?? "Alert"}`
                      : "",
                },
                {
                  field: "status",
                  headerName: "Status",
                  minWidth: 170,
                  valueGetter: ({ data: m }) =>
                    m ? (STATUS[m.status] ?? "Unknown") : "",
                  cellRenderer: cell<(typeof data.messages)[number]>((m) => (
                    <GridBadge
                      tone={
                        m.status === "sent"
                          ? "success"
                          : m.status === "failed"
                            ? "critical"
                            : m.status === "uncertain"
                              ? "warning"
                              : "neutral"
                      }
                    >
                      {STATUS[m.status] ?? "Unknown"}
                    </GridBadge>
                  )),
                },
                {
                  field: "createdAt",
                  headerName: "Created",
                  minWidth: 220,
                  flex: 1,
                  comparator: (a, b) =>
                    new Date(a).getTime() - new Date(b).getTime(),
                  valueFormatter: ({ value }) =>
                    readableTime(new Date(value).toISOString()),
                },
                {
                  colId: "actions",
                  headerName: "Actions",
                  width: 160,
                  sortable: false,
                  filter: false,
                  cellRenderer: cell<(typeof data.messages)[number]>((m) =>
                    m.status === "uncertain" || m.status === "failed" ? (
                      <s-button
                        disabled={busy || !acceptDuplicate}
                        onClick={() =>
                          fetcher.submit(
                            {
                              intent: "retry",
                              id: m.id,
                              acceptDuplicate: "yes",
                            },
                            { method: "POST" },
                          )
                        }
                      >
                        Retry alert
                      </s-button>
                    ) : null,
                  ),
                },
              ]}
            />
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
