/**
 * The embedded Watchtower dashboard — a single self-contained HTML document
 * (no build step, no external assets, CSP-friendly: everything first-party).
 * Hash-routed views: status board, route detail, alerts, watches, exposure.
 * Live via SSE. The hosted product re-implements this IA in a full frontend;
 * see docs/watchtower.md §5.
 *
 * NOTE: the client script deliberately avoids backticks and "${" so it can
 * live inside this TypeScript template literal verbatim.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>evmsec watchtower — bridge backing, live</title>
<style>
:root {
  --bg: #0d1117; --panel: #161b22; --line: #21262d; --text: #e6edf3;
  --muted: #8b949e; --ok: #3fb950; --bad: #f85149; --warn: #d29922;
  --accent: #58a6ff; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { display: flex; align-items: center; gap: 18px; padding: 12px 20px;
  border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 15px; }
.brand span { color: var(--muted); font-weight: 400; }
nav a { margin-right: 12px; color: var(--muted); }
nav a.active, nav a:hover { color: var(--text); }
.spacer { flex: 1; }
.pill { padding: 2px 10px; border-radius: 999px; font-family: var(--mono);
  font-size: 12px; border: 1px solid var(--line); }
.pill.ok { color: var(--ok); border-color: var(--ok); }
.pill.bad { color: var(--bad); border-color: var(--bad); }
.pill.warn { color: var(--warn); border-color: var(--warn); }
.pill.muted { color: var(--muted); }
main { max-width: 1180px; margin: 0 auto; padding: 20px; }
h2 { font-size: 16px; margin: 4px 0 14px; }
.kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 16px; min-width: 130px; }
.kpi .n { font-family: var(--mono); font-size: 20px; }
.kpi .l { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line);
  font-size: 13px; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
td.num, th.num { text-align: right; font-family: var(--mono); }
tr:last-child td { border-bottom: none; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: rgba(88,166,255,.06); }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); }
.v-BACKED { color: var(--ok); } .v-UNDERCOLLATERALIZED { color: var(--bad); font-weight: 700; }
.v-ERROR { color: var(--warn); } .v-NO_SUPPLY { color: var(--muted); }
svg.spark { display: block; }
form.card, .card { background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; padding: 16px; margin-bottom: 16px; }
label { display: block; color: var(--muted); font-size: 12px; margin: 10px 0 3px; }
input, select { background: var(--bg); color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 9px; font-family: var(--mono); font-size: 13px; width: 100%; }
.row { display: flex; gap: 12px; } .row > div { flex: 1; }
button { background: #1f6feb; color: #fff; border: 0; border-radius: 6px;
  padding: 7px 16px; font-size: 13px; cursor: pointer; margin-top: 12px; }
button.ghost { background: transparent; border: 1px solid var(--line); color: var(--text); }
button:hover { filter: brightness(1.15); }
.err { color: var(--bad); font-size: 13px; margin-top: 8px; }
footer { color: var(--muted); text-align: center; font-size: 12px; padding: 24px; }
.crumb { color: var(--muted); font-size: 13px; margin-bottom: 10px; display: inline-block; }
.note { color: var(--muted); font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <div class="brand">⛨ evmsec <span>watchtower</span></div>
  <nav id="nav">
    <a href="#/" data-view="board">board</a>
    <a href="#/alerts" data-view="alerts">alerts</a>
    <a href="#/watches" data-view="watches">watches</a>
    <a href="#/exposure" data-view="exposure">exposure</a>
  </nav>
  <div class="spacer"></div>
  <span id="overall" class="pill muted">connecting…</span>
</header>
<main id="view"><p class="muted">loading…</p></main>
<footer>read-only on-chain monitoring · a heuristic over live balances, not a proof ·
  <a href="https://github.com/0xSoftBoi/evmsec" rel="noreferrer">evmsec</a></footer>
<script>
"use strict";
var S = { status: null, alerts: [], watches: [], exposure: null, exposureAddr: "", exposureBusy: false };

function esc(x) {
  return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function getJSON(path) { return fetch(path).then(function (r) { return r.json(); }); }
function fmtUsd(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  var a = Math.abs(n);
  if (a >= 1e9) return "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return "$" + (a / 1e3).toFixed(1) + "K";
  return "$" + a.toFixed(2);
}
function fmtNum(x) {
  var v = Number(x);
  if (!isFinite(v)) return esc(x);
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function fmtRatio(r) { return r == null ? "—" : Number(r).toFixed(2) + "%"; }
function fmtTime(iso) { return iso ? String(iso).replace("T", " ").slice(0, 19) + "Z" : "—"; }
function mark(v) { return v === "BACKED" ? "✓" : v === "UNDERCOLLATERALIZED" ? "✗" : v === "ERROR" ? "⚠" : "·"; }

function spark(points, w, h) {
  var vals = (points || []).filter(function (p) { return typeof p === "number"; });
  if (vals.length < 2) return '<span class="muted mono">·</span>';
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var span = (max - min) || 1;
  var step = w / (vals.length - 1), d = "";
  for (var i = 0; i < vals.length; i++) {
    var x = (i * step).toFixed(1);
    var y = (h - 2 - ((vals[i] - min) / span) * (h - 4)).toFixed(1);
    d += (i ? " L" : "M") + x + " " + y;
  }
  var color = vals[vals.length - 1] >= 100 ? "var(--ok)" : "var(--bad)";
  return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '">' +
    '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5"/></svg>';
}

function overallPill() {
  var el = document.getElementById("overall");
  if (!S.status || !S.status.generatedAt) { el.className = "pill muted"; el.textContent = "first sweep running…"; return; }
  var o = S.status.overall;
  el.className = "pill " + (o === "backed" ? "ok" : o === "undercollateralized" ? "bad" : "warn");
  el.textContent = S.status.backed + "/" + S.status.total + " backed" +
    (S.status.totalLockedUsd ? " · " + fmtUsd(S.status.totalLockedUsd) : "");
}

function routeRow(r) {
  return '<tr class="clickable" data-route="' + esc(r.id) + '">' +
    '<td class="v-' + esc(r.verdict) + '">' + mark(r.verdict) + " " + esc(r.verdict) + "</td>" +
    "<td>" + esc(r.bridge) + "</td><td>" + esc(r.asset) + "</td>" +
    '<td class="muted">' + esc(r.lockChain) + " → " + esc(r.mintChain) + "</td>" +
    '<td class="num">' + fmtNum(r.locked) + '</td><td class="num">' + fmtNum(r.minted) + "</td>" +
    '<td class="num">' + fmtRatio(r.ratioPct) + '</td><td class="num">' + fmtUsd(r.lockedUsd) + "</td>" +
    "<td>" + spark(r.spark, 90, 24) + "</td></tr>";
}

function viewBoard() {
  if (!S.status || !S.status.generatedAt) {
    return "<h2>Status board</h2><p class='muted'>First sweep is running — live data appears the moment it lands (this page updates itself).</p>";
  }
  var s = S.status;
  var kpis = '<div class="kpis">' +
    '<div class="kpi"><div class="n">' + s.backed + "/" + s.total + '</div><div class="l">routes backed</div></div>' +
    '<div class="kpi"><div class="n">' + fmtUsd(s.totalLockedUsd) + '</div><div class="l">locked collateral tracked</div></div>' +
    '<div class="kpi"><div class="n">' + (s.breached || 0) + '</div><div class="l">breached</div></div>' +
    '<div class="kpi"><div class="n">' + fmtTime(s.generatedAt) + '</div><div class="l">last sweep</div></div></div>';
  var rows = s.routes.map(routeRow).join("");
  return "<h2>Status board</h2>" + kpis +
    "<table><thead><tr><th>Status</th><th>Bridge</th><th>Asset</th><th>Route</th>" +
    '<th class="num">Locked</th><th class="num">Minted</th><th class="num">Backing</th>' +
    '<th class="num">Value</th><th>Trend</th></tr></thead><tbody>' + rows + "</tbody></table>" +
    '<p class="note">Each row checks locked collateral in the source-chain escrow against wrapped supply' +
    " minted on the destination. Values are priced by on-chain Chainlink feeds. Click a row for history.</p>";
}

function viewRoute(id, history) {
  var head = '<a class="crumb" href="#/">← board</a><h2 class="mono">' + esc(id) + "</h2>";
  if (!history || !history.length) return head + '<p class="muted">No observations yet for this route.</p>';
  var latest = history[0];
  var ratios = history.slice().reverse().map(function (o) { return o.ratioPct; });
  var kpis = '<div class="kpis">' +
    '<div class="kpi"><div class="n v-' + esc(latest.verdict) + '">' + esc(latest.verdict) + '</div><div class="l">verdict</div></div>' +
    '<div class="kpi"><div class="n">' + fmtRatio(latest.ratioPct) + '</div><div class="l">backing</div></div>' +
    '<div class="kpi"><div class="n">' + fmtUsd(latest.lockedUsd) + '</div><div class="l">locked value' +
    (latest.pricedVia ? " · " + esc(latest.pricedVia) : "") + "</div></div>" +
    '<div class="kpi"><div class="n">' + history.length + '</div><div class="l">observations kept</div></div></div>';
  var chart = '<div class="card">' + spark(ratios, 1080, 120) + "</div>";
  var rows = history.slice(0, 60).map(function (o) {
    return '<tr><td class="mono muted">' + fmtTime(o.at) + '</td><td class="v-' + esc(o.verdict) + '">' +
      esc(o.verdict) + '</td><td class="num">' + fmtRatio(o.ratioPct) + '</td><td class="num">' + fmtNum(o.locked) +
      '</td><td class="num">' + fmtNum(o.minted) + '</td><td class="num">' + fmtUsd(o.lockedUsd) + "</td>" +
      '<td class="muted">' + esc(o.error || "") + "</td></tr>";
  }).join("");
  return head + kpis + chart +
    '<table><thead><tr><th>At</th><th>Verdict</th><th class="num">Backing</th><th class="num">Locked</th>' +
    '<th class="num">Minted</th><th class="num">Value</th><th>Error</th></tr></thead><tbody>' + rows + "</tbody></table>";
}

function viewAlerts() {
  if (!S.alerts.length) return "<h2>Alerts</h2><p class='muted'>No breach or recovery transitions recorded. Quiet is good.</p>";
  var rows = S.alerts.map(function (a) {
    var cls = a.kind === "breach" ? "v-UNDERCOLLATERALIZED" : "v-BACKED";
    return '<tr><td class="mono muted">' + fmtTime(a.at) + '</td><td class="' + cls + '">' +
      (a.kind === "breach" ? "🚨 breach" : "✅ recovery") + "</td><td>" + esc(a.bridge) + " — " + esc(a.asset) +
      ' <span class="muted mono">[' + esc(a.id) + ']</span></td><td class="num">' + fmtRatio(a.ratioPct) +
      "</td><td class='muted'>" + esc(a.error || "") + "</td></tr>";
  }).join("");
  return "<h2>Alerts</h2><table><thead><tr><th>At</th><th>Kind</th><th>Route</th>" +
    '<th class="num">Backing</th><th>Detail</th></tr></thead><tbody>' + rows + "</tbody></table>" +
    '<p class="note">One alert per transition: a route that stays broken does not repeat; recovery reports once.</p>';
}

function viewWatches() {
  var rows = S.watches.map(function (w) {
    var lock = Array.isArray(w.lock) ? w.lock[0] : w.lock;
    return '<tr><td class="mono">' + esc(w.id) + "</td><td>" + esc(w.bridge) + "</td><td>" + esc(w.asset) + "</td>" +
      '<td class="mono muted">' + esc(lock.chain) + ":" + esc(lock.escrow.slice(0, 10)) + "… → " +
      esc(w.mint.chain) + ":" + esc(w.mint.token.slice(0, 10)) + '…</td><td class="num">' + w.minRatioPct + "%</td>" +
      '<td><button class="ghost" data-del="' + esc(w.id) + '">remove</button></td></tr>';
  }).join("");
  var table = S.watches.length
    ? "<table><thead><tr><th>Id</th><th>Bridge</th><th>Asset</th><th>Route</th><th class='num'>Min ratio</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>"
    : '<p class="muted">No custom watches — the bundled verified registry is being swept. Add your own route below.</p>';
  return "<h2>Watches</h2>" + table +
    '<form class="card" id="watch-form"><b>Add a route to the sweep</b>' +
    '<div class="row"><div><label>bridge label</label><input name="bridge" placeholder="My bridge" /></div>' +
    '<div><label>asset label</label><input name="asset" placeholder="USDC" /></div>' +
    '<div><label>min ratio %</label><input name="minRatioPct" value="100" /></div></div>' +
    '<div class="row"><div><label>lock chain</label><input name="lockChain" placeholder="ethereum" /></div>' +
    '<div><label>escrow</label><input name="escrow" placeholder="0x…" /></div>' +
    '<div><label>locked token</label><input name="lockToken" placeholder="0x…" /></div></div>' +
    '<div class="row"><div><label>mint chain</label><input name="mintChain" placeholder="polygon" /></div>' +
    '<div><label>minted (wrapped) token</label><input name="mintToken" placeholder="0x…" /></div>' +
    '<div><label>write token (if the server has one)</label><input name="token" type="password" /></div></div>' +
    '<button type="submit">add watch</button><div class="err" id="watch-err"></div>' +
    '<p class="note">The route joins the next sweep immediately. Verify escrow/token addresses against the' +
    " bridge's own docs first — a wrong escrow reads as a false breach.</p></form>";
}

function viewExposure() {
  var head = "<h2>My exposure</h2>" +
    '<div class="card"><div class="row"><div><label>address</label>' +
    '<input id="exp-addr" placeholder="0x…" value="' + esc(S.exposureAddr) + '" /></div></div>' +
    '<button id="exp-go">check exposure</button> ' +
    '<button class="ghost" id="exp-wallet">use connected wallet</button>' +
    '<div class="err" id="exp-err"></div>' +
    '<p class="note">Read-only: the wallet only supplies an address — nothing is signed, no transaction is made.</p></div>';
  if (S.exposureBusy) return head + '<p class="muted">reading balances across chains…</p>';
  if (!S.exposure) return head;
  var held = S.exposure.filter(function (r) { return Number(r.balance) > 0; });
  if (!held.length) return head + '<p class="muted">No balances in any monitored wrapped token for this address.</p>';
  var rows = held.map(function (r) {
    return "<tr><td>" + esc(r.bridge) + "</td><td>" + esc(r.asset) + '</td><td class="muted">' + esc(r.mintChain) +
      '</td><td class="num">' + fmtNum(r.balance) + '</td><td class="num">' + fmtUsd(r.balanceUsd) + "</td>" +
      '<td class="v-' + esc(r.verdict || "") + '">' + esc(r.verdict || "—") + '</td><td class="num">' + fmtRatio(r.ratioPct) + "</td></tr>";
  }).join("");
  return head + "<table><thead><tr><th>Bridge</th><th>Asset</th><th>Chain</th>" +
    '<th class="num">Balance</th><th class="num">Value</th><th>Route status</th><th class="num">Backing</th></tr></thead><tbody>' +
    rows + "</tbody></table>";
}

function currentView() {
  var h = location.hash || "#/";
  if (h.indexOf("#/route/") === 0) return { name: "route", id: decodeURIComponent(h.slice(8)) };
  if (h === "#/alerts") return { name: "alerts" };
  if (h === "#/watches") return { name: "watches" };
  if (h === "#/exposure") return { name: "exposure" };
  return { name: "board" };
}

function render() {
  var v = currentView();
  var el = document.getElementById("view");
  document.querySelectorAll("#nav a").forEach(function (a) {
    a.className = a.getAttribute("data-view") === v.name ? "active" : "";
  });
  overallPill();
  if (v.name === "route") {
    getJSON("/api/routes/" + encodeURIComponent(v.id) + "/history?limit=200").then(function (h) {
      el.innerHTML = viewRoute(v.id, h);
    });
    return;
  }
  el.innerHTML = v.name === "alerts" ? viewAlerts() : v.name === "watches" ? viewWatches()
    : v.name === "exposure" ? viewExposure() : viewBoard();
}

document.addEventListener("click", function (e) {
  var tr = e.target.closest ? e.target.closest("tr[data-route]") : null;
  if (tr) { location.hash = "#/route/" + encodeURIComponent(tr.getAttribute("data-route")); return; }
  if (e.target.id === "exp-go" || e.target.id === "exp-wallet") {
    var run = function (addr) {
      S.exposureAddr = addr; S.exposureBusy = true; S.exposure = null; render();
      fetch("/api/exposure?address=" + encodeURIComponent(addr)).then(function (r) { return r.json(); })
        .then(function (rows) {
          S.exposureBusy = false;
          if (rows && rows.error) { S.exposure = null; render(); document.getElementById("exp-err").textContent = rows.error; }
          else { S.exposure = rows; render(); }
        });
    };
    if (e.target.id === "exp-wallet") {
      if (!window.ethereum) { document.getElementById("exp-err").textContent = "no injected wallet found"; return; }
      window.ethereum.request({ method: "eth_requestAccounts" }).then(function (accts) {
        if (accts && accts[0]) run(accts[0]);
      }).catch(function (err) { document.getElementById("exp-err").textContent = err && err.message ? err.message : String(err); });
    } else {
      var addr = document.getElementById("exp-addr").value.trim();
      if (addr) run(addr);
    }
  }
  if (e.target.getAttribute && e.target.getAttribute("data-del")) {
    var id = e.target.getAttribute("data-del");
    var tok = localStorage.getItem("evmsec-token") || "";
    fetch("/api/watches/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: tok ? { authorization: "Bearer " + tok } : {},
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { alert(res.b.error || "delete failed"); return; }
        return getJSON("/api/watches").then(function (w) { S.watches = w; render(); });
      });
  }
});

document.addEventListener("submit", function (e) {
  if (e.target.id !== "watch-form") return;
  e.preventDefault();
  var f = e.target;
  var tok = f.token.value.trim();
  if (tok) localStorage.setItem("evmsec-token", tok);
  tok = tok || localStorage.getItem("evmsec-token") || "";
  var body = {
    bridge: f.bridge.value.trim() || undefined,
    asset: f.asset.value.trim() || undefined,
    minRatioPct: Number(f.minRatioPct.value) || 100,
    lock: { chain: f.lockChain.value.trim(), escrow: f.escrow.value.trim(), token: f.lockToken.value.trim() },
    mint: { chain: f.mintChain.value.trim(), token: f.mintToken.value.trim() },
  };
  var headers = { "content-type": "application/json" };
  if (tok) headers.authorization = "Bearer " + tok;
  fetch("/api/watches", { method: "POST", headers: headers, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
    .then(function (res) {
      if (!res.ok) { document.getElementById("watch-err").textContent = res.b.error || "failed"; return; }
      return getJSON("/api/watches").then(function (w) { S.watches = w; render(); });
    });
});

function pollStatus() {
  getJSON("/api/status").then(function (s) {
    if (s && s.generatedAt) {
      S.status = s;
      overallPill();
      if (currentView().name === "board") render();
    }
  });
}

function connectStream() {
  var failures = 0;
  var es = new EventSource("/api/stream");
  es.addEventListener("status", function (ev) {
    S.status = JSON.parse(ev.data);
    var v = currentView().name;
    overallPill();
    if (v === "board") render();
  });
  es.addEventListener("alert", function (ev) {
    S.alerts.unshift(JSON.parse(ev.data));
    if (currentView().name === "alerts") render();
  });
  es.onerror = function () {
    failures++;
    if (failures >= 3) {
      // No SSE on this host (e.g. a serverless deployment) — poll instead.
      es.close();
      setInterval(pollStatus, 60000);
    }
  };
  es.onopen = function () { // re-hydrate after any reconnect so the board can't go stale
    failures = 0;
    Promise.all([getJSON("/api/status"), getJSON("/api/alerts")]).then(function (r) {
      if (r[0] && r[0].generatedAt) S.status = r[0];
      S.alerts = r[1] || [];
      render();
    });
  };
}

window.addEventListener("hashchange", render);
Promise.all([getJSON("/api/status"), getJSON("/api/alerts"), getJSON("/api/watches")]).then(function (r) {
  if (r[0] && r[0].generatedAt) S.status = r[0];
  S.alerts = r[1] || []; S.watches = r[2] || [];
  render();
  connectStream();
});
</script>
</body>
</html>
`;
