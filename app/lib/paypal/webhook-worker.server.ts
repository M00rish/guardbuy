import { randomUUID } from "node:crypto";
import db from "../../db.server";
import { fundingKey } from "../payments/attempts.server";
import { paypalStoreBinding } from "./config.server";
import { privacyWriteAllowed } from "../privacy/state.server";
import { ensurePayoutWebhook } from "./webhook-registration.server";
import { refreshPayouts } from "./reconcile.server";
export async function processPayoutSignal(
  refresh: typeof refreshPayouts = refreshPayouts,
) {
  const accountKey = fundingKey(),
    now = new Date();
  const job = await db.payPalPayoutSignal.findFirst({
    where: {
      accountKey,
      completedGeneration: { lt: db.payPalPayoutSignal.fields.generation },
      availableAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    orderBy: { availableAt: "asc" },
  });
  if (!job) return false;
  const holder = randomUUID();
  const claim = await db.payPalPayoutSignal.updateMany({
    where: {
      accountKey,
      batchId: job.batchId,
      generation: job.generation,
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    data: {
      holder,
      claimedGeneration: job.generation,
      lockedUntil: new Date(Date.now() + 180_000),
    },
  });
  if (!claim.count) return true;
  const key = { accountKey, batchId: job.batchId, holder };
  try {
    const matches = await db.auditEntry.findMany({
      where: {
        type: "payout",
        event: { path: ["payoutBatchId"], equals: job.batchId },
      },
      select: { shop: true, seq: true },
      take: 2,
    });
    if (matches.length !== 1) {
      // The notification may beat the payment/audit commit. Retain it for bounded recovery.
      if (Date.now() - job.receivedAt.getTime() > 3 * 86400_000)
        await db.payPalPayoutSignal.deleteMany({ where: key });
      else
        await db.payPalPayoutSignal.updateMany({
          where: key,
          data: {
            holder: null,
            lockedUntil: null,
            availableAt: new Date(
              Date.now() +
                Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 7)),
            ),
            attempts: { increment: 1 },
          },
        });
      return true;
    }
    const { shop, seq } = matches[0];
    paypalStoreBinding(shop);
    const allowed = await db.$transaction(async (tx) => {
      if (!(await privacyWriteAllowed(tx, shop))) {
        await tx.payPalPayoutSignal.deleteMany({ where: key });
        return false;
      }
      await tx.payPalPayoutSignal.updateMany({ where: key, data: { shop } });
      return true;
    });
    if (!allowed) return true;
    let check = await db.payoutCheck.findUnique({
      where: { shop_payoutSeq: { shop, payoutSeq: seq } },
    });
    if (
      !check?.lastCheckOk ||
      !check.checkedAt ||
      !check.startedAt ||
      check.startedAt < job.receivedAt
    ) {
      // Never bypass an active provider read. Retry the signal after that lease finishes.
      const ready = await db.$transaction(async (tx) => {
        if (!(await privacyWriteAllowed(tx, shop))) return false;
        await tx.payoutCheck.createMany({
          data: [{ shop, payoutSeq: seq }],
          skipDuplicates: true,
        });
        return (
          (
            await tx.payoutCheck.updateMany({
              where: {
                shop,
                payoutSeq: seq,
                OR: [
                  { lockedUntil: null },
                  { lockedUntil: { lte: new Date() } },
                ],
              },
              data: { nextCheckAt: new Date() },
            })
          ).count === 1
        );
      });
      const result = ready ? await refresh(shop, seq) : null;
      if (!ready || result?.running) {
        await db.payPalPayoutSignal.updateMany({
          where: key,
          data: {
            holder: null,
            lockedUntil: null,
            availableAt: new Date(Date.now() + 5000),
          },
        });
        return true;
      }
      check = await db.payoutCheck.findUnique({
        where: { shop_payoutSeq: { shop, payoutSeq: seq } },
      });
      if (
        !check?.lastCheckOk ||
        !check.checkedAt ||
        !check.startedAt ||
        check.startedAt < job.receivedAt
      )
        throw Error("Status read pending");
    }
    await db.payPalPayoutSignal.updateMany({
      where: key,
      data: {
        completedGeneration: job.generation,
        holder: null,
        lockedUntil: null,
        attempts: 0,
      },
    });
  } catch {
    await db.payPalPayoutSignal
      .updateMany({
        where: key,
        data: {
          holder: null,
          lockedUntil: null,
          availableAt: new Date(
            Date.now() + [5, 15, 30, 60][Math.min(job.attempts, 3)] * 60_000,
          ),
          attempts: { increment: 1 },
        },
      })
      .catch(() => {});
  }
  return true;
}
let started = false;
export function startPayoutWebhookWorker() {
  if (
    started ||
    process.env.NODE_ENV !== "production" ||
    process.env.GUARDBUY_PAYMENTS_DISABLED === "1" ||
    process.env.GUARDBUY_PAYPAL_WEBHOOKS === "off" ||
    !process.env.DATABASE_URL ||
    !process.env.PAYPAL_CLIENT_ID ||
    !process.env.PAYPAL_CLIENT_SECRET
  )
    return;
  started = true;
  let lastMaintenance = 0;
  const tick = async () => {
    let delay = 10_000;
    try {
      if (Date.now() - lastMaintenance > 60_000) {
        lastMaintenance = Date.now();
        await ensurePayoutWebhook();
        await db.payPalWebhookReceipt.deleteMany({
          where: { receivedAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
        });
        await db.payPalPayoutSignal.deleteMany({
          where: {
            receivedAt: { lt: new Date(Date.now() - 7 * 86400_000) },
            lockedUntil: null,
          },
        });
      }
      if (await processPayoutSignal()) delay = 500;
    } catch {
      console.warn("[paypal-webhooks] Queue deferred");
    }
    setTimeout(() => {
      void tick();
    }, delay).unref();
  };
  setTimeout(() => {
    void tick();
  }, 1000).unref();
}
