// Deterministic scheduler: no browser, timers, store, payment or network access.
import assert from "node:assert/strict";
import {
  livePage,
  startLivePolling,
  LIVE_INTERVAL,
} from "../app/lib/live/poll";

for (const path of [
  "/app",
  "/app/activity",
  "/app/deliveries",
  "/app/products",
  "/app/rules",
])
  assert.ok(livePage(path, ""));
for (const [path, search] of [
  ["/app/rules", "?tab=rules"],
  ["/app/products", "?tab=suppliers"],
  ["/app/products/123", ""],
  ["/app/alerts", ""],
])
  assert.equal(
    livePage(path, search),
    false,
    "configuration forms are not automatically reloaded",
  );

let time = 0,
  ready = true,
  revision = "stock-1",
  reads = 0,
  refreshes = 0,
  fail = false;
let scheduled: (() => void) | undefined,
  delay = -1;
let holdRead: (() => void) | undefined;
let signal: AbortSignal | undefined;
const stop = startLivePolling({
  ready: () => ready,
  revision: async (s) => {
    signal = s;
    reads++;
    if (fail) throw new Error("Cold start");
    if (holdRead)
      await new Promise<void>((resolve) => {
        holdRead = resolve;
      });
    return revision;
  },
  refresh: async () => {
    refreshes++;
  },
  now: () => time,
  schedule: (fn, ms) => {
    scheduled = fn;
    delay = ms;
    return () => {
      scheduled = undefined;
    };
  },
});
async function tick() {
  assert.ok(scheduled);
  time += delay;
  const fn = scheduled;
  scheduled = undefined;
  fn();
  // Flush the async revision/revalidation chain without real elapsed time.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
await tick();
assert.equal(reads, 1);
assert.equal(refreshes, 1, "first read closes the page-load race");
await tick();
assert.equal(
  refreshes,
  1,
  "unchanged data does not reload the expensive dashboard",
);
revision = "stock-2";
await tick();
assert.equal(refreshes, 2, "stock webhook updates the visible dashboard");
ready = false;
revision = "approval-3";
const before = reads;
await tick();
assert.equal(reads, before, "hidden, editing or busy pages do not poll");
ready = true;
await tick();
assert.equal(refreshes, 3, "deferred approval changes are not lost");
fail = true;
await tick();
assert.equal(delay, 2 * LIVE_INTERVAL);
assert.equal(refreshes, 3);
await tick();
assert.equal(delay, 4 * LIVE_INTERVAL);
fail = false;
await tick();
assert.equal(delay, LIVE_INTERVAL, "recovery restores normal frequency");
const old = refreshes;
time += 60_000;
await tick();
assert.equal(
  refreshes,
  old + 1,
  "expiry and missed webhooks have a bounded fallback",
);
holdRead = () => {};
const beforeStop = refreshes;
await tick();
assert.equal(
  scheduled,
  undefined,
  "a slow request cannot overlap the next poll",
);
stop();
assert.equal(signal?.aborted, true);
holdRead();
for (let i = 0; i < 8; i++) await Promise.resolve();
assert.equal(
  refreshes,
  beforeStop,
  "late responses cannot update an unmounted page",
);
assert.equal(scheduled, undefined);
console.log(
  "PASS live updates: change detection, expiry, editing/visibility, backoff, single flight and cleanup",
);
