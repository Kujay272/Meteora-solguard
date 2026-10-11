# SolGuard — Meteora DBC Bounty Pitch

## Slide 1: Title
**SolGuard**
*A DBC-native pre-trade risk gate for Meteora*

Built for the Meteora Dynamic Bonding Curve Bounty
By Leon Kasirai Kujinga

---

## Slide 2: The Problem
**Pre-graduation DBC tokens are high-risk**

- Aggregators fail on tokens that haven't graduated to DAMM v2
- No reliable way to assess risk before trading
- Honeypots, frozen accounts, and rug pulls are common
- Existing tools treat "unknown" as "safe"

---

## Slide 3: Our Solution
**SolGuard: Audit before execution, not after**

- Five deterministic checks against Solana mainnet
- Direct integration with Meteora DBC SDK (no aggregator dependency)
- Treats "unverified" as a hold-for-review verdict
- Pre-warming cache for sub-millisecond latency

---

## Slide 4: Technical Architecture
```
Arbitrage Engine → SolGuard Gate → Execution
                      ↓
              Five Checks:
              • Mint Authority
              • Freeze Authority
              • LP Burn
              • Holder Concentration
              • Sell Route (DBC-native)
```

---

## Slide 5: Meteora DBC Integration
**Why we use Meteora's SDK directly**

- Curve-native sell quotes via `quoteCurveSell()`
- Pre-graduation tokens: the curve IS the market
- Post-graduation: DAMM v2 pool path (roadmap)
- No third-party dependency in the risk path

---

## Slide 6: Trading Results
**1,122 historical trades (paper trading)**

| Metric | Value |
|--------|-------|
| Total Trades | 1,122 |
| Trading Period | July 2026 |
| Initial Balance | 10.0 SOL |
| Final Balance | 10.0458 SOL |
| Net Profit | +0.458% |

**Trading Pairs:** JUP-USDC (39.6%), MEW-SOL (28.1%), BOME-SOL (24.2%), SOL-BONK (6.7%), POPCAT-USDC (1.4%)

---

## Slide 7: Security Features
**Pre-warm Security Gate**

- Scans mints before trading
- Risk Classification: READ, LOW_WRITE, HIGH_WRITE, FORBIDDEN
- Slippage Protection: Dynamic calculation
- Stop Loss/Take Profit: Automated risk management
- 60-second cache TTL with stale-while-revalidate

---

## Slide 8: Live Dashboard
**Real-time monitoring at localhost:7780**

- Trade feed with animated updates
- SolGuard panel with security status
- Opportunity replay with full cost breakdown
- Engine logs streaming live

![Dashboard](docs/screenshots/solguard-dashboard.png)

---

## Slide 9: Honest Limitations
**What we're transparent about**

- Paper trading only (no real capital deployed)
- Early trade rows have price-normalization defects
- Five checks are not a full audit
- Cold-path latency is 2-4s before cache warms
- Never signed a transaction (read-only by construction)

---

## Slide 10: Roadmap
**Next steps for mainnet deployment**

- Enable gate against live capital
- Descending probe ladder on sell routes
- Jupiter Organic Score as risk input
- DAMM v2 pool path for post-graduation tokens
- Real trading volume generation

---

## Slide 11: Why This Matters for Meteora
**Depth of DBC integration**

- Direct SDK usage, not through aggregators
- Curve-native quoting for pre-graduation tokens
- Security gating specifically designed for DBC launchpads
- Enables safer token launches on Meteora

---

## Slide 12: Call to Action
**Try it yourself**

```bash
git clone https://github.com/Kujay272/Meteora-solguard
cd Meteora-solguard
npm install
npm run v5:ui  # Dashboard at localhost:7780
```

**GitHub:** https://github.com/Kujay272/Meteora-solguard
**Trading Summary:** docs/TRADING_SUMMARY.md
**Collaborator Access:** dannxbt added for judging

---

## Slide 13: Thank You
**Questions?**

Built for the Meteora DBC track
SolGuard — Making DBC trading safer, one check at a time.

@MeteoraAG #Solana #DBC
