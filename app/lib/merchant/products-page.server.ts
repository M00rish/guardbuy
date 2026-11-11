import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../../db.server";
import { privateAdmin } from "../merchant/staff.server";
import { productOverview } from "../merchant/dashboard.server";
import { auditEntries } from "../audit/log.server";
import { currentRuleSet } from "../agent/restock.server";
import { manageProduct } from "./manage-product.server";
import { usd } from "../format";

// Products & suppliers (index): every product, whether GuardBuy restocks it, and from whom.
// "Manage" opens the product's page to link suppliers and set the preferred one.

export const loadProducts = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await privateAdmin(request);
  const shop = session.shop;
  const [products, links, supplierCount, log] = await Promise.all([
    productOverview(admin, shop).catch((e) => {
      console.warn(`[products] Shopify unavailable: ${(e as Error).message}`);
      return null;
    }),
    db.productSupplier.findMany({
      where: { shop },
      include: { supplier: true },
      orderBy: [{ preferred: "desc" }, { unitPriceCents: "asc" }],
    }),
    db.supplier.count({ where: { shop } }),
    auditEntries(shop),
  ]);
  const allow = currentRuleSet(log)?.supplierAllowlist ?? null; // null: no rules signed yet
  return {
    supplierCount,
    unavailable: products === null,
    products: (products ?? []).map((p) => ({
      variantId: p.variantId,
      title: p.title,
      sku: p.sku,
      stock: p.stock,
      perDay:p.perDay,
      cover: Number.isFinite(p.cover) ? Number(p.cover.toFixed(1)) : null,
      managed: p.managed,
      suppliers: links
        .filter((l) => l.variantId === p.variantId)
        .map((l) => ({
          name: l.supplier.name,
          price: usd(l.unitPriceCents),
          preferred: l.preferred,
          approved: allow === null || allow.includes(l.supplierId), // not on the rules' list: the agent's purchase would be blocked
        })),
    })),
  };
};

export const toggleProduct = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await privateAdmin(request);
  const f = await request.formData();
  const variantId = String(f.get("variantId") ?? "");
  if (f.get("intent") !== "toggle" || !/^\d+$/.test(variantId))
    return { ok: false, message: "Unknown action" };
  const on = f.get("managed") === "true";
  return manageProduct(admin,session.shop,{
    variantId,sku:String(f.get("sku")||"")||null,title:String(f.get("title")??"")
  },on);
};

export type ProductsPageData = Awaited<ReturnType<typeof loadProducts>>;
export type ProductActionData = Awaited<ReturnType<typeof toggleProduct>>;
