// Isolated CI database only; no PayPal, Shopify, or other external writes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = process.env.DATABASE_URL ?? "";
if (!new URL(url).pathname.endsWith("/guardbuy_ism15_test"))
  throw Error("Use the isolated guardbuy_ism15_test database");
const { default: db } = await import("../app/db.server");
const { createPayoutSchedule } =
  await import("../app/lib/paypal/payout-schedule.server");
const { privacyShopHash } = await import("../app/lib/privacy/state.server");
const shop = `test-payout-schedule-${randomUUID()}.test`;
try {
  const a = createPayoutSchedule(),
    b = createPayoutSchedule();
  const claims = await Promise.all([
    a.claim(shop, 1, Date.now() + 1000),
    b.claim(shop, 1, Date.now() + 1000),
  ]);
  assert.equal(
    claims.filter(Boolean).length,
    1,
    "one lease across independent workers",
  );
  await assert.rejects(
    () =>
      (claims[0] ? b : a).append(shop, {
        type: "payout_status",
        payoutSeq: 1,
        status: "SUCCESS",
        confirmedByTransactionSearch: false,
      }),
    "worker without lease cannot append evidence",
  );
  const winner = claims[0] ? a : b,
    loser = claims[0] ? b : a;
  const check = {
    payoutSeq: 1,
    checkedAt: Date.now(),
    nextAt: Date.now() + 900_000,
    unchanged: 1,
  };
  await assert.rejects(
    () => loser.save(shop, check),
    "another worker cannot complete this lease",
  );
  await winner.save(shop, check);
  assert.equal(
    await createPayoutSchedule().claim(shop, 1, Date.now()),
    false,
    "restart retains persisted delay",
  );
  const [stored] = await createPayoutSchedule().load(shop);
  assert.equal(stored.nextAt, check.nextAt);
  assert.equal(
    await a.claim(shop, 2, Date.now() + 1000),
    true,
    "new payout is independent",
  );
  await db.payoutCheck.update({
    where: { shop_payoutSeq: { shop, payoutSeq: 2 } },
    data: { lockedUntil: new Date(Date.now() - 1000) },
  });
  await assert.rejects(
    () =>
      a.append(shop, {
        type: "payout_status",
        payoutSeq: 2,
        status: "SUCCESS",
        confirmedByTransactionSearch: false,
      }),
    "expired worker cannot append evidence",
  );
  assert.equal(
    await b.claim(shop, 2, Date.now() + 1000),
    true,
    "abandoned lease is recoverable",
  );
  await db.privacyBlock.create({ data: { shopHash: privacyShopHash(shop) } });
  await db.payoutCheck.deleteMany({ where: { shop } });
  assert.equal(
    await a.claim(shop, 3, Date.now() + 1000),
    false,
    "erased shop cannot recreate schedules",
  );
  console.log(
    "PASS durable payout schedule: concurrent workers, owner-only completion, restart cooldown, new payout, lease recovery, privacy suppression.",
  );
} finally {
  await db.payoutCheck.deleteMany({ where: { shop } });
  await db.privacyBlock.deleteMany({
    where: { shopHash: privacyShopHash(shop) },
  });
  await db.$disconnect();
}
