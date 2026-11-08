import { createHmac, randomBytes } from "node:crypto";
import type { AlertChannel, Prisma } from "@prisma/client";
import db from "../../db.server";
import { privacyWriteAllowed } from "../privacy/state.server";
import { sha256Hex, canonicalJson } from "../policy/hash";
import { AuditEventSchema, type AuditEntry } from "../policy/schema";
import { attention, type Attention } from "./projection";
import { sameSecret, telegramConfig } from "./config.server";

export const PAIR_TTL = 10 * 60_000;
export function pairingCode(channel: AlertChannel) {
  const config = telegramConfig();
  if (!config || !channel.tokenHash || !channel.pendingChatId)
    throw new Error("Pairing unavailable");
  return String(
    createHmac("sha256", config.token)
      .update(`${channel.tokenHash}:${channel.pendingChatId}`)
      .digest()
      .readUInt32BE() % 1_000_000,
  ).padStart(6, "0");
}
async function channelTransaction<T>(
  shop: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(async (tx) => {
    if (!(await privacyWriteAllowed(tx, shop)))
      throw new Response("Store processing is suppressed", { status: 410 });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"alerts:" + shop}))`;
    return run(tx);
  });
}
export async function beginPairing(shop: string) {
  const config = telegramConfig();
  if (!config) throw new Error("Telegram alerts are not configured");
  const token = randomBytes(32).toString("base64url");
  await channelTransaction(shop, async (tx) => {
    await tx.alertChannel.deleteMany({ where: { shop } });
    await tx.alertChannel.create({
      data: {
        shop,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + PAIR_TTL),
      },
    });
  });
  return `https://t.me/${config.username}?start=${token}`;
}
export async function disconnectAlerts(shop: string) {
  await channelTransaction(shop, (tx) =>
    tx.alertChannel.deleteMany({ where: { shop } }),
  );
}
export async function confirmPairing(shop: string, code: string) {
  return channelTransaction(shop, async (tx) => {
    const channel = await tx.alertChannel.findUnique({ where: { shop } });
    if (
      !channel ||
      channel.enabled ||
      !channel.pendingChatId ||
      !channel.expiresAt ||
      channel.expiresAt.getTime() <= Date.now() ||
      channel.attempts >= 5
    )
      return false;
    if (!/^\d{6}$/.test(code) || !sameSecret(pairingCode(channel), code)) {
      await tx.alertChannel.update({
        where: { shop },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }
    await tx.alertChannel.update({
      where: { shop },
      data: {
        enabled: true,
        chatId: channel.pendingChatId,
        pendingChatId: null,
        tokenHash: null,
        expiresAt: null,
      },
    });
    await tx.merchantAlert.updateMany({
      where: { shop, kind: "pairing", status: "pending" },
      data: { status: "cancelled" },
    });
    return true;
  });
}
/** Only consumes authenticated Telegram private /start commands. Never sends in a webhook. */
export async function telegramWebhook(request: Request) {
  const config = telegramConfig();
  if (!config) return new Response(null, { status: 503 });
  if (
    !sameSecret(
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
      config.secret,
    )
  )
    return new Response(null, { status: 401 });
  // Telegram updates are small; bound parsing without trusting Content-Length.
  const reader = request.body?.getReader();
  let body = "";
  let size = 0;
  if (!reader) return new Response(null, { status: 400 });
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 16_384) {
      await reader.cancel();
      return new Response(null, { status: 413 });
    }
    body += new TextDecoder().decode(part.value, { stream: true });
  }
  let update;
  try {
    update = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const message = update?.message;
  const id = message?.chat?.id;
  const match =
    typeof message?.text === "string"
      ? message.text.match(/^\/start(?:@([a-zA-Z0-9_]+))? ([A-Za-z0-9_-]{43})$/)
      : null;
  if (
    !match ||
    (match[1] && match[1].toLowerCase() !== config.username.toLowerCase()) ||
    message.chat.type !== "private" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    id !== message.from?.id ||
    message.from?.is_bot
  )
    return new Response();
  const tokenHash = sha256Hex(match[2]);
  const found = await db.alertChannel.findUnique({ where: { tokenHash } });
  if (!found) return new Response();
  await channelTransaction(found.shop, async (tx) => {
    const channel = await tx.alertChannel.findUnique({
      where: { shop: found.shop },
    });
    if (
      !channel ||
      channel.enabled ||
      channel.tokenHash !== tokenHash ||
      !channel.expiresAt ||
      channel.expiresAt.getTime() <= Date.now() ||
      (channel.pendingChatId && channel.pendingChatId !== String(id))
    )
      return;
    await tx.alertChannel.update({
      where: { shop: channel.shop },
      data: { pendingChatId: String(id) },
    });
    await tx.merchantAlert.upsert({
      where: {
        shop_subject_revision: {
          shop: channel.shop,
          subject: "pairing",
          revision: 1,
        },
      },
      create: {
        shop: channel.shop,
        generation: channel.generation,
        subject: "pairing",
        revision: 1,
        kind: "pairing",
        state: tokenHash,
      },
      update: {},
    });
  });
  return new Response();
}

/** Verify RAW stored events before parsing; never project corrupted content into notifications. */
export async function currentAttention(
  shop: string,
  now = new Date(),
): Promise<Attention[]> {
  const rows = await db.auditEntry.findMany({
    where: { shop },
    orderBy: { seq: "asc" },
  });
  let previous = "0".repeat(64);
  const log: AuditEntry[] = [];
  for (const [i, row] of rows.entries()) {
    const raw = {
      seq: row.seq,
      shop: row.shop,
      at: row.at.toISOString(),
      event: row.event,
    };
    const parsed = AuditEventSchema.safeParse(row.event);
    if (
      row.seq !== i ||
      row.prevHash !== previous ||
      sha256Hex(previous + canonicalJson(raw)) !== row.hash ||
      !parsed.success
    )
      return [{ subject: "integrity", state: "broken", kind: "integrity" }];
    log.push({
      ...raw,
      event: parsed.data,
      hash: row.hash,
      prevHash: row.prevHash,
    });
    previous = row.hash;
  }
  return attention(log, now);
}
export async function scanShop(shop: string, now = new Date()) {
  // Read history under the per-channel lock so two scanners cannot rewind cursor state.
  return channelTransaction(shop, async (tx) => {
    const channel = await tx.alertChannel.findUnique({ where: { shop } });
    if (!channel?.enabled) return;
    const candidates = await currentAttention(shop, now);
    const old = await tx.alertCursor.findMany({ where: { shop } });
    const subjects = new Set([
      ...old.map((c) => c.subject),
      ...candidates.map((c) => c.subject),
    ]);
    for (const subject of subjects) {
      const candidate = candidates.find((c) => c.subject === subject);
      const state = candidate?.state ?? "resolved";
      const cursor = old.find((c) => c.subject === subject);
      if (cursor?.state === state) continue;
      const revision = (cursor?.revision ?? 0) + 1;
      await tx.alertCursor.upsert({
        where: { shop_subject: { shop, subject } },
        create: { shop, subject, state, revision },
        update: { state, revision },
      });
      await tx.merchantAlert.updateMany({
        where: { shop, subject, status: "pending" },
        data: { status: "cancelled" },
      });
      if (candidate)
        await tx.merchantAlert.create({
          data: {
            ...candidate,
            shop,
            generation: channel.generation,
            revision,
          },
        });
    }
    // Routing and outbox are mutable operational data, retained for at most 30 days.
    await tx.merchantAlert.deleteMany({
      where: {
        shop,
        createdAt: { lt: new Date(now.getTime() - 30 * 86_400_000) },
        status: { notIn: ["pending", "sending"] },
      },
    });
  });
}
export async function retryAlert(
  shop: string,
  id: string,
  duplicateAccepted: boolean,
) {
  if (!duplicateAccepted) return false;
  return channelTransaction(shop, async (tx) => {
    const result = await tx.merchantAlert.updateMany({
      where: {
        id,
        shop,
        kind: { not: "pairing" },
        status: { in: ["uncertain", "failed"] },
      },
      data: {
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
        lockedUntil: null,
      },
    });
    return result.count === 1;
  });
}
