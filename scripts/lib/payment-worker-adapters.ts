// Test bundle adapters only. No production code imports this file, and all I/O is loopback.
import type { ProposerInput } from "../../app/lib/agent/proposer.server";

function base() {
  const url = new URL(process.env.PAYPAL_API_BASE!);
  if (url.hostname !== "127.0.0.1") throw new Error("Worker fixture requires local fake provider");
  return url.origin;
}
export async function runPayPalTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (name !== "get_order") throw new Error("Unexpected toolkit call in test");
  return (await fetch(`${base()}/v2/checkout/orders/${encodeURIComponent(String(args.id))}`)).json();
}
export async function proposePurchase(input: ProposerInput) {
  return (await fetch(`${base()}/test/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json();
}
export const unauthenticated = {
  admin: async (shop: string) => ({ admin: {
    graphql: async (query: string) => {
      if (!query.includes("inventoryItem")) throw new Error("Unexpected Shopify query in worker test");
      const stock = await (await fetch(`${base()}/test/stock?shop=${encodeURIComponent(shop)}`)).json() as { available: number };
      return Response.json({ data: { inventoryItem: { tracked: true, variant: { id: "gid://shopify/ProductVariant/123", sku: "coffee", createdAt: new Date(Date.now() - 40 * 86400_000).toISOString() }, inventoryLevels: { nodes: [{ quantities: [{ quantity: stock.available }] }] } } } });
    },
  } }),
};
