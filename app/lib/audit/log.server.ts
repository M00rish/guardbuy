import db from "../../db.server";
import { canonicalJson, sha256Hex } from "../policy/hash";
import { AuditEventSchema, type AuditEntry, type AuditEvent } from "../policy/schema";

export const GENESIS_HASH = "0".repeat(64);

// Prisma's default 5s limit is too tight when Neon's free tier is waking up; a timed-out write
// rolls back cleanly (nothing half-written), but the caller then has to retry.
export const TX_OPTIONS = { maxWait: 15_000, timeout: 20_000 };

export function entryHash(prevHash: string, entry: { seq: number; shop: string; at: string; event: AuditEvent }) {
  return sha256Hex(prevHash + canonicalJson(entry));
}

/** Appends one event to the shop's chain. Serialized per shop so two writers can't fork the chain. */
export async function appendAudit(shop: string, event: AuditEvent): Promise<AuditEntry> {
  return (await appendAuditWhen(shop, event))!;
}

/** Conditional append checks current history under the same database lock as the write. */
export async function appendAuditWhen(shop: string, event: AuditEvent, when?: (log: AuditEntry[]) => boolean): Promise<AuditEntry | null> {
  const parsed = AuditEventSchema.parse(event);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + shop}))`;
    if (when) {
      const rows = await tx.auditEntry.findMany({ where: { shop }, orderBy: { seq: "asc" } });
      const log = rows.map((r) => ({ seq: r.seq, shop: r.shop, at: r.at.toISOString(), event: AuditEventSchema.parse(r.event), prevHash: r.prevHash, hash: r.hash }));
      if (!when(log)) return null;
    }
    const last = await tx.auditEntry.findFirst({ where: { shop }, orderBy: { seq: "desc" } });

    const seq = last ? last.seq + 1 : 0;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const at = new Date().toISOString();
    const hash = entryHash(prevHash, { seq, shop, at, event: parsed });

    await tx.auditEntry.create({
      data: { shop, seq, at: new Date(at), type: parsed.type, event: parsed as object, prevHash, hash },
    });
    return { seq, shop, at, event: parsed, prevHash, hash };
  }, TX_OPTIONS);
}

export async function auditEntries(shop: string): Promise<AuditEntry[]> {
  const rows = await db.auditEntry.findMany({ where: { shop }, orderBy: { seq: "asc" } });
  return rows.map((r) => ({
    seq: r.seq,
    shop: r.shop,
    at: r.at.toISOString(),
    event: AuditEventSchema.parse(r.event),
    prevHash: r.prevHash,
    hash: r.hash,
  }));
}

export type ChainCheck = { valid: true; length: number } | { valid: false; brokenAtSeq: number; reason: string };

/** Recomputes every hash from the start. Any edited, deleted or reordered row is detected. */
export async function verifyChain(shop: string): Promise<ChainCheck> {
  const entries = await auditEntries(shop);
  let prev = GENESIS_HASH;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i) return { valid: false, brokenAtSeq: i, reason: `missing entry ${i}` };
    if (e.prevHash !== prev) return { valid: false, brokenAtSeq: e.seq, reason: "prevHash does not match previous entry" };
    const expected = entryHash(prev, { seq: e.seq, shop: e.shop, at: e.at, event: e.event });
    if (expected !== e.hash) return { valid: false, brokenAtSeq: e.seq, reason: "entry content was changed" };
    prev = e.hash;
  }
  return { valid: true, length: entries.length };
}
