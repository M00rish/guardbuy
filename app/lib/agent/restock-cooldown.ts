import type { AuditEntry } from "../policy/schema";

export type RestockCooldown = {
  decisionSeq: number;
  rejectedSeq: number;
};
export type RestockBlock = {
  decisionSeq: number;
  proposalSeq: number;
};

/** Only the latest real proposal can impose a decline hold. Resets release one exact decline. */
export function restockCooldown(
  item: { variantId: string; sku: string | null },
  log: AuditEntry[],
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
  // A decline lasts until the merchant resets it; there is no time-based expiry.
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
  return { decisionSeq: decision.seq, rejectedSeq: rejected.seq };
}

/**
 * The hold after the rules blocked the latest real proposal. It only exists while that block is
 * still the product's latest restock attempt, and a recorded lift releases it. It has no timer.
 */
export function restockBlock(
  item: { variantId: string; sku: string | null },
  log: AuditEntry[],
): RestockBlock | null {
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
  if (
    decision?.event.type !== "decision" ||
    decision.event.decision.verdict !== "block"
  )
    return null;
  // A block lasts until the merchant lifts it; there is no time-based expiry.
  if (
    log.some(
      (e) =>
        e.seq > decision.seq &&
        e.event.type === "restock_block_reset" &&
        e.event.decisionSeq === decision.seq,
    )
  )
    return null;
  return { decisionSeq: decision.seq, proposalSeq: last.seq };
}
