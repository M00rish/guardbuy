import { readFile, appendFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { CheckpointError, parseStreams, publishCheckpoints, type AuditRow } from "./lib/checkpoints";
import { R2CheckpointStore } from "./lib/r2-checkpoints";

// Deliberately does not load .env, app/db.server, Shopify or payment modules.
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new CheckpointError(`Missing ${name}`);
  return value;
}

let phase = "configuration";

async function main() {
  const streams = parseStreams(JSON.parse(await readFile("anchors/checkpoint-streams.json", "utf8")));
  const account = required("AUDIT_R2_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/.test(account)) throw new CheckpointError("Invalid R2 account ID");
  const accessKeyId = required("AUDIT_R2_ACCESS_KEY_ID");
  const secretAccessKey = required("AUDIT_R2_SECRET_ACCESS_KEY");
  if (![accessKeyId, secretAccessKey].every((v) => /^[\x21-\x7e]+$/.test(v))) {
    throw new CheckpointError("Invalid R2 credentials: remove embedded whitespace and copy only the access key ID and secret access key");
  }
  let db: PrismaClient | undefined;
  const s3 = new S3Client({
    region: "auto", endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 3, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    const store = new R2CheckpointStore(s3, required("AUDIT_R2_BUCKET"));
    phase = "R2 retention preflight";
    await store.verifyRetention();
    console.log("R2 retention probe: overwrite and deletion rejected by bucket policy.");
    phase = "database credentials and privileges";
    db = new PrismaClient({ datasourceUrl: required("AUDIT_DATABASE_URL"), log: [] });
    const privileges = await db.$queryRaw<{ safe: boolean }[]>`
      SELECT current_user = 'guardbuy_auditor'
        AND current_setting('default_transaction_read_only') = 'on'
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
          AND NOT rolreplication AND NOT rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname = current_user)
        AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
        AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
        AND has_table_privilege(current_user, 'public."AuditEntry"', 'SELECT')
        AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public'
          AND ((tablename <> 'AuditEntry' AND has_table_privilege(current_user,
            format('%I.%I', schemaname, tablename), 'SELECT'))
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename),
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS safe`;
    if (!privileges[0]?.safe) throw new CheckpointError("Use the dedicated read-only guardbuy_auditor role");
    // One repeatable-read snapshot: concurrent appends cannot make a stream look truncated.
    phase = "database snapshot";
    const histories = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const result = new Map<string, AuditRow[]>();
      for (const stream of streams) {
        const rows = await tx.auditEntry.findMany({ where: { shop: stream.shop }, orderBy: { seq: "asc" } });
        result.set(stream.shop, rows.map((r) => ({ ...r, at: r.at.toISOString() })));
      }
      return result;
    }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
    phase = "history verification and checkpoint publication";
    const result = await publishCheckpoints(streams, async (shop) => histories.get(shop)!,
      store, process.argv.includes("--bootstrap"));
    console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), streams: result }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        "### External audit verification passed\n\n" + result.map((r) =>
          `- Stream ${r.stream.slice(0, 12)}: protected through entry ${r.protectedThrough}; ${r.published ? "checkpoint published" : "unchanged"}.\n`).join("") +
        "\nEntries added after the database snapshot remain uncheckpointed until a subsequent successful run.\n");
    }
  } finally { await db?.$disconnect(); s3.destroy(); }
}

main().catch(async (error) => {
  // SDK/Prisma error text may contain credentials or data. Never dump it into Actions logs.
  const message = error instanceof CheckpointError
    ? error.message : "Verification or publication failed; no successful external verification is claimed. Check credentials, connectivity and checkpoint integrity.";
  const status = error?.$metadata?.httpStatusCode;
  const diagnostic = Number.isInteger(status) ? ` (HTTP ${status})` : "";
  console.error(`${phase}${diagnostic}: ${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### External audit verification FAILED\n\n${message}\n`);
  process.exitCode = 1;
});
