import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[key] ?? "invalid:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/guardbuy_ism141_test");
}
Object.assign(process.env, { NODE_ENV: "test", GUARDBUY_PAYMENTS_DISABLED: "1" });
const { default: db } = await import("../app/db.server");
const { saveExpectedSales } = await import("../app/lib/merchant/expected-sales.server");
const { salesPerDay, historicalSalesPerDay, daysOfCover } = await import("../app/lib/inventory/sales.server");
const { checkStock } = await import("../app/lib/inventory/trigger.server");
const { auditEntries, verifyChain } = await import("../app/lib/audit/log.server");
const { deleteAuditEntries, disconnectOwner } = await import("./lib/audit-admin");
const shop = `sales-rate-${randomUUID()}.test`;
const item = { variantId: "123", sku: "COFFEE", createdAt: new Date("2026-01-01"), available: 32 };
let found = true;
const admin = { graphql: async (_q: string, args: { variables: { id: string } }) => {
  assert.equal(args.variables.id, "gid://shopify/ProductVariant/123");
  return Response.json({ data: { productVariant: found ? { id: args.variables.id, title: "Default Title", sku: "COFFEE", product: { title: "Coffee" }, inventoryItem: { id: "gid://shopify/InventoryItem/777", tracked: true } } : null } });
} } as unknown as AdminApiContext;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Unexpected external request"); };
try {
  await db.managedProduct.create({ data: { shop, variantId: "123", title: "Coffee", managed: true } });
  const day = new Date(); day.setUTCHours(0, 0, 0, 0);
  await db.dailySales.create({ data: { shop, variantId: "123", day, units: 90 } });
  assert.equal(await salesPerDay(shop, "123", item.createdAt), 3);
  for (const invalid of ["0", "-2", "NaN", "Infinity", "1000001", "abc"]) {
    assert.equal((await saveExpectedSales(admin, shop, "staff", "123", invalid)).ok, false);
  }
  assert.equal((await auditEntries(shop)).length, 0, "invalid estimates leave no state or audit writes");
  assert.equal((await saveExpectedSales(admin, shop, "staff", "123", "8")).ok, true);
  assert.equal(await salesPerDay(shop, "123", item.createdAt), 8);
  assert.equal(daysOfCover(32, 8), 4);
  assert.equal((await checkStock(shop, item)).daysOfCover, 4, "worker uses same merchant estimate as dashboard");
  assert.equal((await checkStock(shop, item)).needsRestock, true);
  assert.equal(await historicalSalesPerDay(shop, "123", item.createdAt), 3, "estimate does not rewrite sales history");
  assert.equal(await salesPerDay("other-shop.test", "123", item.createdAt), 0, "override is shop scoped");
  const job = await db.restockJob.findFirstOrThrow({ where: { shop } });
  assert.equal(job.generation, 1, "enabled product requests fresh stock check");
  assert.equal((await saveExpectedSales(admin, shop, "staff", "123", "2.5")).ok, true);
  assert.equal(await salesPerDay(shop, "123", item.createdAt), 2.5, "fractional demand supported");
  assert.equal((await checkStock(shop, item)).needsRestock, false);
  assert.equal((await saveExpectedSales(admin, shop, "staff", "123", "")).ok, true);
  assert.equal(await salesPerDay(shop, "123", item.createdAt), 3, "blank restores automatic estimation");
  await db.managedProduct.update({ where: { shop_variantId: { shop, variantId: "123" } }, data: { managed: false } });
  assert.equal((await saveExpectedSales(admin, shop, "staff", "123", "4")).ok, true);
  assert.equal((await db.restockJob.findUniqueOrThrow({ where: { id: job.id } })).generation, 3, "saving does not enable restocking or enqueue disabled products");
  const before = (await auditEntries(shop)).length;
  found = false;
  assert.equal((await saveExpectedSales(admin, shop, "staff", "123", "5")).ok, false);
  assert.equal((await auditEntries(shop)).length, before, "failed Shopify verification leaves prior estimate intact");
  assert.equal(await salesPerDay(shop, "123", item.createdAt), 4);
  assert.equal((await verifyChain(shop)).valid, true);
  assert.ok((await auditEntries(shop)).every(e => e.event.type === "daily_sales_estimate_changed"));
  console.log("PASS expected sales: automatic history, fractional overrides, consistent worker cover, shop isolation, validation, audited save, clear-to-automatic and enabled-only recheck. No payments or inventory writes.");
} finally {
  globalThis.fetch = originalFetch;
  await db.restockJob.deleteMany({ where: { shop } });
  await db.managedProduct.deleteMany({ where: { shop } });
  await db.dailySales.deleteMany({ where: { shop } });
  await db.paymentLock.deleteMany({ where: { shop: { contains: shop } } });
  await deleteAuditEntries({ shop });
  await db.$disconnect(); await disconnectOwner();
}
