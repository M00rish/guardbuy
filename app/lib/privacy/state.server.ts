import type { Prisma } from "@prisma/client";
import db from "../../db.server";
import { sha256Hex } from "../policy/hash";

export const privacyShopHash = (shop: string) => sha256Hex(shop);
export async function privacyBlocked(shop: string) {
  return !!await db.privacyBlock.findUnique({ where: { shopHash: privacyShopHash(shop) } });
}
export async function assertPrivacyActive(shop: string) {
  if (await privacyBlocked(shop)) throw new Response("This store has a pending or completed privacy deletion request. Contact GuardBuy support before reconnecting.", { status: 410 });
}
// All persistent sales/job writes share this lock with shop suppression and owner erasure.
export async function privacyWriteAllowed(tx: Prisma.TransactionClient, shop: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"privacy:" + shop}))`;
  return !await tx.privacyBlock.findUnique({ where: { shopHash: privacyShopHash(shop) } });
}
