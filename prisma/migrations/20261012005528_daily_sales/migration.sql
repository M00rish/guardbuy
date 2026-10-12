-- CreateTable
CREATE TABLE "DailySales" (
    "shop" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "units" INTEGER NOT NULL,

    CONSTRAINT "DailySales_pkey" PRIMARY KEY ("shop","sku","day")
);
