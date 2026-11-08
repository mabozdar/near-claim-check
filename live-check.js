// Optional: real read-only calls to the public NEAR RPC. Run: node tests/live-check.js
const L = require("../lib.js");
(async () => { for (const t of L.TOKENS) {
  try { const s = await L.liveFetch(fetch, t.id, null, 25000); const a = L.analyze(t.id, s.raw); const b = await L.buildBundle(t.id, "live", s);
    console.log("LIVE", a.symbol, "block", s.block.height, a.supply, a.keys.status, a.claim.status, (await L.verifyBundle(b)).ok ? "bundle-ok" : "bundle-bad");
  } catch (e) { console.log("LIVE", t.short, "ERROR", e.kind, e.message); process.exitCode = 1; } } })();
