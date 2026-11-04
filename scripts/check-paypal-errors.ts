// PayPal failure handling, against a fake PayPal server on localhost (no network, no money).
//   npx tsx scripts/check-paypal-errors.ts
import { createServer } from "node:http";

let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };

// Scripted responses per path: each request takes the next one (the last one repeats).
const script: Record<string, number[]> = {};
const hits: Record<string, number> = {};
const server = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/v1/oauth2/token") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ access_token: "fake", expires_in: 3600 })); return; }
  hits[path] = (hits[path] ?? 0) + 1;
  const codes = script[path] ?? [404];
  const code = codes[Math.min(hits[path] - 1, codes.length - 1)];
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(code === 200 ? { ok: true } : { name: `HTTP_${code}`, message: "scripted" }));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

process.env.NODE_ENV = "test";
process.env.GUARDBUY_PAYPAL_TEST_API = "1";
process.env.PAYPAL_API_BASE = `http://127.0.0.1:${port}`;
process.env.PAYPAL_CLIENT_ID = "fake"; process.env.PAYPAL_CLIENT_SECRET = "fake";
const { paypal, PayPalError } = await import("../app/lib/paypal/client.server");

const call = (path: string) => paypal(path, { method: "POST", requestId: "r1" }).then(() => "ok", (e) => (e instanceof PayPalError ? `PayPalError ${e.status}` : `other ${e}`));

script["/a"] = [500];
ok((await call("/a")) === "PayPalError 500" && hits["/a"] === 3, `PayPal down (500): retried, gave up after ${hits["/a"]} tries`);
script["/b"] = [429, 200];
ok((await call("/b")) === "ok" && hits["/b"] === 2, "rate limited (429) once: retried and succeeded");
script["/c"] = [503, 503, 200];
ok((await call("/c")) === "ok" && hits["/c"] === 3, "two blips (503) then success");
script["/d"] = [400];
ok((await call("/d")) === "PayPalError 400" && hits["/d"] === 1, "bad request (400): not retried");
script["/e"] = [422];
ok((await call("/e")) === "PayPalError 422" && hits["/e"] === 1, "PayPal refuses (422, e.g. insufficient funds): not retried, error surfaces");

server.close();
process.exit(failed ? 1 : 0);
