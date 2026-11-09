import { timingSafeEqual } from "node:crypto";
export function telegramConfig() {
  if (process.env.TELEGRAM_ALERTS_ENABLED !== "true") return null;
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const username = process.env.TELEGRAM_BOT_USERNAME ?? "";
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  if (
    !/^\d+:[\w-]{20,}$/.test(token) ||
    !/^[a-zA-Z0-9_]{5,32}$/.test(username) ||
    !/^[\w-]{32,256}$/.test(secret) ||
    !/^[a-zA-Z0-9_-]+$/.test(apiKey)
  )
    return null;
  return { token, username, secret, apiKey };
}
export function sameSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function merchantLink(shop: string, kind: string, decisionSeq?: number) {
  const config = telegramConfig();
  if (!config || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))
    throw new Error("Invalid alert destination");
  const store = shop.slice(0, -".myshopify.com".length);
  const activity = kind === "integrity" || kind === "restock";
  const params = new URLSearchParams(activity ? {} : { tab: "approvals" });
  if (decisionSeq !== undefined) params.set("purchase", String(decisionSeq));
  // Same embedded-admin root as Shopify SDK buildEmbeddedAppUrl; no bearer token in the link.
  const query = params.size ? `?${params}` : "";
  return `https://admin.shopify.com/store/${store}/apps/${config.apiKey}/app/${activity ? "activity" : "rules"}${query}`;
}
