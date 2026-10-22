import { unauthenticated } from "../../shopify.server";

// Demo starting stock: coffee is low (under 3 days of cover) so the agent restocks it right away;
// everything else has plenty. Only ever applied to the demo store (GUARDBUY_DEMO_STORE).
const DEMO_STOCK: Record<string, number> = {
  "COFFEE-HOUSE-1KG": 9,
  "COFFEE-ETH-250": 36,
  "MUG-STONE": 30,
  "FILTER-100": 50,
  "DRIPPER-CERAMIC": 21,
};

type Variant = { sku: string | null; inventoryItem: { id: string; inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] } } };

export async function resetDemoStock() {
  const shop = process.env.GUARDBUY_DEMO_STORE ?? "guardbuy-demo.myshopify.com";
  const { admin } = await unauthenticated.admin(shop);
  const changes: string[] = [];
  for (const [sku, quantity] of Object.entries(DEMO_STOCK)) {
    const res = await admin.graphql(
      `#graphql
      query DemoStock($q: String!) {
        productVariants(first: 1, query: $q) {
          nodes { sku inventoryItem { id inventoryLevels(first: 1) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } }
        }
      }`,
      { variables: { q: `sku:${sku}` } },
    );
    const v = ((await res.json()) as { data?: { productVariants: { nodes: Variant[] } } }).data?.productVariants.nodes[0];
    const level = v?.inventoryItem.inventoryLevels.nodes[0];
    if (!v || v.sku !== sku || !level) { changes.push(`${sku}: not found`); continue; }
    const current = level.quantities[0]?.quantity ?? 0;
    if (current === quantity) { changes.push(`${sku}: already ${quantity}`); continue; }
    const set = await admin.graphql(
      `#graphql
      mutation DemoSet($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { message } }
      }`,
      {
        variables: {
          key: `gb-reset-${sku}-${current}-${quantity}-${new Date().toISOString().slice(0, 16)}`,
          input: { name: "available", reason: "correction", quantities: [{ inventoryItemId: v.inventoryItem.id, locationId: level.location.id, quantity, changeFromQuantity: current }] },
        },
      },
    );
    const errors = ((await set.json()) as { data?: { inventorySetQuantities?: { userErrors: { message: string }[] } } }).data?.inventorySetQuantities?.userErrors ?? [];
    changes.push(errors.length ? `${sku}: ${errors[0].message}` : `${sku}: ${current} -> ${quantity}`);
  }
  return { shop, changes };
}
