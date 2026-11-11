import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../../db.server";
import { setManaged } from "../suppliers/directory.server";
import { enqueueRestockInTransaction } from "../jobs/restock-queue.server";
/** Enabling grants permission and durably requests a check, not an unconditional purchase. */
export async function manageProduct(
  admin: AdminApiContext,
  shop: string,
  product: { variantId: string; sku: string | null; title: string },
  enabled: boolean,
) {
  if (!/^\d+$/.test(product.variantId))
    return { ok: false, message: "Unknown product" };
  if (!enabled) {
    await setManaged(shop, product, false);
    return { ok: true, message: "Automatic restocking disabled" };
  }
  let variant: {
    id: string;
    title: string;
    sku: string | null;
    product: { title: string };
    inventoryItem: { id: string; tracked: boolean };
  } | null;
  try {
    const response = await admin.graphql(
      `#graphql
      query GuardBuyEnableRestock($id: ID!) {
        productVariant(id: $id) {
          id title sku product { title } inventoryItem { id tracked }
        }
      }`,
      {
        variables: { id: `gid://shopify/ProductVariant/${product.variantId}` },
      },
    );
    const body = (await response.json()) as {
      errors?: unknown[];
      data?: { productVariant: typeof variant };
    };
    if (body.errors?.length || !body.data)
      throw Error("Product lookup unavailable");
    variant = body.data.productVariant;
  } catch {
    return {
      ok: false,
      message:
        "Could not check this product with Shopify. Automatic restocking was not enabled; try again.",
    };
  }
  if (
    !variant ||
    variant.id !== `gid://shopify/ProductVariant/${product.variantId}`
  )
    return { ok: false, message: "Product not found in this store" };
  if (!variant.sku?.trim())
    return {
      ok: false,
      message: "Add a SKU in Shopify before enabling automatic restocking.",
    };
  const itemId = /^gid:\/\/shopify\/InventoryItem\/(\d+)$/.exec(
    variant.inventoryItem?.id ?? "",
  )?.[1];
  if (!itemId || !variant.inventoryItem.tracked)
    return {
      ok: false,
      message:
        "Turn on inventory tracking in Shopify before enabling automatic restocking.",
    };
  const data = {
    sku: variant.sku,
    title:
      variant.title === "Default Title"
        ? variant.product.title
        : `${variant.product.title} · ${variant.title}`,
    managed: true,
  };
  await db.$transaction(
    async (tx) => {
      const job = await enqueueRestockInTransaction(tx, shop, itemId);
      if (!job) throw new Response("This store is not active", { status: 410 });
      await tx.managedProduct.upsert({
        where: { shop_variantId: { shop, variantId: product.variantId } },
        create: { shop, variantId: product.variantId, ...data },
        update: data,
      });
    },
    { maxWait: 15_000, timeout: 20_000 },
  );
  return {
    ok: true,
    message: "Automatic restocking enabled. A stock check is queued.",
  };
}
