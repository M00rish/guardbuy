import { requirePublicDemo } from "../lib/demo/dashboard.server";
import { CONSOLE_SHELL } from "../lib/judge/console-shell";

// Public judge console: https://guardbuy.onrender.com/demo — no Shopify login and no app install.
// A development store cannot drop its password page, so the app-proxy copy stays for the branded
// URL and this one is the link judges actually open. Each browser acts only on its own sandbox.
const demoShop = () => process.env.GUARDBUY_DEMO_STORE ?? "guardbuy-demo.myshopify.com";

export const loader = async () => {
  requirePublicDemo(demoShop());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>GuardBuy — judge console</title></head>
<body style="margin:0;background:#f6f8f5">${CONSOLE_SHELL}</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
};
