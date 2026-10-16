-- Sales history is now keyed by Shopify variant id instead of SKU. Existing SKU-keyed rows can't be
-- mapped reliably, so they are cleared together with the backfill markers: the next stock webhook
-- for each shop rebuilds the last 30 days from Shopify orders.
DELETE FROM "DailySales";
DELETE FROM "SalesBackfill";

ALTER TABLE "DailySales" DROP CONSTRAINT "DailySales_pkey";
ALTER TABLE "DailySales" RENAME COLUMN "sku" TO "variantId";
ALTER TABLE "DailySales" ADD CONSTRAINT "DailySales_pkey" PRIMARY KEY ("shop", "variantId", "day");

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "eventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("eventId","topic")
);
