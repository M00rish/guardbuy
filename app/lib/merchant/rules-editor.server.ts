import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { demoEnabled } from "../demo/public-dashboard";
import db from "../../db.server";
import { auditEntries } from "../audit/log.server";
import {
  currentRuleSet,
  defaultRuleSet,
  signRuleSet,
} from "../agent/restock.server";
import { adminWithStaff } from "../merchant/staff.server";
import { RuleSetSchema } from "../policy/schema";
import { usd } from "../format";
import {
  readRulesForm,
  rulesFormErrors,
  type FormErrors,
  type NumberField,
} from "../policy/rules-form";

// The merchant's spending rules. Signing writes the rules and their fingerprint (hash) to the
// audit log with the staff member who signed; every decision records which rule set it used.

export const loadRules = async ({ request }: LoaderFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  const log = await auditEntries(session.shop);
  const rules = currentRuleSet(log) ?? defaultRuleSet(session.shop);
  const suppliers = await db.supplier.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
    select: { id: true, name: true, _count: { select: { products: true } } },
  });
  const signer = (by: string) =>
    by === actor ? "you" : by.replace("shopify-staff:", "staff member ");
  const history = log
    .flatMap((e) =>
      e.event.type === "ruleset_signed"
        ? [
            {
              seq: e.seq,
              by: signer(e.event.ruleSet.signedBy),
              at: e.event.ruleSet.signedAt,
              hash: e.event.ruleSet.hash,
              approvalAbove: usd(e.event.ruleSet.rules.approvalAboveCents),
              weeklyCap: usd(e.event.ruleSet.rules.weeklySpendCapCents),
            },
          ]
        : [],
    )
    .reverse();
  return {
    demoAvailable: demoEnabled(session.shop, {
      enabled: process.env.GUARDBUY_PUBLIC_DEMO_ENABLED,
      shop: process.env.GUARDBUY_DEMO_STORE,
      paypalBase: process.env.PAYPAL_API_BASE,
    }),
    signed: currentRuleSet(log) !== null,
    rules,
    suppliers: suppliers.map((s) => ({
      id: s.id,
      name: s.name,
      products: s._count.products,
    })),
    history,
  };
};

export const signRules = async ({ request }: ActionFunctionArgs) => {
  const { session, actor, redirect } = await adminWithStaff(request);
  const form = readRulesForm(await request.formData());
  const errors = rulesFormErrors(form);
  if (Object.keys(errors).length > 0)
    return { ok: false, message: "Check the highlighted rules", errors };
  const num = (k: NumberField) => Number(form[k]);
  const cents = (k: NumberField) => Math.round(num(k) * 100);
  const parsed = RuleSetSchema.safeParse({
    version: 1,
    shop: session.shop,
    currency: "USD",
    reorderBelowDaysOfCover: num("reorderBelowDaysOfCover"),
    targetDaysOfCover: num("targetDaysOfCover"),
    priceToleranceCents: cents("priceTolerance"),
    approvalAboveCents: cents("approvalAbove"),
    weeklySpendCapCents: cents("weeklySpendCap"),
    cashFloorCents: cents("cashFloor"),
    supplierAllowlist: form.allow,
    maxQuantityMultiple: num("maxQuantityMultiple"),
    maxPurchasesPer24h: num("maxPurchasesPer24h"),
  });
  if (!parsed.success)
    return {
      ok: false,
      message: "Check the highlighted rules",
      errors: {} as FormErrors,
    };
  const firstSigning =
    currentRuleSet(await auditEntries(session.shop)) === null;
  const entry = await signRuleSet(session.shop, parsed.data, actor);
  // The first signing finishes setup: go to Home, where the agent is now running.
  if (firstSigning) throw redirect("/app");
  return {
    ok: true,
    message: `Rules signed (audit log entry #${entry.seq})`,
    errors: {} as FormErrors,
  };
};

export type RulesPageData = Awaited<ReturnType<typeof loadRules>>;
export type RulesActionData = Awaited<ReturnType<typeof signRules>>;
