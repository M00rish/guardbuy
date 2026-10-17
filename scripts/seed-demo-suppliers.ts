// Dev-only: loads the demo products & suppliers into a store's GuardBuy directory (what a merchant
// would set up in onboarding). Looks up variant ids by SKU through the CLI's GraphiQL proxy, so
// `shopify app dev` must be running. Safe to re-run.
//
//   GRAPHIQL_URL="http://localhost:3457/graphiql/graphql.json?key=...&api_version=2026-10" \
//   SHOP=guardbuy-demo.myshopify.com npx tsx scripts/seed-demo-suppliers.ts
export {};
process.loadEnvFile(".env");

const { GRAPHIQL_URL, SHOP, SUPPLIER_EMAIL } = process.env;
if (!GRAPHIQL_URL || !SHOP || !SUPPLIER_EMAIL) throw new Error("Set GRAPHIQL_URL, SHOP (and SUPPLIER_EMAIL in .env)");

const { default: db } = await import("../app/db.server");
const { PRODUCTS } = await import("../app/lib/suppliers/catalog");
const { offersForVariant, seedDemoCatalog } = await import("../app/lib/suppliers/directory.server");

const variantIdBySku: Record<string, string> = {};
for (const p of PRODUCTS) {
  const res = await fetch(GRAPHIQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($q: String!) { productVariants(first: 2, query: $q) { nodes { legacyResourceId sku } } }",
      variables: { q: `sku:${p.sku}` },
    }),
  });
  const body = (await res.json()) as { data?: { productVariants: { nodes: { legacyResourceId: string; sku: string }[] } } };
  const matches = body.data?.productVariants.nodes.filter((n) => n.sku === p.sku) ?? [];
  if (matches.length !== 1) { console.log(`skip ${p.sku}: ${matches.length} variants with this SKU`); continue; }
  variantIdBySku[p.sku] = matches[0].legacyResourceId;
}

await seedDemoCatalog(SHOP, variantIdBySku, SUPPLIER_EMAIL);
for (const [sku, variantId] of Object.entries(variantIdBySku)) {
  const managed = (await db.managedProduct.findUnique({ where: { shop_variantId: { shop: SHOP, variantId } } }))?.managed;
  const offers = await offersForVariant(SHOP, variantId);
  console.log(`${sku.padEnd(18)} variant ${variantId}  ${managed ? "managed  " : "NOT managed"}  ${offers.map((o) => `${o.supplierId} $${(o.unitPriceTodayCents / 100).toFixed(2)}${o.preferred ? " (preferred)" : ""}`).join(", ")}`);
}
await db.$disconnect();
