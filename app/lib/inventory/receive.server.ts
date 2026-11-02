import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { appendAuditWhen, auditEntries } from "../audit/log.server";
import { withPaymentLock } from "../agent/payment-lock.server";
import { canAppendReceipt, createReceiveDelivery, DeliveryRefused } from "./deliveries";

export const RECEIPT_LOCATIONS = `#graphql
  query ReceiptLocations($id: ID!) {
    productVariant(id: $id) {
      inventoryItem { id tracked inventoryLevels(first: 50) { nodes { location { id name } } } }
    }
  }
`;
export const RECEIVE_STOCK = `#graphql
  mutation ReceiveSupplierDelivery($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      userErrors { code message }
      inventoryAdjustmentGroup { referenceDocumentUri }
    }
  }
`;

async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Shopify timeout")), 15_000); })]);
  } finally { clearTimeout(timer); }
}

export async function receiptLocations(admin: AdminApiContext, variantId: string) {
  const response = await bounded(() => admin.graphql(RECEIPT_LOCATIONS, { variables: { id: `gid://shopify/ProductVariant/${variantId}` } }));
  const body = await response.json() as { errors?: unknown[]; data?: { productVariant: { inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: { location: { id: string; name: string } }[] } } } | null } };
  const item = body.data?.productVariant?.inventoryItem;
  if (body.errors?.length || !item?.tracked) throw new DeliveryRefused("Tracked inventory could not be loaded for this product");
  return { inventoryItemId: item.id, locations: item.inventoryLevels.nodes.map((l) => l.location) };
}

export function receiver(admin: AdminApiContext) {
  return createReceiveDelivery({
    read: auditEntries, lock: withPaymentLock,
    append: async (shop, event) => {
      const result = await appendAuditWhen(shop, event, (log) => canAppendReceipt(log, event));
      if (!result && event.type === "receipt_started") throw new DeliveryRefused("Another receipt changed this purchase. Reload before continuing.");
      return result;
    },
    resolveItem: async (variantId, locationId) => {
      const item = await receiptLocations(admin, variantId);
      if (!item.locations.some((l) => l.id === locationId)) throw new DeliveryRefused("Choose a location already stocking this product");
      return item.inventoryItemId;
    },
    adjust: async (event) => {
      try {
        const referenceDocumentUri = `guardbuy://deliveries/${event.receiptId}`;
        const response = await bounded(() => admin.graphql(RECEIVE_STOCK, { variables: {
          key: event.receiptId,
          input: { name: "available", reason: "received", referenceDocumentUri, changes: [{ inventoryItemId: event.inventoryItemId, locationId: event.locationId, delta: event.quantity, changeFromQuantity: null }] },
        } }));
        const body = await response.json() as { errors?: unknown[]; data?: { inventoryAdjustQuantities: { userErrors: { code: string; message: string }[]; inventoryAdjustmentGroup: { referenceDocumentUri: string } | null } } };
        const result = body.data?.inventoryAdjustQuantities;
        if (body.errors?.length || !result) throw new Error("Unconfirmed inventory response");
        if (result.inventoryAdjustmentGroup?.referenceDocumentUri === referenceDocumentUri && !result.userErrors.length) return "received";
        if (result.userErrors.length && !result.inventoryAdjustmentGroup) return "rejected";
        throw new Error("Unconfirmed adjustment");
      } catch {
        throw new DeliveryRefused("Stock update is not confirmed. Retry this same receipt; do not add inventory manually until its outcome is checked.");
      }
    },
  });
}
