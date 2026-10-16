// Checks for sales history: duplicate webhooks, refunds, and the sales rate for new products.
// Uses a throwaway shop in the real database and deletes its rows at the end.
//   npx tsx scripts/check-sales.ts
export {};
process.loadEnvFile(".env");

const { default: db } = await import("../app/db.server");
const { recordSalesOnce, salesPerDay, variantKey } = await import("../app/lib/inventory/sales.server");

const SHOP = "sales-check.guardbuy.test";
const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const clean = async () => {
  await db.dailySales.deleteMany({ where: { shop: SHOP } });
  await db.processedWebhook.deleteMany({ where: { shop: SHOP } });
};
const total = async (variantId: string) =>
  (await db.dailySales.aggregate({ where: { shop: SHOP, variantId }, _sum: { units: true } }))._sum.units ?? 0;

await clean();
ok(variantKey("gid://shopify/ProductVariant/123") === "123" && variantKey(123) === "123", "GraphQL and webhook variant ids match");

// Duplicate delivery of the same order event is counted once.
const order = [{ variantId: 111, units: 3 }, { variantId: null, units: 9 }];
const a = await recordSalesOnce(SHOP, "evt-1", "orders/create", daysAgo(1), order);
const b = await recordSalesOnce(SHOP, "evt-1", "orders/create", daysAgo(1), order);
ok(a && !b && (await total("111")) === 3, `duplicate webhook skipped (total ${await total("111")}, expected 3)`);

// A refund takes units back out.
await recordSalesOnce(SHOP, "evt-2", "refunds/create", daysAgo(0), [{ variantId: 111, units: -2 }]);
ok((await total("111")) === 1, `refund subtracted (total ${await total("111")}, expected 1)`);
// Same event id on a different topic is a different event.
ok(await recordSalesOnce(SHOP, "evt-2", "orders/create", daysAgo(0), [{ variantId: 111, units: 1 }]), "same id on another topic is not a duplicate");

// Sales rate: 10 units over the last 5 days.
for (let d = 0; d < 5; d++) await recordSalesOnce(SHOP, `evt-new-${d}`, "orders/create", daysAgo(d), [{ variantId: 222, units: 2 }]);
const fresh = await salesPerDay(SHOP, "222", daysAgo(5), NOW);
const old = await salesPerDay(SHOP, "222", daysAgo(400), NOW);
ok(Math.abs(fresh - 2) < 0.1, `5-day-old product: ${fresh.toFixed(2)}/day (expected ~2, was 0.33 before)`);
ok(Math.abs(old - 10 / 30) < 0.01, `long-established product with the same sales: ${old.toFixed(2)}/day (over 30 days)`);

// History older than the product (e.g. imported or seeded orders) still counts from the first sale.
await recordSalesOnce(SHOP, "evt-old", "orders/create", daysAgo(20), [{ variantId: 333, units: 20 }]);
const seeded = await salesPerDay(SHOP, "333", daysAgo(5), NOW);
ok(Math.abs(seeded - 1) < 0.05, `sales from before the product's created date: ${seeded.toFixed(2)}/day (20 units / 20 days)`);
ok((await salesPerDay(SHOP, "999", daysAgo(3), NOW)) === 0, "no sales -> 0/day");

await clean();
await db.$disconnect();
process.exit(failed ? 1 : 0);
