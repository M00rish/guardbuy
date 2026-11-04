// Server-only deployment configuration. No merchant credentials or payer IDs come from requests.
const SANDBOX = "https://api-m.sandbox.paypal.com";
type Environment = Record<string, string | undefined>;
type StoreBinding = { clientId: string; payerIds: string[] };

export class PayPalConfigurationError extends Error {}
const refuse = (message: string): never => { throw new PayPalConfigurationError(message); };

export function paypalApiBase(env: Environment = process.env): string {
  const base = env.PAYPAL_API_BASE ?? SANDBOX;
  if (base === SANDBOX) return base;
  // A fake provider is allowed only with two explicit test settings, never in a deployed server.
  if (env.NODE_ENV === "test" && env.GUARDBUY_PAYPAL_TEST_API === "1") {
    try {
      const url = new URL(base);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port && url.origin === base) return base;
    } catch { /* Fail closed below; never include configuration values in errors. */ }
  }
  return refuse("GuardBuy requires the exact PayPal sandbox API origin. Live and mixed API environments are unsupported.");
}

export function assertToolkitEnvironment(env: Environment = process.env) {
  if (paypalApiBase(env) !== SANDBOX) refuse("The sandbox Toolkit cannot be used with a different REST environment.");
}

function storeBindings(env: Environment): Record<string, StoreBinding> {
  let raw: unknown;
  try { raw = JSON.parse(env.GUARDBUY_PAYPAL_STORES ?? "{}"); }
  catch { return refuse("GUARDBUY_PAYPAL_STORES must be a valid store/account mapping."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("GUARDBUY_PAYPAL_STORES must be a store/account mapping.");
  for (const [shop, value] of Object.entries(raw)) {
    const entry = value as Partial<StoreBinding> | null;
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]+$/.test(shop) || !entry || typeof entry !== "object"
      || typeof entry.clientId !== "string" || !entry.clientId.trim() || entry.clientId !== entry.clientId.trim()
      || !Array.isArray(entry.payerIds) || !entry.payerIds.length
      || entry.payerIds.some((id) => typeof id !== "string" || !/^[A-Z0-9]+$/.test(id))) {
      return refuse("Each PayPal store binding requires a shop domain, clientId and nonempty payerIds.");
    }
  }
  return raw as Record<string, StoreBinding>;
}

export function paypalStoreBinding(shop: string, env: Environment = process.env): StoreBinding {
  paypalApiBase(env);
  const entries = storeBindings(env);
  const binding = Object.hasOwn(entries, shop) ? entries[shop] : undefined;
  if (!binding || !env.PAYPAL_CLIENT_ID || binding.clientId !== env.PAYPAL_CLIENT_ID) {
    return refuse("This store is not bound to the configured PayPal funding account. Review the server mapping.");
  }
  return binding;
}

export function allowedStorePayer(shop: string, payerId: string | undefined, env: Environment = process.env): boolean {
  const binding = paypalStoreBinding(shop, env);
  return typeof payerId === "string" && binding.payerIds.includes(payerId);
}

/** Called before the server starts its worker. A disabled server can still display recorded history. */
export function validatePayPalStartup(env: Environment = process.env) {
  assertToolkitEnvironment(env);
  const bindings = storeBindings(env);
  if (env.GUARDBUY_PAYMENTS_DISABLED === "1") return;
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) refuse("PayPal sandbox credentials are required when payments are enabled.");
  if (!Object.keys(bindings).length) refuse("Configure GUARDBUY_PAYPAL_STORES before enabling payments.");
  for (const shop of Object.keys(bindings)) paypalStoreBinding(shop, env);
  if (env.GUARDBUY_PUBLIC_DEMO_ENABLED === "true") {
    if (!env.GUARDBUY_DEMO_STORE) refuse("A public demo requires an explicitly bound demo store.");
    paypalStoreBinding(env.GUARDBUY_DEMO_STORE!, env);
  }
}
