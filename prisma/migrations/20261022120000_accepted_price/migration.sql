-- The unit price the merchant accepted for a supplier's product: the price they entered when linking
-- it. "unitPriceCents" is the supplier's current quote and can change; this one only changes when the
-- merchant edits the link. The policy engine compares quotes against it (plus approvals in the log).
ALTER TABLE "ProductSupplier" ADD COLUMN "acceptedUnitPriceCents" INTEGER;
UPDATE "ProductSupplier" SET "acceptedUnitPriceCents" = "unitPriceCents";
