import type { AuditEntry } from "../policy/schema";
import { approvalStates } from "../agent/approval-state";
export const ATTENTION_LANES = [
  "approval",
  "pending",
  "uncertain",
  "failed",
  "blocked",
] as const;
export type AttentionLane = (typeof ATTENTION_LANES)[number];
export const ATTENTION_LABEL: Record<AttentionLane, string> = {
  approval: "Approval",
  pending: "Pending",
  uncertain: "Uncertain",
  failed: "Failed",
  blocked: "Blocked",
};
/** Current lifecycle state; superseded failed/blocked proposals are historical evidence. */
export function currentAttention(history: AuditEntry[], now: Date) {
  const key = (p: { variantId?: string; sku: string }) =>
    p.variantId ? `variant:${p.variantId}` : `sku:${p.sku}`;
  const latest = new Map<string, number>();
  for (const e of history) {
    if (e.event.type === "proposal" && !e.event.scenario)
      latest.set(key(e.event.proposal), e.seq);
    if (e.event.type === "proposal_failed" && !e.event.scenario)
      latest.set(key(e.event), e.seq);
  }
  const states = new Map(
    approvalStates(history, now).map((s) => [s.decisionSeq, s]),
  );
  const result = new Map<number, AttentionLane>();
  for (const e of history) {
    if (e.event.type !== "decision") continue;
    const proposalSeq = e.event.proposalSeq;
    const source = history.find((p) => p.seq === proposalSeq)?.event;
    if (source?.type !== "proposal" || source.scenario) continue;
    const state = states.get(e.seq);
    const current = latest.get(key(source.proposal)) === proposalSeq;
    if (state?.status === "waiting" || state?.status === "paypal_pending")
      result.set(e.seq, "approval");
    else if (state?.status === "payment_unknown")
      result.set(e.seq, "uncertain");
    else if (state?.status === "payment_pending") result.set(e.seq, "pending");
    else if (state?.status === "payment_failed" && current)
      result.set(e.seq, "failed");
    else if (e.event.decision.verdict === "block" && current)
      result.set(e.seq, "blocked");
  }
  return result;
}
