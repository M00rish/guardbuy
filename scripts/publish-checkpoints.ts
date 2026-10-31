import { readFile, appendFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { S3Client } from "@aws-sdk/client-s3";
import { parseStreams, publishCheckpoints, type AuditRow } from "./lib/checkpoints";
import { R2CheckpointStore } from "./lib/r2-checkpoints";

// Deliberately does not load .env, app/db.server, Shopify or payment modules.
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

let phase = "configuration";

async function main() {
  const streams = parseStreams(JSON.parse(await readFile("anchors/checkpoint-streams.json", "utf8")));
  const account = required("AUDIT_R2_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid R2 account ID");
  let db: PrismaClient | undefined;
  const s3 = new S3Client({
    region: "auto", endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: required("AUDIT_R2_ACCESS_KEY_ID"), secretAccessKey: required("AUDIT_R2_SECRET_ACCESS_KEY") },
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
        AND has_table_privilege(current_user, '"AuditEntry"', 'SELECT')
        AND NOT has_table_privilege(current_user, '"AuditEntry"', 'INSERT')
        AND NOT has_table_privilege(current_user, '"AuditEntry"', 'UPDATE')
        AND NOT has_table_privilege(current_user, '"AuditEntry"', 'DELETE')
        AND NOT has_table_privilege(current_user, '"AuditEntry"', 'TRUNCATE') AS safe`;
    if (!privileges[0]?.safe) throw new Error("Use the dedicated read-only guardbuy_auditor role");
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
  const message = error instanceof Error && /^(Missing |Invalid |Configure |Use the dedicated|Conflicting checkpoint|[a-f0-9]{12}:)/.test(error.message)
    ? error.message : "Verification or publication failed; no successful external verification is claimed. Check credentials, connectivity and checkpoint integrity.";
  const status = error?.$metadata?.httpStatusCode;
  const diagnostic = Number.isInteger(status) ? ` (HTTP ${status})` : "";
  console.error(`${phase}${diagnostic}: ${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### External audit verification FAILED\n\n${message}\n`);
  process.exitCode = 1;
});
