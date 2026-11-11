import { appendAuditWhen } from "../audit/log.server";
import type { AuditEvent } from "../policy/schema";
import { randomUUID } from "node:crypto";
import db from "../../db.server";
import { privacyWriteAllowed } from "../privacy/state.server";
import type { PayoutSchedule } from "./payout-refresh";
export function createPayoutSchedule(): PayoutSchedule & {
  append: (shop: string, event: AuditEvent) => Promise<unknown>;
} {
  const holder = randomUUID();
  const client = db;
  return {
    append: async (shop, event) => {
      if (event.type !== "payout_status")
        throw Error("Only payout status evidence is accepted");
      return appendAuditWhen(shop, event, undefined, undefined, {
        payoutSeq: event.payoutSeq,
        holder,
      });
    },
    load: async (shop) =>
      (await client.payoutCheck.findMany({ where: { shop } })).map((r) => ({
        payoutSeq: r.payoutSeq,
        nextAt: Math.max(
          r.nextCheckAt.getTime(),
          r.lockedUntil?.getTime() ?? 0,
        ),
        checkedAt: r.checkedAt?.getTime() ?? null,
        unchanged: r.unchanged,
      })),
    claim: async (shop, payoutSeq, now) =>
      client.$transaction(async (tx) => {
        if (!(await privacyWriteAllowed(tx, shop))) return false;
        await tx.payoutCheck.createMany({
          data: [{ shop, payoutSeq, nextCheckAt: new Date(now) }],
          skipDuplicates: true,
        });
        const r = await tx.payoutCheck.updateMany({
          where: {
            shop,
            payoutSeq,
            nextCheckAt: { lte: new Date(now) },
            OR: [
              { lockedUntil: null },
              { lockedUntil: { lte: new Date(now) } },
            ],
          },
          data: {
            holder,
            startedAt: new Date(now),
            lockedUntil: new Date(now + 180_000),
          },
        });
        return r.count === 1;
      }),
    save: async (shop, c) => {
      const r = await client.payoutCheck.updateMany({
        where: { shop, payoutSeq: c.payoutSeq, holder },
        data: {
          lastCheckOk: c.ok ?? false,
          checkedAt: c.checkedAt === null ? null : new Date(c.checkedAt),
          nextCheckAt: new Date(c.nextAt),
          unchanged: c.unchanged,
          holder: null,
          lockedUntil: null,
        },
      });
      if (r.count !== 1) throw Error("Payout check lease expired");
    },
  };
}
export const payoutSchedule = createPayoutSchedule();
