ALTER TABLE "ManagedProduct" ADD COLUMN "dailySalesOverride" DOUBLE PRECISION;
ALTER TABLE "ManagedProduct" ADD CONSTRAINT "ManagedProduct_dailySalesOverride_positive"
  CHECK ("dailySalesOverride" IS NULL OR ("dailySalesOverride" > 0 AND "dailySalesOverride" <= 1000000));
