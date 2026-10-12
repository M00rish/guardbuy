-- CreateTable
CREATE TABLE "SalesBackfill" (
    "shop" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesBackfill_pkey" PRIMARY KEY ("shop")
);
