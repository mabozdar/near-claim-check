const test = require("node:test"), assert = require("node:assert");
const L = require("../lib.js"), S = require("../snapshot.js");
const REF = "token.v2.ref-finance.near", USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", USDT = "usdt.tether-token.near";

test("formatUnits is exact (BigInt, no float loss)", () => {
  assert.strictEqual(L.formatUnits("99990503455868361423784555", 18), "99,990,503.455868361423784555");
  assert.strictEqual(L.formatUnits("78063818380469", 6), "78,063,818.380469");
  assert.strictEqual(L.formatUnits("1000000", 6), "1");
  assert.strictEqual(L.formatUnits("5", 6), "0.000005");
  assert.strictEqual(L.formatUnits("0", 18), "0");
  assert.throws(() => L.formatUnits("1.5", 6), /integer/);
  assert.throws(() => L.formatUnits(123, 6));
});

test("key interpretation never claims immutability", () => {
  const none = L.interpretKeys({ result: { keys: [] } });
  assert.strictEqual(none.status, "no_full_access_keys");
  assert.match(none.summary, /does NOT prove/);
  const full = L.interpretKeys({ result: { keys: [{ access_key: { permission: "FullAccess" } }, { access_key: { permission: { FunctionCall: { receiver_id: "x.near", method_names: ["a"] } } } }] } });
  assert.strictEqual(full.status, "upgradeable_by_key");
  assert.strictEqual(full.fullAccessCount, 1);
  assert.deepStrictEqual(full.functionCallKeys, [{ receiver: "x.near", methods: ["a"] }]);
  const fcOnly = L.interpretKeys({ result: { keys: [{ access_key: { permission: { FunctionCall: { receiver_id: "y", method_names: [] } } } }] } });
  assert.strictEqual(fcOnly.status, "no_full_access_keys");
  assert.throws(() => L.interpretKeys({ error: { message: "x" } }), e => e.kind === "rpc");
});

test("snapshot selection and analysis of the three real tokens", () => {
  const r = L.analyze(REF, L.snapshotSource(S, REF).raw);
  assert.strictEqual(r.symbol, "REF");
  assert.strictEqual(r.claim.status, "differs");
  assert.strictEqual(r.claim.direction, "below");
  assert.strictEqual(r.claim.difference, "9,496.544131638576215445");
  assert.strictEqual(r.claim.percent, "0.009496");
  assert.doesNotMatch(JSON.stringify(r.claim), /scam|fraud|false/i);
  const u = L.analyze(USDC, L.snapshotSource(S, USDC).raw);
  assert.strictEqual(u.keys.status, "upgradeable_by_key");
  assert.strictEqual(u.claim.status, "no_fixed_claim");
  assert.strictEqual(L.analyze(USDT, L.snapshotSource(S, USDT).raw).supply, "525,944,120.793709");
  assert.strictEqual(S.block.height, 223569575);
  assert.throws(() => L.snapshotSource(S, "nope.near"), e => e.kind === "no_snapshot");
  assert.throws(() => L.tokenById("nope.near"), e => e.kind === "unknown_token");
});

test("compareFixedClaim: match / above", () => {
  assert.strictEqual(L.compareFixedClaim("100000000000000000000000000", 18, "100000000").status, "matches");
  const a = L.compareFixedClaim("100000001000000", 6, "100000000");
  assert.strictEqual(a.direction, "above"); assert.strictEqual(a.difference, "1");
});

const ok = body => ({ ok: true, status: 200, json: async () => body });
test("live errors are surfaced, never replaced by snapshot", async () => {
  await assert.rejects(L.liveFetch(async () => { throw new TypeError("Failed to fetch"); }, REF), e => e.kind === "network");
  await assert.rejects(L.liveFetch(async () => ({ ok: false, status: 429 }), REF), e => e.kind === "rate_limited");
  await assert.rejects(L.liveFetch(async () => ({ ok: false, status: 502 }), REF), e => e.kind === "http");
  await assert.rejects(L.liveFetch(async () => ok({ error: { cause: { name: "UNKNOWN_BLOCK" } } }), REF), e => e.kind === "rpc");
  await assert.rejects(L.liveFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error("x"); } }), REF), e => e.kind === "malformed");
  await assert.rejects(L.liveFetch((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => { const e = new Error("a"); e.name = "AbortError"; rej(e); })), REF, null, 50), e => e.kind === "timeout");
});

test("live fetch pins every query to one block height", async () => {
  const seen = []; const snap = S.tokens[REF];
  const f = async (u, o) => { const b = JSON.parse(o.body); seen.push(b);
    if (b.method === "block") return ok({ result: { header: { height: 999, hash: "H", timestamp_nanosec: "1794114389369620230" } } });
    const p = b.params; return ok(p.request_type === "view_account" ? snap.account : p.request_type === "view_access_key_list" ? snap.keys : snap[p.method_name]); };
  const src = await L.liveFetch(f, REF);
  assert.strictEqual(seen.length, 5);
  seen.slice(1).forEach(b => { assert.strictEqual(b.params.block_id, 999); assert.strictEqual(b.params.account_id, REF); });
  assert.strictEqual(src.block.height, 999);
});

test("evidence bundle is deterministic and tamper-evident", async () => {
  const src = L.snapshotSource(S, REF);
  const b1 = await L.buildBundle(REF, "snapshot", src), b2 = await L.buildBundle(REF, "snapshot", src);
  assert.strictEqual(b1.integrity.sha256, b2.integrity.sha256);
  assert.match(b1.integrity.sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(L.canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.ok((await L.verifyBundle(JSON.parse(JSON.stringify(b1)))).ok);
  const t = JSON.parse(JSON.stringify(b1)); t.payload.findings.supply = "100,000,000";
  const v = await L.verifyBundle(t); assert.strictEqual(v.ok, false); assert.match(v.reason, /mismatch/);
  assert.strictEqual((await L.verifyBundle({})).ok, false);
  assert.strictEqual(b1.payload.block.timeUtc, "2026-11-08T05:06:29.369Z");
});

const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const nodeHash = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");
test("JS SHA-256 fallback matches Node and WebCrypto on known vectors", async () => {
  assert.strictEqual(L.sha256Fallback("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.strictEqual(L.sha256Fallback(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (const s of ["اردو ✓ 😀 NEAR", "x".repeat(55), "x".repeat(56), "x".repeat(64), "a".repeat(1000000), L.canonicalize(S)]) {
    assert.strictEqual(L.sha256Fallback(s), nodeHash(s));
    const wc = Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
    assert.strictEqual(L.sha256Fallback(s), wc);
  }
});
test("bundle hash works without crypto.subtle (insecure content:// context)", async () => {
  const src = L.snapshotSource(S, REF);
  const withWC = await L.buildBundle(REF, "snapshot", src);
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    const noWC = await L.buildBundle(REF, "snapshot", src);
    assert.strictEqual(L.hashEngine(), "built-in JS SHA-256");
    assert.strictEqual(noWC.integrity.sha256, withWC.integrity.sha256);
    assert.ok((await L.verifyBundle(withWC)).ok);
  } finally { Object.defineProperty(globalThis, "crypto", desc); }
});
test("standalone Final HTML: no sibling/external assets, safe inline scripts, valid JS", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "NEAR-Claim-Check-Final.html"), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /\bimport\s*\(|^\s*import\s|type=["']module/m);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /@import|url\(/i);
  assert.doesNotMatch(html, /fonts\.googleapis|cdn\.|unpkg|jsdelivr|<img[^>]+src=["']?http/i);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.strictEqual(scripts.length, 3);
  scripts.forEach(js => { assert.doesNotMatch(js, /<\/script/i); new vm.Script(js); });
  assert.match(html, /<style>[\s\S]*\.cards[\s\S]*<\/style>/);
  assert.match(html, /max-width:480px/);
  assert.match(html, /id="boot"/); assert.match(html, /<noscript>/);
  // execute rules + snapshot in a sandbox like a browser would (classic scripts on a shared global)
  const ctx = { TextEncoder, TextDecoder, BigInt, setTimeout, clearTimeout, console }; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(scripts[0] + "\n;this.NCC_SNAPSHOT=NCC_SNAPSHOT;", ctx); vm.runInContext(scripts[1], ctx);
  assert.ok(ctx.NCC && ctx.NCC_SNAPSHOT);
  assert.strictEqual(ctx.NCC.TOKENS.length, 3);
  for (const t of ctx.NCC.TOKENS) assert.ok(ctx.NCC.analyze(t.id, ctx.NCC.snapshotSource(ctx.NCC_SNAPSHOT, t.id).raw).supply);
});

test("live: progress, cancellation and overall timeout", async () => {
  const snap = S.tokens[REF]; const steps = [];
  const good = async (u, o) => { const b = JSON.parse(o.body);
    if (b.method === "block") return ok({ result: { header: { height: 7, hash: "H", timestamp_nanosec: "1794114389369620230" } } });
    const p = b.params; return ok(p.request_type === "view_account" ? snap.account : p.request_type === "view_access_key_list" ? snap.keys : snap[p.method_name]); };
  await L.liveFetch(good, REF, { onProgress: (i, n, l) => steps.push(i + "/" + n) });
  assert.deepStrictEqual(steps, ["1/5", "2/5", "3/5", "4/5", "5/5"]);
  const hang = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => { const e = new Error("a"); e.name = "AbortError"; rej(e); }));
  const c = new AbortController(); setTimeout(() => c.abort(), 20);
  await assert.rejects(L.liveFetch(hang, REF, { signal: c.signal, perRequestMs: 5000 }), e => e.kind === "cancelled");
  const pre = new AbortController(); pre.abort();
  await assert.rejects(L.liveFetch(good, REF, { signal: pre.signal }), e => e.kind === "cancelled");
  await assert.rejects(L.liveFetch(hang, REF, { perRequestMs: 5000, totalMs: 40 }), e => e.kind === "timeout" && /overall/.test(e.message));
});

/* Minimal fake DOM to exercise app.js state logic (not a visual test). */
function fakeApp(fetchImpl) {
  const els = {}, el = id => els[id] || (els[id] = { id, innerHTML: "", textContent: "", listeners: {}, classList: { toggle() {}, add() {} },
    addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.removed = true; } });
  const buttons = { list: [] };
  const radios = ["snapshot", "live"].map(v => ({ value: v, checked: v === "snapshot", listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } }));
  const document = {
    documentElement: { classList: { add() {} } },
    getElementById: id => el(id),
    querySelector(s) { if (s === "input[name=mode]:checked") return radios.find(r => r.checked); return el(s.replace("#", "")); },
    querySelectorAll(s) { if (s === "input[name=mode]") return radios; if (s === ".mode label") return [];
      if (s === ".card button") { const ids = [...els.cards.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]);
        return (buttons.list = ids.map(id => ({ id, disabled: false, listeners: {}, getAttribute: () => id, addEventListener(t, f) { this.listeners[t] = f; } })));
      } return []; },
    createElement: () => ({ click() {} })
  };
  const html = fs.readFileSync(path.join(__dirname, "..", "NEAR-Claim-Check-Final.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const window = { addEventListener() {}, fetch: fetchImpl };
  const ctx = { window, document, screen: { width: 1000, height: 800 }, TextEncoder, TextDecoder, BigInt, setTimeout, clearTimeout, AbortController, console, URL, Blob, crypto: globalThis.crypto };
  ctx.globalThis = ctx; window.document = document; vm.createContext(ctx);
  vm.runInContext(scripts[0] + ";window.NCC_SNAPSHOT=NCC_SNAPSHOT;", ctx); vm.runInContext(scripts[1] + ";window.NCC=this.NCC;", ctx); vm.runInContext(scripts[2], ctx);
  return { els, radios, click: id => buttons.list.find(b => b.id === id).listeners.click(), buttons };
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
test("app: loads REF snapshot on open, all 3 cards render", async () => {
  const { els } = fakeApp(async () => { throw new Error("no network in test"); });
  await tick();
  assert.strictEqual(els.boot.removed, true);
  for (const s of ["REF", "USDC", "USDt"]) assert.match(els.cards.innerHTML, new RegExp("<h3>" + s + "</h3>"));
  assert.match(els.detail.innerHTML, /Cached snapshot/); assert.match(els.detail.innerHTML, /99,990,503\.455868361423784555/);
  assert.match(els.modeNote.textContent, /2026-11-08T05:06:29\.369Z/);
});
test("app: switching to snapshot during a live read cancels it; no stale live result", async () => {
  let release; const pending = new Promise(r => (release = r)); const snap = S.tokens[REF];
  const slow = async (u, o) => { await pending; const b = JSON.parse(o.body);
    if (b.method === "block") return ok({ result: { header: { height: 7, hash: "LIVEHASH", timestamp_nanosec: "1794114389369620230" } } });
    const p = b.params; return ok(p.request_type === "view_account" ? snap.account : p.request_type === "view_access_key_list" ? snap.keys : snap[p.method_name]); };
  const app = fakeApp(slow); await tick();
  app.radios[0].checked = false; app.radios[1].checked = true; app.radios[1].listeners.change();
  app.click(USDC); await tick();
  assert.match(app.els.detail.innerHTML, /Reading NEAR mainnet/);
  assert.ok(app.buttons.list.every(b => b.disabled), "cards locked during live read");
  app.radios[1].checked = false; app.radios[0].checked = true; app.radios[0].listeners.change();
  release(); await tick(80);
  assert.match(app.els.detail.innerHTML, /Cached snapshot/); assert.doesNotMatch(app.els.detail.innerHTML, /LIVEHASH|Live read/);
  assert.ok(app.buttons.list.every(b => !b.disabled), "cards unlocked");
});
test("app: live failure shows explicit error with retry; cancel works; controls unlock", async () => {
  const app = fakeApp(async () => ({ ok: false, status: 429 })); await tick();
  app.radios[0].checked = false; app.radios[1].checked = true; app.radios[1].listeners.change();
  app.click(REF); await tick();
  assert.match(app.els.detail.innerHTML, /Could not read live data/); assert.match(app.els.detail.innerHTML, /rate limit/);
  assert.doesNotMatch(app.els.detail.innerHTML, /99,990,503/);
  assert.ok(app.buttons.list.every(b => !b.disabled));
  assert.ok(app.els.retry.listeners.click);
  const hang = fakeApp((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => { const e = new Error("a"); e.name = "AbortError"; rej(e); })));
  await tick(); hang.radios[0].checked = false; hang.radios[1].checked = true; hang.radios[1].listeners.change();
  hang.click(USDT); await tick(); hang.els.cancel.listeners.click(); await tick();
  assert.match(hang.els.detail.innerHTML, /Live read cancelled/);
  assert.ok(hang.buttons.list.every(b => !b.disabled));
});
test("responsive stylesheet rules present (not a visual test)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "NEAR-Claim-Check-Final.html"), "utf8");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /body\{font-size:16px/);
  assert.match(html, /html\.phone \.cards,html\.phone \.grid2\{grid-template-columns:1fr\}/);
  assert.match(html, /word-break:break-all/);
  assert.match(html, /About &amp; limitations/);
});
