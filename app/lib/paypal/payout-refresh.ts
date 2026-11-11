import type { AuditEntry, AuditEvent } from "../policy/schema";
export type PayoutBatch = {
  batch_header?: { batch_status: string };
  items?: { transaction_id?: string; transaction_status?: string }[];
};
export type PayoutCheck = {
  payoutSeq: number;
  nextAt: number;
  checkedAt: number | null;
  unchanged: number;
};
export type PayoutSchedule = {
  load: (shop: string) => Promise<PayoutCheck[]>;
  claim: (shop: string, seq: number, now: number) => Promise<boolean>;
  save: (shop: string, check: PayoutCheck) => Promise<void>;
};
type Ports = {
  read: (shop: string) => Promise<AuditEntry[]>;
  append: (shop: string, event: AuditEvent) => Promise<unknown>;
  batch: (id: string) => Promise<PayoutBatch>;
  confirmed: (id: string) => Promise<boolean>;
  schedule?: PayoutSchedule;
};
export type RefreshState = {
  running: boolean;
  checkedAt: string | null;
  retryAt: string | null;
  incomplete: boolean;
  failed: boolean;
  awaitingConfirmation: boolean;
  scheduled?: boolean;
};
const FINAL = new Set([
  "SUCCESS",
  "FAILED",
  "RETURNED",
  "BLOCKED",
  "REFUNDED",
  "REVERSED",
]);
const MINUTE = 60_000;
/** Back off unchanged/error results. Settled payments are checked daily for returns/refunds. */
export function payoutCheckDelay(unchanged: number, confirmed: boolean) {
  return confirmed
    ? 24 * 60 * MINUTE
    : [5, 15, 30, 60][Math.min(unchanged, 3)] * MINUTE;
}
/** Fallback for deterministic offline consumers; production injects the durable, leased store. */
function memorySchedule(): PayoutSchedule {
  const shops = new Map<string, Map<number, PayoutCheck>>();
  const get = (shop: string) => {
    let s = shops.get(shop);
    if (!s) {
      s = new Map();
      shops.set(shop, s);
    }
    return s;
  };
  return {
    load: async (shop) => [...get(shop).values()],
    claim: async (shop, seq, now) => {
      const s = get(shop),
        old = s.get(seq);
      if (old && old.nextAt > now) return false;
      s.set(seq, {
        payoutSeq: seq,
        nextAt: now + 180_000,
        checkedAt: old?.checkedAt ?? null,
        unchanged: old?.unchanged ?? 0,
      });
      return true;
    },
    save: async (shop, check) => {
      get(shop).set(check.payoutSeq, check);
    },
  };
}
/** No payment submission capability. Only provider reads, audit evidence and a check schedule. */
export function createPayoutRefresh(
  ports: Ports,
  options: {
    now?: () => number;
    cooldownMs?: number;
    waitMs?: number;
    batchSize?: number;
  } = {},
) {
  const now = options.now ?? Date.now,
    schedule = ports.schedule ?? memorySchedule(),
    batchSize = options.batchSize ?? 5;
  const shops = new Map<
    string,
    { state: RefreshState; pending?: Promise<void> }
  >();
  async function run(shop: string, state: RefreshState) {
    state.failed = false;
    state.incomplete = false;
    state.awaitingConfirmation = false;
    state.scheduled = false;
    try {
      const [log, stored] = await Promise.all([
        ports.read(shop),
        schedule.load(shop),
      ]);
      const checks = new Map(stored.map((c) => [c.payoutSeq, c]));
      const payouts = log.filter((e) => e.event.type === "payout");
      const latest = new Map<
        number,
        Extract<AuditEvent, { type: "payout_status" }>
      >();
      for (const e of log)
        if (e.event.type === "payout_status")
          latest.set(e.event.payoutSeq, e.event);
      const due = payouts
        .filter((p) => (checks.get(p.seq)?.nextAt ?? 0) <= now())
        .sort(
          (a, b) =>
            (checks.get(a.seq)?.nextAt ?? 0) -
              (checks.get(b.seq)?.nextAt ?? 0) || a.seq - b.seq,
        );
      for (const payout of due.slice(0, batchSize)) {
        if (payout.event.type !== "payout") continue;
        if (!(await schedule.claim(shop, payout.seq, now()))) continue;
        const previous = latest.get(payout.seq),
          old = checks.get(payout.seq);
        let unchanged = (old?.unchanged ?? -1) + 1,
          verified = false;
        try {
          const batch = await ports.batch(payout.event.payoutBatchId);
          const item = batch.items?.length === 1 ? batch.items[0] : undefined;
          if (!item?.transaction_status)
            throw Error("Missing payout item status");
          const status = item.transaction_status,
            transactionId = item.transaction_id ?? previous?.transactionId;
          const changed =
            status !== (previous?.status ?? payout.event.status) ||
            transactionId !== previous?.transactionId;
          if (changed) unchanged = 0;
          verified =
            !changed && Boolean(previous?.confirmedByTransactionSearch);
          if (changed)
            await ports.append(shop, {
              type: "payout_status",
              payoutSeq: payout.seq,
              status,
              transactionId,
              confirmedByTransactionSearch: false,
            });
          if (transactionId && FINAL.has(status) && !verified) {
            verified = await ports.confirmed(transactionId);
            if (verified)
              await ports.append(shop, {
                type: "payout_status",
                payoutSeq: payout.seq,
                status,
                transactionId,
                confirmedByTransactionSearch: true,
              });
          }
          latest.set(payout.seq, {
            type: "payout_status",
            payoutSeq: payout.seq,
            status,
            transactionId,
            confirmedByTransactionSearch: verified,
          });
        } catch {
          state.failed = true;
        }
        const at = now();
        await schedule.save(shop, {
          payoutSeq: payout.seq,
          checkedAt: at,
          nextAt:
            at + (options.cooldownMs ?? payoutCheckDelay(unchanged, verified)),
          unchanged,
        });
      }
      // Reload durable deadlines: another app process may own a payout's lease.
      const updated = await schedule.load(shop),
        active = updated.filter((c) =>
          payouts.some((p) => p.seq === c.payoutSeq),
        );
      const times = active.flatMap((c) =>
        c.checkedAt === null ? [] : [c.checkedAt],
      );
      state.checkedAt = times.length
        ? new Date(Math.max(...times)).toISOString()
        : null;
      state.incomplete = due.length > batchSize;
      state.awaitingConfirmation = payouts.some((p) => {
        const v = latest.get(p.seq);
        return v && FINAL.has(v.status) && !v.confirmedByTransactionSearch;
      });
      state.scheduled =
        state.incomplete ||
        payouts.some((p) => {
          const v = latest.get(p.seq);
          return !v || !FINAL.has(v.status) || !v.confirmedByTransactionSearch;
        });
      // Remaining due records can run in the next bounded group without rechecking completed ones.
      const next = state.incomplete
        ? now() + 5_000
        : active.length
          ? Math.min(...active.map((c) => c.nextAt))
          : null;
      state.retryAt = next === null ? null : new Date(next).toISOString();
    } catch {
      state.failed = true;
      state.retryAt = new Date(now() + 5 * MINUTE).toISOString();
    } finally {
      state.running = false;
    }
  }
  return async function refresh(shop: string): Promise<RefreshState> {
    let slot = shops.get(shop);
    if (!slot) {
      slot = {
        state: {
          running: false,
          checkedAt: null,
          retryAt: null,
          incomplete: false,
          failed: false,
          awaitingConfirmation: false,
        },
      };
      shops.set(shop, slot);
    }
    if (!slot.pending) {
      slot.state.running = true;
      const current = slot;
      slot.pending = run(shop, slot.state).finally(() => {
        current.pending = undefined;
        shops.delete(shop);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      slot.pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.waitMs ?? 1500);
      }),
    ]);
    clearTimeout(timer);
    return { ...slot.state };
  };
}
