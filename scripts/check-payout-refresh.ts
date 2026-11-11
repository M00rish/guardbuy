// Offline: no environment files, database, credentials, or money movement.
import assert from "node:assert/strict";
import {
  createPayoutRefresh,
  type PayoutBatch,
} from "../app/lib/paypal/payout-refresh";
import type { AuditEntry, AuditEvent } from "../app/lib/policy/schema";

function fixture(count = 1) {
  let time = 100_000;
  let calls = 0;
  let search = false;
  let failSearch = false;
  let batch: (id: string) => Promise<PayoutBatch> = async () => ({
    items: [{ transaction_status: "PENDING" }],
  });
  const logs = new Map<string, AuditEntry[]>();
  const row = (shop: string, event: AuditEvent, seq: number): AuditEntry => ({
    shop,
    event,
    seq,
    at: new Date(time).toISOString(),
    hash: "",
    prevHash: "",
  });
  for (const shop of ["a", "b"])
    logs.set(
      shop,
      Array.from({ length: count }, (_, seq) =>
        row(
          shop,
          {
            type: "payout",
            decisionSeq: seq,
            payoutBatchId: `batch${seq}`,
            amountCents: 100,
            status: "PENDING",
          },
          seq,
        ),
      ),
    );
  const refresh = createPayoutRefresh(
    {
      read: async (shop) => logs.get(shop)!,
      append: async (shop, event) => {
        const log = logs.get(shop)!;
        log.push(row(shop, event, log.length));
      },
      batch: async (id) => {
        calls++;
        return batch(id);
      },
      confirmed: async () => {
        if (failSearch) throw Error("secret error");
        return search;
      },
    },
    { now: () => time, waitMs: 5, cooldownMs: 60_000 },
  );
  return {
    refresh,
    logs,
    calls: () => calls,
    tick: (ms = 60_001) => {
      time += ms;
    },
    batch: (fn: typeof batch) => {
      batch = fn;
    },
    search: (value: boolean) => {
      search = value;
    },
    failSearch: () => {
      failSearch = true;
    },
  };
}
const f = fixture();
await f.refresh("a");
assert.equal(
  f.logs.get("a")!.length,
  1,
  "unchanged initial status must not append",
);
await f.refresh("a");
assert.equal(f.calls(), 1, "cooldown");
for (const status of ["SUCCESS", "FAILED", "RETURNED"]) {
  f.tick();
  f.batch(async () => ({
    items: [{ transaction_status: status, transaction_id: "txn" }],
  }));
  const result = await f.refresh("a");
  assert.equal(result.awaitingConfirmation, true);
  assert.equal(
    (
      f.logs.get("a")!.at(-1)!.event as Extract<
        AuditEvent,
        { type: "payout_status" }
      >
    ).status,
    status,
  );
}
f.tick();
f.search(true);
await f.refresh("a");
assert.equal(
  (
    f.logs.get("a")!.at(-1)!.event as Extract<
      AuditEvent,
      { type: "payout_status" }
    >
  ).confirmedByTransactionSearch,
  true,
);
const length = f.logs.get("a")!.length;
f.tick();
await f.refresh("a");
assert.equal(
  f.logs.get("a")!.length,
  length,
  "unchanged confirmed state must not append",
);
f.tick();
f.batch(async () => {
  throw Error("secret error");
});
const failure = await f.refresh("a");
assert.equal(failure.failed, true);
assert.equal(f.logs.get("a")!.length, length);
assert.ok(!JSON.stringify(failure).includes("secret"));
const g = fixture();
g.batch(async () => ({ batch_header: { batch_status: "SUCCESS" } }));
assert.equal(
  (await g.refresh("a")).failed,
  true,
  "batch success is not item success",
);
assert.equal(g.logs.get("a")!.length, 1);
g.tick();
g.batch(async () => ({
  items: [{ transaction_status: "SUCCESS", transaction_id: "txn" }],
}));
g.failSearch();
assert.equal((await g.refresh("a")).failed, true);
assert.equal(
  (
    g.logs.get("a")!.at(-1)!.event as Extract<
      AuditEvent,
      { type: "payout_status" }
    >
  ).status,
  "SUCCESS",
  "search failure preserves status evidence",
);
const h = fixture();
let release!: (value: PayoutBatch) => void;
h.batch(
  () =>
    new Promise((resolve) => {
      release = resolve;
    }),
);
const overlap = await Promise.all([h.refresh("a"), h.refresh("a")]);
assert.ok(overlap.every((r) => r.running));
assert.equal(h.calls(), 1, "overlapping requests share one run");
release({ items: [{ transaction_status: "FAILED" }] });
await h.refresh("a");
assert.equal(h.logs.get("a")!.length, 2);
assert.equal(h.logs.get("b")!.length, 1, "shop isolation");
const bounded = fixture(7);
await bounded.refresh("a");
assert.equal(bounded.calls(), 5);
bounded.tick(5_001);
await bounded.refresh("a");
assert.equal(bounded.calls(), 7, "rotation reaches later payouts");
const isolated = fixture(2);
isolated.batch(async (id) => {
  if (id === "batch0") throw Error("failed");
  return { items: [{ transaction_status: "FAILED" }] };
});
assert.equal((await isolated.refresh("a")).failed, true);
assert.equal(
  isolated.logs.get("a")!.length,
  3,
  "one failure must not block another payout",
);
console.log(
  "Payout refresh checks passed: transitions, confirmation lag, failures, isolation, throttling, concurrency, and bounded rotation.",
);

// A shared store represents durable state across independent refresh instances/restarts.
let clock = 1_000_000,
  providerCalls = 0;
const entries: AuditEntry[] = [
  {
    shop: "durable",
    seq: 1,
    at: new Date(clock).toISOString(),
    hash: "",
    prevHash: "",
    event: {
      type: "payout",
      decisionSeq: 1,
      payoutBatchId: "one",
      amountCents: 100,
      status: "PENDING",
    },
  },
];
const stored = new Map<
  number,
  import("../app/lib/paypal/payout-refresh").PayoutCheck
>();
const schedule: import("../app/lib/paypal/payout-refresh").PayoutSchedule = {
  load: async () => [...stored.values()],
  claim: async (_, seq, time) => {
    const old = stored.get(seq);
    if (old && old.nextAt > time) return false;
    stored.set(seq, {
      payoutSeq: seq,
      nextAt: time + 180_000,
      checkedAt: old?.checkedAt ?? null,
      unchanged: old?.unchanged ?? 0,
    });
    return true;
  },
  save: async (_, c) => {
    stored.set(c.payoutSeq, c);
  },
};
let resultStatus = "PENDING";
const make = () =>
  createPayoutRefresh(
    {
      read: async () => entries,
      append: async (_, event) => {
        entries.push({
          shop: "durable",
          seq: entries.length + 1,
          at: new Date(clock).toISOString(),
          hash: "",
          prevHash: "",
          event,
        });
      },
      schedule,
      batch: async () => {
        providerCalls++;
        return {
          items: [{ transaction_status: resultStatus, transaction_id: "txn" }],
        };
      },
      confirmed: async () => true,
    },
    { now: () => clock },
  );
await Promise.all([make()("durable"), make()("durable")]);
assert.equal(providerCalls, 1, "independent instances share persisted claim");
for (const minutes of [5, 15, 30, 60]) {
  assert.equal(stored.get(1)!.nextAt - clock, minutes * 60_000);
  await make()("durable");
  assert.equal(
    providerCalls,
    [5, 15, 30, 60].indexOf(minutes) + 1,
    "restarts do not bypass cooldown",
  );
  clock = stored.get(1)!.nextAt;
  await make()("durable");
}
resultStatus = "SUCCESS";
clock = stored.get(1)!.nextAt;
await make()("durable");
assert.equal(
  stored.get(1)!.nextAt - clock,
  86_400_000,
  "confirmed payout checks daily",
);
const settledCalls = providerCalls;
clock += 60_000;
await make()("durable");
assert.equal(
  providerCalls,
  settledCalls,
  "settled history is not read each minute",
);
entries.push({
  shop: "durable",
  seq: 99,
  at: new Date(clock).toISOString(),
  hash: "",
  prevHash: "",
  event: {
    type: "payout",
    decisionSeq: 99,
    payoutBatchId: "new",
    amountCents: 100,
    status: "PENDING",
  },
});
await make()("durable");
assert.equal(
  providerCalls,
  settledCalls + 1,
  "new payout is checked without waiting for historical cooldown",
);
clock = stored.get(1)!.nextAt;
resultStatus = "RETURNED";
await make()("durable");
assert.ok(
  entries.some(
    (e) =>
      e.event.type === "payout_status" &&
      e.event.payoutSeq === 1 &&
      e.event.status === "RETURNED",
  ),
  "daily read still detects a return",
);
const empty = await createPayoutRefresh({
  read: async () => [],
  append: async () => {},
  batch: async () => {
    throw Error("must not call");
  },
  confirmed: async () => false,
})("empty");
assert.equal(empty.retryAt, null);
assert.equal(empty.incomplete, false);
assert.equal(empty.scheduled, false);
console.log(
  "PASS adaptive payouts: 5/15/30/60 minute backoff, shared claims/restarts, daily settled checks, new payout priority, returns and idle stop.",
);
