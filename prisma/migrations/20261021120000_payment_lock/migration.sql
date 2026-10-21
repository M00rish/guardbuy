-- CreateTable
CREATE TABLE "PaymentLock" (
    "shop" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLock_pkey" PRIMARY KEY ("shop")
);
