(function () {
  "use strict";
  var L = window.NCC, S = window.NCC_SNAPSHOT;
  var boot = document.getElementById("boot");
  if (!L || !S) { if (boot) boot.textContent = "The inspector's data or rules did not load (" + (!L ? "rules " : "") + (!S ? "snapshot" : "") + "). Use the single-file NEAR-Claim-Check-Final.html."; return; }
  window.addEventListener("error", function (ev) { var d = document.getElementById("detail"); if (d) d.innerHTML = '<div class="panel err"><h2>Something went wrong</h2><p>' + String(ev.message).replace(/[<>&]/g, "") + "</p></div>"; });
  var $ = function (s) { return document.querySelector(s); };
  var state = { selected: null, busy: false };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function mode() { return document.querySelector('input[name=mode]:checked').value; }
  function pkt(iso) { return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "medium" }) + " PKT"; }

  function renderModeNote() {
    Array.prototype.forEach.call(document.querySelectorAll(".mode label"), function (l) { l.classList.toggle("on", l.querySelector("input").checked); });
    $("#modeNote").textContent = mode() === "snapshot"
      ? "Snapshot captured " + pkt(L.blockTimeIso(S.block.timestamp_nanosec)) + " (" + L.blockTimeIso(S.block.timestamp_nanosec) + ")" + " at block " + S.block.height + ". It is not updated."
      : "Live: reads the latest final block from rpc.mainnet.near.org and pins all four queries to it. If it fails you will see an error, never old data.";
  }

  function renderCards() {
    $("#cards").innerHTML = L.TOKENS.map(function (t) {
      return '<article class="card' + (state.selected === t.id ? " sel" : "") + '"><h3>' + esc(t.short) + '</h3><div class="kind">' + esc(t.issuerKind) +
        '</div><code>' + esc(t.id) + '</code><button data-id="' + esc(t.id) + '">Check evidence</button></article>';
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll(".card button"), function (b) {
      b.disabled = state.busy; b.addEventListener("click", function () { run(b.getAttribute("data-id")); });
    });
  }

  function claimHtml(c, a) {
    if (c.status === "differs") return '<span class="badge b-diff">Differs from stated figure</span><p>Stated: <b>' + esc(c.stated) + '</b></p><p class="mono">' +
      esc(c.direction) + " by " + esc(c.difference) + " " + esc(a.symbol) + " (" + esc(c.percent) + "%)</p><p class='note'>" + esc(c.note) + "</p>";
    if (c.status === "matches") return '<span class="badge b-ok">Matches stated figure</span><p class="note">' + esc(c.note) + "</p>";
    return '<span class="badge b-info">No fixed supply claimed</span><p class="note">' + esc(c.note) + "</p>";
  }

  function renderResult(a, src, m, bundle) {
    var t = a.token, time = L.blockTimeIso(src.block.timestamp_nanosec);
    var keys = a.keys;
    var fc = keys.functionCallKeys.length ? "<p class='mono'>" + keys.functionCallKeys.map(function (k) { return esc(k.receiver) + " → " + esc(k.methods.join(", ") || "any method"); }).join("<br>") + "</p>" : "";
    $("#detail").innerHTML =
      '<div class="panel"><h2>' + esc(a.metaName) + " (" + esc(a.symbol) + ') <span class="badge ' + (m === "live" ? "b-live" : "b-snap") + '">' + (m === "live" ? "Live read" : "Cached snapshot") + "</span></h2>" +
      '<p class="mono">Block ' + esc(src.block.height) + " · " + esc(src.block.hash) + "<br>" + esc(time) + " (" + esc(pkt(time)) + ")" + (m === "snapshot" ? "<br>Snapshot, not current data." : "") + "</p></div>" +
      '<div class="grid2"><div class="panel"><h4>Total supply on chain</h4><div class="big">' + esc(a.supply) + " " + esc(a.symbol) + '</div><p class="note">Exact: raw ' + esc(a.supplyRaw) + " with " + esc(a.decimals) + " decimals.</p><h4>Against the cited claim</h4>" + claimHtml(a.claim, a) + "</div>" +
      '<div class="panel"><h4>Access keys at this block</h4><span class="badge ' + (keys.fullAccessCount ? "b-diff" : "b-info") + '">' + keys.fullAccessCount + " full-access · " + keys.functionCallKeys.length + " function-call</span><p>" + esc(keys.summary) + "</p>" + fc +
      "<h4>Code hash (identity, not verification)</h4><p class='mono'>" + esc(a.codeHash) + "</p><p class='note'>" + esc(a.codeHashNote) + "</p></div></div>" +
      '<div class="panel"><h4>Sources</h4>' + t.sources.map(function (s) {
        return "<p><a href='" + esc(s.url) + "' target='_blank' rel='noopener noreferrer'>" + esc(s.title) + "</a> " + (s.verified ? "<span class='badge b-ok'>Directly read</span>" : "<span class='badge b-diff'>Unverified excerpt</span>") +
          "</p><blockquote>" + esc(s.quote) + "</blockquote><p class='note'>" + esc(s.provenance) + "</p>" + (s.mirror ? "<p class='note'>Mirror: <a href='" + esc(s.mirror) + "' target='_blank' rel='noopener noreferrer'>" + esc(s.mirror) + "</a></p>" : "");
      }).join("") +
      '<div class="actions"><button id="dl">Download evidence bundle (.json)</button></div><p class="note mono">SHA-256 ' + esc(bundle.integrity.sha256) + " · computed with " + esc(L.hashEngine() || "?") + "</p></div>";
    $("#dl").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      var u = URL.createObjectURL(blob), el = document.createElement("a");
      el.href = u; el.download = "near-claim-check_" + a.symbol + "_" + m + "_block" + src.block.height + ".json"; el.click();
      setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    });
  }

  function renderError(e, id) {
    var title = e.kind === "cancelled" ? "Live read cancelled" : "Could not read live data";
    $("#detail").innerHTML = '<div class="panel err"><h2>' + title + '</h2><p>' + esc(e.message) + "</p><p class='note'>Kind: " + esc(e.kind || "unknown") +
      ". Nothing from the snapshot is shown in its place. Switch to “Cached snapshot” to view the saved evidence.</p><div class='actions'><button id='retry'>Retry live read</button></div></div>";
    $("#retry").addEventListener("click", function () { run(id); });
  }

  var gen = 0, liveCtrl = null;
  function cancelLive() { if (liveCtrl) { liveCtrl.abort(); liveCtrl = null; } }

  async function run(id) {
    var my = ++gen; cancelLive();
    state.selected = id; var m = mode();
    state.busy = m === "live"; renderCards();
    if (m === "live") {
      liveCtrl = new AbortController(); var ctrl = liveCtrl;
      $("#detail").innerHTML = '<div class="panel"><h2>Reading NEAR mainnet…</h2><p id="prog" class="note">Starting…</p><p class="note">Stops automatically after 75 s. Switching to “Cached snapshot” also cancels it.</p><div class="actions"><button class="ghost" id="cancel">Cancel</button></div></div>';
      $("#cancel").addEventListener("click", function () { if (my === gen) cancelLive(); });
    }
    try {
      var src = m === "live"
        ? await L.liveFetch(window.fetch.bind(window), id, { signal: liveCtrl.signal, onProgress: function (i, n, lbl) { var p = document.getElementById("prog"); if (p && my === gen) p.textContent = "Step " + i + " of " + n + ": " + lbl; } })
        : L.snapshotSource(S, id);
      if (my !== gen) return;
      var a = L.analyze(id, src.raw);
      var bundle = await L.buildBundle(id, m, src);
      if (my !== gen) return;
      renderResult(a, src, m, bundle);
    } catch (e) { if (my === gen) renderError(e, id); }
    finally { if (my === gen) { state.busy = false; liveCtrl = null; renderCards(); } }
  }

  $("#verifyFile").addEventListener("change", async function (ev) {
    var f = ev.target.files[0]; if (!f) return;
    try { var r = await L.verifyBundle(JSON.parse(await f.text()));
      $("#verifyOut").textContent = r.ok ? "✓ Intact. SHA-256 " + r.sha256 : "✗ " + r.reason;
    } catch (e) { $("#verifyOut").textContent = "✗ Not a readable evidence bundle: " + e.message; }
  });
  Array.prototype.forEach.call(document.querySelectorAll("input[name=mode]"), function (r) { r.addEventListener("change", function () { gen++; cancelLive(); state.busy = false; renderModeNote(); $("#detail").innerHTML = ""; state.selected = null; renderCards(); if (mode() === "snapshot") run(L.TOKENS[0].id); }); });
  try { if ((window.matchMedia && matchMedia("(pointer: coarse)").matches) && Math.min(screen.width, screen.height) <= 820) document.documentElement.classList.add("phone"); } catch (e) {}
  renderModeNote(); renderCards();
  if (boot) boot.remove();
  run(L.TOKENS[0].id);
})();
