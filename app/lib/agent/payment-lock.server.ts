import { randomUUID } from "node:crypto";

import db from "../../db.server";

// One payment at a time per shop, across processes and servers: the payment module re-checks the
// rules and pays while holding this lock, so the second of two simultaneous purchases sees the
// first one's payment. Stored in Postgres (not in memory) and self-expiring, so a crashed server
// can't block payments for long.

const HOLD_MS = 60_000; // longer than a PayPal call with its retries
const WAIT_MS = 30_000;
const POLL_MS = 250;

export class PaymentLockBusy extends Error {}
export type PaymentLease = { key: string; holder: string };

/** A late worker must not submit after another process acquired its expired lease. */
export async function renewPaymentLease(lease: PaymentLease) {
  const now = new Date();
  const renewed = await db.paymentLock.updateMany({ where: { shop: lease.key, holder: lease.holder, lockedUntil: { gt: now } }, data: { lockedUntil: new Date(now.getTime() + HOLD_MS) } });
  if (renewed.count !== 1) throw new PaymentLockBusy("Payment lease lost; refresh the original payment status");
}

/** Takes the shop's payment lock in one atomic statement; false if someone else holds it. */
async function tryLock(shop: string, holder: string) {
  const now = new Date();
  const until = new Date(now.getTime() + HOLD_MS);
  // Times come from the app (UTC), not the database's NOW(), so the comparison doesn't depend on its timezone.
  const rows = await db.$executeRaw`
    INSERT INTO "PaymentLock" ("shop", "holder", "lockedUntil") VALUES (${shop}, ${holder}, ${until})
    ON CONFLICT ("shop") DO UPDATE SET "holder" = EXCLUDED."holder", "lockedUntil" = EXCLUDED."lockedUntil"
    WHERE "PaymentLock"."lockedUntil" < ${now}`;
  return rows === 1;
}

export async function withPaymentLock<T>(shop: string, fn: (lease: PaymentLease) => Promise<T>): Promise<T> {
  const holder = randomUUID();
  const deadline = Date.now() + WAIT_MS;
  while (!(await tryLock(shop, holder))) {
    if (Date.now() > deadline) throw new PaymentLockBusy("Another payment for this store is still in progress; try again shortly");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const timer = setInterval(() => {
    const now = new Date();
    void db.paymentLock.updateMany({ where: { shop, holder, lockedUntil: { gt: now } }, data: { lockedUntil: new Date(now.getTime() + HOLD_MS) } }).catch(() => {});
  }, 15_000);
  timer.unref();
  try {
    return await fn({ key: shop, holder });
  } finally {
    clearInterval(timer);
    // Release only our own lock (if it expired and someone else took it, leave theirs alone).
    await db.paymentLock.deleteMany({ where: { shop, holder } }).catch(() => {
      // The lease expires on its own; cleanup failure must not hide a recorded payment result.
      console.warn("[payment-lock] Lease cleanup unavailable; expiry will release it");
    });
  }
}
