# SolGuard — a DBC-native pre-trade risk gate for Meteora

**Read-only · no wallet · no vendor key · no signing key ever loaded**

SolGuard audits a token **before** a trade decision, not after. It runs five
deterministic checks against Solana mainnet, and it treats *"I could not verify
this"* as a verdict of its own rather than quietly rounding it up to "safe".

It was built alongside **V5 Alpha SOL** — a paper-trading arbitrage research
engine — and written against Meteora's **Dynamic Bonding Curve (DBC)**, read
directly through Meteora's own TypeScript SDK. Not through an aggregator.

> **What this submission is.** The gate, and the reasoning discipline behind it.
> The arb engine that hosts it is a research harness running on paper. Its audit
> output is real mainnet state; its P&L ledger is not a track record — see
> [Honest limitations](#honest-limitations).

---

## Why DBC, and why no aggregator

A general-purpose arb bot asks an aggregator *"where is liquidity?"*. When the
subject is a pre-graduation Meteora token, that question is malformed. The curve
**is** the market. There is nothing to route until migration deposits liquidity
into DAMM v2.

So SolGuard quotes the venue that actually holds the asset:

| Stage of a token's life | Where the sell actually has to go | What SolGuard uses |
|---|---|---|
| Pre-graduation | The DBC curve | `quoteCurveSell()` — Meteora DBC SDK, pool state read on-chain |
| Post-graduation | DAMM v2 pool | DAMM v2 (roadmap) |
| Not on Meteora | Any DEX | Venue-direct pools, aggregator only as fallback |

Two consequences that matter:

1. **No third-party dependency in the risk path.** The curve quote is computed
   from pool state SolGuard fetched itself. If Meteora's SDK is missing,
   SolGuard reports `UNVERIFIED` — it never falls back to a fake pass.
2. **The answer is specific.** A curve quote against real reserves can say
   *"5.00% price impact to exit this size"* — a statement about **this** token's
   liquidity. An aggregator's "no route" cannot distinguish *"this token is a
   honeypot"* from *"this token has not graduated yet, and that is normal."*

That second point was a real bug once. SolGuard used to accuse clean
pre-graduation tokens of being honeypots, because no aggregator route exists for
a token that has not graduated. It now says so in as many words:

> `No DEX pair exists yet — pre-graduation curve token, so the curve IS the
> market. A missing aggregator route is expected here and is not a honeypot
> signal.`

---

## The five checks

| id | Check | What a failure means |
|---|---|---|
| `mint_authority` | Mint authority revoked | Supply can be inflated at will |
| `freeze_authority` | Freeze authority revoked | Your token account can be frozen — you cannot sell |
| `lp_burn` | Liquidity burned | LP is withdrawable, rug is possible |
| `concentration` | Holder concentration | A small set of wallets controls the float |
| `sell_route` | Sell route exists | **You may not be able to exit** |

Every check returns one of four states, and the distinction is load-bearing:

| State | Meaning |
|---|---|
| `pass` | Checked, and it is clean |
| `warn` | Checked, and it is concerning — trade still possible |
| `block` | Checked, and it is disqualifying |
| `skip` | Not applicable — there was never anything here to judge |
| `unverified` | **We tried to check and could not.** Never rendered as a pass |

That last row is the whole design thesis. Most risk tooling collapses "unknown"
into "fine", because a confident-looking green tick is easier to sell. SolGuard
refuses, and the engine treats an unreadable check as *hold for review* rather
than as a finding about the token.

---

## Verified live, on mainnet

Every row below came from a real RPC call against a real account. Nothing here
is a fixture.

| Scenario | Live address | Result |
|---|---|---|
| Legacy SPL virtual pool | `RMCXnc7LgcxPLbSL5dWS7kNUhSviraDZtWf2grkcNtN` | **PASS** — no hook surface |
| Token-2022 virtual pool | `Ev4TtL4xzxMvV64aV6sBf7gKeKjLGFAo1Gf9vQWLLfRG` | **PASS** — standard `virtualPool`; discriminator ran and returned `false` |
| Token-2022 **transfer-hook** pool | `5SEiyQuzmhbSE8S35RxsXq1DyHtjxZwxCZupuYfLUdio` | **BLOCK** — external program runs on every transfer, and can reject the sell |
| Numeraire (`USDC`, `USDT`) | `EPjFWdd5…`, `Es9vMFr…` | **N/A** — not a honeypot candidate |
| Clean memecoin | `8ioGsEHtWUqa1P6tKdPQaX5F2MctE26TYMU6pg4Jpump` | **SAFE** 100/100, confidence 1.00, 2.2 s cold |
| DBC curve sell quote | resolved from a base mint via `findPoolByBaseMint()` | **live** — 5.00% impact; flagged *"too thin to exit a real size"* |

The block on the transfer-hook pool is the check earning its keep. That pool is
a Token-2022 account running an **external program on every transfer** — a
program the token's author controls, free to reject sells whenever it likes. A
mint-authority check sees nothing wrong with it. SolGuard refuses the trade.

---

## Two bugs worth reading about

These are in the README because they are the argument that this gate is
honest, not because they were fun.

**1. `poolState != null` was true for every pool ever created.**
Discovery classified a pool as a transfer-hook pool by testing whether the
account had a decodable `poolState` field. But *both* `virtualPool` and
`transferHookPool` decode to `{ poolState: { … } }`. The test was therefore true
for every account, and discovery tagged **5 of 5 pools as hook pools — including
4 that were legacy SPL tokens, which cannot have a transfer hook at all.**

Fix: classify from the account **discriminator bytes**, exported as a pure
function (`classifyPoolAccount`, `isTransferHookFromBytes`) so discovery and the
gate share one byte test and cannot drift apart. Zero extra RPC — the bytes were
already in hand. After the fix: 0 impossible tags across two live runs, and
exactly 1 `[hook]` on the only Token-2022 pool.

**2. Auditing a stablecoin accused USDC of being a honeypot.**
The engine resolves a trade's "risk mint" from its pair. For `SOL-USDC` that
mint *is* USDC. SolGuard then tried to quote a **USDC → USDC self-swap** — which
can never route — and reported *"a DEX pair exists but Jupiter cannot route a
sell; treat as a potential honeypot."* Circle genuinely holds USDC's mint and
freeze authority, so two more checks failed too, and the engine refused to trade
**the most liquid pair in existence.**

Fix: a numeraire is never an audit target. `resolveRiskTarget()` returns a third
state, `not_applicable` — deliberately distinct from `unresolved`. `unresolved`
means *we wanted to audit and could not* (a real hole in coverage, logged as a
warning every cycle). `not_applicable` means *there was never anything here to
audit* (correct behaviour, logged with a different glyph, and it does not
inflate the gate's audit counters).

The general lesson, which is why both are documented: **a check that is wrong in
the safe direction is still wrong.** A false accusation and a false refusal are
the same defect wearing different clothes.

---

## Latency: caching and pre-warming

A cold audit costs seconds. Arb windows are hundreds of milliseconds. So the
gate is built to be a cache hit almost always:

- **Single-flight.** Ten candidates on one pair share one in-flight audit
  instead of firing ten and rate-limiting each other.
- **Cache**: 60 s TTL per mint.
- **Stale-while-revalidate**: a stale verdict is served immediately while a
  refresh runs behind it. `SOLGUARD_SWR_SECONDS=0` disables it.
- **Failed audits cache for 10 s, not 60.** A rate-limited verdict must not lock
  the engine out of a mint for a full minute.
- **Pre-warmer** (`warm.ts`): a strictly serial pass — 250 ms gap, no overlap,
  12 s per-audit timeout — that walks the pairs the engine is currently
  watching and refreshes them *before* the hot path asks.

Measured, single process, live RPC (`npm run solguard -- --warm`):

| | Cold | After pre-warm |
|---|---|---|
| Gate call, 1 mint | **3,833 ms** | **0 ms** |
| Gate call, 3 mints | — | **0 ms × 3** (3/3 warmed in 7,421 ms) |

A pre-warmer only works *inside* the engine process — the cache is a
module-level map, so two separate CLI runs share nothing. That is why the
`--warm` test mode exists as a single-process, three-phase proof.

---

## The dashboard

`npm run v5:ui` → `http://localhost:7780`

Live two-pane UI. Left: the trade feed, new cards animating in with a gold edge.
Right: a SolGuard panel that slides in over the top, plus the engine log.

The dashboard is **purely observational**. It tails the files the engine already
writes — `paper_trades_solana.jsonl`, `opportunity_replay.jsonl`,
`logs/solana_bot.log` — and streams updates over SSE. It does not import, patch
or instrument the engine:

> A UI must never be load-bearing for a trade.

Standalone gate UI: `npm run solguard:ui` → port **7778**. Different port on
purpose, so the two never collide.

---

## Quickstart

```bash
npm install

# one token
npm run solguard -- --mint 8ioGsEHtWUqa1P6tKdPQaX5F2MctE26TYMU6pg4Jpump

# one Meteora DBC pool (curve state + curve-native sell quote)
npm run solguard -- --dbc BzqTRH4p8rYVf4nbVu9ymBvLpahXbtUWGtMtkM9xAKyu

# machine-readable, for piping into your own tooling
npm run solguard -- --mint <MINT> --json
npm run solguard -- --mint <MINT> --out state.json

# live DBC pools, read straight off-chain
npm run solguard -- --discover 10

# why did the curve path decline? (diagnostics go to stderr; the verdict is unchanged)
npm run solguard -- --dbc <POOL> --dbc-debug

# prove the pre-warmer turns a cold audit into a cache hit
npm run solguard -- --warm <MINT,MINT,MINT>

npm run solguard:test     # 12 assertions — pair→mint resolution + counter accounting
npm run typecheck         # tsc --noEmit, exit 0
```

RPC configuration is read from the project's own `.env.Solana`, so a key never
has to be exported into a shell, typed onto a command line, or pasted into
source. **Every endpoint that gets printed passes through `redact()` first** —
a key that lands in a screenshot is a leaked key, and the UI prints its endpoint
on every page load.

Useful flags: `--rpc`, `--cache-seconds`, `--skip-liquidity`, `--only-active`,
`--lp-mint`, `--pool`, `--dex`.

Environment: `SOLGUARD_SWR_SECONDS`, `SOLGUARD_DEBUG_DBC`, `SOLGUARD_PORT`,
`V5_UI_PORT`.

---

## Architecture

```
solguard/
  checks.ts       five checks, verdict assembly, cache + single-flight, SWR
  integrate.ts    wiring for the engine — risk-target resolution, gate counters
  dbc.ts          DBC pool classification (from discriminator bytes) + curve quote
  discover.ts     walk live DBC pools off-chain; report hook status from bytes
  warm.ts         serial pre-warmer + warmth introspection
  cli.ts          command-line surface
  ui-server.ts    standalone gate UI           :7778
  dashboard.ts    V5 live dashboard            :7780
  dashboard.html  two-pane UI, animations, slide-in guard panel
  env.ts          .env loading + secret redaction
  adapters.ts     chain/RPC adapters
  resolve.test.ts 12 assertions

Cyborg_V5_Alpha_Solana.ts   the arb engine that hosts the gate
paper_trades_solana.jsonl   paper trade ledger      (see limitations)
opportunity_replay.jsonl    every candidate seen, with full cost breakdown
logs/                       engine logs
```

`Cyborg_V5_Alpha_Solana.ts` has **no main-guard** — importing it starts the bot.
That is deliberate context for anyone tempted to `import` it, and it is why the
dashboard tails files instead. The regression suite therefore uses a transcribed
fixture rather than importing the engine.

### How the gate sits in the engine

```
detectArb() → for each opportunity → executeArb()
                                        │
                                        ├─ resolveRiskTarget(pair)
                                        │     ├─ not_applicable → allow, log ⏭️
                                        │     ├─ unresolved     → warn ⚠️ (coverage hole)
                                        │     └─ resolved       → evaluateTokenRisk()
                                        │             └─ BLOCK / UNVERIFIED → return false
                                        │
                                        └─ execution
```

Config flags: `solguardEnabled` (default **true**),
`solguardAllowUnverified` (default **false** — an unreadable check holds the
trade), `solguardRequireResolvedMint` (default **false** — an unresolved pair
warns loudly and still trades; set **true** to refuse instead).

Gate counters print every 20 cycles, and the summary separates `unverified`
from `unresolved`, because *"we checked and could not tell"* and *"we never
checked"* are different failures and should not be pooled.

---

## Honest limitations

**1. The paper P&L is not a track record. Do not read it as one.**

`paper_trades_solana.jsonl` holds 1,122 rows, and its early rows are wrong in a
way that matters: a `0.1 SOL` `SOL-BONK` trade logs `profitSol: 221771.9` and
`spreadBps: 22177192123`. That is a price-normalization defect — buy and sell
legs are recorded in mismatched units — and it inflates profit by orders of
magnitude. Later rows are plausible in shape (a `JUP-USDC` row shows ~68 bps
spread, `profitSol: 3.07e-7`) but the ledger still does not subtract the full
cost model that `opportunity_replay.jsonl` computes.

The per-opportunity cost model *is* sound and is the more interesting artifact:
it decomposes DEX fees, flash-loan fee, priority fee, Jito tip, network fee,
slippage estimate and a safety buffer, then **rejects** a 69 bps spread because
the expected net is negative. A cost-aware engine that says *no* is worth more
than a ledger that says *yes*.

**2. Jupiter is demoted to an optional oracle, and its old endpoint is dead.**
The engine's Jupiter block is opt-in and defaults off
(`JUPITER_QUOTE_ENABLED=false`). The legacy `quote-api.jup.ag/v6` host no longer
resolves at all. SolGuard's own quoter targets `lite-api.jup.ag/swap/v1`, and
the sell-route check is DBC-native **first**. Aggregator routing is not on the
critical path.

**3. Five checks are not an audit.** They are deterministic, cheap, and cover
the failure modes that actually liquidate people: inflatable supply, freezable
accounts, withdrawable LP, concentrated float, no exit. They do not model
contract logic, and they are not a substitute for reading the contract.

**4. Cold-path latency is real before the cache warms.** First sight of a mint
costs 2–4 s. Pre-warming and SWR make this rare, not impossible.

**5. This code has never signed a transaction.** Read-only by construction.

---

## Roadmap

- Enable the gate against live capital (paper only today), with the pre-warmer
  running on the engine's own watchlist.
- **Descending probe ladder** on the sell route: if `supply/1e5` returns no
  route, retry at smaller sizes, so `noRoute` is only asserted when *every* size
  fails — and a whale-sized probe is never mistaken for a liquidity fact.
- **Jupiter Organic Score as a risk input** — Meteora's own migration keepers
  gate on *Jupiter Verified* and *Organic Score > 50*. Mirroring the threshold
  Meteora itself uses is the highest-signal, lowest-cost addition available.
- DAMM v2 pool path for post-graduation tokens.
- Promote the transcribed pair fixture into a real import once the engine grows
  a main-guard.

---

**Author:** Leon · **License:** ISC · Built for the Meteora DBC track.
