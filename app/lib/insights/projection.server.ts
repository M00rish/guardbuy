import type { AuditEntry } from "../policy/schema";
import { approvalStates } from "../agent/approval-state";
import { currentRuleSet, spending } from "../agent/restock.server";
import { purchaseReservations } from "../payments/attempts";
import { paymentStatus, budgetSummary } from "../payments/status";
import type { FeedNames } from "../audit/feed.server";
import {
  APPROVAL_LABEL,
  type InsightRow,
  type InsightsSnapshot,
} from "./types";

/** Exclude simulated purchases and their related results, without modifying source records. */
function realHistory(log: AuditEntry[]) {
  const proposals = new Set(
    log
      .filter((e) => e.event.type === "proposal" && !e.event.scenario)
      .map((e) => e.seq),
  );
  const decisions = new Set(
    log
      .filter(
        (e) =>
          e.event.type === "decision" && proposals.has(e.event.proposalSeq),
      )
      .map((e) => e.seq),
  );
  const payments = new Set(
    log
      .filter(
        (e) =>
          (e.event.type === "payout" || e.event.type === "order_captured") &&
          decisions.has(e.event.decisionSeq),
      )
      .map((e) => e.seq),
  );
  return log.filter((e) =>
    e.event.type === "proposal"
      ? proposals.has(e.seq)
      : e.event.type === "decision"
        ? decisions.has(e.seq)
        : e.event.type === "payout_status"
          ? payments.has(e.event.payoutSeq)
          : "decisionSeq" in e.event
            ? decisions.has(e.event.decisionSeq)
            : !["proposal_failed"].includes(e.event.type),
  );
}
export function insightsSnapshot(
  history: AuditEntry[],
  names: FeedNames = {},
  now = new Date(),
): InsightsSnapshot {
  const log = realHistory(history),
    reservations = purchaseReservations(log);
  const approvals = new Map(
    approvalStates(log, now).map((state) => [state.decisionSeq, state]),
  );
  const days = Array.from({ length: 8 }, (_, index) =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - 7 + index,
      ),
    )
      .toISOString()
      .slice(0, 10),
  );
  const trend = days.map((day) => ({ day, spent: 0 }));
  const rows: InsightRow[] = [];
  for (const entry of log) {
    if (entry.event.type !== "decision") continue;
    const decision = entry.event.decision,
      source = log.find(
        (e) =>
          e.seq ===
          (entry.event.type === "decision" ? entry.event.proposalSeq : -1),
      );
    if (source?.event.type !== "proposal") continue;
    const proposal = source.event.proposal;
    const events = log.filter(
      (e) => "decisionSeq" in e.event && e.event.decisionSeq === entry.seq,
    );
    const result = events.find(
      (e) => e.event.type === "payout" || e.event.type === "order_captured",
    );
    const state = approvals.get(entry.seq);
    const declined = events.some((e) => e.event.type === "rejected");
    const status = result
      ? paymentStatus(log, result).label
      : state
        ? APPROVAL_LABEL[state.status]
        : declined
          ? "Declined"
          : decision.verdict === "block"
            ? "Blocked"
            : decision.verdict === "approval"
              ? "Approval expired"
              : "Allowed by rules";
    const reserved =
      reservations.get(entry.seq)?.amountCents ??
      (state?.status === "waiting" ? decision.totalCents : 0);
    let settled = 0,
      paidAt = result?.at;
    if (result?.event.type === "payout" && paymentStatus(log, result).settled) {
      settled = result.event.amountCents;
      paidAt =
        log.find(
          (e) =>
            e.event.type === "payout_status" &&
            e.event.payoutSeq === result.seq &&
            e.event.status === "SUCCESS",
        )?.at ?? result.at;
    }
    if (result?.event.type === "order_captured") {
      const orderId = result.event.orderId;
      const latest = log
        .filter(
          (e) => e.event.type === "order_status" && e.event.orderId === orderId,
        )
        .at(-1)?.event;
      const providerStatus =
        latest?.type === "order_status" ? latest.status : result.event.status;
      if (["COMPLETED", "PARTIALLY_REFUNDED"].includes(providerStatus)) {
        settled = Math.max(
          0,
          result.event.amountCents -
            (latest?.type === "order_status" ? latest.refundedCents : 0),
        );
        if (result.event.status !== "COMPLETED")
          paidAt =
            log.find(
              (e) =>
                e.event.type === "order_status" &&
                e.event.orderId === orderId &&
                e.event.status === "COMPLETED",
            )?.at ?? result.at;
      }
    }
    const bucket = trend.find((day) => day.day === paidAt?.slice(0, 10));
    if (
      bucket &&
      paidAt &&
      Date.parse(paidAt) > now.getTime() - 7 * 86_400_000 &&
      Date.parse(paidAt) <= now.getTime()
    )
      bucket.spent += settled / 100;
    const openOrder = events
      .filter((e) => e.event.type === "order_created")
      .at(-1)?.event;
    const paymentReference =
      result?.event.type === "payout"
        ? result.event.payoutBatchId
        : result?.event.type === "order_captured"
          ? result.event.orderId
          : openOrder?.type === "order_created"
            ? openOrder.orderId
            : "";
    const reason = decision.checks
      .filter((check) => check.outcome !== "auto")
      .map((check) => check.detail)
      .join("; ");
    rows.push({
      purchase: entry.seq,
      variantId: proposal.variantId,
      proposedAt: source.at,
      product:
        names.product?.(proposal.sku, proposal.variantId) ?? proposal.sku,
      supplier: names.supplier?.(proposal.supplierId) ?? proposal.supplierId,
      status,
      reason: reason || "All recorded rules passed.",
      amount: decision.totalCents / 100,
      settled: settled / 100,
      reserved: reserved / 100,
      blocked: decision.verdict === "block" ? decision.totalCents / 100 : 0,
      paymentReference,
      route:
        result?.event.type === "payout"
          ? "PayPal Payouts"
          : events.some(
                (e) =>
                  e.event.type === "order_created" ||
                  e.event.type === "order_captured",
              )
            ? "PayPal checkout"
            : state?.status === "payment_unknown" ||
                state?.status === "payment_failed"
              ? "Not confirmed"
              : "Not submitted",
      activityUrl: `/app/activity?purchase=${entry.seq}`,
      pending:
        state?.status === "payment_pending" ||
        state?.status === "payment_unknown",
      attention:
        state?.status === "waiting" ||
        state?.status === "payment_failed" ||
        state?.status === "payment_unknown" ||
        state?.status === "paypal_pending",
    });
  }
  const spent = spending(log, now),
    capCents = currentRuleSet(log)?.weeklySpendCapCents ?? 0;
  const budget = budgetSummary(
    spent.spentLast7dCents,
    spent.pendingCents,
    capCents,
  );
  return {
    rows: rows.reverse(),
    trend,
    checkedAt: now.toISOString(),
    summary: {
      spentCents: spent.spentLast7dCents,
      reservedCents: spent.pendingCents,
      capCents,
      remainingCents: budget.remaining,
      overCents: budget.over,
      blockedCents: rows.reduce(
        (sum, row) => sum + Math.round(row.blocked * 100),
        0,
      ),
      blockedCount: rows.filter((row) => row.status === "Blocked").length,
    },
  };
}
