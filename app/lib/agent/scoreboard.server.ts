import { auditEntries } from "../audit/log.server";
import type { AuditEntry } from "../policy/schema";
import { attackById, type AttackLevel } from "../suppliers/attacks";
import { classifyAttack, WHAT_IF_SCENARIO, type AttackOutcome } from "./attack.server";
import { RULE_LABELS } from "../policy/rules";

export { RULE_LABELS };

// The attack scoreboard, computed from the hash-chained log only (nothing is counted separately,
// so it can't drift from what actually happened).
//   attacks: injection tests (judge sandboxes, demo): how often the AI was fooled and what stopped it
//   real:    normal operation: what the rules blocked or sent to a person, by rule and in dollars

type Tally = { tried: number; resisted: number; blocked: number; flagged: number; slipped: number; failed: number };
const tally = (): Tally => ({ tried: 0, resisted: 0, blocked: 0, flagged: 0, slipped: 0, failed: 0 });

export type Scoreboard = {
  attacks: Tally & {
    blockedCents: number; // money the AI was talked into, stopped by a rule
    flaggedCents: number; // money the AI was talked into, held for a person
    slippedCents: number; // money that would have moved (known gaps)
    byLevel: Record<AttackLevel, Tally>;
    simulated: { tried: number; blocked: number }; // "what if the AI were fooled?" runs
    knownGaps: { title: string; fix: string }[];
    recent: { at: string; title: string; level: AttackLevel; outcome: AttackOutcome | "failed"; totalCents?: number; model?: string }[];
  };
  real: { decisions: number; blocked: number; blockedCents: number; approval: number; approvalCents: number };
  stoppedBy: { rule: string; count: number }[]; // rules that blocked something (tests and real)
};

export async function scoreboard(shop: string, log?: AuditEntry[]): Promise<Scoreboard> {
  log ??= await auditEntries(shop);
  const attacks: Scoreboard["attacks"] = {
    ...tally(), blockedCents: 0, flaggedCents: 0, slippedCents: 0,
    byLevel: { easy: tally(), medium: tally(), hard: tally() },
    simulated: { tried: 0, blocked: 0 }, knownGaps: [], recent: [],
  };
  const real: Scoreboard["real"] = { decisions: 0, blocked: 0, blockedCents: 0, approval: 0, approvalCents: 0 };
  const rules = new Map<string, number>();
  const gaps = new Map<string, string>();

  for (const e of log) {
    if (e.event.type === "proposal_failed" && e.event.scenario) {
      const attack = attackById(e.event.scenario);
      if (!attack) continue;
      attacks.tried++; attacks.failed++;
      attacks.byLevel[attack.level].tried++; attacks.byLevel[attack.level].failed++;
      attacks.recent.push({ at: e.at, title: attack.title, level: attack.level, outcome: "failed" });
      continue;
    }
    if (e.event.type !== "decision") continue;
    const proposalSeq = e.event.proposalSeq;
    const p = log.find((x) => x.seq === proposalSeq);
    if (p?.event.type !== "proposal") continue;
    const { decision } = e.event;
    for (const c of decision.checks) if (c.outcome === "block") rules.set(c.rule, (rules.get(c.rule) ?? 0) + 1);

    const scenario = p.event.scenario;
    if (!scenario) {
      real.decisions++;
      if (decision.verdict === "block") { real.blocked++; real.blockedCents += decision.totalCents; }
      if (decision.verdict === "approval") { real.approval++; real.approvalCents += decision.totalCents; }
      continue;
    }
    if (scenario === WHAT_IF_SCENARIO) {
      attacks.simulated.tried++;
      if (decision.verdict === "block") attacks.simulated.blocked++;
      continue;
    }
    const attack = attackById(scenario);
    if (!attack) continue;
    const outcome = classifyAttack(attack, p.event.proposal, decision.verdict);
    const level = attacks.byLevel[attack.level];
    attacks.tried++; level.tried++;
    attacks[outcome]++; level[outcome]++;
    if (outcome === "blocked") attacks.blockedCents += decision.totalCents;
    if (outcome === "flagged") attacks.flaggedCents += decision.totalCents;
    if (outcome === "slipped") {
      attacks.slippedCents += decision.totalCents;
      gaps.set(attack.title, attack.gap ?? "No rule caught this yet");
    }
    attacks.recent.push({ at: p.at, title: attack.title, level: attack.level, outcome, totalCents: decision.totalCents, model: p.event.proposal.model });
  }

  attacks.knownGaps = [...gaps].map(([title, fix]) => ({ title, fix }));
  attacks.recent = attacks.recent.reverse().slice(0, 10);
  const stoppedBy = [...rules].map(([rule, count]) => ({ rule: RULE_LABELS[rule] ?? rule, count })).sort((a, b) => b.count - a.count);
  return { attacks, real, stoppedBy };
}
