import { setTimeout as delay } from "node:timers/promises";
import { paypalApiBase } from "./config.server";
// Minimal PayPal REST client for the calls the Agent Toolkit doesn't cover (Payouts, Orders with a payee).
// Sandbox only for the hackathon. Caches the OAuth token, spaces requests out to stay under the
// sandbox limit (~50 req/min per IP), and retries network blips and 429s.

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
    super(`PayPal request failed (HTTP ${status})`);
  }
}

const tokens = new Map<string, { value: string; expiresAt: number }>();
// Per PayPal account (client id), so one busy account can't slow every other account's payments.
const lastRequestAt = new Map<string, number>();

const sleep = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal });

async function throttle(clientId: string, signal: AbortSignal) {
  const last = lastRequestAt.get(clientId) ?? 0;
  const wait = last + MIN_INTERVAL_MS - Date.now();
  lastRequestAt.set(clientId, Math.max(Date.now(), last + MIN_INTERVAL_MS));
  if (wait > 0) await sleep(wait, signal);
}

async function accessToken(creds: Credentials, signal: AbortSignal): Promise<string> {
  const cached = tokens.get(creds.clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    signal,
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
 * result instead of acting twice, within the API-specific retention window. Durable attempts enforce those windows.
 */
export async function paypal<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH"; body?: unknown; requestId?: string; creds?: Credentials; maxAttempts?: number; timeoutMs?: number } = {},
): Promise<T> {
  const base = paypalApiBase();
  const creds = init.creds ?? merchantCredentials();
  const signal = AbortSignal.timeout(init.timeoutMs ?? 20_000);
  const maxAttempts = init.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    await throttle(creds.clientId, signal);
    signal.throwIfAborted();
    try {
      const res = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        signal,
        headers: {
          Authorization: `Bearer ${await accessToken(creds, signal)}`,
          "Content-Type": "application/json",
          ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      const body = text ? JSON.parse(text) : {};
      if (res.status === 401) tokens.delete(creds.clientId); // token revoked or permissions changed
      if (res.ok) return body as T;
      if ((res.status === 429 || res.status >= 500 || res.status === 401) && attempt < maxAttempts) {
        await sleep(attempt * 2_000, signal);
        continue;
      }
      throw new PayPalError(res.status, body);
    } catch (err) {
      if (signal.aborted || err instanceof PayPalError || attempt >= maxAttempts) throw err;
      await sleep(attempt * 2_000, signal); // network error: retry, the request id keeps it safe
    }
  }
}
