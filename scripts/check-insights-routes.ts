// Route boundary checks with explicit auth/data/model adapters; no external services.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, ".."),
  work = await mkdtemp(resolve(root, "node_modules/.insights-route-"));
const priorEnv = {
  node: process.env.NODE_ENV,
  license: process.env.AG_STUDIO_LICENSE_KEY,
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
      contents: "export {loader,action} from './app/routes/app.insights';",
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
          b.onResolve({ filter: /audit\/log.server$/ }, () => ({
            path: "audit",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /merchant\/dashboard.server$/ }, () => ({
            path: "names",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /insights\/planner.server$/ }, () => ({
            path: "planner",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /components\/insights-studio$/ }, () => ({
            path: "ui",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            loader: "js",
            contents: (
              {
                auth: `export async function adminWithStaff(request){if(request.headers.get('x-auth')!=='verified')throw new Response('Unauthorized',{status:401});if(request.headers.get('x-staff')==='missing')throw new Response('Staff required',{status:403});return{session:{shop:request.headers.get('x-shop')||'shop-a'},actor:request.headers.get('x-staff')||'staff-a'}}`,
                audit: `export async function appendAudit(){throw Error('Unexpected audit write')}export async function appendAuditWhen(){throw Error('Unexpected audit write')}export async function verifyChain(shop){return{valid:!globalThis.__brokenInsightChain,length:0}}export async function auditEntries(shop){globalThis.__insightReads.push(shop);return[];}`,
                names: `export async function feedNames(shop){globalThis.__insightReads.push('names:'+shop);return{product:()=> 'Scoped product',supplier:()=> 'Scoped supplier'}}`,
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
    routes.action(args(req({}, { "x-staff": "missing" }))),
    (e: unknown) => e instanceof Response && e.status === 403,
  );
  assert.equal(
    fixtures.__insightReads.length,
    0,
    "authorization precedes all merchant data reads",
  );
  const loaded = await routes.loader(
    args(
      new Request("https://local.test/app/insights", {
        headers: { "x-auth": "verified", "x-shop": "shop-b" },
      }),
    ),
  );
  assert.equal(loaded.snapshot.rows.length, 0);
  assert.deepEqual(
    fixtures.__insightReads,
    ["shop-b", "names:shop-b"],
    "both log and names are scoped to authenticated shop",
  );
  fixtures.__brokenInsightChain = true;
  await assert.rejects(
    routes.loader(
      args(
        new Request("https://local.test/app/insights", {
          headers: { "x-auth": "verified" },
        }),
      ),
    ),
    (e: unknown) => e instanceof Response && e.status === 409,
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
  const unlicensed = await routes.loader(
    args(
      new Request("https://local.test/app/insights", {
        headers: { "x-auth": "verified" },
      }),
    ),
  );
  assert.equal(
    unlicensed.enabled,
    false,
    "hosted Studio waits for configured deployment licence",
  );
  assert.equal(
    (await routes.action(args(req({}, { "x-staff": "staff-b" })))).status,
    503,
  );
  assert.equal(fixtures.__insightPlans.length, 1);
  console.log(
    "PASS insights routes: authentication/staff boundary, shop isolation, chain refusal, bounded strict JSON, no client tools/data, model prompt isolation, rate limit and hosted licence gate.",
  );
} finally {
  if (priorEnv.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorEnv.node;
  if (priorEnv.license === undefined) delete process.env.AG_STUDIO_LICENSE_KEY;
  else process.env.AG_STUDIO_LICENSE_KEY = priorEnv.license;
  delete fixtures.__insightReads;
  delete fixtures.__insightPlans;
  delete fixtures.__brokenInsightChain;
  await rm(work, { recursive: true, force: true });
}
