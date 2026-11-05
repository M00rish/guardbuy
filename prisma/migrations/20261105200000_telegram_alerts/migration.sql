CREATE TABLE "AlertChannel" (
 "shop" TEXT PRIMARY KEY, "generation" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
 "chatId" TEXT, "tokenHash" TEXT, "expiresAt" TIMESTAMP(3), "pendingChatId" TEXT,
 "attempts" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AlertChannel_tokenHash_key" ON "AlertChannel"("tokenHash");
CREATE TABLE "AlertCursor" (
 "shop" TEXT NOT NULL REFERENCES "AlertChannel"("shop") ON DELETE CASCADE,
 "subject" TEXT NOT NULL, "state" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY ("shop", "subject")
);
CREATE TABLE "MerchantAlert" (
 "id" TEXT PRIMARY KEY, "shop" TEXT NOT NULL REFERENCES "AlertChannel"("shop") ON DELETE CASCADE,
 "generation" TEXT NOT NULL, "subject" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "kind" TEXT NOT NULL, "state" TEXT NOT NULL, "decisionSeq" INTEGER,
 "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lockedUntil" TIMESTAMP(3),
 "sentAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MerchantAlert_shop_subject_revision_key" ON "MerchantAlert"("shop","subject","revision");
CREATE INDEX "MerchantAlert_status_availableAt_idx" ON "MerchantAlert"("status","availableAt");
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['AlertChannel','AlertCursor','MerchantAlert'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guardbuy_privacy_active()', t || '_privacy_active', t);
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbuy_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "AlertChannel", "AlertCursor", "MerchantAlert" TO guardbuy_app;
 END IF;
END $$;
