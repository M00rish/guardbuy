import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import db from "../../db.server";
import { privateAdmin } from "../merchant/staff.server";
import { auditEntries } from "../audit/log.server";
import { currentRuleSet } from "../agent/restock.server";
import { saveSupplier } from "../suppliers/directory.server";

// Suppliers (index): who GuardBuy may pay, at which PayPal address, for how many products, and
// whether the merchant's rules approve them. Editing happens on each supplier's page.

const RECENT_CHANGE_MS = 14 * 86_400_000;

export const loadSuppliers = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const [suppliers, log] = await Promise.all([
    db.supplier.findMany({
      where: { shop: session.shop },
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    }),
    auditEntries(session.shop),
  ]);
  const allow = currentRuleSet(log)?.supplierAllowlist ?? null;
  return {
    suppliers: suppliers.map((s) => {
      const changed = s.emailChangedAt.getTime() - s.createdAt.getTime() > 1000;
      return {
        id: s.id,
        name: s.name,
        paypalEmail: s.paypalEmail,
        products: s._count.products,
        approved: allow === null ? null : allow.includes(s.id),
        emailChangedAt:
          changed && Date.now() - s.emailChangedAt.getTime() < RECENT_CHANGE_MS
            ? s.emailChangedAt.toISOString()
            : null,
      };
    }),
  };
};

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

export const addSupplier = async ({ request }: ActionFunctionArgs) => {
  const { session } = await privateAdmin(request);
  const f = await request.formData();
  const name = String(f.get("name") ?? "").trim();
  const paypalEmail = String(f.get("paypalEmail") ?? "").trim();
  const id = slug(name);
  if (!name || !id) return { ok: false, message: "Enter the supplier's name" };
  if (!z.email().safeParse(paypalEmail).success)
    return {
      ok: false,
      message: "Enter the PayPal email the supplier is paid at",
    };
  // Never overwrite an existing supplier from here: changing where a supplier is paid is a deliberate edit on its page.
  if (
    await db.supplier.findUnique({
      where: { shop_id: { shop: session.shop, id } },
    })
  ) {
    return {
      ok: false,
      message: `${name} already exists. Open it to change its PayPal email.`,
    };
  }
  await saveSupplier(session.shop, { id, name, paypalEmail });
  return { ok: true, message: `Added ${name}` };
};

export type SuppliersPageData = Awaited<ReturnType<typeof loadSuppliers>>;
export type AddSupplierData = Awaited<ReturnType<typeof addSupplier>>;
