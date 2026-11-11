CREATE TABLE "PayoutCheck" (
  "shop" TEXT NOT NULL,
  "payoutSeq" INTEGER NOT NULL,
  "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "checkedAt" TIMESTAMP(3),
  "unchanged" INTEGER NOT NULL DEFAULT 0,
  "holder" TEXT,
  "lockedUntil" TIMESTAMP(3),
  CONSTRAINT "PayoutCheck_pkey" PRIMARY KEY ("shop", "payoutSeq")
);
CREATE TRIGGER "PayoutCheck_privacy_active" BEFORE INSERT OR UPDATE ON "PayoutCheck"
FOR EACH ROW EXECUTE FUNCTION guardbuy_privacy_active();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbuy_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PayoutCheck" TO guardbuy_app;
  END IF;
END $$;
