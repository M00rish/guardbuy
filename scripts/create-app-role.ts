// Creates (or re-grants) the database role the deployed app connects as, "guardbuy_app":
//  - read and write on every GuardBuy table, except
//  - "AuditEntry": SELECT and INSERT only (no UPDATE, DELETE or TRUNCATE), so the running app can
//    add to the audit log but never change or remove an entry, even with a bug or a stolen connection.
// Migrations and check-script cleanups keep using the owner connection (DIRECT_URL).
//
//   npx tsx scripts/create-app-role.ts            grants only (role must exist, .env untouched)
//   npx tsx scripts/create-app-role.ts --rotate   new random password, DATABASE_URL in .env switched to it
//
// The password is never printed. After --rotate, copy DATABASE_URL from .env to Render's dashboard.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

process.loadEnvFile(".env");
const { PrismaClient } = await import("@prisma/client");

const ROLE = "guardbuy_app";
const rotate = process.argv.includes("--rotate");
const direct = process.env.DIRECT_URL;
const pooled = process.env.DATABASE_URL;
if (!direct || !pooled) throw new Error("Set DIRECT_URL (owner) and DATABASE_URL in .env");

const owner = new PrismaClient({ datasourceUrl: direct });
try {
  const [{ exists }] = await owner.$queryRawUnsafe<{ exists: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') AS exists`);
  const password = rotate ? randomBytes(24).toString("base64url") : null;
  if (!exists && !password) throw new Error(`Role ${ROLE} doesn't exist yet: run with --rotate to create it`);
  if (password) {
    // base64url has no quote characters, so it's safe inside the literal.
    await owner.$executeRawUnsafe(`${exists ? "ALTER" : "CREATE"} ROLE ${ROLE} WITH LOGIN PASSWORD '${password}'`);
  }

  const grants = [
    `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`,
    // The audit log: read and append only.
    `REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEntry" FROM ${ROLE}`,
    // Privacy fulfillment and lifting suppression require offline owner review.
    `REVOKE UPDATE, DELETE, TRUNCATE ON "PrivacyRequest", "PrivacyBlock" FROM ${ROLE}`,
    // Migrations are the owner's business.
    `REVOKE ALL ON "_prisma_migrations" FROM ${ROLE}`,
    // Tables added by future migrations (created by the owner) get the same read/write access;
    // a migration that adds an append-only table must revoke explicitly, like "AuditEntry" above.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE}`,
  ];
  for (const sql of grants) await owner.$executeRawUnsafe(sql);
  console.log(`${exists ? "Updated" : "Created"} role ${ROLE}: read/write on GuardBuy tables, read + insert only on AuditEntry.`);

  if (password) {
    const url = new URL(pooled);
    url.username = ROLE;
    url.password = password;
    const backup = `${homedir()}/.guardbuy-env.${Date.now()}.bak`;
    copyFileSync(".env", backup);
    const env = readFileSync(".env", "utf8");
    const line = /^DATABASE_URL=.*$/m;
    if (!line.test(env)) throw new Error("No DATABASE_URL line in .env");
    writeFileSync(".env", env.replace(line, `DATABASE_URL="${url.toString()}"`));
    console.log(`DATABASE_URL in .env now connects as ${ROLE} (previous .env backed up to ${backup}). Restart the app.`);
  }
} finally {
  await owner.$disconnect();
}
