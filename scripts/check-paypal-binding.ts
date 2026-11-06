// Pure configuration checks; no environment files, database or provider requests.
import assert from "node:assert/strict";
import { allowedStorePayer, assertToolkitEnvironment, paypalApiBase, paypalStoreBinding, validatePayPalStartup } from "../app/lib/paypal/config.server";

const binding = { clientId: "sandbox-client", payerIds: ["MERCHANTA"] };
const env = { NODE_ENV: "production", PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "fake-never-a-real-secret", GUARDBUY_PAYPAL_STORES: JSON.stringify({ "a.myshopify.com": binding, "b.myshopify.com": { ...binding, payerIds: ["MERCHANTB"] } }) };
let count = 0;
const check = (title: string, fn: () => void) => { fn(); count++; console.log(`PASS ${title}`); };
check("Explicit sandbox mapping starts with matching REST and Toolkit", () => { validatePayPalStartup(env); assert.equal(paypalApiBase(env), "https://api-m.sandbox.paypal.com"); assertToolkitEnvironment(env); });
check("Store A cannot use Store B's allowed payer", () => { assert.equal(allowedStorePayer("a.myshopify.com", "MERCHANTA", env), true); assert.equal(allowedStorePayer("a.myshopify.com", "MERCHANTB", env), false); assert.equal(allowedStorePayer("b.myshopify.com", "MERCHANTB", env), true); });
check("Missing, empty and wrong payer identities are refused", () => { for (const id of [undefined, "", "STRANGER"]) assert.equal(allowedStorePayer("a.myshopify.com", id, env), false); });
check("Unmapped stores cannot use global credentials", () => { assert.throws(() => paypalStoreBinding("unknown.myshopify.com", env)); });
check("Empty mappings and legacy global allowlist do not enable payments", () => { assert.throws(() => validatePayPalStartup({ ...env, GUARDBUY_PAYPAL_STORES: "{}", GUARDBUY_APPROVER_PAYER_IDS: "MERCHANTA" })); });
check("Malformed mapping errors do not echo secrets or configuration", () => {
  for (const raw of ["fake-never-a-real-secret", "null", "[]", JSON.stringify({ "a.myshopify.com": { ...binding, payerIds: [] } }), JSON.stringify({ "a.myshopify.com": { ...binding, payerIds: [null] } })]) {
    assert.throws(() => validatePayPalStartup({ ...env, GUARDBUY_PAYPAL_STORES: raw }), (e: Error) => !e.message.includes("fake-never-a-real-secret"));
  }
});
check("Funding account change requires deliberate store rebinding", () => { assert.throws(() => validatePayPalStartup({ ...env, PAYPAL_CLIENT_ID: "another-client" })); assert.throws(() => paypalStoreBinding("a.myshopify.com", { ...env, PAYPAL_CLIENT_ID: "another-client" })); });
check("Live, alternate hosts and malformed origins fail before provider I/O", () => {
  for (const base of ["https://api-m.paypal.com", "https://api.paypal.com", "https://api-m.sandbox.paypal.com/", "https://api-m.sandbox.paypal.com.evil.test", "http://api-m.sandbox.paypal.com", "https://user:pass@api-m.sandbox.paypal.com", "https://api-m.sandbox.paypal.com?x=1"]) assert.throws(() => validatePayPalStartup({ ...env, PAYPAL_API_BASE: base }));
});
check("Public judge configuration cannot enable live payments", () => { assert.throws(() => validatePayPalStartup({ ...env, PAYPAL_API_BASE: "https://api-m.paypal.com", GUARDBUY_PUBLIC_DEMO_ENABLED: "true", GUARDBUY_DEMO_STORE: "a.myshopify.com" })); });
check("Public demo requires its own explicit store binding", () => { validatePayPalStartup({ ...env, GUARDBUY_PUBLIC_DEMO_ENABLED: "true", GUARDBUY_DEMO_STORE: "a.myshopify.com" }); assert.throws(() => validatePayPalStartup({ ...env, GUARDBUY_PUBLIC_DEMO_ENABLED: "true", GUARDBUY_DEMO_STORE: "other.myshopify.com" })); });
check("Development has no permissive payer bypass", () => { assert.throws(() => validatePayPalStartup({ ...env, NODE_ENV: "development", GUARDBUY_PAYPAL_STORES: "{}" })); });
check("Fake REST API needs explicit test opt-in and exact loopback origin", () => {
  const local = { ...env, PAYPAL_API_BASE: "http://127.0.0.1:9000", GUARDBUY_PAYPAL_TEST_API: "1" };
  assert.equal(paypalApiBase({ ...local, NODE_ENV: "test" }), local.PAYPAL_API_BASE);
  for (const NODE_ENV of ["development", "production"]) assert.throws(() => paypalApiBase({ ...local, NODE_ENV }));
  assert.throws(() => paypalApiBase({ ...local, NODE_ENV: "test", GUARDBUY_PAYPAL_TEST_API: undefined }));
  assert.throws(() => paypalApiBase({ ...local, NODE_ENV: "test", PAYPAL_API_BASE: "http://evil.test:9000" }));
  assert.throws(() => assertToolkitEnvironment({ ...local, NODE_ENV: "test" }), /Toolkit/);
});
check("Disabled sandbox server can display history without payment bindings", () => { validatePayPalStartup({ NODE_ENV: "production", GUARDBUY_PAYMENTS_DISABLED: "1" }); assert.throws(() => validatePayPalStartup({ GUARDBUY_PAYMENTS_DISABLED: "1", PAYPAL_API_BASE: "https://api-m.paypal.com" })); });
check("Missing credentials refuse enabled startup", () => { assert.throws(() => validatePayPalStartup({ ...env, PAYPAL_CLIENT_SECRET: "" })); });
console.log(`${count} PayPal binding/environment checks passed; no external requests.`);
