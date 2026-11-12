import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { liveRevision } from "../app/lib/live/revision.server";

const url = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/guardbuy_ism141_test");
const shop = `live-${randomUUID()}.test`,
  other = `other-${randomUUID()}.test`;
const where = { shop: { in: [shop, other] } };
try {
  const initial = await liveRevision(shop);
  assert.equal(
    await liveRevision(shop),
    initial,
    "unchanged state has a stable token",
  );
  await db.restockJob.create({
    data: { id: randomUUID(), shop: other, inventoryItemId: "1" },
  });
  assert.equal(
    await liveRevision(shop),
    initial,
    "another shop cannot invalidate this shop",
  );
  const job = await db.restockJob.create({
    data: { id: randomUUID(), shop, inventoryItemId: "1" },
  });
  const stock = await liveRevision(shop);
  assert.notEqual(
    stock,
    initial,
    "inventory webhook is visible before a decision exists",
  );
  await db.restockJob.update({
    where: { id: job.id },
    data: {
      generation: { increment: 1 },
      updatedAt: new Date(Date.now() + 100),
    },
  });
  const nextStock = await liveRevision(shop);
  assert.notEqual(
    nextStock,
    stock,
    "coalesced stock changes also invalidate the snapshot",
  );
  await db.auditEntry.create({
    data: {
      shop,
      seq: 1,
      at: new Date(),
      type: "agent_state",
      event: { type: "agent_state", on: true, by: "test" },
      prevHash: "",
      hash: randomUUID(),
    },
  });
  const audit = await liveRevision(shop);
  assert.notEqual(
    audit,
    nextStock,
    "audit events invalidate approvals and payment data",
  );
  await db.processedWebhook.create({
    data: { shop, eventId: randomUUID(), topic: "orders/create" },
  });
  const sales = await liveRevision(shop);
  assert.notEqual(sales, audit, "sales updates invalidate cover calculations");
  await db.managedProduct.create({
    data: { shop, variantId: "1", title: "Coffee", managed: true },
  });
  assert.notEqual(
    await liveRevision(shop),
    sales,
    "product settings invalidate the overview",
  );
  console.log(
    "PASS live revisions: stable token, shop isolation, stock generations, audit, sales and product settings",
  );
} finally {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.deleteMany({ where });
  });
  await db.restockJob.deleteMany({ where });
  await db.processedWebhook.deleteMany({ where });
  await db.managedProduct.deleteMany({ where });
  await db.$disconnect();
}
