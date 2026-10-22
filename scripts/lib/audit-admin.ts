// Check scripts only: rewriting or deleting audit entries of throwaway test shops.
// The app's own connection can't do this (no UPDATE/DELETE on "AuditEntry"), and even the owner
// connection needs the transaction to opt in (migration 20261022090000_audit_append_only).
// Load .env before importing this module.
import { PrismaClient, type Prisma } from "@prisma/client";

let owner: PrismaClient | null = null;
const ownerDb = () => (owner ??= new PrismaClient({ datasourceUrl: process.env.DIRECT_URL }));

/** Runs `fn` as the database owner with audit rewrites allowed for this one transaction. */
export function asAuditOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return ownerDb().$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL guardbuy.audit_rewrite = 'on'");
    return fn(tx);
  });
}

/** Deletes a test shop's audit entries. Refuses anything that doesn't look like a test shop. */
export function deleteAuditEntries(where: Prisma.AuditEntryWhereInput & { shop: string }) {
  if (!/(^check-|^test-|#judge-|\.test$)/.test(where.shop)) throw new Error(`refusing to delete the audit log of ${where.shop}`);
  return asAuditOwner((tx) => tx.auditEntry.deleteMany({ where }));
}

export const disconnectOwner = () => owner?.$disconnect();
