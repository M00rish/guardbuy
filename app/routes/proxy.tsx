import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

// Judge console on the storefront: https://<shop>/apps/guardbuy (no Shopify login needed).
// Shopify signs every proxied request; appProxy() rejects anything unsigned.
// This shell is static: it contains no data, so no supplier or AI text ever passes through Liquid.
// The page fetches its data as JSON from /apps/guardbuy/api and renders it with textContent only.
// (Keep "{{" and "{%" out of this file: Shopify would run them as Liquid.)

const SHELL = `
<style>
  .gb { max-width: 760px; margin: 32px auto; padding: 0 16px; font-family: system-ui, -apple-system, sans-serif; color: #1a1a1a; line-height: 1.5; }
  .gb h1 { font-size: 1.8rem; margin: 0 0 4px; }
  .gb h2 { font-size: 1.1rem; margin: 28px 0 8px; }
  .gb .lede { color: #555; margin: 0 0 16px; }
  .gb .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
  .gb button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
  .gb button.primary { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .gb button.danger { color: #b42318; }
  .gb button:disabled { opacity: .5; cursor: default; }
  .gb .msg { min-height: 1.5em; color: #555; }
  .gb .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; margin: 8px 0; background: #fff; }
  .gb .muted { color: #666; font-size: .9rem; }
  .gb .ai { background: #f5f5f5; border-radius: 8px; padding: 10px; margin-top: 8px; font-size: .92rem; }
  .gb .ai b { display: block; font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; color: #666; }
  .gb ul.feed { list-style: none; padding: 0; margin: 0; }
  .gb ul.feed li { border-left: 3px solid #ddd; padding: 6px 12px; margin: 6px 0; }
  .gb li.k-block { border-color: #d92d20; } .gb li.k-paid { border-color: #12b76a; } .gb li.k-approval { border-color: #f79009; }
  .gb li.k-attack { border-color: #7a5af8; } .gb li.k-resisted { border-color: #12b76a; }
  .gb li.k-failed { border-color: #d92d20; } .gb li.k-stock { border-color: #2e90fa; } .gb li.k-approved { border-color: #12b76a; }
  .gb .chain { font-weight: 600; }
</style>
<div class="gb">
  <h1>GuardBuy</h1>
  <p class="lede">An AI restocks this coffee shop, but it can only spend PayPal money inside rules the merchant signed. Try it: these buttons run the real agent, the real rules engine and real PayPal sandbox payments, in a private sandbox just for you.</p>
  <div class="actions">
    <button class="primary" data-action="restock">Simulate a sale (low stock)</button>
    <button data-action="attack">Send the dishonest supplier (real AI)</button>
    <button data-action="whatif">What if the AI were fooled?</button>
    <button data-action="verify">Verify the log</button>
    <button data-action="new">New session</button>
  </div>
  <p class="msg" id="gb-msg"></p>
  <div id="gb-approvals"></div>
  <h2>Activity</h2>
  <p class="chain" id="gb-chain"></p>
  <ul class="feed" id="gb-feed"><li class="muted">Loading...</li></ul>
  <p class="muted">Your session id stays in this browser. To continue on another device, open this page with ?session=<span id="gb-id"></span></p>
</div>
<script>
(function () {
  var api = location.pathname.replace(/\\/$/, "") + "/api";
  var params = new URLSearchParams(location.search);
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function newId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2)).toLowerCase(); }
  var id = params.get("session") || store("gb_judge") || newId();
  store("gb_judge", id);
  document.getElementById("gb-id").textContent = id;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(text) { document.getElementById("gb-msg").textContent = text; }

  function render(data) {
    var feed = document.getElementById("gb-feed");
    feed.replaceChildren();
    data.feed.forEach(function (item) {
      var li = el("li", "k-" + item.kind);
      li.appendChild(el("div", null, item.title));
      if (item.detail) li.appendChild(el("div", "muted", item.detail));
      if (item.untrusted) { var ai = el("div", "ai"); ai.appendChild(el("b", null, item.untrustedLabel || "Untrusted text")); ai.appendChild(el("span", null, item.untrusted)); li.appendChild(ai); }
      li.appendChild(el("div", "muted", "#" + item.seq + " · " + new Date(item.at).toLocaleTimeString()));
      feed.appendChild(li);
    });
    var box = document.getElementById("gb-approvals");
    box.replaceChildren();
    if (data.approvals.length) box.appendChild(el("h2", null, "Waiting for your approval"));
    data.approvals.forEach(function (a) {
      var card = el("div", "card");
      card.appendChild(el("div", null, a.title + " · " + a.total));
      var ul = el("ul", "muted");
      a.facts.forEach(function (f) { ul.appendChild(el("li", null, f)); });
      card.appendChild(ul);
      var ai = el("div", "ai"); ai.appendChild(el("b", null, "The AI's explanation (not verified)")); ai.appendChild(el("span", null, a.aiExplanation)); card.appendChild(ai);
      var row = el("div", "actions");
      if (a.waitingForPayPal) row.appendChild(el("span", "muted", "Waiting for approval in PayPal."));
      else {
        var yes = el("button", "primary", "Approve and pay " + a.total); yes.onclick = function () { act("approve", a.decisionSeq); };
        var no = el("button", "danger", "Decline"); no.onclick = function () { act("decline", a.decisionSeq); };
        row.appendChild(yes); row.appendChild(no);
      }
      card.appendChild(row);
      box.appendChild(card);
    });
    var c = data.chain;
    document.getElementById("gb-chain").textContent = c.valid ? "Audit log: " + c.entries + " entries, hash chain intact" : "Audit log: BROKEN at entry #" + c.brokenAt + " (" + c.reason + ")";
  }

  function load() {
    return fetch(api + "?j=" + encodeURIComponent(id), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) render(d); else say(d.message); })
      .catch(function () { say("Couldn't load the activity. Retrying..."); });
  }

  var buttons = document.querySelectorAll(".gb button[data-action]");
  function busy(on) { buttons.forEach(function (b) { b.disabled = on; }); }

  function act(intent, decisionSeq) {
    busy(true); say("Working...");
    var body = new URLSearchParams({ j: id, intent: intent });
    if (decisionSeq != null) body.set("decisionSeq", String(decisionSeq));
    return fetch(api, { method: "POST", body: body, headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) { say(d.message); return load(); })
      .catch(function () { say("That didn't go through. Nothing was paid twice; try again."); })
      .finally(function () { busy(false); });
  }

  buttons.forEach(function (b) {
    b.onclick = function () {
      var a = b.getAttribute("data-action");
      if (a === "verify") { say("Recomputing every hash from the first entry..."); load().then(function () { say(document.getElementById("gb-chain").textContent); }); }
      else if (a === "new") { id = newId(); store("gb_judge", id); document.getElementById("gb-id").textContent = id; say("New session started."); load(); }
      else act(a);
    };
  });

  // Poll every 3s for 90s after an action (Gemini and PayPal take a while), otherwise every 30s,
  // so an open tab doesn't keep the database awake.
  var fastUntil = 0, lastPoll = 0;
  var origAct = act;
  act = function (intent, decisionSeq) { fastUntil = Date.now() + 90000; return origAct(intent, decisionSeq); };
  load();
  setInterval(function () {
    var gap = Date.now() < fastUntil ? 3000 : 30000;
    if (!document.hidden && Date.now() - lastPoll >= gap) { lastPoll = Date.now(); load(); }
  }, 1000);
})();
</script>
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid } = await authenticate.public.appProxy(request);
  return liquid(SHELL);
};
