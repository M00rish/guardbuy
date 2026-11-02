import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { requirePublicDemo } from "../lib/demo/dashboard.server";

// Static shell only: all remote values are rendered with textContent, never Liquid or HTML.
export const SHELL = `
<style>
  .gb { max-width:1100px; margin:40px auto; padding:0 20px 40px; color:#18312c; font:16px/1.55 system-ui,sans-serif; }
  .gb * { box-sizing:border-box; } .gb h1 { font-size:clamp(30px,5vw,48px); line-height:1.15; margin:12px 0; letter-spacing:-1px; }
  .gb h2 { font-size:22px; margin:0 0 14px; } .gb p { margin:8px 0; } .gb .muted { color:#52665f; font-size:14px; }
  .gb .badge { display:inline-block; background:#e6f1eb; padding:5px 10px; border-radius:20px; font-size:13px; font-weight:650; }
  .gb .lead { max-width:750px; font-size:18px; } .gb .actions { display:flex; gap:12px; flex-wrap:wrap; margin:22px 0; align-items:center; }
  .gb .button { font:inherit; display:inline-block; padding:11px 18px; border:1px solid #234d3f; border-radius:8px; background:#fff; color:#234d3f; text-decoration:none; cursor:pointer; }
  .gb .primary { background:#234d3f; color:#fff; } .gb button:disabled { opacity:.5; cursor:wait; }
  .gb .steps { border-left:3px solid #b5cdbd; padding:8px 16px; margin:22px 0; }
  .gb .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:14px; margin:24px 0; }
  .gb .card { background:#f5f8f4; border:1px solid #dbe5dc; border-radius:12px; padding:20px; }
  .gb .stat strong { display:block; font-size:34px; line-height:1.3; } .gb .columns { display:grid; grid-template-columns:1.2fr 1fr; gap:24px; margin-top:28px; }
  .gb .product { border-bottom:1px solid #dbe5dc; padding:14px 0; } .gb .product:first-child { padding-top:0; } .gb a { color:#234d3f; }
  .gb .low { color:#8b3d16; font-weight:650; } .gb ol { padding-left:22px; } .gb li { margin:0 0 16px; }
  .gb .notice { border:1px solid #dbe5dc; border-radius:8px; padding:14px; margin-top:22px; } .gb :focus-visible { outline:3px solid #b36a20; outline-offset:3px; }
  @media(max-width:700px) { .gb .columns { grid-template-columns:1fr; } }
</style>
<div class="gb">
  <span class="badge">Live demo store · PayPal sandbox</span>
  <h1>Buy in the store.<br>Watch GuardBuy respond.</h1>
  <p class="lead">Place a test order in another tab. Watch available stock change, then follow the AI restock proposal, policy decision and supplier payment here.</p>
  <div class="actions">
    <a class="button primary" href="/collections/all" target="_blank" rel="noopener">Open the store ↗</a>
    <button class="button" id="gb-refresh" type="button">Refresh dashboard</button>
    <span class="muted" id="gb-updated" role="status" aria-live="polite">Loading live data…</span>
  </div>
  <p class="muted">Use the test checkout configured by the demo host. Customer checkout and GuardBuy’s supplier payment are separate transactions.</p>
  <div class="steps">Store checkout → stock change → AI proposal → policy checks → merchant review if required → supplier payment</div>
  <div class="stats" id="gb-stats"></div>
  <p id="gb-agent" class="muted"></p>
  <div class="columns">
    <section class="card"><h2>Managed store stock</h2><div id="gb-stock">Loading…</div><p class="muted">Available units across locations. Reorder levels depend on sales history and the merchant’s rules.</p></section>
    <section class="card"><h2>Supplier payment outcomes</h2><div id="gb-payments">Loading…</div><p class="muted">Latest recorded PayPal sandbox outcomes, across this store’s restock history. They are not customer checkout payments.</p><p class="muted">The merchant checks statuses in Activity or Approvals. This public page does not refresh PayPal, approve purchases, or send money.</p></section>
  </div>
  <section class="card" style="margin-top:24px"><h2>Restock activity</h2><p class="muted">Latest 30 recorded steps, newest first. Attack simulations are excluded. This is a shared store view, not a private session or proof that a particular order caused a payment.</p><ol id="gb-timeline"></ol></section>
  <div class="notice"><strong>What to expect</strong><p>Stock changes arrive through Shopify webhooks. A restock starts only when the product is managed, the agent is on, stock is below its threshold, and no existing restock blocks a new one. AI and payment processing can take time.</p><p class="muted">Paying a supplier does not immediately replenish inventory. Stock increases when the merchant records received goods. Merchant approvals and attack tests stay inside the authenticated GuardBuy app.</p></div>
</div>
<script>
(function () {
  var api = location.pathname.replace(/\\/$/, "") + "/api";
  var loading = false, lastStocks = new Map(), changes = new Map();
  var button = document.getElementById("gb-refresh");
  var updated = document.getElementById("gb-updated");
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = String(text); return node; }
  function render(data) {
    var stats = document.getElementById("gb-stats"); stats.replaceChildren();
    var orderCount = data.orders ? String(data.orders.count) + (data.orders.precision === "EXACT" ? "" : "+") : "Unavailable";
    [[orderCount, "Test orders today · UTC"], [data.stock ? data.stock.products.length : "Unavailable", "Managed variants shown"], [data.decisions.proposals, "Restock proposals · all time"], [data.payments.total, "Supplier payments submitted · all time"]].forEach(function (pair) {
      var card = el("div", "card stat"); card.append(el("strong", null, pair[0]), el("span", "muted", pair[1])); stats.appendChild(card);
    });
    document.getElementById("gb-agent").textContent = (data.agentRunning ? "Agent enabled." : "Agent paused or rules not configured.") + " Policy decisions so far: " + data.decisions.automatic + " automatic, " + data.decisions.review + " required review, " + data.decisions.blocked + " blocked.";
    var stock = document.getElementById("gb-stock"); stock.replaceChildren();
    if (!data.stock) stock.appendChild(el("p", null, "Stock is temporarily unavailable. Try refreshing."));
    else {
      if (!data.stock.products.length) stock.appendChild(el("p", null, "No managed products are available. The demo host needs to prepare a product."));
      if (data.stock.truncated) stock.appendChild(el("p", "muted", "Showing the first 50 managed variants."));
      data.stock.products.forEach(function (p) {
        var key = p.title + p.href;
        if (lastStocks.has(key) && lastStocks.get(key) !== p.available && lastStocks.get(key) !== null && p.available !== null) changes.set(key, lastStocks.get(key) + " → " + p.available + " units (observed in this tab)");
        lastStocks.set(key, p.available);
        var row = el("div", "product"), link = el("a", null, p.title);
        if (p.href.indexOf("/products/") === 0) link.href = p.href;
        link.target = "_blank"; link.rel = "noopener";
        row.append(link, el("p", p.low ? "low" : "", p.available === null ? "Stock unavailable" : p.available + " units available" + (p.low ? " · Low stock" : "")));
        row.appendChild(el("p", "muted", p.reorderBelowUnits === null ? "Reorder threshold unavailable" : "Restock below " + p.reorderBelowUnits + " units"));
        if (changes.has(key)) row.appendChild(el("p", "muted", changes.get(key)));
        stock.appendChild(row);
      });
    }
    var payments = document.getElementById("gb-payments"); payments.replaceChildren();
    [[data.payments.successful, "successful"], [data.payments.pending, "pending / unconfirmed"], [data.payments.failed, "failed / blocked"], [data.payments.refunded, "returned / refunded / reversed"]].forEach(function (pair) { payments.appendChild(el("p", null, pair[0] + " " + pair[1])); });
    var timeline = document.getElementById("gb-timeline"); timeline.replaceChildren();
    if (!data.timeline.length) timeline.appendChild(el("li", "muted", "No restock activity yet. Place a test order for a prepared product to begin."));
    data.timeline.forEach(function (item) { var li = el("li"); li.append(el("div", null, item.text), el("span", "muted", new Date(item.at).toLocaleString())); timeline.appendChild(li); });
    updated.textContent = "Snapshot " + new Date(data.checkedAt).toLocaleTimeString() + " · refreshes every 15 seconds";
  }
  async function load() {
    if (loading) return;
    loading = true; button.disabled = true;
    var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch(api, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Unavailable");
      var data = await response.json(); if (!data.ok) throw new Error("Unavailable"); render(data);
    } catch (e) { updated.textContent = "Could not refresh. Any displayed values are from the previous snapshot. Retrying…"; }
    finally { clearTimeout(timeout); loading = false; button.disabled = false; }
  }
  button.onclick = load;
  load();
  setInterval(function () { if (!document.hidden) load(); }, 15000);
})();
</script>
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  requirePublicDemo(session.shop);
  return liquid(SHELL, { headers: { "Cache-Control": "no-store" } });
};
