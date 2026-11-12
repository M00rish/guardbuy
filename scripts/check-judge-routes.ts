// Actual routes/API/sandbox scoping with explicit offline database, auth and payment adapters.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(resolve(root, "node_modules/.judge-route-test-"));
const shop = "judge-test.myshopify.com",
  alice = "alice-12345678",
  bob = "bob-12345678";
const fixture = {
  reads: [] as string[],
  calls: [] as { intent: string; shop: string; seq?: number; actor?: string }[],
  cards: new Map<string, unknown[]>(),
  owners: new Map<number, string>(),
};
Object.assign(globalThis, { __judgeRouteFixture: fixture });
const keys = [
  "GUARDBUY_PUBLIC_DEMO_ENABLED",
  "GUARDBUY_DEMO_STORE",
  "PAYPAL_API_BASE",
] as const;
const saved = keys.map((k) => process.env[k]);
const originalFetch = globalThis.fetch;
try {
  Object.assign(process.env, {
    GUARDBUY_PUBLIC_DEMO_ENABLED: "true",
    GUARDBUY_DEMO_STORE: shop,
    PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  });
  globalThis.fetch = async () => {
    throw Error("Unexpected external request in offline judge test");
  };
  const adapters: Record<string, string> = {
    auth: `export const authenticate={public:{appProxy:async(request)=>{if(request.headers.get('x-proxy-auth')!=='verified')throw new Response('Unauthorized',{status:401});return{session:{shop:request.headers.get('x-shop')||'${shop}'},admin:{graphql:async()=>Response.json({data:{ordersCount:{count:0,precision:'EXACT'}}})},liquid:(html)=>new Response(html)}}}};`,
    db: `export default {auditEntry:{count:async()=>0},managedProduct:{findMany:async()=>[]},supplier:{updateMany:async()=>{throw Error('Unexpected seed')}}};`,
    privacy: `export async function assertPrivacyActive(){} export async function privacyBlocked(){return false}`,
    log: `export async function auditEntries(shop){globalThis.__judgeRouteFixture.reads.push(shop);return []}export async function verifyChain(){return{valid:true,length:0}}export async function appendAudit(){throw Error('Unexpected append')}`,
    approvals: `import {ExecutionRefused} from '${root}/app/lib/agent/execute.server.ts';export async function approvalQueue(shop){return globalThis.__judgeRouteFixture.cards.get(shop)||[]}async function act(intent,shop,seq,actor){if(globalThis.__judgeRouteFixture.owners.get(seq)!==shop)throw new ExecutionRefused('Unknown purchase');globalThis.__judgeRouteFixture.calls.push({intent,shop,seq,actor});return{message:'Offline '+intent}}export const approvePurchase=(...a)=>act('approve',...a);export const rejectPurchase=(...a)=>act('decline',...a);`,
    execute: `export class ExecutionRefused extends Error {}`,
    attack: `export const WHAT_IF_SCENARIO='what-if';export async function runInjectionTest(shop){globalThis.__judgeRouteFixture.calls.push({intent:'attack',shop})}`,
    feed: `export const toFeed=()=>[];export const usd=(c)=>'$'+(c/100).toFixed(2);`,
    score: `export async function scoreboard(){return{attacks:{tried:0,failed:0,blocked:0,flagged:0,slipped:0,blockedCents:0,flaggedCents:0,slippedCents:0,byLevel:{easy:{},medium:{},hard:{}},simulated:0,knownGaps:[]},stoppedBy:{}}}`,
    restock: `export function defaultRuleSet(shop){return{version:1,shop,currency:'USD',reorderBelowDaysOfCover:7,targetDaysOfCover:14,priceToleranceCents:50,approvalAboveCents:50000,weeklySpendCapCents:150000,cashFloorCents:100000,supplierAllowlist:['atlas-roasters'],maxQuantityMultiple:3,maxPurchasesPer24h:5}}export const currentRuleSet=()=>defaultRuleSet('fixture');export const agentOn=()=>true;export async function signRuleSet(shop){globalThis.__judgeRouteFixture.calls.push({intent:'rules',shop})}export async function runRestock(shop){globalThis.__judgeRouteFixture.calls.push({intent:'restock',shop})}export async function paypalBalanceCents(){throw Error('Unexpected PayPal read')}export function policyContext(){throw Error('Unexpected policy context')}`,
    directory: `export async function seedDemoCatalog(){throw Error('Unexpected seed')}export async function offersForVariant(){return[]}export async function supplierRoster(){return[]}export async function isManaged(){return true}`,
    sales: `export async function salesPerDay(){return 1}`,
  };
  const boundaries: [RegExp, string][] = [
    [/shopify.server(?:\.ts)?$/, "auth"],
    [/(^|\/)db.server(?:\.ts)?$/, "db"],
    [/privacy\/state.server$/, "privacy"],
    [/audit\/log.server$/, "log"],
    [/agent\/approvals.server$/, "approvals"],
    [/agent\/execute.server(?:\.ts)?$/, "execute"],
    [/agent\/attack.server$/, "attack"],
    [/audit\/feed.server$/, "feed"],
    [/agent\/scoreboard.server$/, "score"],
    [/agent\/restock.server$/, "restock"],
    [/suppliers\/directory.server$/, "directory"],
    [/inventory\/sales.server$/, "sales"],
  ];
  await build({
    stdin: {
      contents: `export * as proxy from './app/routes/proxy_.api';export * as publicApi from './app/routes/demo_.api';export * as publicShell from './app/routes/demo';export * as store from './app/routes/proxy_.store_.api';export {judgeShop} from './app/lib/judge/console.server';`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: resolve(work, "routes.mjs"),
    plugins: [
      {
        name: "explicit-offline-judge-boundaries",
        setup(b) {
          for (const [filter, path] of boundaries)
            b.onResolve({ filter }, () => ({ path, namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents: adapters[path],
            resolveDir: root,
            loader: "js",
          }));
        },
      },
    ],
  });
  const routes = await import(pathToFileURL(resolve(work, "routes.mjs")).href);
  const sandbox = (id: string) => routes.judgeShop(shop, id);
  const args = (
    id: string,
    form?: Record<string, string>,
    headers: Record<string, string> = {},
  ) => ({
    request: new Request(
      `https://local.test/demo/api?j=${encodeURIComponent(id)}`,
      {
        headers,
        ...(form
          ? { method: "POST", body: new URLSearchParams({ j: id, ...form }) }
          : {}),
      },
    ),
    params: {},
    context: {},
  });
  const refused = (status: number) => (e: unknown) =>
    e instanceof Response && e.status === status;
  const verified = { "x-proxy-auth": "verified" };
  // Proxy authentication and demo configuration must run before any data/payment adapter.
  await assert.rejects(routes.proxy.loader(args(alice)), refused(401));
  await assert.rejects(
    routes.proxy.action(args(alice, { intent: "scene", preset: "allow" })),
    refused(401),
  );
  await assert.rejects(
    routes.proxy.loader(
      args(alice, undefined, { ...verified, "x-shop": "other.myshopify.com" }),
    ),
    refused(404),
  );
  for (const config of [
    { GUARDBUY_PUBLIC_DEMO_ENABLED: "false" },
    { PAYPAL_API_BASE: "https://api-m.paypal.com" },
  ]) {
    Object.assign(process.env, config);
    await assert.rejects(routes.publicShell.loader(), refused(404));
    await assert.rejects(routes.publicApi.loader(args(alice)), refused(404));
    await assert.rejects(
      routes.publicApi.action(
        args(alice, { intent: "scene", preset: "allow" }),
      ),
      refused(404),
    );
    Object.assign(process.env, {
      GUARDBUY_PUBLIC_DEMO_ENABLED: "true",
      PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
    });
  }
  assert.equal(fixture.reads.length, 0);
  assert.equal(fixture.calls.length, 0);
  const shell = await routes.publicShell.loader();
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("Cache-Control"), "no-store");
  assert.match(await shell.text(), /data-scene="allow"/);
  // The relocated merchant dashboard keeps its no-write contract.
  assert.equal(
    (
      await routes.store.action(
        args(alice, { intent: "approve", decisionSeq: "77" }),
      )
    ).status,
    405,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(
    (await routes.store.loader(args(alice, undefined, verified))).status,
    200,
  );
  fixture.reads.length = 0;
  for (const id of [
    "",
    "../merchant",
    "alice#judge-other",
    "UPPERCASE",
    "x".repeat(41),
  ]) {
    assert.equal((await routes.publicApi.loader(args(id))).status, 400);
    assert.equal(
      (
        await routes.publicApi.action(
          args(id, { intent: "scene", preset: "allow" }),
        )
      ).status,
      400,
    );
  }
  assert.equal(fixture.reads.length, 0);
  assert.equal(fixture.calls.length, 0);
  fixture.owners.set(77, sandbox(alice));
  // Real judgeState must show only actionable cards, not another session or pending payments.
  const card = {
    decisionSeq: 77,
    sku: "coffee",
    supplierName: "Supplier",
    quantity: 1,
    totalCents: 100,
    unitPriceCents: 100,
    needsApprovalBecause: [],
    aiExplanation: "fixture",
  };
  fixture.cards.set(sandbox(alice), [
    { ...card, status: "waiting" },
    { ...card, decisionSeq: 78, status: "payment_pending" },
  ]);
  const state = await (await routes.publicApi.loader(args(alice))).json();
  assert.deepEqual(
    state.approvals.map((c: { decisionSeq: number }) => c.decisionSeq),
    [77],
  );
  assert.deepEqual(
    (await (await routes.publicApi.loader(args(bob))).json()).approvals,
    [],
  );
  assert.equal(
    (
      await routes.publicApi.action(
        args(bob, { intent: "approve", decisionSeq: "77" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await routes.publicApi.action(
        args(bob, { intent: "decline", decisionSeq: "77" }),
      )
    ).status,
    400,
  );
  assert.equal(fixture.calls.length, 0);
  assert.equal(
    (
      await routes.publicApi.action(
        args(alice, { intent: "approve", decisionSeq: "77" }),
      )
    ).status,
    200,
  );
  assert.deepEqual(fixture.calls.pop(), {
    intent: "approve",
    shop: sandbox(alice),
    seq: 77,
    actor: `judge:${alice}`,
  });
  assert.equal(
    (
      await routes.proxy.action(
        args(alice, { intent: "decline", decisionSeq: "77" }, verified),
      )
    ).status,
    200,
  );
  assert.deepEqual(fixture.calls.pop(), {
    intent: "decline",
    shop: sandbox(alice),
    seq: 77,
    actor: `judge:${alice}`,
  });
  for (const preset of ["allow", "ask", "block"])
    assert.equal(
      (await routes.publicApi.action(args(bob, { intent: "scene", preset })))
        .status,
      200,
    );
  assert.ok(fixture.calls.every((c) => c.shop === sandbox(bob)));
  assert.ok(
    fixture.reads.every((s) => s === sandbox(alice) || s === sandbox(bob)),
    "judge operations never read the merchant stream",
  );
  const count = fixture.calls.length;
  assert.equal(
    (
      await routes.publicApi.action(
        args(alice, { intent: "approve", decisionSeq: "not-a-number" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await routes.publicApi.action(
        args(alice, { intent: "scene", preset: "unknown" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await routes.publicApi.action(
        args(alice, { intent: "arbitrary-payment" }),
      )
    ).status,
    400,
  );
  assert.equal(fixture.calls.length, count);
  console.log(
    "PASS judge routes: opt-in/sandbox-only gates, proxy auth, read-only store, session isolation, actionable approvals and scoped scene dispatch (no external services)",
  );
} finally {
  globalThis.fetch = originalFetch;
  keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  });
  Reflect.deleteProperty(globalThis, "__judgeRouteFixture");
  await rm(work, { recursive: true, force: true });
}
