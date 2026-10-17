-- Merchant-chosen products and suppliers (replaces the hard-coded catalog, which becomes demo seed data).

-- CreateTable
CREATE TABLE "ManagedProduct" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "managed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedProduct_pkey" PRIMARY KEY ("shop","variantId")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "shop" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "paypalEmail" TEXT NOT NULL,
    "emailChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("shop","id")
);

-- CreateTable
CREATE TABLE "ProductSupplier" (
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "usualQuantity" INTEGER NOT NULL,
    "leadTimeDays" INTEGER NOT NULL,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "simulatedPrices" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductSupplier_pkey" PRIMARY KEY ("shop","variantId","supplierId")
);

-- AddForeignKey
ALTER TABLE "ProductSupplier" ADD CONSTRAINT "ProductSupplier_shop_supplierId_fkey" FOREIGN KEY ("shop", "supplierId") REFERENCES "Supplier"("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE;
