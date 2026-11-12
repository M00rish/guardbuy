// Public shell for the judge console. Static HTML + vanilla JS: every remote value is rendered with
// textContent, never HTML or Liquid. Served by /demo (no auth) and by the app proxy (storefront).
// Keep "{{" and "{%" out of this file: Shopify runs proxy responses as Liquid.
export const CONSOLE_SHELL = `
<style>
  .gb { max-width: 940px; margin: 0 auto; padding: 32px 20px 56px; color:#18312c; font:16px/1.55 system-ui,-apple-system,sans-serif; }
  .gb * { box-sizing: border-box; }
  .gb h1 { font-size: clamp(30px,5vw,44px); line-height:1.1; letter-spacing:-1px; margin:10px 0 8px; }
  .gb h2 { font-size:18px; margin:32px 0 10px; }
  .gb p { margin:8px 0; }
  .gb .badge { display:inline-block; background:#e6f1eb; color:#234d3f; padding:5px 11px; border-radius:20px; font-size:13px; font-weight:650; }
  .gb .lede { max-width:720px; font-size:17px; color:#2c4a41; }
  .gb .muted { color:#52665f; font-size:14px; }
  .gb .scenes { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin:22px 0 10px; }
  .gb .scene { text-align:left; background:#fff; border:1px solid #cfdcd3; border-radius:12px; padding:16px; cursor:pointer; font:inherit; color:inherit; transition:border-color .15s, box-shadow .15s; }
  .gb .scene:hover { border-color:#234d3f; box-shadow:0 1px 0 #234d3f; }
  .gb .scene b { display:block; font-size:17px; margin-bottom:4px; }
  .gb .scene span { display:block; font-size:13px; color:#52665f; }
  .gb .scene em { display:block; font-style:normal; font-size:12px; color:#8b3d16; margin-top:8px; font-weight:600; }
  .gb .msg { min-height:1.5em; color:#234d3f; font-weight:600; margin-top:14px; }
  .gb .rules { background:#f1f5f1; border:1px solid #dbe5dc; border-radius:10px; padding:12px 14px; font-size:14px; margin-top:6px; }
  .gb .card { background:#fff; border:1px solid #dbe5dc; border-radius:12px; padding:16px; margin:10px 0; }
  .gb .card .total { font-weight:700; }
  .gb .card ul { margin:8px 0; padding-left:18px; }
  .gb .ai { background:#f5f5f2; border-radius:8px; padding:10px 12px; margin-top:8px; font-size:14px; }
  .gb .ai b { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#6b7f77; margin-bottom:4px; }
  .gb .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; align-items:center; }
  .gb button.primary, .gb button.plain { font:inherit; padding:9px 15px; border-radius:8px; cursor:pointer; }
  .gb button.primary { background:#234d3f; color:#fff; border:1px solid #234d3f; }
  .gb button.plain { background:#fff; color:#234d3f; border:1px solid #9fb6aa; }
  .gb button:disabled { opacity:.45; cursor:wait; }
  .gb ul.feed { list-style:none; padding:0; margin:0; }
  .gb ul.feed li { border-left:3px solid #dbe5dc; padding:7px 12px; margin:7px 0; }
  .gb li.k-block, .gb li.k-failed, .gb li.k-slipped { border-color:#d92d20; }
  .gb li.k-paid, .gb li.k-approved, .gb li.k-resisted, .gb li.k-auto { border-color:#12b76a; }
  .gb li.k-approval, .gb li.k-flagged { border-color:#f79009; }
  .gb li.k-attack { border-color:#7a5af8; }
  .gb li.k-stock, .gb li.k-proposed { border-color:#2e90fa; }
  .gb li .time { color:#6b7f77; font-size:12px; }
  .gb .chain { font-weight:650; font-size:14px; }
  .gb details { margin-top:28px; border-top:1px solid #dbe5dc; padding-top:14px; }
  .gb summary { cursor:pointer; font-weight:650; }
  .gb .stats { display:flex; flex-wrap:wrap; gap:18px; margin:10px 0; }
  .gb .stat b { display:block; font-size:22px; }
  .gb .stat span { font-size:12px; color:#52665f; }
  .gb a { color:#234d3f; }
  .gb :focus-visible { outline:3px solid #b36a20; outline-offset:2px; }
  .gb .foot { margin-top:30px; display:flex; flex-wrap:wrap; gap:14px; align-items:center; }
</style>
<div class="gb">
  <span class="badge">Live demo · PayPal sandbox · no login</span>
  <h1>GuardBuy</h1>
  <p class="lede">An AI restocks this coffee shop, but it can only spend money inside rules the merchant signed.
  Pick a scene: each button runs the real agent, the real policy engine and real PayPal sandbox payments
  inside a private sandbox just for you. Nothing here touches a real store or real money.</p>

  <div class="scenes" id="gb-scenes">
    <button class="scene" data-scene="allow" type="button"><b>Allow</b><span>Approval above $200. The agent pays the supplier without asking.</span><em>Expect: paid automatically</em></button>
    <button class="scene" data-scene="ask" type="button"><b>Ask me</b><span>Approval above $50. It waits for you before paying.</span><em>Expect: needs your approval</em></button>
    <button class="scene" data-scene="block" type="button"><b>Block</b><span>Weekly cap $30. The rules stop it before PayPal is called.</span><em>Expect: blocked</em></button>
  </div>
  <p class="muted">A scene simulates a customer sale (coffee drops from 9 to 3 bags) and lets the agent react.</p>
  <p class="msg" id="gb-msg" role="status" aria-live="polite"></p>
  <div class="rules" id="gb-rules" hidden></div>

  <div id="gb-approvals"></div>

  <h2>What the agent did</h2>
  <p class="chain" id="gb-chain">Loading…</p>
  <ul class="feed" id="gb-feed"><li class="muted">Loading…</li></ul>

  <details id="gb-attacks">
    <summary>Adversarial tests — prompt injection against the AI</summary>
    <p class="muted">A dishonest supplier writes instructions into its product note. The AI reads it. The rules still decide.</p>
    <div class="actions">
      <button class="plain" data-action="attack" type="button">Run the next attack</button>
      <button class="plain" data-action="whatif" type="button">What if the AI were fooled?</button>
    </div>
    <div id="gb-score"></div>
  </details>

  <div class="foot">
    <button class="plain" id="gb-again" type="button">Start over</button>
    <span class="muted">Sandbox <code id="gb-id">…</code> · stays in this browser</span>
    <a class="muted" id="gb-store" href="/collections/all" target="_blank" rel="noopener">See the demo store ↗</a>
  </div>
  <p class="muted">This page is public and shared with other judges, but each browser gets its own sandbox: its own rules,
  audit log and approvals. Supplier emails, staff identities and raw provider errors are never returned.</p>
</div>
<script>
(function () {
  var api = location.pathname.replace(/\\/$/, "") + "/api";
  var ID = /^[a-z0-9-]{8,40}$/;
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function newId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(36).slice(2)).toLowerCase(); }
  var params = new URLSearchParams(location.search);
  var id = (params.get("session") || store("gb_judge") || newId()).toLowerCase();
  if (!ID.test(id)) id = newId();
  store("gb_judge", id);
  document.getElementById("gb-id").textContent = id;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function say(t) { document.getElementById("gb-msg").textContent = t; }
  function buttons() { return document.querySelectorAll(".gb button"); }
  function busy(on) { buttons().forEach(function (b) { b.disabled = on; }); if (!on) markScene(); }
  function markScene() {
    var last = store("gb_preset");
    document.querySelectorAll(".gb .scene").forEach(function (b) {
      b.style.borderColor = b.getAttribute("data-scene") === last ? "#234d3f" : "";
      b.style.boxShadow = b.getAttribute("data-scene") === last ? "0 0 0 2px #234d3f inset" : "";
    });
  }

  function renderFeed(items) {
    var feed = document.getElementById("gb-feed");
    feed.replaceChildren();
    if (!items.length) { feed.appendChild(el("li", "muted", "Nothing yet. Pick a scene above.")); return; }
    items.forEach(function (item) {
      var li = el("li", "k-" + item.kind);
      li.appendChild(el("div", null, item.title));
      if (item.detail) li.appendChild(el("div", "muted", item.detail));
      if (item.untrusted) {
        var ai = el("div", "ai");
        ai.appendChild(el("b", null, item.untrustedLabel || "Untrusted text, not verified"));
        ai.appendChild(el("span", null, item.untrusted));
        li.appendChild(ai);
      }
      li.appendChild(el("div", "time", "#" + item.seq + " · " + new Date(item.at).toLocaleTimeString()));
      feed.appendChild(li);
    });
  }

  function renderApprovals(list) {
    var box = document.getElementById("gb-approvals");
    box.replaceChildren();
    if (!list.length) return;
    box.appendChild(el("h2", null, "Waiting for your approval"));
    list.forEach(function (a) {
      var card = el("div", "card");
      card.appendChild(el("div", "total", a.title + " · " + a.total));
      var ul = el("ul", "muted");
      a.facts.forEach(function (f) { ul.appendChild(el("li", null, f)); });
      card.appendChild(ul);
      var ai = el("div", "ai");
      ai.appendChild(el("b", null, "The AI's explanation (not verified)"));
      ai.appendChild(el("span", null, a.aiExplanation));
      card.appendChild(ai);
      var row = el("div", "actions");
      if (a.waitingForPayPal) row.appendChild(el("span", "muted", "Waiting for approval in PayPal."));
      else {
        var yes = el("button", "primary", "Approve and pay " + a.total);
        yes.onclick = function () { act("approve", { decisionSeq: a.decisionSeq }); };
        var no = el("button", "plain", "Decline");
        no.onclick = function () { act("decline", { decisionSeq: a.decisionSeq }); };
        row.appendChild(yes); row.appendChild(no);
      }
      card.appendChild(row);
      box.appendChild(card);
    });
  }

  function render(data) {
    if (data.rules) {
      var r = document.getElementById("gb-rules");
      r.hidden = false;
      r.textContent = "Signed rules in this sandbox: purchases above " + data.rules.approvalAbove +
        " need your approval · weekly cap " + data.rules.weeklyCap + ". Every decision records this rule set.";
    }
    renderApprovals(data.approvals || []);
    renderFeed(data.feed || []);
    var c = data.chain;
    document.getElementById("gb-chain").textContent = c.valid
      ? "Audit log: " + c.entries + " entries, hash chain intact"
      : "Audit log: BROKEN at entry #" + c.brokenAt + " (" + c.reason + ")";
    var sc = data.scoreboard, box = document.getElementById("gb-score");
    box.replaceChildren();
    if (!sc.tried) { box.appendChild(el("p", "muted", "No attacks run in this sandbox yet.")); return; }
    var stats = el("div", "stats");
    [[sc.tried, "attacks tried"], [sc.aiFooled + " / " + sc.answered, "times the AI was fooled"],
     [sc.blockedDollars, "blocked by rules"], [sc.flaggedDollars, "held for a person"],
     [sc.slippedDollars, "known gaps"]].forEach(function (s) {
      var d = el("div", "stat"); d.appendChild(el("b", null, String(s[0]))); d.appendChild(el("span", null, s[1])); stats.appendChild(d);
    });
    box.appendChild(stats);
    box.appendChild(el("p", "muted", sc.remaining > 0 ? sc.remaining + " of the attacks not tried yet in this sandbox." : "Every attack has been tried. Start over to run them again."));
  }

  function load() {
    return fetch(api + "?j=" + encodeURIComponent(id), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) render(d); else say(d.message); })
      .catch(function () { say("Couldn't load the activity. Retrying…"); });
  }

  var act;
  function rawAct(intent, extra) {
    busy(true);
    var body = new URLSearchParams({ j: id, intent: intent });
    Object.keys(extra || {}).forEach(function (k) { body.set(k, String(extra[k])); });
    return fetch(api, { method: "POST", body: body, headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { say(d.message); return load(); })
      .catch(function () { say("That didn't go through. Nothing was paid twice; try again."); })
      .finally(function () { busy(false); });
  }
  act = function (intent, extra) { fastUntil = Date.now() + 120000; return rawAct(intent, extra); };

  document.querySelectorAll(".gb .scene").forEach(function (b) {
    b.onclick = function () {
      var preset = b.getAttribute("data-scene");
      id = newId();
      store("gb_judge", id);
      store("gb_preset", preset);
      document.getElementById("gb-id").textContent = id;
      say("Starting a fresh sandbox and signing the " + preset + " rules. The AI can take up to a minute…");
      act("scene", { preset: preset });
    };
  });
  document.getElementById("gb-again").onclick = function () {
    var preset = store("gb_preset") || "ask";
    id = newId(); store("gb_judge", id); document.getElementById("gb-id").textContent = id;
    say("Fresh sandbox. Running the " + preset + " scene again…");
    act("scene", { preset: preset });
  };
  document.querySelectorAll(".gb [data-action]").forEach(function (b) {
    b.onclick = function () { act(b.getAttribute("data-action"), {}); };
  });
  document.getElementById("gb-store").href = "https://" + "guardbuy-demo.myshopify.com" + "/collections/all";

  var fastUntil = 0, lastPoll = 0;
  markScene();
  load();
  setInterval(function () {
    var gap = Date.now() < fastUntil ? 3000 : 20000;
    if (!document.hidden && Date.now() - lastPoll >= gap) { lastPoll = Date.now(); load(); }
  }, 1000);
})();
</script>
`;
