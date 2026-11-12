import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../../db.server";
import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { restockCooldown } from "../agent/restock-cooldown";
import { withPaymentLock } from "../agent/payment-lock.server";
import { enqueueRestockInTransaction } from "../jobs/restock-queue.server";

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
    return {
      ok: false,
      message: "Invalid cooldown. Refresh this product and try again.",
    };
  const product = await db.managedProduct.findUnique({
    where: { shop_variantId: { shop, variantId } },
  });
  if (!product?.managed)
    return {
      ok: false,
      message:
        "Enable automatic restocking for this product before resetting its cooldown.",
    };
  const response = await admin.graphql(
    `#graphql
    query CooldownInventoryItem($id: ID!) { productVariant(id: $id) { id inventoryItem { id tracked } } }
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
    return {
      ok: false,
      message:
        "Could not verify this product's tracked inventory. No cooldown was reset.",
    };
  return withPaymentLock(`restock:${shop}|${variantId}`, async (lease) => {
    const cooldown = restockCooldown(product, await auditEntries(shop));
    if (!cooldown || cooldown.rejectedSeq !== rejectedSeq)
      return {
        ok: false,
        message:
          "This cooldown changed or already ended. Refresh to see the current state.",
      };
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
      async (tx) => {
        const job = await enqueueRestockInTransaction(tx, shop, itemId);
        if (!job)
          throw new Response("This store is not active", { status: 410 });
        // Wake even a generation that was waiting for the original cooldown to expire.
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
      },
    );
    return event
      ? {
          ok: true,
          message:
            "Cooldown reset. A fresh stock check is queued; current rules and payment safeguards still apply.",
        }
      : {
          ok: false,
          message:
            "This cooldown changed or already ended. Refresh to see the current state.",
        };
  });
}
