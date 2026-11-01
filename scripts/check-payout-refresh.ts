// Offline: no environment files, database, credentials, or money movement.
import assert from "node:assert/strict";
import { createPayoutRefresh, type PayoutBatch } from "../app/lib/paypal/payout-refresh";
import type { AuditEntry, AuditEvent } from "../app/lib/policy/schema";

function fixture(count = 1) {
  let time = 100_000;
  let calls = 0;
  let search = false;
  let failSearch = false;
  let batch: (id: string) => Promise<PayoutBatch> = async () => ({ items: [{ transaction_status: "PENDING" }] });
  const logs = new Map<string, AuditEntry[]>();
  const row = (shop: string, event: AuditEvent, seq: number): AuditEntry => ({ shop, event, seq, at: new Date(time).toISOString(), hash: "", prevHash: "" });
  for (const shop of ["a", "b"]) logs.set(shop, Array.from({ length: count }, (_, seq) => row(shop, { type: "payout", decisionSeq: seq, payoutBatchId: `batch${seq}`, amountCents: 100, status: "PENDING" }, seq)));
  const refresh = createPayoutRefresh({
    read: async (shop) => logs.get(shop)!,
    append: async (shop, event) => { const log = logs.get(shop)!; log.push(row(shop, event, log.length)); },
    batch: async (id) => { calls++; return batch(id); },
    confirmed: async () => { if (failSearch) throw Error("secret error"); return search; },
  }, { now: () => time, waitMs: 5 });
  return { refresh, logs, calls: () => calls, tick: () => { time += 60_001; }, batch: (fn: typeof batch) => { batch = fn; }, search: (value: boolean) => { search = value; }, failSearch: () => { failSearch = true; } };
}
const f = fixture();
await f.refresh("a");
assert.equal(f.logs.get("a")!.length, 1, "unchanged initial status must not append");
await f.refresh("a");
assert.equal(f.calls(), 1, "cooldown");
for (const status of ["SUCCESS", "FAILED", "RETURNED"]) {
  f.tick();
  f.batch(async () => ({ items: [{ transaction_status: status, transaction_id: "txn" }] }));
  const result = await f.refresh("a");
  assert.equal(result.awaitingConfirmation, true);
  assert.equal((f.logs.get("a")!.at(-1)!.event as Extract<AuditEvent, { type: "payout_status" }>).status, status);
}
f.tick();
f.search(true);
await f.refresh("a");
assert.equal((f.logs.get("a")!.at(-1)!.event as Extract<AuditEvent, { type: "payout_status" }>).confirmedByTransactionSearch, true);
const length = f.logs.get("a")!.length;
f.tick();
await f.refresh("a");
assert.equal(f.logs.get("a")!.length, length, "unchanged confirmed state must not append");
f.tick();
f.batch(async () => { throw Error("secret error"); });
const failure = await f.refresh("a");
assert.equal(failure.failed, true);
assert.equal(f.logs.get("a")!.length, length);
assert.ok(!JSON.stringify(failure).includes("secret"));
const g = fixture();
g.batch(async () => ({ batch_header: { batch_status: "SUCCESS" } }));
assert.equal((await g.refresh("a")).failed, true, "batch success is not item success");
assert.equal(g.logs.get("a")!.length, 1);
g.tick();
g.batch(async () => ({ items: [{ transaction_status: "SUCCESS", transaction_id: "txn" }] }));
g.failSearch();
assert.equal((await g.refresh("a")).failed, true);
assert.equal((g.logs.get("a")!.at(-1)!.event as Extract<AuditEvent, { type: "payout_status" }>).status, "SUCCESS", "search failure preserves status evidence");
const h = fixture();
let release!: (value: PayoutBatch) => void;
h.batch(() => new Promise((resolve) => { release = resolve; }));
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
bounded.tick();
await bounded.refresh("a");
assert.equal(bounded.calls(), 7, "rotation reaches later payouts");
const isolated = fixture(2);
isolated.batch(async (id) => { if (id === "batch0") throw Error("failed"); return { items: [{ transaction_status: "FAILED" }] }; });
assert.equal((await isolated.refresh("a")).failed, true);
assert.equal(isolated.logs.get("a")!.length, 3, "one failure must not block another payout");
console.log("Payout refresh checks passed: transitions, confirmation lag, failures, isolation, throttling, concurrency, and bounded rotation.");
