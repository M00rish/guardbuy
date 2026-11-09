import { approvalStates } from "../agent/approval-state";
import { paymentStatus } from "../payments/status";
import type { AuditEntry } from "../policy/schema";

/** Current failures only; historical evidence stays in the audit log. */
export function currentProblems(log: AuditEntry[], now = new Date()) {
  const key = (p: { variantId?: string; sku: string }) =>
    p.variantId ? `variant:${p.variantId}` : `sku:${p.sku}`;
  const proposals = new Map<string, AuditEntry>();
  for (const entry of log) {
    const ev = entry.event;
    if (
      (ev.type === "proposal" || ev.type === "proposal_failed") &&
      !ev.scenario
    )
      proposals.set(key(ev.type === "proposal" ? ev.proposal : ev), entry);
  }
  const failedDecisions = new Set<number>();
  const states = approvalStates(log, now);
  for (const entry of log) {
    if (entry.event.type !== "payment_failed") continue;
    const seq = entry.event.decisionSeq;
    const decision = log.find((e) => e.seq === seq)?.event;
    const source =
      decision?.type === "decision"
        ? log.find((e) => e.seq === decision.proposalSeq)
        : undefined;
    if (source?.event.type !== "proposal" || source.event.scenario) continue;
    if (
      log.some(
        (e) =>
          (e.event.type === "payout" || e.event.type === "order_captured") &&
          e.event.decisionSeq === seq &&
          paymentStatus(log, e).settled,
      )
    )
      continue;
    if (
      log.some(
        (e) => e.event.type === "rejected" && e.event.decisionSeq === seq,
      )
    )
      continue;
    const state = states.find((s) => s.decisionSeq === seq);
    if (state && state.status !== "payment_failed") continue; // retry in progress, not a current failure
    if (proposals.get(key(source.event.proposal))?.seq !== source.seq) continue;
    failedDecisions.add(seq);
  }
  return {
    payments: failedDecisions.size,
    proposals: [...proposals.values()].filter(
      (e) => e.event.type === "proposal_failed",
    ).length,
  };
}
