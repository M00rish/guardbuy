import { randomUUID } from "node:crypto";
import type { RestockJob } from "@prisma/client";
import db from "../../db.server";

const HOLD_MS = 120_000;
export type ClaimedRestockJob = RestockJob & { holder: string; claimedGeneration: number };
export const restockJobKey = (job: ClaimedRestockJob) => `${job.id}:${job.claimedGeneration}`;

/** Persist before acknowledging Shopify. Repeated stock changes coalesce without losing a new generation. */
export async function enqueueRestock(shop: string, inventoryItemId: string | number) {
  const item = String(inventoryItemId);
  if (!shop || !/^\d+$/.test(item)) throw new Error("Invalid restock trigger");
  const rows = await db.$queryRaw<RestockJob[]>`
    INSERT INTO "RestockJob" ("id", "shop", "inventoryItemId", "updatedAt")
    VALUES (${randomUUID()}, ${shop}, ${item}, clock_timestamp())
    ON CONFLICT ("shop", "inventoryItemId") DO UPDATE
    SET "generation" = "RestockJob"."generation" + 1,
        "availableAt" = CASE WHEN "RestockJob"."claimedGeneration" IS NULL
          THEN LEAST("RestockJob"."availableAt", clock_timestamp()) ELSE "RestockJob"."availableAt" END,
        "updatedAt" = clock_timestamp()
    RETURNING *`;
  return rows[0];
}

export async function claimRestockJob(): Promise<ClaimedRestockJob | null> {
  const holder = randomUUID();
  const jobs = await db.$queryRaw<ClaimedRestockJob[]>`
    WITH candidate AS (
      SELECT "id" FROM "RestockJob"
      WHERE "generation" > "completedGeneration" AND "availableAt" <= clock_timestamp()
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= clock_timestamp())
      ORDER BY "availableAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "RestockJob" j SET "holder" = ${holder},
      "claimedGeneration" = COALESCE(j."claimedGeneration", j."generation"),
      "lockedUntil" = clock_timestamp() + ${HOLD_MS} * interval '1 millisecond',
      "attempts" = j."attempts" + 1, "updatedAt" = clock_timestamp()
    FROM candidate WHERE j."id" = candidate."id" RETURNING j.*`;
  return jobs[0] ?? null;
}

export async function renewRestockJob(job: ClaimedRestockJob) {
  const count = await db.$executeRaw`
    UPDATE "RestockJob" SET "lockedUntil" = clock_timestamp() + ${HOLD_MS} * interval '1 millisecond', "updatedAt" = clock_timestamp()
    WHERE "id" = ${job.id} AND "holder" = ${job.holder} AND "claimedGeneration" = ${job.claimedGeneration}
      AND "lockedUntil" > clock_timestamp()`;
  if (count !== 1) throw new Error("Restock job lease lost");
}

/** A late worker cannot complete a newer claim or acknowledge webhooks received during its run. */
export async function finishRestockJob(job: ClaimedRestockJob) {
  return (await db.$executeRaw`
    UPDATE "RestockJob" SET "completedGeneration" = ${job.claimedGeneration}, "claimedGeneration" = NULL,
      "holder" = NULL, "lockedUntil" = NULL, "attempts" = 0, "lastError" = NULL,
      "availableAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE "id" = ${job.id} AND "holder" = ${job.holder} AND "claimedGeneration" = ${job.claimedGeneration}
      AND "lockedUntil" > clock_timestamp()`) === 1;
}

export async function retryRestockJob(job: ClaimedRestockJob, delayMs = Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 8))) {
  return (await db.$executeRaw`
    UPDATE "RestockJob" SET "holder" = NULL, "lockedUntil" = NULL,
      "availableAt" = clock_timestamp() + ${delayMs} * interval '1 millisecond',
      "lastError" = 'Restock processing failed; retry scheduled', "updatedAt" = clock_timestamp()
    WHERE "id" = ${job.id} AND "holder" = ${job.holder} AND "claimedGeneration" = ${job.claimedGeneration}
      AND "lockedUntil" > clock_timestamp()`) === 1;
}
