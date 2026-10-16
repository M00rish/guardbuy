// Minimal PayPal REST client for the calls the Agent Toolkit doesn't cover (Payouts, Orders with a payee).
// Sandbox only for the hackathon. Caches the OAuth token, spaces requests out to stay under the
// sandbox limit (~50 req/min per IP), and retries network blips and 429s.

const BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
const MIN_INTERVAL_MS = 1_300; // ~46 requests per minute at most

type Credentials = { clientId: string; clientSecret: string };

export function merchantCredentials(): Credentials {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  return { clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET };
}

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`PayPal ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

const tokens = new Map<string, { value: string; expiresAt: number }>();
// Per PayPal account (client id), so one busy account can't slow every other account's payments.
const lastRequestAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(clientId: string) {
  const last = lastRequestAt.get(clientId) ?? 0;
  const wait = last + MIN_INTERVAL_MS - Date.now();
  lastRequestAt.set(clientId, Math.max(Date.now(), last + MIN_INTERVAL_MS));
  if (wait > 0) await sleep(wait);
}

async function accessToken(creds: Credentials): Promise<string> {
  const cached = tokens.get(creds.clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new PayPalError(res.status, body);
  tokens.set(creds.clientId, { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 0) * 1000 });
  return body.access_token;
}

/**
 * Calls the PayPal REST API. `requestId` makes POSTs idempotent: PayPal returns the original
 * result instead of acting twice, so retries can never pay twice.
 */
export async function paypal<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; requestId?: string; creds?: Credentials } = {},
): Promise<T> {
  const creds = init.creds ?? merchantCredentials();
  for (let attempt = 1; ; attempt++) {
    await throttle(creds.clientId);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${await accessToken(creds)}`,
          "Content-Type": "application/json",
          ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (res.status === 401) tokens.delete(creds.clientId); // token revoked or permissions changed
      if (res.ok) return body as T;
      if ((res.status === 429 || res.status >= 500 || res.status === 401) && attempt < 3) {
        await sleep(attempt * 2_000);
        continue;
      }
      throw new PayPalError(res.status, body);
    } catch (err) {
      if (err instanceof PayPalError || attempt >= 3) throw err;
      await sleep(attempt * 2_000); // network error: retry, the request id keeps it safe
    }
  }
}
