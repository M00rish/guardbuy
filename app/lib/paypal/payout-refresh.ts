import type { AuditEntry, AuditEvent } from "../policy/schema";

export type PayoutBatch = {
  batch_header?: { batch_status: string };
  items?: { transaction_id?: string; transaction_status?: string }[];
};
type Ports = {
  read: (shop: string) => Promise<AuditEntry[]>;
  append: (shop: string, event: AuditEvent) => Promise<unknown>;
  batch: (id: string) => Promise<PayoutBatch>;
  confirmed: (id: string) => Promise<boolean>;
};
export type RefreshState = {
  running: boolean;
  checkedAt: string | null;
  retryAt: string | null;
  incomplete: boolean;
  failed: boolean;
  awaitingConfirmation: boolean;
};
const FINAL = new Set(["SUCCESS", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]);

/** Read-only PayPal operations; the only write capability is appending audit evidence. */
export function createPayoutRefresh(ports: Ports, options: { now?: () => number; cooldownMs?: number; waitMs?: number; batchSize?: number } = {}) {
  const now = options.now ?? Date.now;
  const cooldown = options.cooldownMs ?? 60_000;
  const batchSize = options.batchSize ?? 5;
  type Slot = { state: RefreshState; pending?: Promise<void>; cursor: number; next: number };
  const shops = new Map<string, Slot>();

  async function run(shop: string, slot: Slot) {
    const state = slot.state;
    state.failed = false;
    state.awaitingConfirmation = false;
    try {
      const log = await ports.read(shop);
      // Continue checking previously confirmed payouts: they can later be returned/refunded.
      const payouts = log.filter((e) => e.event.type === "payout");
      const selected = payouts.filter((e) => e.seq > slot.cursor).slice(0, batchSize);
      if (!selected.length) selected.push(...payouts.slice(0, batchSize));
      state.incomplete = payouts.length > selected.length;
      for (const payout of selected) {
        slot.cursor = payout.seq;
        if (payout.event.type !== "payout") continue;
        const latest = [...log].reverse().find((e) => e.event.type === "payout_status" && e.event.payoutSeq === payout.seq)?.event;
        const previous = latest?.type === "payout_status" ? latest : undefined;
        try {
          const batch = await ports.batch(payout.event.payoutBatchId);
          // GuardBuy sends one recipient per batch. A batch SUCCESS isn't proof that an item succeeded.
          const item = batch.items?.length === 1 ? batch.items[0] : undefined;
          if (!item?.transaction_status) throw new Error("Missing payout item status");
          const status = item.transaction_status;
          const transactionId = item.transaction_id ?? previous?.transactionId;
          const changed = status !== (previous?.status ?? payout.event.status) || transactionId !== previous?.transactionId;
          let confirmed = !changed && (previous?.confirmedByTransactionSearch ?? false);
          if (changed) {
            await ports.append(shop, { type: "payout_status", payoutSeq: payout.seq, status, transactionId, confirmedByTransactionSearch: false });
          }
          if (transactionId && FINAL.has(status) && !confirmed) {
            confirmed = await ports.confirmed(transactionId);
            if (confirmed) await ports.append(shop, { type: "payout_status", payoutSeq: payout.seq, status, transactionId, confirmedByTransactionSearch: true });
          }
          if (FINAL.has(status) && !confirmed) state.awaitingConfirmation = true;
        } catch {
          // Preserve successful status evidence even if transaction search fails. Never expose provider errors.
          state.failed = true;
        }
      }
      if (!state.failed) state.checkedAt = new Date(now()).toISOString();
    } catch {
      state.failed = true;
    } finally {
      state.running = false;
      slot.next = now() + cooldown;
      state.retryAt = new Date(slot.next).toISOString();
    }
  }

  return async function refresh(shop: string): Promise<RefreshState> {
    // Bound idle cache growth; never evict an active run or bypass its cooldown.
    for (const [key, value] of shops) {
      if (!value.pending && now() > value.next + 3_600_000) shops.delete(key);
    }
    let slot = shops.get(shop);
    if (!slot) {
      slot = { cursor: -1, next: 0, state: { running: false, checkedAt: null, retryAt: null, incomplete: false, failed: false, awaitingConfirmation: false } };
      shops.set(shop, slot);
    }
    if (!slot.pending && now() >= slot.next) {
      slot.state.running = true;
      const current = slot;
      slot.pending = run(shop, current).finally(() => { current.pending = undefined; });
    }
    // Keep page loads responsive. The shared run continues; subsequent requests join it.
    if (slot.pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([slot.pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs ?? 1_500); })]);
      clearTimeout(timer);
    }
    return { ...slot.state };
  };
}
