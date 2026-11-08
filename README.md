# NEAR Claim Check — Evidence Inspector

A small, rules-based web app (no AI) that puts a NEAR token's **own documentation** next to what **NEAR mainnet shows at one exact block**. It shows evidence. It never says "scam", "safe" or "false". Not financial advice.

Built for NEAR HACKATHON 2026. All code was written on 8 Nov 2026.

## Quick start (judges: do X, see Y)
1. Open `NEAR-Claim-Check-Final.html` in Chrome, Edge or Firefox. It is one self-contained file with no other files, install, wallet or sign-up. (`index.html` is the same app split into modules.)
   **See:** three cards (REF, USDC, USDt). The REF result opens automatically and is labelled **Cached snapshot**, block 223569575, 2026-11-08T05:06:29.369Z (10:06:29 AM PKT).
2. Look at the REF result. **See:** supply `99,990,503.455868361423784555 REF`, which **differs** from the docs' stated "Fixed Supply: 100,000,000" by 9,496.544131638576215445 REF (0.009496%). The cause is not verified, and this is not an accusation.
3. Tap **Check evidence** on USDC. **See:** 1 full-access key, explained as "the key holder can redeploy code", normal for an issuer-controlled token.
4. Switch to **Live public RPC** and tap any card. **See:** "Step n of 5" progress, then a live result pinned to a new block. You may instead get an explicit error (rate limit, network/CORS, or a timeout after 75 s); old data is never shown silently. You can cancel at any time.
5. Tap **Download evidence bundle**, then load that file in **Check a downloaded evidence file**. **See:** "✓ Intact". If you edit any value in the file, it shows "✗ Hash mismatch".

## What each check means
| Check | NEAR RPC call | What it can honestly say |
|---|---|---|
| Name, symbol, decimals | `ft_metadata` | What the contract reports |
| Total supply | `ft_total_supply` | Exact BigInt value. Compared only with a stated *fixed* figure, and a difference is reported as "differs, cause not verified" |
| Access keys | `view_access_key_list` | Full-access keys mean the code can be redeployed by the key holder at that block. **No keys does NOT prove the contract is immutable** (the code may have its own upgrade method) |
| Code hash | `view_account` | Identifies the deployed code. **Not code verification**, which needs a reproducible build from source |

## Architecture
- `lib.js`: pure logic. Exact formatting, key interpretation, claim comparison, the RPC client (per-request 20 s timeout, 75 s overall, cancellable, 5 steps pinned to one block height), the canonical-JSON evidence bundle, and SHA-256 (WebCrypto, with a built-in JavaScript fallback that gives identical results).
- `snapshot.js`: raw RPC responses captured read-only at block 223569575 (originals in a separate validation folder, with SHA256SUMS).
- `app.js`, `index.html`, `styles.css`: UI. A generation guard stops a stale live result from replacing newer content. Switching modes cancels a live read.
- `build-standalone.py`: inlines everything into `NEAR-Claim-Check-Final.html`. No external fonts, CDNs or images.

## Sources (fixtures) and their provenance
| Token | Contract | Source | Status |
|---|---|---|---|
| REF | `token.v2.ref-finance.near` | https://guide.ref.finance/tokenomics ("Fixed Supply: 100,000,000") | **Unverified excerpt**: search-index text, because a direct fetch timed out |
| USDC | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | https://developers.circle.com/stablecoins/usdc-contract-addresses | Address only (search excerpt) |
| USDt | `usdt.tether-token.near` | https://tether.to/en/supported-protocols/ | Address only (directly read) |

## Security and privacy
- Read-only. No wallet, keys, transactions, accounts or secrets.
- Live mode talks only to `https://rpc.mainnet.near.org` (restricted by a Content-Security-Policy `connect-src` rule). No analytics or tracking.
- All on-page text derived from data is HTML-escaped before it is inserted.
- The evidence hash only proves the file was not edited after export. It is not a proof of truth.

## Tests
```
python3 build-standalone.py && node --test tests/test.js   # 15 offline tests
node tests/live-check.js                                   # optional, real read-only RPC (slow)
```
The tests cover: exact BigInt formatting; key interpretation; all 3 token snapshots; claim comparison; RPC errors; per-block pinning; progress, cancellation and overall timeout; deterministic, tamper-evident bundles; SHA-256 fallback against standard test values; the standalone file having no external dependencies and valid JavaScript; app state (open on REF, cancel on mode switch, no stale result, error with retry, controls unlocking) using a minimal fake DOM; and the presence of the responsive CSS rules. **No real-browser visual test has been run.**

## Known limits
- Only 3 hard-coded tokens with curated claims. It does not extract claims from arbitrary websites.
- The public RPC is free but slow and rate-limited. Some phone file viewers may refuse live requests.
- Similar claim checkers exist on other chains (e.g. Calibr, Whitepaper IQ). This one focuses on NEAR.

MIT License. See `LICENSE`.
