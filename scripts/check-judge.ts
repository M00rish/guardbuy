// Checks for the judge console's server side (the storefront page itself needs a browser).
// Runs a real restock (Gemini), the dishonest-supplier attempt and an approval (sandbox payout)
// in a throwaway judge session, then deletes it.
//   npx tsx scripts/check-judge.ts
export {};
process.loadEnvFile(".env");

const { default: db } = await import("../app/db.server");
const { judgeApprove, judgeAttack, judgeRestock, judgeShop, judgeState } = await import("../app/lib/judge/console.server");
const { deleteDirectory } = await import("../app/lib/suppliers/directory.server");

const SHOP = "guardbuy-demo.myshopify.com";
const ID = "check-judge-0001";
const sandbox = judgeShop(SHOP, ID);
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const cleanup = async () => { await db.auditEntry.deleteMany({ where: { shop: sandbox } }); await deleteDirectory(sandbox); };
const realLogBefore = await db.auditEntry.count({ where: { shop: SHOP } });

await cleanup();
ok(await judgeState(SHOP, "BAD ID!").then(() => false, () => true), "malformed session id refused");

let state = await judgeState(SHOP, ID);
ok(state.feed.length === 1 && state.feed[0].kind === "rules" && state.chain.valid, `new sandbox: rules signed (${state.feed[0]?.detail})`);

console.log("      restock:", await judgeRestock(SHOP, ID));
const until = Date.now() + 150_000;
while (Date.now() < until && !(state = await judgeState(SHOP, ID)).feed.some((f) => ["auto", "approval", "block", "failed"].includes(f.kind))) {
  await new Promise((r) => setTimeout(r, 3000));
}
for (const f of [...state.feed].reverse()) console.log(`      [${f.kind}] ${f.title}${f.detail ? ` | ${f.detail}` : ""}`);
ok(state.feed.some((f) => f.kind === "stock") && state.feed.some((f) => f.kind === "approval"), "feed: stock fell -> AI proposed -> needs approval");
ok(state.approvals.length === 1, `approval card: ${state.approvals[0]?.title} ${state.approvals[0]?.total}`);
ok(!JSON.stringify(state).includes(process.env.SUPPLIER_EMAIL!), "no PayPal email in what the storefront receives");

console.log("      attack: ", await judgeAttack(SHOP, ID));
state = await judgeState(SHOP, ID);
const blocked = state.feed.find((f) => f.kind === "block");
ok(!!blocked, `dishonest supplier blocked: ${blocked?.detail}`);

console.log("      approve:", await judgeApprove(SHOP, ID, state.approvals[0].decisionSeq));
state = await judgeState(SHOP, ID);
ok(state.feed[0].kind === "paid" && state.approvals.length === 0, `paid: ${state.feed[0].detail}`);
ok(state.chain.valid, `chain intact (${"entries" in state.chain ? state.chain.entries : 0} entries)`);
ok((await db.auditEntry.count({ where: { shop: SHOP } })) === realLogBefore, "the merchant's real log was not touched");

await cleanup();
await db.$disconnect();
process.exit(failed ? 1 : 0);
