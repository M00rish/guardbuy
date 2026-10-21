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

export async function withPaymentLock<T>(shop: string, fn: () => Promise<T>): Promise<T> {
  const holder = randomUUID();
  const deadline = Date.now() + WAIT_MS;
  while (!(await tryLock(shop, holder))) {
    if (Date.now() > deadline) throw new PaymentLockBusy("Another payment for this store is still in progress; try again shortly");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock (if it expired and someone else took it, leave theirs alone).
    await db.paymentLock.deleteMany({ where: { shop, holder } });
  }
}
