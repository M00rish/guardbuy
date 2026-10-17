import { z } from "zod";

import db from "../../db.server";
import { OFFERS, PRODUCTS, SUPPLIERS, simulatedAverage, simulatedPrice } from "./catalog";

// The merchant's own products and suppliers: what GuardBuy may restock, from whom, and on what terms.
// The merchant chooses what and from whom; the agent decides when and how much; the rules decide if.

/** One supplier's offer for one product, as the agent and the policy engine see it. */
export type Offer = {
  supplierId: string;
  supplierName: string;
  paypalEmail: string; // looked up by GuardBuy, never shown to or taken from the AI
  unitPriceTodayCents: number;
  avgUnitPrice30dCents: number;
  usualQuantity: number;
  leadTimeDays: number;
  preferred: boolean;
  note: string; // from the supplier: untrusted
};

export async function isManaged(shop: string, variantId: string) {
  const product = await db.managedProduct.findUnique({ where: { shop_variantId: { shop, variantId } } });
  return product?.managed ?? false;
}

/** The merchant's suppliers for one product, with today's price and the 30-day average. */
export async function offersForVariant(shop: string, variantId: string, today = new Date()): Promise<Offer[]> {
  const rows = await db.productSupplier.findMany({ where: { shop, variantId }, include: { supplier: true } });
  return rows.map((r) => {
    const key = `${variantId}|${r.supplierId}`;
    return {
      supplierId: r.supplierId,
      supplierName: r.supplier.name,
      paypalEmail: r.supplier.paypalEmail,
      // Without a price feed the merchant's listed price is today's price and its own average.
      // (The rule comparing against what was actually paid replaces this average on Oct 20.)
      unitPriceTodayCents: r.simulatedPrices ? simulatedPrice(key, r.unitPriceCents, today) : r.unitPriceCents,
      avgUnitPrice30dCents: r.simulatedPrices ? simulatedAverage(key, r.unitPriceCents, today) : r.unitPriceCents,
      usualQuantity: r.usualQuantity,
      leadTimeDays: r.leadTimeDays,
      preferred: r.preferred,
      note: r.note,
    };
  });
}

/** Where a supplier gets paid right now, or null if none is on file (or it isn't a valid email). */
export async function supplierPaymentEmail(shop: string, supplierId: string) {
  const supplier = await db.supplier.findUnique({ where: { shop_id: { shop, id: supplierId } } });
  return z.email().safeParse(supplier?.paypalEmail).success ? supplier!.paypalEmail : null;
}

// ---------- Changes made by the merchant (the Oct 18 screens call these) ----------

export async function setManaged(shop: string, product: { variantId: string; sku: string | null; title: string }, managed: boolean) {
  const data = { sku: product.sku, title: product.title, managed };
  await db.managedProduct.upsert({
    where: { shop_variantId: { shop, variantId: product.variantId } },
    create: { shop, variantId: product.variantId, ...data },
    update: data,
  });
}

/** Adds or updates a supplier. A new PayPal email is timestamped so the policy can react to it. */
export async function saveSupplier(shop: string, supplier: { id: string; name: string; paypalEmail: string }) {
  const paypalEmail = z.email().parse(supplier.paypalEmail);
  const existing = await db.supplier.findUnique({ where: { shop_id: { shop, id: supplier.id } } });
  const emailChanged = existing && existing.paypalEmail.toLowerCase() !== paypalEmail.toLowerCase();
  await db.supplier.upsert({
    where: { shop_id: { shop, id: supplier.id } },
    create: { shop, id: supplier.id, name: supplier.name, paypalEmail },
    update: { name: supplier.name, paypalEmail, ...(emailChanged ? { emailChangedAt: new Date() } : {}) },
  });
}

export type SupplierTerms = {
  unitPriceCents: number;
  usualQuantity: number;
  leadTimeDays: number;
  preferred?: boolean;
  note?: string;
  simulatedPrices?: boolean;
};

export async function linkSupplier(shop: string, variantId: string, supplierId: string, terms: SupplierTerms) {
  await db.productSupplier.upsert({
    where: { shop_variantId_supplierId: { shop, variantId, supplierId } },
    create: { shop, variantId, supplierId, ...terms },
    update: terms,
  });
}

/** Deletes a shop's products and suppliers (tests now; the shop/redact privacy webhook later). */
export async function deleteDirectory(shop: string) {
  await db.productSupplier.deleteMany({ where: { shop } });
  await db.supplier.deleteMany({ where: { shop } });
  await db.managedProduct.deleteMany({ where: { shop } });
}

// ---------- Demo seed ----------

/**
 * Loads the demo catalog into a shop: every demo supplier (paid at `paypalEmail`, one sandbox
 * account) linked to its products with simulated daily prices. Products are managed except
 * `unmanagedSkus`, which shows the "not managed" rule. Variants not in `variantIdBySku` are skipped.
 */
export async function seedDemoCatalog(
  shop: string,
  variantIdBySku: Record<string, string>,
  paypalEmail: string,
  unmanagedSkus: string[] = ["DRIPPER-CERAMIC"],
) {
  for (const s of SUPPLIERS) await saveSupplier(shop, { id: s.id, name: s.name, paypalEmail });
  for (const p of PRODUCTS) {
    const variantId = variantIdBySku[p.sku];
    if (!variantId) continue;
    await setManaged(shop, { variantId, sku: p.sku, title: p.title }, !unmanagedSkus.includes(p.sku));
    const offers = OFFERS.filter((o) => o.sku === p.sku);
    for (const o of offers) {
      await linkSupplier(shop, variantId, o.supplierId, {
        unitPriceCents: o.baseUnitCostCents,
        usualQuantity: o.usualQuantity,
        leadTimeDays: 3,
        preferred: offers.length === 1 || o.supplierId !== "bean-bargains",
        note: o.note,
        simulatedPrices: true,
      });
    }
  }
}
