CREATE TABLE "PayPalWebhookSubscription" (
 "accountKey" TEXT PRIMARY KEY, "webhookId" TEXT, "url" TEXT NOT NULL,
 "checkedAt" TIMESTAMP(3), "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "holder" TEXT, "lockedUntil" TIMESTAMP(3)
);
CREATE TABLE "PayPalWebhookReceipt" (
 "accountKey" TEXT NOT NULL, "eventId" TEXT NOT NULL,
 "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("accountKey","eventId")
);
CREATE TABLE "PayPalPayoutSignal" (
 "accountKey" TEXT NOT NULL, "batchId" TEXT NOT NULL,
 "generation" INTEGER NOT NULL DEFAULT 1, "completedGeneration" INTEGER NOT NULL DEFAULT 0,
 "claimedGeneration" INTEGER, "shop" TEXT, "holder" TEXT, "lockedUntil" TIMESTAMP(3),
 "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY ("accountKey","batchId")
);
CREATE INDEX "PayPalPayoutSignal_availableAt_lockedUntil_idx" ON "PayPalPayoutSignal"("availableAt","lockedUntil");
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='guardbuy_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON "PayPalWebhookSubscription","PayPalWebhookReceipt","PayPalPayoutSignal" TO guardbuy_app;
 END IF;
END $$;

ALTER TABLE "PayoutCheck" ADD COLUMN "lastCheckOk" BOOLEAN NOT NULL DEFAULT false;
CREATE TRIGGER "PayPalPayoutSignal_privacy_active" BEFORE INSERT OR UPDATE ON "PayPalPayoutSignal" FOR EACH ROW EXECUTE FUNCTION guardbuy_privacy_active();

ALTER TABLE "PayoutCheck" ADD COLUMN "startedAt" TIMESTAMP(3);
