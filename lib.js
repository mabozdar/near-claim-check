/* NEAR Claim Check — evidence inspector core logic. No network calls unless liveFetch is invoked. */
(function (root) {
  "use strict";

  var DEFAULT_RPC = "https://rpc.mainnet.near.org";

  var TOKENS = [
    {
      id: "token.v2.ref-finance.near", short: "REF", name: "Ref Finance Token",
      issuerKind: "Fixed-supply governance token (as stated by its docs)",
      sources: [{
        title: "Ref Finance guide — Tokenomics", url: "https://guide.ref.finance/tokenomics",
        mirror: "https://guide.rhea.finance/tokenomics",
        quote: "Fungible Token Contract: token.v2.ref-finance.near … Fixed Supply: 100,000,000",
        provenance: "UNVERIFIED EXCERPT: text came from a search-index copy of the page. A direct fetch from the build machine timed out, so the live page was not re-read.",
        verified: false
      }],
      supplyClaim: { kind: "fixed", wholeTokens: "100000000", text: "Fixed Supply: 100,000,000" }
    },
    {
      id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", short: "USDC", name: "USDC (Circle, native on NEAR)",
      issuerKind: "Issuer-managed stablecoin: supply changes as coins are minted and redeemed",
      sources: [{
        title: "Circle developer docs — USDC contract addresses", url: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
        quote: "NEAR | 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        provenance: "Excerpt of the official address table as returned by search on 2026-11-08; establishes the contract address only.",
        verified: false
      }],
      supplyClaim: null
    },
    {
      id: "usdt.tether-token.near", short: "USDt", name: "Tether USD on NEAR",
      issuerKind: "Issuer-managed stablecoin: supply changes as coins are issued and redeemed",
      sources: [{
        title: "Tether — Supported protocols", url: "https://tether.to/en/supported-protocols/",
        quote: "usdt.tether-token.near",
        provenance: "Address string found by a direct fetch of the official page on 2026-11-08; establishes the contract address only.",
        verified: true
      }],
      supplyClaim: null
    }
  ];

  function NccError(kind, message, detail) {
    var e = new Error(message); e.name = "NccError"; e.kind = kind; e.detail = detail; return e;
  }

  function tokenById(id) {
    for (var i = 0; i < TOKENS.length; i++) if (TOKENS[i].id === id) return TOKENS[i];
    throw NccError("unknown_token", "Unknown token: " + id);
  }

  function groupThousands(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  /* Exact BigInt formatting, no floating point. */
  function formatUnits(raw, decimals) {
    if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) throw NccError("malformed", "Supply is not an integer string");
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw NccError("malformed", "Bad decimals");
    var neg = raw[0] === "-"; var v = BigInt(neg ? raw.slice(1) : raw);
    var base = 10n ** BigInt(decimals);
    var whole = (v / base).toString(), frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + groupThousands(whole) + (frac ? "." + frac : "");
  }

  function decodeCallResult(resp) {
    if (!resp || typeof resp !== "object") throw NccError("malformed", "Empty RPC response");
    if (resp.error) throw NccError("rpc", "RPC error: " + (resp.error.cause && resp.error.cause.name || resp.error.message || "unknown"), resp.error);
    var r = resp.result;
    if (!r || !Array.isArray(r.result)) throw NccError("malformed", "Call result missing bytes", r);
    var text = new TextDecoder().decode(new Uint8Array(r.result));
    try { return JSON.parse(text); } catch (e) { throw NccError("malformed", "Call result is not JSON"); }
  }

  function interpretKeys(resp) {
    if (resp && resp.error) throw NccError("rpc", "RPC error reading access keys", resp.error);
    if (!resp || !resp.result || !Array.isArray(resp.result.keys)) throw NccError("malformed", "Access key list missing");
    var full = 0, fc = [];
    resp.result.keys.forEach(function (k) {
      var p = k.access_key && k.access_key.permission;
      if (p === "FullAccess") full++;
      else if (p && p.FunctionCall) fc.push({ receiver: p.FunctionCall.receiver_id, methods: p.FunctionCall.method_names || [] });
    });
    var status, summary;
    if (full > 0) {
      status = "upgradeable_by_key";
      summary = "At this block, " + full + " full-access key(s) exist. Whoever holds such a key can redeploy the contract code or move the account's NEAR. This is normal for issuer-controlled tokens and is not evidence of wrongdoing.";
    } else {
      status = "no_full_access_keys";
      summary = "No full-access keys at this block. This does NOT prove the contract is immutable: the deployed code itself may expose an upgrade or admin method. Reading the contract source is required to know.";
    }
    return { status: status, fullAccessCount: full, functionCallKeys: fc, totalKeys: resp.result.keys.length, summary: summary };
  }

  /* Compare an on-chain total with a stated fixed/max figure. Never returns a fraud verdict. */
  function compareFixedClaim(rawSupply, decimals, claimWhole) {
    var claimRaw = BigInt(claimWhole) * 10n ** BigInt(decimals);
    var chain = BigInt(rawSupply), diff = chain - claimRaw;
    if (diff === 0n) return { status: "matches", note: "On-chain total equals the stated figure." };
    var abs = diff < 0n ? -diff : diff;
    var ppm = (abs * 100000000n) / claimRaw; // percent with 6 decimals
    var pct = (ppm / 1000000n).toString() + "." + (ppm % 1000000n).toString().padStart(6, "0");
    return {
      status: "differs", direction: diff < 0n ? "below" : "above",
      differenceRaw: abs.toString(), difference: formatUnits(abs.toString(), decimals), percent: pct,
      note: diff < 0n
        ? "On-chain total is BELOW the stated fixed figure. Possible reasons include burns or an outdated document; the cause was not verified. A stated fixed/max supply is not automatically contradicted by a different current total."
        : "On-chain total is ABOVE the stated fixed figure. This is worth investigating (e.g. later minting or a different contract), but the cause was not verified here."
    };
  }

  function analyze(tokenId, raw) {
    var t = tokenById(tokenId);
    var meta = decodeCallResult(raw.ft_metadata);
    var supply = decodeCallResult(raw.ft_total_supply);
    if (typeof supply !== "string") throw NccError("malformed", "ft_total_supply did not return a string");
    if (raw.account && raw.account.error) throw NccError("rpc", "RPC error reading account", raw.account.error);
    var acct = raw.account && raw.account.result;
    if (!acct || !acct.code_hash) throw NccError("malformed", "Account code_hash missing");
    var out = {
      token: t, symbol: meta.symbol, metaName: meta.name, decimals: meta.decimals, spec: meta.spec,
      supplyRaw: supply, supply: formatUnits(supply, meta.decimals),
      keys: interpretKeys(raw.keys),
      codeHash: acct.code_hash,
      codeHashNote: "Identifies exactly which compiled code is deployed. It is NOT code verification: matching it to audited source needs a reproducible build.",
      claim: null
    };
    if (t.supplyClaim && t.supplyClaim.kind === "fixed") {
      out.claim = Object.assign({ stated: t.supplyClaim.text }, compareFixedClaim(supply, meta.decimals, t.supplyClaim.wholeTokens));
    } else {
      out.claim = { status: "no_fixed_claim", note: "No fixed supply is claimed by the cited source; supply is expected to change. Only the current on-chain value is shown." };
    }
    return out;
  }

  function abortError(signal) {
    var r = signal && signal.reason;
    return r && r.name === "NccError" ? r : NccError("cancelled", "Live read was cancelled.");
  }

  async function rpc(fetchImpl, url, method, params, timeoutMs, outerSignal) {
    if (outerSignal && outerSignal.aborted) throw abortError(outerSignal);
    var ctrl = new AbortController(), timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, timeoutMs || 20000);
    var onOuter = function () { ctrl.abort(); };
    if (outerSignal) outerSignal.addEventListener("abort", onOuter);
    var res;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "ncc", method: method, params: params }), signal: ctrl.signal });
    } catch (e) {
      if (outerSignal && outerSignal.aborted) throw abortError(outerSignal);
      if (timedOut || (e && e.name === "AbortError")) throw NccError("timeout", "A request to the public RPC timed out after " + Math.round((timeoutMs || 20000) / 1000) + " s.");
      throw NccError("network", "Network error: offline, blocked by this viewer, or refused by the RPC (CORS). Browser said: " + (e && e.message));
    } finally { clearTimeout(timer); if (outerSignal) outerSignal.removeEventListener("abort", onOuter); }
    if (res.status === 429) throw NccError("rate_limited", "Public RPC rate limit hit (HTTP 429). Wait a minute and retry.");
    if (!res.ok) throw NccError("http", "RPC returned HTTP " + res.status);
    var body;
    try { body = await res.json(); } catch (e) { throw NccError("malformed", "RPC response was not JSON"); }
    if (body.error) throw NccError("rpc", "RPC error: " + (body.error.cause && body.error.cause.name || body.error.message), body.error);
    return body;
  }

  /* Live read: one final block, then all four queries pinned to that block height.
     opts: { url, perRequestMs (default 20000), totalMs (default 75000), signal, onProgress(step, total, label) } */
  async function liveFetch(fetchImpl, tokenId, opts) {
    tokenById(tokenId);
    if (typeof opts === "string" || opts === null || opts === undefined) opts = { url: opts || undefined, perRequestMs: arguments[3] };
    var url = opts.url || DEFAULT_RPC, per = opts.perRequestMs || 20000, totalMs = opts.totalMs || 75000;
    var ctrl = new AbortController();
    var total = setTimeout(function () { ctrl.abort(NccError("timeout", "Live read took longer than " + Math.round(totalMs / 1000) + " s overall and was stopped.")); }, totalMs);
    var onOuter = function () { ctrl.abort(NccError("cancelled", "Live read was cancelled.")); };
    if (opts.signal) { if (opts.signal.aborted) onOuter(); else opts.signal.addEventListener("abort", onOuter); }
    var prog = opts.onProgress || function () {};
    var steps = ["latest final block", "ft_metadata", "ft_total_supply", "view_account", "view_access_key_list"];
    try {
      prog(1, 5, steps[0]);
      var b = await rpc(fetchImpl, url, "block", { finality: "final" }, per, ctrl.signal);
      var h = b.result && b.result.header;
      if (!h || typeof h.height !== "number") throw NccError("malformed", "Block header missing");
      var q = function (p) { return rpc(fetchImpl, url, "query", Object.assign({ block_id: h.height, account_id: tokenId }, p), per, ctrl.signal); };
      var call = function (m) { return q({ request_type: "call_function", method_name: m, args_base64: "e30=" }); };
      prog(2, 5, steps[1]); var meta = await call("ft_metadata");
      prog(3, 5, steps[2]); var sup = await call("ft_total_supply");
      prog(4, 5, steps[3]); var acct = await q({ request_type: "view_account" });
      prog(5, 5, steps[4]); var keys = await q({ request_type: "view_access_key_list" });
      return { rpc: url, block: { height: h.height, hash: h.hash, timestamp_nanosec: h.timestamp_nanosec }, raw: { ft_metadata: meta, ft_total_supply: sup, account: acct, keys: keys } };
    } finally { clearTimeout(total); if (opts.signal) opts.signal.removeEventListener("abort", onOuter); }
  }

  function blockTimeIso(ns) { return new Date(Number(BigInt(ns) / 1000000n)).toISOString(); }

  function canonicalize(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canonicalize(v[k]); }).join(",") + "}";
  }

  /* Pure-JS SHA-256 (FIPS 180-4) for contexts without crypto.subtle (e.g. content:// or file:// on some mobiles). */
  function sha256Fallback(str) {
    var bytes = new TextEncoder().encode(str), K = [], H = [], i, j;
    var primes = [], n = 2;
    while (primes.length < 64) { var ip = true; for (j = 2; j * j <= n; j++) if (n % j === 0) { ip = false; break; } if (ip) primes.push(n); n++; }
    var frac = function (x) { return ((x - Math.floor(x)) * 4294967296) >>> 0; };
    for (i = 0; i < 64; i++) K[i] = frac(Math.cbrt(primes[i]));
    for (i = 0; i < 8; i++) H[i] = frac(Math.sqrt(primes[i]));
    var l = bytes.length, total = Math.ceil((l + 9) / 64) * 64, m = new Uint8Array(total);
    m.set(bytes); m[l] = 0x80;
    var bitsHi = Math.floor(l / 536870912), bitsLo = (l * 8) >>> 0, dv = new DataView(m.buffer);
    dv.setUint32(total - 8, bitsHi); dv.setUint32(total - 4, bitsLo);
    var w = new Array(64), rotr = function (x, k) { return (x >>> k) | (x << (32 - k)); };
    for (var off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (x) { return x.toString(16).padStart(8, "0"); }).join("");
  }

  var lastHashEngine = null;
  async function sha256Hex(str) {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle);
    if (c) {
      try {
        var buf = await c.digest("SHA-256", new TextEncoder().encode(str));
        lastHashEngine = "WebCrypto";
        return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      } catch (e) { /* fall through to JS implementation */ }
    }
    lastHashEngine = "built-in JS SHA-256";
    return sha256Fallback(str);
  }

  async function buildBundle(tokenId, mode, source) {
    var a = analyze(tokenId, source.raw), t = a.token;
    var payload = {
      schema: "near-claim-check/evidence-bundle@1",
      tool: "NEAR Claim Check — Evidence Inspector (rules-based, no AI)",
      mode: mode, network: "mainnet", rpc: source.rpc,
      block: { height: source.block.height, hash: source.block.hash, timestamp_nanosec: String(source.block.timestamp_nanosec), timeUtc: blockTimeIso(source.block.timestamp_nanosec) },
      token: { id: t.id, symbol: a.symbol, decimals: a.decimals },
      sources: t.sources,
      findings: { supplyRaw: a.supplyRaw, supply: a.supply, claim: a.claim, keys: a.keys, codeHash: a.codeHash, codeHashNote: a.codeHashNote },
      raw: source.raw,
      disclaimer: "Evidence only. Not a verdict, not financial advice. A hash proves this file was not altered after export; it does not prove any claim is true."
    };
    return { payload: payload, integrity: { algorithm: "SHA-256", canonicalization: "sorted-keys JSON, no whitespace", sha256: await sha256Hex(canonicalize(payload)) } };
  }

  async function verifyBundle(bundle) {
    if (!bundle || !bundle.payload || !bundle.integrity) return { ok: false, reason: "Not an evidence bundle" };
    var h = await sha256Hex(canonicalize(bundle.payload));
    return h === bundle.integrity.sha256 ? { ok: true, sha256: h } : { ok: false, reason: "Hash mismatch: file was modified", expected: bundle.integrity.sha256, actual: h };
  }

  function snapshotSource(snap, tokenId) {
    var r = snap && snap.tokens && snap.tokens[tokenId];
    if (!r) throw NccError("no_snapshot", "No cached snapshot for " + tokenId);
    return { rpc: snap.rpc, block: snap.block, raw: r };
  }

  var api = { DEFAULT_RPC: DEFAULT_RPC, TOKENS: TOKENS, tokenById: tokenById, formatUnits: formatUnits, decodeCallResult: decodeCallResult,
    interpretKeys: interpretKeys, compareFixedClaim: compareFixedClaim, analyze: analyze, rpc: rpc, liveFetch: liveFetch,
    blockTimeIso: blockTimeIso, canonicalize: canonicalize, sha256Hex: sha256Hex, buildBundle: buildBundle, verifyBundle: verifyBundle,
    snapshotSource: snapshotSource, NccError: NccError, sha256Fallback: sha256Fallback, hashEngine: function () { return lastHashEngine; } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.NCC = api;
})(this);
