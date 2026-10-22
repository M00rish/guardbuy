// Proves the audit log is append-only in the database itself (no PayPal, no AI, no money).
// Needs the migration 20261022090000_audit_append_only applied and DATABASE_URL connecting as the
// app role (scripts/create-app-role.ts --rotate). Uses a throwaway shop, deleted at the end.
//   npx tsx scripts/check-audit-readonly.ts
export {};
process.loadEnvFile(".env");

const { asAuditOwner, deleteAuditEntries, disconnectOwner } = await import("./lib/audit-admin");
const { default: db } = await import("../app/db.server");
const { appendAudit, verifyChain } = await import("../app/lib/audit/log.server");
const { PrismaClient } = await import("@prisma/client");

const SHOP = "readonly-check.guardbuy.test";
let failures = 0;
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!pass) failures++;
};
/** Runs `fn` and reports whether the database refused it. */
const refused = async (fn: () => Promise<unknown>) => {
  try { await fn(); return { refused: false, why: "it succeeded" }; }
  catch (e) { return { refused: true, why: ((e as Error).message.match(/(permission denied[^"`\n]*|append-only[^"`\n]*)/)?.[1] ?? (e as Error).message).slice(0, 90) }; }
};

await deleteAuditEntries({ shop: SHOP });
try {
  const [{ user }] = await db.$queryRawUnsafe<{ user: string }[]>("SELECT current_user AS user");
  ok("app connection uses the restricted role", user === "guardbuy_app", user);

  // The app can add entries (that's how the log grows) and read them back.
  await appendAudit(SHOP, { type: "agent_state", on: true, by: "check" });
  await appendAudit(SHOP, { type: "agent_state", on: false, by: "check" });
  ok("app can append", (await db.auditEntry.count({ where: { shop: SHOP } })) === 2);

  // ...but never change or remove them.
  let r = await refused(() => db.auditEntry.update({ where: { shop_seq: { shop: SHOP, seq: 0 } }, data: { type: "edited" } }));
  ok("app UPDATE refused", r.refused, r.why);
  r = await refused(() => db.auditEntry.deleteMany({ where: { shop: SHOP } }));
  ok("app DELETE refused", r.refused, r.why);
  r = await refused(() => db.$executeRawUnsafe(`TRUNCATE "AuditEntry"`));
  ok("app TRUNCATE refused", r.refused, r.why);
  r = await refused(() => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL guardbuy.audit_rewrite = 'on'");
    await tx.auditEntry.deleteMany({ where: { shop: SHOP } });
  }));
  ok("app DELETE refused even after switching the rewrite setting on", r.refused, r.why);

  // The owner is stopped by the trigger unless the transaction opts in.
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  r = await refused(() => owner.auditEntry.update({ where: { shop_seq: { shop: SHOP, seq: 0 } }, data: { type: "edited" } }));
  ok("owner UPDATE refused without opting in", r.refused, r.why);
  r = await refused(() => owner.auditEntry.deleteMany({ where: { shop: SHOP } }));
  ok("owner DELETE refused without opting in", r.refused, r.why);
  await owner.$disconnect();

  const chain = await verifyChain(SHOP);
  ok("chain still intact after every attempt", chain.valid && chain.length === 2);

  // Opting in works for the owner (this is how test shops are cleaned up).
  await asAuditOwner((tx) => tx.auditEntry.update({ where: { shop_seq: { shop: SHOP, seq: 1 } }, data: { event: { type: "agent_state", on: true, by: "edited" } } }));
  ok("owner can rewrite after opting in (test shops only), and the chain catches it", !(await verifyChain(SHOP)).valid);
} finally {
  await deleteAuditEntries({ shop: SHOP });
  ok("cleanup", (await db.auditEntry.count({ where: { shop: SHOP } })) === 0);
  await db.$disconnect();
  await disconnectOwner();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll audit read-only checks passed");
process.exit(failures ? 1 : 0);
