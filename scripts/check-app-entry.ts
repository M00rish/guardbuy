// Actual production HTTP entry checks, with disposable loopback DB and no Shopify session.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const url = new URL(process.env.DATABASE_URL ?? "invalid:");
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.pathname, "/guardbuy_ism141_test");
const base = "http://127.0.0.1:4193";
const child = spawn(
  process.execPath,
  [
    "--import",
    "./scripts/safe-access-log.mjs",
    "./node_modules/@react-router/serve/bin.js",
    "./build/server/index.js",
  ],
  {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "4193",
      SHOPIFY_API_KEY: "offline-api-key",
      SHOPIFY_API_SECRET: "offline-secret",
      SHOPIFY_APP_URL: base,
      SCOPES: "read_products",
      GUARDBUY_PAYMENTS_DISABLED: "1",
      TELEGRAM_ALERTS_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/auth/login");
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the local server to bind. */
    }
    if (child.exitCode !== null) throw Error(logs);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, "Production server must start");
  for (const path of [
    "/app",
    "/app/rules",
    "/app/approvals?purchase=118",
    "/app/products",
    "/app/activity",
  ]) {
    const r = await fetch(base + path, { redirect: "manual" });
    assert.equal(r.status, 302, path);
    assert.equal(r.headers.get("location"), "/auth/login");
  }
  const entry = await fetch(base + "/auth/login");
  const html = await entry.text();
  assert.match(html, /Open GuardBuy in Shopify/);
  assert.match(html, /name="shop"/);
  assert.ok(!html.includes("Unhandled Thrown Response"));
  const invalid = await fetch(base + "/auth/login", {
    method: "POST",
    body: new URLSearchParams({ shop: "not-a-shop.invalid" }),
    redirect: "manual",
  });
  assert.equal(invalid.status, 200);
  assert.match(await invalid.text(), /Please enter a valid shop domain/);
  // A context parameter alone does not authenticate: invalid JWT must not expose merchant data.
  const invalidAuth = await fetch(base + "/app/rules?embedded=1", {
    headers: { Authorization: "Bearer invalid-token" },
    redirect: "manual",
  });
  assert.notEqual(invalidAuth.status, 200);
  console.log(
    "PASS production app entry: protected URLs lead to Shopify login, native form renders/validates, invalid credentials expose no merchant data.",
  );
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}
