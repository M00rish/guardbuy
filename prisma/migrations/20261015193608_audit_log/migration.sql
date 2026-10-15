-- CreateTable
CREATE TABLE "AuditEntry" (
    "shop" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "event" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("shop","seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditEntry_hash_key" ON "AuditEntry"("hash");
