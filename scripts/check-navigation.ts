// Route integration checks: disposable Postgres, explicit Shopify authentication adapter,
// deterministic catalog, and simulated payment commands. Never accesses a merchant store.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
  const url = new URL(process.env[key] ?? "invalid:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/guardbuy_ism141_test");
}
Object.assign(process.env, {
  NODE_ENV: "test",
  GUARDBUY_PAYMENTS_DISABLED: "1",
  SHOPIFY_APP_URL: "http://127.0.0.1:4191",
  TELEGRAM_ALERTS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "12345:offline_token_never_real_123456789",
  TELEGRAM_BOT_USERNAME: "GuardBuyTestBot",
  TELEGRAM_WEBHOOK_SECRET: "offline_webhook_secret_1234567890123456",
  SHOPIFY_API_KEY: "offline-api-key",
});
const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(resolve(root, "node_modules/.navigation-test-"));
const shop = `navigation-${randomUUID()}.myshopify.com`;
process.env.GUARDBUY_NAVIGATION_TEST_SHOP = shop;
const { default: db } = await import("../app/db.server");
const { appendAudit, auditEntries, verifyChain } =
  await import("../app/lib/audit/log.server");
const { merchantLink } = await import("../app/lib/alerts/config.server");
const results: string[] = [];
const pass = (name: string) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
await build({
  stdin: {
    contents: `export {loader as liveState} from './app/routes/app.live-state';export {approvePurchase as realApprove} from './app/lib/agent/approvals.server.ts';export {loader as products,action as productsAction} from './app/routes/app.products._index';export {loader as rules,action as rulesAction} from './app/routes/app.rules';export {loader as activity,action as activityAction} from './app/routes/app.activity';export {loader as oldSuppliers,action as oldSupplierAction} from './app/routes/app.suppliers._index';export {loader as oldApprovals,action as oldApprovalAction} from './app/routes/app.approvals';export {loader as oldProtection,action as oldProtectionAction} from './app/routes/app.protection';export {action as productAction} from './app/routes/app.products.$variantId';export {action as supplierAction} from './app/routes/app.suppliers.$supplierId';`,
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
      name: "explicit-offline-boundaries",
      setup(b) {
        b.onResolve({ filter: /merchant\/staff.server$/ }, () => ({
          path: "auth",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /merchant\/dashboard.server$/ }, () => ({
          path: "catalog",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /paypal\/orders-sweep.server$/ }, () => ({
          path: "sweep",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /paypal\/reconcile.server$/ }, () => ({
          path: "refresh",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /agent\/approvals.server$/ }, () => ({
          path: "commands",
          namespace: "fixture",
        }));
        b.onResolve({ filter: /^\.\.\/agent\/execute.server$/ }, (args) =>
          args.importer.endsWith("approval-page.server.ts")
            ? { path: "execute", namespace: "fixture" }
            : null,
        );
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          loader: "js",
          resolveDir: root,
          contents: {
            auth: `import {redirect} from 'react-router';export async function privateAdmin(request){if(request.headers.get('x-test-auth')!=='yes')throw new Response('Unauthorized',{status:401});return{admin:{graphql:async(query,args)=>{if(!query.includes("GuardBuyEnableRestock"))throw Error("Unexpected Shopify query");return Response.json({data:{productVariant:{id:args.variables.id,title:"Default Title",sku:"COFFEE",product:{title:"Test coffee"},inventoryItem:{id:"gid://shopify/InventoryItem/777",tracked:true}}}})}},session:{shop:process.env.GUARDBUY_NAVIGATION_TEST_SHOP},sessionToken:request.headers.get('x-test-staff')==='no'?{}:{sub:'offline-staff'},redirect}}export async function adminWithStaff(request){const ctx=await privateAdmin(request);if(!ctx.sessionToken.sub)throw new Response('Staff required',{status:403});return{...ctx,actor:'shopify-staff:'+ctx.sessionToken.sub}}`,
            catalog: `import db from '${root}/app/db.server.ts';export async function productOverview(){const p=await db.managedProduct.findFirst({where:{shop:process.env.GUARDBUY_NAVIGATION_TEST_SHOP,variantId:'123'}});return[{variantId:'123',title:'Test coffee',sku:'COFFEE',stock:3,cover:1.5,managed:p?.managed??false}]}export async function feedNames(){return{product:()=> 'Test coffee',supplier:()=> 'Test supplier'}}`,
            sweep: `export async function sweepPayPalOrders(){globalThis.__navigationSweeps=(globalThis.__navigationSweeps??0)+1}`,
            refresh: `export async function refreshPayouts(){return{running:false,checkedAt:null,retryAt:null,incomplete:false,failed:false,awaitingConfirmation:false}}`,
            commands: `export {approvalQueue,rejectPurchase} from '${root}/app/lib/agent/approvals.server.ts';const record=(intent,shop,seq,staff)=>{(globalThis.__navigationPayments??=[]).push({intent,shop,seq,staff});return{paid:false,message:'Offline '+intent,approveUrl:'https://example.test/paypal'}};export async function approvePurchase(...a){return record('approve',...a)}export async function retryPurchase(...a){return record('retry',...a)}export async function approveInPayPal(...a){return record('paypal',...a)}`,
            execute: `export {ExecutionRefused} from '${root}/app/lib/agent/execute.server.ts';export async function resumePayment(shop,seq){(globalThis.__navigationPayments??=[]).push({intent:'resume',shop,seq});return{event:{type:'order_created',approveUrl:'https://example.test/paypal'}}}`,
          }[args.path]!,
        }));
      },
    },
  ],
});
const routes = await import(pathToFileURL(resolve(work, "routes.mjs")).href);
const headers = { "x-test-auth": "yes" };
function args(
  path: string,
  form?: Record<string, string>,
  params = {},
  extra = {},
) {
  return {
    request: new Request(`http://local${path}`, {
      headers: { ...headers, ...extra },
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    }),
    params,
    context: {},
  };
}
const counters = globalThis as typeof globalThis & {
  __navigationSweeps?: number;
  __navigationPayments?: {
    intent: string;
    shop: string;
    seq: number;
    staff?: string;
  }[];
};
try {
  for (const route of [
    "products",
    "liveState",
    "rules",
    "activity",
    "oldSuppliers",
    "oldApprovals",
    "oldProtection",
  ]) {
    await assert.rejects(
      routes[route]({
        request: new Request("http://local/app"),
        params: {},
        context: {},
      }),
      (e: unknown) => e instanceof Response && e.status === 401,
    );
  }
  for (const route of [
    "productsAction",
    "rulesAction",
    "activityAction",
    "oldSupplierAction",
    "oldApprovalAction",
    "oldProtectionAction",
  ]) {
    await assert.rejects(
      routes[route]({
        request: new Request("http://local/app", {
          method: "POST",
          body: new URLSearchParams({
            intent: "reject",
            decisionSeq: "1",
            share: "true",
          }),
        }),
        params: {},
        context: {},
      }),
      (e: unknown) => e instanceof Response && e.status === 401,
    );
  }
  pass("Canonical and historical loaders/actions still enforce authentication");
  const live = await routes.liveState(args("/app/live-state"));
  assert.equal(live.headers.get("Cache-Control"), "private, no-store");
  assert.equal(typeof (await live.json()).revision, "string");
  pass("Authenticated live resource returns uncached JSON without provider calls");
  for (const [route, path] of [
    ["oldSuppliers", "/app/products?tab=suppliers"],
    ["oldApprovals", "/app/rules?tab=approvals"],
    ["oldProtection", "/app/activity"],
  ]) {
    const response = await routes[route](
      args(
        "/app/old?purchase=7&payoutRefresh=1&shop=test.myshopify.com&host=fixture&tab=old",
      ),
    );
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("Location"), "http://local");
    assert.ok((target.pathname + target.search).startsWith(path));
    for (const [k, v] of Object.entries({
      purchase: "7",
      payoutRefresh: "1",
      shop: "test.myshopify.com",
      host: "fixture",
    }))
      assert.equal(target.searchParams.get(k), v);
  }
  assert.equal(counters.__navigationSweeps ?? 0, 0);
  pass(
    "Historical bookmarks preserve purchase IDs and Shopify embedding parameters without payment work",
  );
  assert.equal(
    (
      await routes.productsAction(
        args("/app/products?tab=suppliers", {
          intent: "add-supplier",
          name: "Test supplier",
          paypalEmail: "invalid",
        }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await routes.productsAction(
        args("/app/products?tab=suppliers", {
          intent: "add-supplier",
          name: "Test supplier",
          paypalEmail: "supplier@example.test",
        }),
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await routes.oldSupplierAction(
        args("/app/suppliers", {
          name: "Test supplier",
          paypalEmail: "changed@example.test",
        }),
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await db.supplier.findUniqueOrThrow({
        where: { shop_id: { shop, id: "test-supplier" } },
      })
    ).paypalEmail,
    "supplier@example.test",
  );
  await routes.productsAction(
    args("/app/products", {
      intent: "toggle",
      variantId: "123",
      sku: "COFFEE",
      title: "Test coffee",
      managed: "true",
    }),
  );
  await routes.productAction(
    args(
      "/app/products/123",
      {
        intent: "link",
        supplierId: "test-supplier",
        price: "2",
        usualQuantity: "10",
        leadTimeDays: "3",
      },
      { variantId: "123" },
    ),
  );
  const products = await routes.products(args("/app/products"));
  assert.equal(products.products.products[0].managed, true);
  assert.equal(
    products.products.products[0].suppliers[0].name,
    "Test supplier",
  );
  assert.equal(products.suppliers, null);
  const suppliers = await routes.products(args("/app/products?tab=suppliers"));
  assert.equal(suppliers.suppliers.suppliers[0].products, 1);
  assert.equal(suppliers.products, null);
  pass(
    "Supplier creation, duplicate protection, product toggles and supplier linking use the merged destination",
  );
  const rulesForm = {
    intent: "sign-rules",
    reorderBelowDaysOfCover: "3",
    targetDaysOfCover: "14",
    maxQuantityMultiple: "2",
    approvalAbove: "50",
    weeklySpendCap: "1000",
    cashFloor: "20",
    maxPurchasesPer24h: "5",
    priceTolerance: "0",
    allow: "test-supplier",
  };
  const invalid = await routes.rulesAction(
    args("/app/rules?tab=rules", { ...rulesForm, weeklySpendCap: "0" }),
  );
  assert.equal(invalid.ok, false);
  assert.equal((await auditEntries(shop)).length, 0);
  await assert.rejects(
    routes.rulesAction(
      args("/app/rules?tab=rules", rulesForm, {}, { "x-test-staff": "no" }),
    ),
    (e: unknown) => e instanceof Response && e.status === 403,
  );
  await assert.rejects(
    routes.rulesAction(args("/app/rules?tab=rules", rulesForm)),
    (e: unknown) =>
      e instanceof Response && e.headers.get("Location") === "/app",
  );
  assert.equal((await routes.rules(args("/app/rules?payoutRefresh=1"))).tab, "approvals");
  const signed = await routes.rules(args("/app/rules?tab=rules"));
  assert.equal(signed.tab, "rules");
  assert.equal(signed.approvals, null);
  assert.equal(signed.rules.history[0].by, "you");
  assert.equal(
    (
      await routes.rulesAction(
        args("/app/rules", {
          ...rulesForm,
          intent: "sign-rules",
          approvalAbove: "40",
        }),
      )
    ).ok,
    true,
  );
  assert.equal((await auditEntries(shop)).length, 2);
  assert.equal(counters.__navigationSweeps ?? 0, 0);
  pass(
    "Explicit Rules tab validates and signs with staff history; visiting or signing never captures payments",
  );
  await appendAudit(shop, {
    type: "proposal",
    proposal: {
      variantId: "123",
      sku: "COFFEE",
      supplierId: "test-supplier",
      quantity: 10,
      unitPriceCents: 200,
      reasoning: "Fixture only",
      payeeEmail: "supplier@example.test",
    },
  });
  await appendAudit(shop, {
    type: "decision",
    proposalSeq: 2,
    decision: {
      verdict: "approval",
      totalCents: 2000,
      checks: [],
      ruleSetHash: signed.rules.history[0].hash,
    },
  });
  let approvals = await routes.rules(
    args("/app/rules?tab=approvals&purchase=3"),
  );
  assert.equal(approvals.approvals.cards.length, 1);
  assert.equal(approvals.approvals.cards[0].decisionSeq, 3);
  assert.equal(
    (await routes.rules(args("/app/rules?tab=approvals&purchase=999")))
      .approvals.cards.length,
    0,
  );
  await routes.rules(args("/app/rules?tab=approvals&payoutRefresh=1"));
  assert.equal(counters.__navigationSweeps ?? 0, 0);
  await routes.rules(args("/app/rules?tab=approvals"));
  assert.equal(counters.__navigationSweeps, 1);
  pass(
    "Purchase-specific approvals and status refresh preserve the no-capture rule; queue visits retain their existing sweep",
  );
  Object.assign(process.env, { PAYPAL_CLIENT_ID: "offline-client", PAYPAL_CLIENT_SECRET: "offline-secret", GUARDBUY_PAYPAL_STORES: JSON.stringify({[shop]:{clientId:"offline-client",payerIds:["OFFLINEPAYER"]}}) });
  await db.managedProduct.updateMany({where:{shop},data:{managed:false}});
  const originalFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("Provider access forbidden in product-off test"); };
  try {
    const refusal = await routes.realApprove(shop, 3, "shopify-staff:offline-staff");
    assert.equal(refusal.paid, false);assert.match(refusal.message, /restocking is switched off/);assert.equal(outbound,0);
    const persisted = await routes.rules(args("/app/rules?tab=approvals&purchase=3"));
    assert.equal(persisted.approvals.cards[0].status,"payment_failed");
    assert.match(persisted.approvals.cards[0].paymentReason,/Turn it on in Products & Suppliers/);
    assert.ok(!(await auditEntries(shop)).some(e=>e.event.type==="payout"));
  } finally { globalThis.fetch = originalFetch; }
  pass("Confirmed product-off refusal persists a useful reason without a single provider request");
  for (const intent of ["approve", "retry", "paypal", "resume"])
    await routes.rulesAction(
      args("/app/rules?tab=approvals", { intent, decisionSeq: "3" }),
    );
  assert.deepEqual(
    counters.__navigationPayments?.map((c) => c.intent),
    ["approve", "retry", "paypal", "resume"],
  );
  assert.ok(
    counters.__navigationPayments?.every((c) => c.shop === shop && c.seq === 3),
  );
  assert.equal(
    counters.__navigationPayments?.[0].staff,
    "shopify-staff:offline-staff",
  );
  const before = counters.__navigationPayments?.length;
  await assert.rejects(
    routes.rulesAction(
      args(
        "/app/rules?tab=approvals",
        { intent: "approve", decisionSeq: "3" },
        {},
        { "x-test-staff": "no" },
      ),
    ),
    (e: unknown) => e instanceof Response && e.status === 403,
  );
  assert.equal(counters.__navigationPayments?.length, before);
  assert.equal(
    (
      await routes.oldApprovalAction(
        args("/app/approvals", { intent: "reject", decisionSeq: "3" }),
      )
    ).ok,
    true,
  );
  approvals = await routes.rules(args("/app/rules?tab=approvals&purchase=3"));
  assert.equal(approvals.approvals.cards.length, 0);
  pass(
    "Payment intent dispatch preserves purchase and staff identity; historical decline records real audit evidence",
  );
  assert.equal((await routes.activity(args("/app/activity"))).share, false);
  await routes.activityAction(args("/app/activity", { share: "true" }));
  assert.equal((await routes.activity(args("/app/activity"))).share, true);
  await routes.oldProtectionAction(args("/app/protection", { share: "false" }));
  assert.equal((await routes.activity(args("/app/activity"))).share, false);
  await assert.rejects(
    routes.activityAction(args("/app/activity", { share: "invalid" })),
    (e: unknown) => e instanceof Response && e.status === 400,
  );
  assert.equal((await verifyChain(shop)).valid, true);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.updateMany({
      where: { shop, seq: 0 },
      data: { event: { type: "corrupt" } },
    });
  });
  const broken = await routes.activity(args("/app/activity"));
  assert.equal(broken.chain.valid, false);
  assert.equal(broken.payoutRefresh, null);
  assert.deepEqual(broken.feed, []);
  pass(
    "Relocated public-sharing control defaults private and corrupted audit data renders a warning without parsing it",
  );
  const link = new URL(merchantLink(shop, "approval", 3));
  assert.equal(link.pathname.split("/").at(-1), "rules");
  assert.equal(link.searchParams.get("tab"), "approvals");
  assert.equal(link.searchParams.get("purchase"), "3");
  assert.ok(merchantLink(shop, "integrity").endsWith("/app/activity"));
  pass(
    "New Telegram alerts link directly to the merged approval tab or Activity",
  );
  const removal = await routes.supplierAction(
    args(
      "/app/suppliers/test-supplier",
      { intent: "remove" },
      { supplierId: "test-supplier" },
    ),
  );
  assert.equal(removal.headers.get("Location"), "/app/products?tab=suppliers");
  pass("Removing a supplier returns to the merged Suppliers tab");
  if (process.env.GUARDBUY_NAVIGATION_EVIDENCE_PATH) {
    const file = resolve(process.env.GUARDBUY_NAVIGATION_EVIDENCE_PATH);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        {
          localTestOnly: true,
          realPostgres: true,
          authenticationAdapter: true,
          simulatedPaymentCommands: true,
          checks: results,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL guardbuy.audit_rewrite = 'on'`;
    await tx.auditEntry.deleteMany({ where: { shop } });
  });
  await db.productSupplier.deleteMany({ where: { shop } });
  await db.supplier.deleteMany({ where: { shop } });
  await db.restockJob.deleteMany({ where: { shop } });
  await db.managedProduct.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
  await db.$disconnect();
  await rm(work, { recursive: true, force: true });
}
