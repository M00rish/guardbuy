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
        ? "Notification queued again. Its current purchase state will be checked before sending."
        : "Confirm the duplicate-notification warning before retrying an eligible notification.",
    };
  return { message: "Unknown action." };
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
            Get notified when a purchase needs approval, a payment needs
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
              <s-badge tone="success">
                Connected · chat ending {data.chatSuffix}
              </s-badge>
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
                    <s-text-field
                      label="Connection code from Telegram"
                      value={code}
                      onInput={(e) => setCode(e.currentTarget.value)}
                      maxLength={6}
                      autocomplete="off"
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
            Disconnecting removes the routing and queued notifications; a
            message already being sent may still arrive.
          </s-text>
        </s-stack>
      </s-section>
      <s-section heading="Recent notifications">
        <s-stack gap="base">
          <s-text>
            A delivery marked unconfirmed may already have arrived. Retrying can
            send a duplicate notification. Notification delivery never changes
            payment state.
          </s-text>
          <s-checkbox
            label="I understand retrying may send a duplicate notification"
            checked={acceptDuplicate}
            onChange={(e) => setAcceptDuplicate(e.currentTarget.checked)}
          />
          {data.messages.length === 0 && (
            <s-text>
              No notifications yet. Delivery history is kept for up to 30 days.
            </s-text>
          )}
          {data.messages.map((m) => (
            <s-box key={m.id} padding="base" border="base" borderRadius="base">
              <s-stack gap="small-200">
                <s-badge tone={m.status === "sent" ? "success" : "neutral"}>
                  {STATUS[m.status] ?? "Unknown"}
                </s-badge>
                <s-text>
                  {m.decisionSeq === null
                    ? ""
                    : `Purchase #${m.decisionSeq} · `}
                  {ALERT_TEXT[m.kind] ?? "Notification"}
                </s-text>
                <s-text>{new Date(m.createdAt).toISOString()}</s-text>
                {(m.status === "uncertain" || m.status === "failed") && (
                  <s-button
                    disabled={busy || !acceptDuplicate}
                    onClick={() =>
                      fetcher.submit(
                        { intent: "retry", id: m.id, acceptDuplicate: "yes" },
                        { method: "POST" },
                      )
                    }
                  >
                    Retry notification
                  </s-button>
                )}
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
