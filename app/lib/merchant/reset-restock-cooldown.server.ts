import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { restockBlock, restockCooldown } from "../agent/restock-cooldown";
import { withPaymentLock } from "../agent/payment-lock.server";
import { enqueueRestockInTransaction } from "../jobs/restock-queue.server";

// Two audited holds stop a product from being re-proposed: the decline cooldown and the block
// after the rules stopped a purchase. Neither has a time limit; both stay until the merchant
// releases them, and a release only queues a fresh stock check. Current rules and payment
// safeguards still decide the new attempt.

const failed = (message: string) => ({ ok: false as const, message });

/** Confirms the variant still exists in Shopify and has tracked inventory. */
async function trackedItemId(
  admin: AdminApiContext,
  variantId: string,
  failure: string,
): Promise<{ itemId: string } | { ok: false; message: string }> {
  const response = await admin.graphql(
    `#graphql
    query RestockHoldInventoryItem($id: ID!) { productVariant(id: $id) { id inventoryItem { id tracked } } }
  `,
    { variables: { id: `gid://shopify/ProductVariant/${variantId}` } },
  );
  const body = (await response.json()) as {
    errors?: unknown[];
    data?: {
      productVariant: {
        id: string;
        inventoryItem: { id: string; tracked: boolean };
      } | null;
    };
  };
  const variant = body.data?.productVariant;
  const itemId = /^gid:\/\/shopify\/InventoryItem\/(\d+)$/.exec(
    variant?.inventoryItem.id ?? "",
  )?.[1];
  if (
    body.errors?.length ||
    variant?.id !== `gid://shopify/ProductVariant/${variantId}` ||
    !itemId ||
    !variant.inventoryItem.tracked
  )
    return failed(failure);
  return { itemId };
}

/** Queues a fresh stock check and wakes any generation waiting for the old hold to expire. */
async function queueFreshCheck(
  tx: Prisma.TransactionClient,
  shop: string,
  itemId: string,
) {
  const job = await enqueueRestockInTransaction(tx, shop, itemId);
  if (!job) throw new Response("This store is not active", { status: 410 });
  await tx.restockJob.update({
    where: { id: job.id },
    data: {
      availableAt: new Date(),
      claimedGeneration: null,
      holder: null,
      lockedUntil: null,
      attempts: 0,
      lastError: null,
    },
  });
}

export async function resetRestockCooldown(
  admin: AdminApiContext,
  shop: string,
  actor: string,
  variantId: string,
  rejectedSeq: number,
) {
  if (
    !/^\d+$/.test(variantId) ||
    !Number.isSafeInteger(rejectedSeq) ||
    rejectedSeq < 0
  )
    return failed("Invalid cooldown. Refresh this product and try again.");
  const product = await db.managedProduct.findUnique({
    where: { shop_variantId: { shop, variantId } },
  });
  if (!product?.managed)
    return failed(
      "Enable automatic restocking for this product before resetting its cooldown.",
    );
  const item = await trackedItemId(
    admin,
    variantId,
    "Could not verify this product's tracked inventory. No cooldown was reset.",
  );
  if (!("itemId" in item)) return item;
  return withPaymentLock(`restock:${shop}|${variantId}`, async (lease) => {
    const cooldown = restockCooldown(product, await auditEntries(shop));
    if (!cooldown || cooldown.rejectedSeq !== rejectedSeq)
      return failed(
        "This cooldown changed or already ended. Refresh to see the current state.",
      );
    const event = await appendAuditWhen(
      shop,
      {
        type: "restock_cooldown_reset",
        variantId,
        rejectedSeq,
        decisionSeq: cooldown.decisionSeq,
        by: actor,
      },
      (log) => restockCooldown(product, log)?.rejectedSeq === rejectedSeq,
      lease,
      undefined,
      (tx) => queueFreshCheck(tx, shop, item.itemId),
    );
    return event
      ? {
          ok: true,
          message:
            "Cooldown reset. A fresh stock check is queued; current rules and payment safeguards still apply.",
        }
      : failed(
          "This cooldown changed or already ended. Refresh to see the current state.",
        );
  });
}

export async function resetRestockBlock(
  admin: AdminApiContext,
  shop: string,
  actor: string,
  variantId: string,
  decisionSeq: number,
) {
  if (
    !/^\d+$/.test(variantId) ||
    !Number.isSafeInteger(decisionSeq) ||
    decisionSeq < 0
  )
    return failed("Invalid block. Refresh this product and try again.");
  const product = await db.managedProduct.findUnique({
    where: { shop_variantId: { shop, variantId } },
  });
  if (!product?.managed)
    return failed(
      "Enable automatic restocking for this product before lifting its block.",
    );
  const item = await trackedItemId(
    admin,
    variantId,
    "Could not verify this product's tracked inventory. No block was lifted.",
  );
  if (!("itemId" in item)) return item;
  return withPaymentLock(`restock:${shop}|${variantId}`, async (lease) => {
    const block = restockBlock(product, await auditEntries(shop));
    if (!block || block.decisionSeq !== decisionSeq)
      return failed(
        "This block changed or already ended. Refresh to see the current state.",
      );
    const event = await appendAuditWhen(
      shop,
      { type: "restock_block_reset", variantId, decisionSeq, by: actor },
      (log) => restockBlock(product, log)?.decisionSeq === decisionSeq,
      lease,
      undefined,
      (tx) => queueFreshCheck(tx, shop, item.itemId),
    );
    return event
      ? {
          ok: true,
          message:
            "Block lifted. A fresh stock check is queued; current rules and payment safeguards still apply.",
        }
      : failed(
          "This block changed or already ended. Refresh to see the current state.",
        );
  });
}
