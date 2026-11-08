import db from "../../db.server";
import { privacyBlocked } from "../privacy/state.server";
import { ALERT_TEXT } from "./projection";
import { currentAttention, pairingCode, scanShop } from "./service.server";
import { merchantLink, telegramConfig } from "./config.server";

type Delivery = {
  status: "sent" | "failed" | "uncertain" | "pending";
  delay?: number;
};
/** Telegram has no sendMessage idempotency key. Ambiguous sends must never be auto-replayed. */
export async function sendTelegram(
  chatId: string,
  text: string,
): Promise<Delivery> {
  const config = telegramConfig();
  if (!config) return { status: "failed" };
  let origin = "https://api.telegram.org";
  const fixture = process.env.GUARDBUY_TELEGRAM_TEST_ORIGIN;
  if (
    fixture &&
    process.env.NODE_ENV === "test" &&
    process.env.GUARDBUY_TELEGRAM_TEST_MODE === "true"
  ) {
    const url = new URL(fixture);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Telegram test transport must be loopback");
    origin = url.origin;
  }
  try {
    const response = await fetch(`${origin}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        protect_content: true,
      }),
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    // Bound response parsing and never include Telegram bodies/URLs in logs or stored errors.
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (!reader) return { status: "uncertain" };
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16_384) {
        await reader.cancel();
        return { status: "uncertain" };
      }
      chunks.push(part.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      response.ok &&
      data.ok === true &&
      Number.isSafeInteger(data.result?.message_id)
    )
      return { status: "sent" };
    // Retry only an explicit provider rejection; generic HTTP/proxy failures might hide acceptance.
    if (data.ok === false && Number.isInteger(data.error_code)) {
      if (data.error_code === 429 || data.error_code >= 500) {
        const seconds = Number(data.parameters?.retry_after);
        return {
          status: "pending",
          delay: Number.isFinite(seconds)
            ? Math.min(86_400_000, Math.max(1_000, seconds * 1_000))
            : 30_000,
        };
      }
      return { status: "failed" };
    }
    return { status: "uncertain" };
  } catch {
    return { status: "uncertain" };
  }
}

export async function deliverOne() {
  if (!telegramConfig()) return false;
  const now = new Date();
  await db.merchantAlert.updateMany({
    where: { status: "sending", lockedUntil: { lt: now } },
    data: { status: "uncertain", lockedUntil: null },
  });
  const message = await db.merchantAlert.findFirst({
    where: { status: "pending", availableAt: { lte: now } },
    orderBy: { createdAt: "asc" },
  });
  if (!message) return false;
  const claimed = await db.merchantAlert.updateMany({
    where: { id: message.id, status: "pending", availableAt: { lte: now } },
    data: {
      status: "sending",
      attempts: { increment: 1 },
      lockedUntil: new Date(now.getTime() + 30_000),
    },
  });
  if (!claimed.count) return true;
  const channel = await db.alertChannel.findUnique({
    where: { shop: message.shop },
  });
  let text: string | undefined, chatId: string | null | undefined;
  if (
    channel?.generation === message.generation &&
    !(await privacyBlocked(message.shop))
  ) {
    if (
      message.kind === "pairing" &&
      !channel.enabled &&
      channel.pendingChatId &&
      channel.tokenHash === message.state &&
      channel.expiresAt &&
      channel.expiresAt.getTime() > Date.now() &&
      channel.attempts < 5
    ) {
      chatId = channel.pendingChatId;
      text = `GuardBuy connection code: ${pairingCode(channel)}. Enter this code in GuardBuy Alerts to enable notifications. Never share it. If you did not request this connection, ignore it. Expires in ten minutes.`;
    } else if (
      message.kind !== "pairing" &&
      channel.enabled &&
      channel.chatId
    ) {
      const current = (await currentAttention(message.shop)).find(
        (c) => c.subject === message.subject,
      );
      if (current?.state === message.state && ALERT_TEXT[message.kind]) {
        chatId = channel.chatId;
        text = `GuardBuy${message.decisionSeq === null ? "" : ` · Purchase #${message.decisionSeq}`}\n${ALERT_TEXT[message.kind]}\n${merchantLink(message.shop, message.kind, message.decisionSeq ?? undefined)}`;
      }
    }
  }
  if (!text || !chatId) {
    await db.merchantAlert.updateMany({
      where: { id: message.id, status: "sending" },
      data: { status: "cancelled", lockedUntil: null },
    });
    return true;
  }
  const outcome = await sendTelegram(chatId, text);
  const status =
    outcome.status === "pending" && message.attempts + 1 >= 5
      ? "failed"
      : outcome.status;
  await db.merchantAlert.updateMany({
    where: { id: message.id, status: "sending" },
    data: {
      status,
      lockedUntil: null,
      sentAt: status === "sent" ? new Date() : null,
      availableAt: new Date(
        Date.now() +
          Math.max(outcome.delay ?? 0, 2 ** message.attempts * 1_000),
      ),
    },
  });
  return true;
}

let started = false;
/** Independent read-only audit scan: no browser, inventory event or payment execution needed. */
export function startAlertWorker() {
  if (started || !telegramConfig()) return;
  started = true;
  let scanning = false,
    delivering = false;
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      const channels = await db.alertChannel.findMany({
        where: { enabled: true },
        select: { shop: true },
      });
      for (const { shop } of channels)
        await scanShop(shop).catch(() =>
          console.warn("[alerts] Store scan deferred"),
        );
      await db.alertChannel.deleteMany({
        where: { enabled: false, expiresAt: { lt: new Date() } },
      });
    } catch {
      console.warn("[alerts] Scan deferred");
    } finally {
      scanning = false;
    }
  };
  const drain = async () => {
    if (delivering) return;
    delivering = true;
    try {
      await deliverOne();
    } catch {
      console.warn("[alerts] Delivery deferred; check Alerts for its status");
    } finally {
      delivering = false;
    }
  };
  setInterval(() => void scan(), 15_000).unref();
  setInterval(() => void drain(), 1_200).unref();
  void scan();
  void drain();
}
