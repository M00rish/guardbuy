CREATE TABLE "RestockJob" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "completedGeneration" INTEGER NOT NULL DEFAULT 0,
  "claimedGeneration" INTEGER,
  "holder" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RestockJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RestockJob_generations" CHECK ("completedGeneration" <= "generation" AND ("claimedGeneration" IS NULL OR "claimedGeneration" <= "generation"))
);
CREATE UNIQUE INDEX "RestockJob_shop_inventoryItemId_key" ON "RestockJob"("shop", "inventoryItemId");
CREATE INDEX "RestockJob_availableAt_lockedUntil_idx" ON "RestockJob"("availableAt", "lockedUntil");

-- The app may update job state, while audit history keeps its existing append-only privileges.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbuy_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "RestockJob" TO guardbuy_app;
  END IF;
END $$;
