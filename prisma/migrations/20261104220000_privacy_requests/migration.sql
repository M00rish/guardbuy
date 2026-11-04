CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL, "eventId" TEXT NOT NULL, "shop" TEXT, "shopHash" TEXT NOT NULL,
  "topic" TEXT NOT NULL, "requestId" TEXT, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dueAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
  "completedAt" TIMESTAMP(3), "referenceHash" TEXT,
  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrivacyRequest_shopHash_topic_eventId_key" ON "PrivacyRequest"("shopHash", "topic", "eventId");
CREATE INDEX "PrivacyRequest_status_dueAt_idx" ON "PrivacyRequest"("status", "dueAt");
CREATE TABLE "PrivacyBlock" (
  "shopHash" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purgedAt" TIMESTAMP(3), CONSTRAINT "PrivacyBlock_pkey" PRIMARY KEY ("shopHash")
);
-- The app may receive requests and suppress processing; only the offline owner can fulfill or lift blocks.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbuy_app') THEN
    GRANT SELECT, INSERT ON "PrivacyRequest", "PrivacyBlock" TO guardbuy_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "PrivacyRequest", "PrivacyBlock" FROM guardbuy_app;
  END IF;
END $$;

-- A late authenticated request/webhook cannot recreate mutable shop data after suppression.
-- The same per-shop lock serializes inserts/updates with suppression and owner erasure.
CREATE FUNCTION guardbuy_privacy_active() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('privacy:' || NEW.shop));
  IF EXISTS (SELECT 1 FROM "PrivacyBlock" WHERE "shopHash" = encode(sha256(convert_to(NEW.shop, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'Shop processing is suppressed for privacy' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['Session','DailySales','ProcessedWebhook','SalesBackfill','ManagedProduct','Supplier','ProductSupplier','ShopSettings','RestockJob'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guardbuy_privacy_active()', t || '_privacy_active', t);
  END LOOP;
END $$;

-- Existing payment evidence can still append during reconciliation; erased chains cannot restart.
CREATE FUNCTION guardbuy_privacy_audit() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit:' || NEW.shop));
  IF EXISTS (SELECT 1 FROM "PrivacyBlock" WHERE "shopHash" = encode(sha256(convert_to(NEW.shop, 'UTF8')), 'hex') AND "purgedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'Erased audit stream cannot be recreated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditEntry_privacy" BEFORE INSERT ON "AuditEntry" FOR EACH ROW EXECUTE FUNCTION guardbuy_privacy_audit();
