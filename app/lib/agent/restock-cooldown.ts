import type { AuditEntry } from "../policy/schema";

export const DECLINE_COOLDOWN_MS = 24 * 60 * 60_000;
export type RestockCooldown = {
  decisionSeq: number;
  rejectedSeq: number;
  until: string;
};

/** Only the latest real proposal can impose a decline hold. Resets release one exact decline. */
export function restockCooldown(
  item: { variantId: string; sku: string | null },
  log: AuditEntry[],
  now = new Date(),
): RestockCooldown | null {
  const same = (p: { variantId?: string; sku: string }) =>
    p.variantId ? p.variantId === item.variantId : p.sku === item.sku;
  const last = log
    .filter((e) =>
      e.event.type === "proposal"
        ? !e.event.scenario && same(e.event.proposal)
        : e.event.type === "proposal_failed" &&
          !e.event.scenario &&
          same(e.event),
    )
    .at(-1);
  if (last?.event.type !== "proposal") return null;
  const decision = log.find(
    (e) => e.event.type === "decision" && e.event.proposalSeq === last.seq,
  );
  if (!decision) return null;
  // Payment and incoming-stock protections always take precedence over a decline hold.
  if (
    log.some(
      (e) =>
        (e.event.type === "payout" || e.event.type === "order_captured") &&
        e.event.decisionSeq === decision.seq,
    )
  )
    return null;
  const rejected = log
    .filter(
      (e) =>
        e.event.type === "rejected" && e.event.decisionSeq === decision.seq,
    )
    .at(-1);
  if (!rejected) return null;
  const until = new Date(
    Date.parse(rejected.at) + DECLINE_COOLDOWN_MS,
  ).toISOString();
  if (Date.parse(until) <= now.getTime()) return null;
  if (
    log.some(
      (e) =>
        e.seq > rejected.seq &&
        e.event.type === "restock_cooldown_reset" &&
        e.event.variantId === item.variantId &&
        e.event.rejectedSeq === rejected.seq &&
        e.event.decisionSeq === decision.seq,
    )
  )
    return null;
  return { decisionSeq: decision.seq, rejectedSeq: rejected.seq, until };
}
