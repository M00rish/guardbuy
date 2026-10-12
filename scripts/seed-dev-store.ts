// Dev-only: seeds the demo store with the catalog products and ~30 days of backdated test orders.
// Talks to Shopify through the CLI's local GraphiQL proxy, so `shopify app dev` must be running.
//
//   GRAPHIQL_URL="http://localhost:3457/graphiql/graphql.json?key=...&api_version=2026-07" npx tsx scripts/seed-dev-store.ts
//
// Safe to re-run: products are matched by SKU, and days that already have a seeded order are skipped.

import { randomUUID } from "node:crypto";

import { PRODUCTS } from "../app/lib/suppliers/catalog";

const GRAPHIQL_URL = process.env.GRAPHIQL_URL;
if (!GRAPHIQL_URL) throw new Error("Set GRAPHIQL_URL (printed by `shopify app dev`)");

const HISTORY_DAYS = 30;
const ORDER_TAG = "guardbuy-seed";
// Stock left after seeding: coffee is low on purpose so the agent has something to do in the demo.
const DAYS_OF_STOCK: Record<string, number> = {
  "COFFEE-HOUSE-1KG": 4,
  "COFFEE-ETH-250": 12,
  "MUG-STONE": 20,
  "FILTER-100": 25,
  "DRIPPER-CERAMIC": 30,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries network blips and rate limits; idempotency keys make retried mutations safe.
async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(GRAPHIQL_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json()) as { data?: T; errors?: unknown };
      if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors ?? res.status));
      return body.data as T;
    } catch (err) {
      const transient = /Too many attempts|request to .* failed|THROTTLED/.test(String(err));
      if (!transient || attempt >= 3) throw err;
      console.log(`retry    attempt ${attempt} failed, waiting ${attempt * 20}s`);
      await sleep(attempt * 20_000);
    }
  }
}

// Deterministic Poisson-ish daily sales so re-seeding a fresh store gives the same history.
function unitsSold(mean: number, seed: number): number {
  let x = Math.sin(seed) * 10000;
  x -= Math.floor(x);
  return Math.max(0, Math.round(mean + (x - 0.5) * 2 * Math.sqrt(mean)));
}

async function main() {
  const { locations, publications } = await gql(`{
    locations(first: 1) { nodes { id } }
    publications(first: 10) { nodes { id name } }
  }`);
  const locationId: string = locations.nodes[0].id;
  const onlineStore = publications.nodes.find((p: any) => p.name === "Online Store");

  // 1. Products: find by SKU or create, publish, track inventory.
  const variants: Record<string, { variantId: string; inventoryItemId: string }> = {};
  for (const p of PRODUCTS) {
    const found = await gql(
      `query($q: String!) { productVariants(first: 1, query: $q) { nodes { id inventoryItem { id } } } }`,
      { q: `sku:${p.sku}` },
    );
    let variant = found.productVariants.nodes[0];

    if (!variant) {
      const created = await gql(
        `mutation($product: ProductCreateInput!) {
          productCreate(product: $product) {
            product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
            userErrors { message }
          }
        }`,
        { product: { title: p.title, status: "ACTIVE", tags: ["guardbuy-demo"] } },
      );
      const product = created.productCreate.product;
      if (!product) throw new Error(JSON.stringify(created.productCreate.userErrors));
      variant = product.variants.nodes[0];

      const updated = await gql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
        }`,
        {
          productId: product.id,
          variants: [
            {
              id: variant.id,
              price: (p.retailPriceCents / 100).toFixed(2),
              inventoryItem: { sku: p.sku, tracked: true },
            },
          ],
        },
      );
      if (updated.productVariantsBulkUpdate.userErrors.length) {
        throw new Error(JSON.stringify(updated.productVariantsBulkUpdate.userErrors));
      }
      if (onlineStore) {
        await gql(
          `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
          { id: product.id, input: [{ publicationId: onlineStore.id }] },
        );
      }
      console.log(`created  ${p.sku}`);
    } else {
      console.log(`exists   ${p.sku}`);
    }
    variants[p.sku] = { variantId: variant.id, inventoryItemId: variant.inventoryItem.id };
  }

  // 2. Order history: one test order per day containing that day's sales, backdated.
  //    BYPASS keeps history from touching today's stock; stock is set explicitly in step 3.
  const existing = await gql(
    `{ orders(first: 100, query: "tag:${ORDER_TAG}") { nodes { processedAt } } }`,
  );
  const seededDays = new Set<string>(existing.orders.nodes.map((o: any) => o.processedAt.slice(0, 10)));
  {
    for (let day = HISTORY_DAYS; day >= 1; day--) {
      const processedAt = new Date(Date.now() - day * 86_400_000);
      processedAt.setUTCHours(14, 0, 0, 0);
      if (seededDays.has(processedAt.toISOString().slice(0, 10))) continue;

      const lineItems = PRODUCTS.map((p, i) => ({
        variantId: variants[p.sku].variantId,
        quantity: unitsSold(p.dailySales, day * 31 + i),
      })).filter((li) => li.quantity > 0);
      if (!lineItems.length) continue;

      const res = await gql(
        `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
          orderCreate(order: $order, options: $options) @idempotent(key: "${randomUUID()}") {
            order { name }
            userErrors { message }
          }
        }`,
        {
          order: {
            lineItems,
            processedAt: processedAt.toISOString(),
            financialStatus: "PAID",
            test: true,
            tags: [ORDER_TAG],
          },
          options: { inventoryBehaviour: "BYPASS", sendReceipt: false },
        },
      );
      if (!res.orderCreate.order) throw new Error(JSON.stringify(res.orderCreate.userErrors));
      console.log(`order    ${res.orderCreate.order.name}  ${processedAt.toISOString().slice(0, 10)}  ${lineItems.length} items`);
      await sleep(13_000); // dev stores allow ~5 API-created orders per minute
    }
  }

  // 3. Stock: set each SKU to N days of cover at its average daily sales.
  //    The API requires the current quantity (compare-and-set), so read it first.
  const quantities = [];
  for (const p of PRODUCTS) {
    const { inventoryItem } = await gql(
      `query($id: ID!, $loc: ID!) { inventoryItem(id: $id) { inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { quantity } } } }`,
      { id: variants[p.sku].inventoryItemId, loc: locationId },
    );
    quantities.push({
      inventoryItemId: variants[p.sku].inventoryItemId,
      locationId,
      quantity: Math.round(p.dailySales * DAYS_OF_STOCK[p.sku]),
      changeFromQuantity: inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? 0,
    });
  }
  const stock = await gql(
    `mutation($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) @idempotent(key: "${randomUUID()}") { userErrors { message } }
    }`,
    { input: { name: "available", reason: "correction", quantities } },
  );
  if (stock.inventorySetQuantities.userErrors.length) {
    throw new Error(JSON.stringify(stock.inventorySetQuantities.userErrors));
  }
  for (const p of PRODUCTS) {
    console.log(`stock    ${p.sku.padEnd(17)} ${Math.round(p.dailySales * DAYS_OF_STOCK[p.sku])} units (~${DAYS_OF_STOCK[p.sku]} days)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
