// Route boundary checks with explicit auth/data/model adapters; no external services.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler, type ServerBuild } from "react-router";
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(resolve(root, "node_modules/.insights-route-"));
const priorEnv = {
  node: process.env.NODE_ENV,
  license: process.env.AG_STUDIO_LICENSE_KEY,
  gridLicense: process.env.AG_GRID_LICENSE_KEY,
};
const fixtures = globalThis as typeof globalThis & {
  __insightReads?: string[];
  __insightPlans?: string[];
  __brokenInsightChain?: boolean;
};
try {
  process.env.NODE_ENV = "test";
  fixtures.__insightReads = [];
  fixtures.__insightPlans = [];
  await build({
    stdin: {
      contents:
        "export {loader,action} from './app/routes/app.insights'; export * as home from './app/routes/app._index'; export * as resource from './app/routes/app.insights.plan';",
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
        name: "explicit-offline-insights-boundaries",
        setup(b) {
          b.onResolve({ filter: /merchant\/staff.server$/ }, () => ({
            path: "auth",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /audit\/feed.server$/ }, () => ({
            path: "feed",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /audit\/log.server$/ }, () => ({
            path: "audit",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /merchant\/dashboard.server$/ }, () => ({
            path: "names",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /(^|\/)planner.server$/ }, () => ({
            path: "planner",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /components\/insights-studio$/ }, () => ({
            path: "ui",
            namespace: "fixture",
          }));
          b.onResolve(
            { filter: /agent\/(approvals|scoreboard|restock).server$/ },
            ({ path }) => ({
              path: path.includes("restock")
                ? "restock"
                : path.includes("scoreboard")
                  ? "score"
                  : "approvals",
              namespace: "fixture",
            }),
          );
          b.onResolve({ filter: /suppliers\/directory.server$/ }, () => ({
            path: "directory",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            loader: "js",
            contents: (
              {
                feed: `export function toFeed(){return []}`,
                auth: `export async function adminWithStaff(request){if(request.headers.get('x-auth')!=='verified')throw new Response('Unauthorized',{status:401});if(request.headers.get('x-staff')==='missing')throw new Response('Staff required',{status:403});return{session:{shop:request.headers.get('x-shop')||'shop-a'},actor:request.headers.get('x-staff')||'staff-a'}}`,
                audit: `export async function appendAudit(){throw Error('Unexpected audit write')}export async function appendAuditWhen(){throw Error('Unexpected audit write')}export async function verifyChain(shop){return{valid:!globalThis.__brokenInsightChain,length:0}}export async function auditEntries(shop){globalThis.__insightReads.push(shop);return[];}`,
                restock: `export function currentRuleSet(){return null} export function spending(){return {spentLast7dCents:0,pendingCents:0}} export function agentOn(){return false} export async function setAgentState(){throw Error('Unexpected agent command')}`,
                score: `export async function scoreboard(){return {real:{blocked:0,blockedCents:0},attacks:{blocked:0,flagged:0}}}`,
                approvals: `export async function approvalQueue(){return []}`,
                directory: `export async function setupStatus(){return {managedProducts:0,suppliers:0,managedWithSuppliers:0}} export async function setManaged(){throw Error('Unexpected product command')}`,
                names: `export async function cachedBalanceCents(){return null} export async function productOverview(){return []} export function productStatus(){return {}} export async function feedNames(shop){globalThis.__insightReads.push('names:'+shop);return{product:()=> 'Scoped product',supplier:()=> 'Scoped supplier'}}`,
                planner: `export function insightsAiConfigured(){return true}export async function planInsightView(prompt){globalThis.__insightPlans.push(prompt);return{view:'pending',refused:false}}`,
                ui: `export default function Insights(){return null}`,
              } as Record<string, string>
            )[path],
          }));
        },
      },
    ],
  });
  const routes = await import(pathToFileURL(resolve(work, "routes.mjs")).href);
  const req = (
    body: unknown = { prompt: "Show pending purchases" },
    headers: Record<string, string> = {},
    raw?: string,
  ) =>
    new Request("https://local.test/app/insights", {
      method: "POST",
      headers: {
        "x-auth": "verified",
        "content-type": "application/json",
        ...headers,
      },
      body: raw ?? JSON.stringify(body),
    });
  const args = (request: Request) => ({ request, params: {}, context: {} });
  await assert.rejects(
    routes.loader(args(new Request("https://local.test/app/insights"))),
    (e: unknown) => e instanceof Response && e.status === 401,
  );
  await assert.rejects(
    routes.home.loader(args(new Request("https://local.test/app"))),
    (e: unknown) => e instanceof Response && e.status === 401,
  );
  await assert.rejects(
    routes.action(args(req({}, { "x-staff": "missing" }))),
    (e: unknown) => e instanceof Response && e.status === 403,
  );
  assert.equal(
    fixtures.__insightReads.length,
    0,
    "authorization precedes all merchant data reads",
  );
  const loaded = await routes.home.loader(
    args(
      new Request("https://local.test/app/insights", {
        headers: { "x-auth": "verified", "x-shop": "shop-b" },
      }),
    ),
  );
  assert.equal(loaded.purchasing.snapshot.rows.length, 0);
  assert.equal(loaded.shop, "shop-b");
  assert.deepEqual(
    fixtures.__insightReads,
    ["shop-b", "names:shop-b"],
    "both log and names are scoped to authenticated shop",
  );
  const bookmark = await routes.loader(
    args(
      new Request(
        "https://local.test/app/insights?host=abc&shop=shop-b&embedded=1&id_token=secret",
        { headers: { "x-auth": "verified" } },
      ),
    ),
  );
  assert.equal(bookmark.status, 302);
  assert.equal(
    bookmark.headers.get("Location"),
    "/app?host=abc&shop=shop-b&embedded=1",
  );
  assert.equal(bookmark.headers.get("Cache-Control"), "private, no-store");
  fixtures.__brokenInsightChain = true;
  const broken = await routes.home.loader(
    args(
      new Request("https://local.test/app", {
        headers: { "x-auth": "verified" },
      }),
    ),
  );
  assert.equal(
    broken.purchasing,
    null,
    "unverified audit data cannot enter dashboard while Home warnings remain usable",
  );
  fixtures.__brokenInsightChain = false;
  assert.equal(
    (await routes.action(args(req({}, { "content-type": "text/plain" }))))
      .status,
    415,
  );
  assert.equal(
    (await routes.action(args(req({}, {}, "not JSON")))).status,
    400,
  );
  assert.equal(
    (await routes.action(args(req({ prompt: "show pending", tools: ["pay"] }))))
      .status,
    400,
  );
  assert.equal(
    (await routes.action(args(req({}, {}, "x".repeat(4097))))).status,
    413,
  );
  assert.equal(
    fixtures.__insightPlans.length,
    0,
    "invalid payloads cannot trigger a model call",
  );
  const accepted = await routes.action(args(req()));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { view: "pending", refused: false });
  assert.deepEqual(
    fixtures.__insightPlans,
    ["Show pending purchases"],
    "model receives only user prompt",
  );
  assert.equal(
    (await routes.action(args(req()))).status,
    429,
    "repeated prompts are rate limited",
  );
  process.env.NODE_ENV = "production";
  delete process.env.AG_STUDIO_LICENSE_KEY;
  const unlicensed = await routes.home.loader(
    args(
      new Request("https://local.test/app/insights", {
        headers: { "x-auth": "verified" },
      }),
    ),
  );
  assert.equal(
    unlicensed.purchasing.enabled,
    false,
    "hosted Studio waits for configured deployment licence",
  );
  assert.equal(
    (await routes.action(args(req({}, { "x-staff": "staff-b" })))).status,
    503,
  );
  assert.equal(fixtures.__insightPlans.length, 1);
  process.env.AG_STUDIO_LICENSE_KEY = "test-studio-config";
  delete process.env.AG_GRID_LICENSE_KEY;
  const gridUnlicensed = await routes.home.loader(
    args(
      new Request("https://local.test/app", {
        headers: { "x-auth": "verified" },
      }),
    ),
  );
  assert.equal(
    gridUnlicensed.purchasing.enabled,
    false,
    "Studio key alone does not enable custom Enterprise grid",
  );
  process.env.AG_GRID_LICENSE_KEY = "test-grid-config";
  const licensed = await routes.home.loader(
    args(
      new Request("https://local.test/app", {
        headers: { "x-auth": "verified" },
      }),
    ),
  );
  assert.equal(licensed.purchasing.enabled, true);

  // Real React Router request handling (not just calling action directly): a UI
  // document POST renders HTML, while the component-less endpoint returns JSON.
  process.env.NODE_ENV = "test";
  const handler = createRequestHandler(
    {
      entry: {
        module: {
          default: () =>
            new Response("<html>Insights UI</html>", {
              headers: { "Content-Type": "text/html" },
            }),
        },
      },
      routes: {
        root: { id: "root", path: "", module: { default: () => null } },
        insights: {
          id: "insights",
          parentId: "root",
          path: "app/insights",
          module: { loader: routes.loader, action: routes.action },
        },
        plan: {
          id: "plan",
          parentId: "insights",
          path: "plan",
          module: routes.resource,
        },
      },
      assets: {
        routes: {},
        entry: { module: "/entry.js", imports: [] },
        url: "/manifest.js",
        version: "test",
      },
      future: {},
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
      publicPath: "/",
      assetsBuildDirectory: "build/client",
    } as unknown as ServerBuild,
    "test",
  );
  const httpReq = (path: string, staff: string, verified = true) =>
    new Request(`https://local.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-staff": staff,
        ...(verified ? { "x-auth": "verified" } : {}),
      },
      body: JSON.stringify({ prompt: "Show pending purchases" }),
    });
  const redirected = await handler(
    new Request("https://local.test/app/insights", {
      headers: { "x-auth": "verified" },
    }),
  );
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get("Location"), "/app");
  const json = await handler(httpReq("/app/insights/plan", "resource-test"));
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(json.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await json.json(), { view: "pending", refused: false });
  const unauthenticated = await handler(
    httpReq("/app/insights/plan", "unauthenticated", false),
  );
  assert.equal(
    unauthenticated.status,
    401,
    "resource endpoint retains staff authorization",
  );
  console.log(
    "PASS insights routes: authentication/staff boundary, shop isolation, Home migration, bookmark redirect, chain refusal, bounded strict JSON, no client tools/data, model prompt isolation, rate limit and hosted licence gate.",
  );
} finally {
  if (priorEnv.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorEnv.node;
  if (priorEnv.license === undefined) delete process.env.AG_STUDIO_LICENSE_KEY;
  else process.env.AG_STUDIO_LICENSE_KEY = priorEnv.license;
  if (priorEnv.gridLicense === undefined)
    delete process.env.AG_GRID_LICENSE_KEY;
  else process.env.AG_GRID_LICENSE_KEY = priorEnv.gridLicense;
  delete fixtures.__insightReads;
  delete fixtures.__insightPlans;
  delete fixtures.__brokenInsightChain;
  await rm(work, { recursive: true, force: true });
}
