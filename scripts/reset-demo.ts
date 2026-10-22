// One command to reset the demo: stock back to the starting point (on the running app) and the
// merchant's sandbox PayPal balance topped up from the supplier sandbox account.
//   GUARDBUY_URL=https://<app url> npx tsx scripts/reset-demo.ts
// (GUARDBUY_URL defaults to SHOPIFY_APP_URL from .env.)
export {};
process.loadEnvFile(".env");
const url = process.env.GUARDBUY_URL ?? process.env.SHOPIFY_APP_URL;
if (!url || !process.env.JOBS_SECRET) throw new Error("Set GUARDBUY_URL (the running app) and JOBS_SECRET");

const res = await fetch(`${url}/jobs/reset-demo`, { method: "POST", headers: { Authorization: `Bearer ${process.env.JOBS_SECRET}` } });
if (!res.ok) throw new Error(`reset-demo: HTTP ${res.status}`);
const { shop, changes } = (await res.json()) as { shop: string; changes: string[] };
console.log(`Stock reset on ${shop}:\n  ${changes.join("\n  ")}`);

console.log("Topping up the sandbox balance:");
await import("./refill-sandbox");
