// Isolated Postgres and explicit Shopify reads; no provider/model/payment/inventory writes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const u = new URL(process.env[key] ?? "invalid:");
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.pathname, "/guardbuy_ism141_test");
}
Object.assign(process.env, {
  NODE_ENV: "test",
  GUARDBUY_PAYMENTS_DISABLED: "1",
});
const { default: db } = await import("../app/db.server");
const { manageProduct } =
  await import("../app/lib/merchant/manage-product.server");
const { defaultRuleSet, signRuleSet, runRestock } =
  await import("../app/lib/agent/restock.server");
const { auditEntries } = await import("../app/lib/audit/log.server");
const { productStatus } = await import("../app/lib/merchant/dashboard.server");
const { coverLabel } = await import("../app/lib/inventory/cover-label");
const { privacyShopHash } = await import("../app/lib/privacy/state.server");
const { stockForInventoryItem } =
  await import("../app/lib/inventory/trigger.server");
const shop = `enable-restock-${randomUUID()}.test`;
let calls = 0;
let variant: {
  id: string;
  title: string;
  sku: string | null;
  product: { title: string };
  inventoryItem: { id: string; tracked: boolean };
} | null = {
  id: "gid://shopify/ProductVariant/123",
  title: "Default Title",
  sku: "REAL-SKU",
  product: { title: "Real product title" },
  inventoryItem: { id: "gid://shopify/InventoryItem/777", tracked: true },
};
let fail = false;
const admin = {
  graphql: async (query: string, args: { variables: { id: string } }) => {
    calls++;
    assert.ok(query.includes("GuardBuyEnableRestock"));
    assert.equal(args.variables.id, "gid://shopify/ProductVariant/123");
    if (fail) throw Error("Offline Shopify outage");
    return Response.json({ data: { productVariant: variant } });
  },
} as unknown as AdminApiContext;
const product = { variantId: "123", sku: "CLIENT-SKU", title: "Client title" };
const originalFetch = globalThis.fetch;
let outsideCalls = 0;
globalThis.fetch = async () => {
  outsideCalls++;
  throw Error("Unexpected external request");
};
try {
  const enabled = await manageProduct(admin, shop, product, true);
  assert.equal(enabled.ok, true);
  assert.match(enabled.message, /queued/);
  const record = await db.managedProduct.findUniqueOrThrow({
    where: { shop_variantId: { shop, variantId: "123" } },
  });
  assert.equal(record.sku, "REAL-SKU");
  assert.equal(record.title, "Real product title");
  assert.equal(record.managed, true);
  let job = await db.restockJob.findUniqueOrThrow({
    where: { shop_inventoryItemId: { shop, inventoryItemId: "777" } },
  });
  assert.equal(job.completedGeneration, 0);
  assert.equal(job.generation, 1);
  assert.ok(job.availableAt <= new Date());
  await manageProduct(admin, shop, product, true);
  job = await db.restockJob.findUniqueOrThrow({
    where: { shop_inventoryItemId: { shop, inventoryItemId: "777" } },
  });
  assert.equal(job.generation, 2);
  assert.equal(
    await db.restockJob.count({ where: { shop } }),
    1,
    "repeat enables coalesce",
  );
  const before = calls;
  await manageProduct(admin, shop, product, false);
  assert.equal(calls, before, "disable requires no provider call");
  assert.equal(
    (
      await db.managedProduct.findUniqueOrThrow({
        where: { shop_variantId: { shop, variantId: "123" } },
      })
    ).managed,
    false,
  );
  fail = true;
  assert.equal((await manageProduct(admin, shop, product, true)).ok, false);
  fail = false;
  assert.equal(
    (
      await db.managedProduct.findUniqueOrThrow({
        where: { shop_variantId: { shop, variantId: "123" } },
      })
    ).managed,
    false,
  );
  const original = variant!;
  variant = null;
  assert.equal((await manageProduct(admin, shop, product, true)).ok, false);
  variant = {
    ...original,
    inventoryItem: { ...original.inventoryItem, tracked: false },
  };
  assert.equal((await manageProduct(admin, shop, product, true)).ok, false);
  variant = { ...original, sku: null };
  assert.equal((await manageProduct(admin, shop, product, true)).ok, false);
  variant = original;
  assert.equal(
    (
      await db.restockJob.findUniqueOrThrow({
        where: { shop_inventoryItemId: { shop, inventoryItemId: "777" } },
      })
    ).generation,
    2,
    "failed lookups do not enqueue",
  );
  await manageProduct(admin, shop, product, true);
  await db.supplier.create({
    data: {
      shop,
      id: "atlas-roasters",
      name: "Offline supplier",
      paypalEmail: "supplier@example.test",
    },
  });
  await db.productSupplier.create({
    data: {
      shop,
      variantId: "123",
      supplierId: "atlas-roasters",
      unitPriceCents: 100,
      usualQuantity: 4,
      leadTimeDays: 2,
      preferred: true,
    },
  });
  const rules = defaultRuleSet(shop);
  await signRuleSet(shop, rules, "shopify-staff:fixture");
  for (const available of [0, 30]) {
    const result = await runRestock(shop, {
      variantId: "123",
      sku: "REAL-SKU",
      available,
      perDay: 0,
      daysOfCover: Infinity,
      needsRestock: false,
    });
    assert.equal(result.outcome, "skipped");
    assert.ok("reason" in result && result.reason.includes("sales rate"));
  }
  for (const perDay of [NaN, Infinity]) {
    const result = await runRestock(shop, {
      variantId: "123",
      sku: "REAL-SKU",
      available: 10,
      perDay,
      daysOfCover: 0,
      needsRestock: true,
    });
    assert.equal(result.outcome, "skipped");
  }
  const log = await auditEntries(shop);
  assert.ok(
    !log.some((e) =>
      ["proposal", "decision", "payout", "order_created"].includes(
        e.event.type,
      ),
    ),
    "no demand never starts a proposal or payment",
  );
  assert.equal(outsideCalls, 0);
  const status = productStatus(
    log,
    { variantId: "123", sku: "REAL-SKU", managed: true, cover: Infinity },
    rules,
    true,
  );
  assert.match(status.label, /No recent sales/);
  assert.notEqual(status.label, "Stock sufficient");
  assert.equal(coverLabel(null, 0), "No recent sales");
  assert.equal(coverLabel(null, undefined), "Unavailable");
  assert.equal(coverLabel(0, 2), "0");
  const untracked = {
    graphql: async () =>
      Response.json({
        data: {
          inventoryItem: {
            tracked: false,
            variant: {
              id: "gid://shopify/ProductVariant/123",
              sku: "REAL-SKU",
              createdAt: new Date().toISOString(),
            },
            inventoryLevels: { nodes: [] },
          },
        },
      }),
  } as unknown as AdminApiContext;
  assert.equal(await stockForInventoryItem(untracked, "777"), null);
  await db.privacyBlock.create({ data: { shopHash: privacyShopHash(shop) } });
  await db.restockJob.deleteMany({ where: { shop } });
  await assert.rejects(() => manageProduct(admin, shop, product, true));
  assert.equal(
    await db.restockJob.count({ where: { shop } }),
    0,
    "suppressed store cannot queue a check",
  );
  console.log(
    "PASS restock enable: durable immediate check, trusted variant/item binding, coalescing, disable, failed/missing/untracked/no-SKU reads, no-demand refusal before LLM/payment, accurate cover status and privacy suppression. No external calls.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.deleteMany({ where: { shop } });
  });
  await db.restockJob.deleteMany({ where: { shop } });
  await db.productSupplier.deleteMany({ where: { shop } });
  await db.supplier.deleteMany({ where: { shop } });
  await db.managedProduct.deleteMany({ where: { shop } });
  await db.privacyBlock.deleteMany({
    where: { shopHash: privacyShopHash(shop) },
  });
  await db.paymentLock.deleteMany({
    where: { OR: [{ shop }, { shop: { startsWith: `restock:${shop}|` } }] },
  });
  await db.$disconnect();
}
