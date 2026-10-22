// The rules form's values, checks and plain-language summary. Browser-safe: the Rules page uses it
// while the merchant types, and the action uses the same checks before signing.

import { usd } from "../format";

export const NUMBER_FIELDS = [
  "reorderBelowDaysOfCover", "targetDaysOfCover", "maxQuantityMultiple",
  "approvalAbove", "weeklySpendCap", "cashFloor", "maxPriceAboveAvgPct", "priceTolerance", "maxPurchasesPer24h",
] as const;
export type NumberField = (typeof NUMBER_FIELDS)[number];
export type RulesForm = Record<NumberField, string> & { allow: string[] };
export type FormErrors = Partial<Record<NumberField | "allow", string>>;

export function readRulesForm(data: FormData): RulesForm {
  const form = Object.fromEntries(NUMBER_FIELDS.map((k) => [k, String(data.get(k) ?? "")])) as Record<NumberField, string>;
  return { ...form, allow: data.getAll("allow").map(String) };
}

const n = (v: string) => (v.trim() === "" ? NaN : Number(v));

/** Field-level problems, in plain words. Empty when the form can be signed. */
export function rulesFormErrors(f: RulesForm): FormErrors {
  const e: FormErrors = {};
  const atLeast = (k: NumberField, min: number, msg: string) => { if (!(n(f[k]) >= min)) e[k] = msg; };
  atLeast("reorderBelowDaysOfCover", 1, "Enter at least 1 day");
  atLeast("targetDaysOfCover", 1, "Enter at least 1 day");
  atLeast("maxQuantityMultiple", 1, "Enter at least 1 (the usual order)");
  atLeast("approvalAbove", 0, "Enter an amount (0 means every purchase waits for you)");
  atLeast("weeklySpendCap", 0.01, "Enter an amount above $0");
  atLeast("cashFloor", 0, "Enter an amount ($0 or more)");
  atLeast("priceTolerance", 0, "Enter an amount per unit ($0 means any increase waits for you)");
  if (!(n(f.maxPriceAboveAvgPct) >= 0 && n(f.maxPriceAboveAvgPct) <= 100)) e.maxPriceAboveAvgPct = "Enter a percentage from 0 to 100";
  if (!(Number.isInteger(n(f.maxPurchasesPer24h)) && n(f.maxPurchasesPer24h) >= 1)) e.maxPurchasesPer24h = "Enter a whole number, at least 1";

  if (!e.targetDaysOfCover && !e.reorderBelowDaysOfCover && n(f.targetDaysOfCover) <= n(f.reorderBelowDaysOfCover)) {
    e.targetDaysOfCover = "Must be more days than the restock point, or every order is too small to matter";
  }
  if (!e.approvalAbove && !e.weeklySpendCap && n(f.approvalAbove) > n(f.weeklySpendCap)) {
    e.approvalAbove = "Can't be above the weekly cap: purchases that size would be blocked, not sent to you";
  }
  if (f.allow.length === 0) e.allow = "Tick at least one supplier, or every purchase is blocked";
  return e;
}

/** One paragraph saying what the rules do, as the merchant would explain them. */
export function rulesSummary(f: RulesForm, supplierNames: string[]) {
  const money = (k: NumberField) => (Number.isFinite(n(f[k])) ? usd(Math.round(n(f[k]) * 100)) : "…");
  const days = (k: NumberField) => (Number.isFinite(n(f[k])) ? `${n(f[k])} ${n(f[k]) === 1 ? "day" : "days"}` : "…");
  const who = supplierNames.length === 0 ? "no supplier (everything is blocked)" : supplierNames.length === 1 ? supplierNames[0] : `${supplierNames.slice(0, -1).join(", ")} and ${supplierNames.at(-1)}`;
  return [
    `When a product has less than ${days("reorderBelowDaysOfCover")} of stock left, the agent proposes enough for ${days("targetDaysOfCover")}.`,
    `Purchases up to ${money("approvalAbove")} go through on their own; bigger ones wait for you.`,
    `At most ${money("weeklySpendCap")} a week and ${f.maxPurchasesPer24h || "…"} purchases a day, never leaving less than ${money("cashFloor")} in PayPal.`,
    `Only from ${who}, at no more than ${f.maxPriceAboveAvgPct || "…"}% above the usual price and ${f.maxQuantityMultiple || "…"}× the usual quantity.`,
    `A price more than ${money("priceTolerance")} per unit above the one you accepted waits for you once; approving it makes it your new price.`,
  ].join(" ");
}

export const sameForm = (a: RulesForm, b: RulesForm) =>
  NUMBER_FIELDS.every((k) => n(a[k]) === n(b[k])) && [...a.allow].sort().join() === [...b.allow].sort().join();
