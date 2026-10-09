// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — Token Risk Check Engine
//  Second safety gate for V5 Alpha. Runs AFTER the confidence score.
//  Built by Nxvana for Leon. Meteora DBC sidetrack submission.
// ═══════════════════════════════════════════════════════════════
//
//  Design rule: profitability and safety are SEPARATE gates.
//  A very profitable trade must never be able to outvote a honeypot.
//
//  Design rule 2: a failed FETCH must never read as a PASS — and must
//  never be reported as a FAIL either. Those are different facts.
//  A 429 rate limit is not evidence about a token; it is evidence about
//  the RPC endpoint. Conflating the two manufactures accusations against
//  healthy tokens. Unreadable checks land in their own state: UNVERIFIED.
//
//  Every check here is public RPC or a free public API. No vendor key.

import { Connection, PublicKey } from '@solana/web3.js';
import type { DexAdapter } from './adapters';
// Runtime import, one-directional: dbc.ts imports ONLY types from this file,
// so `import type` erases its side of the edge and there is no runtime cycle.
import { findPoolByBaseMint, quoteCurveSell } from './dbc';

// ── Types ──────────────────────────────────────────────────────

export type Severity = 'block' | 'warn';

/**
 * Four states, not two.
 *
 *   pass        — the read succeeded and the token is clean on this axis
 *   fail        — the read succeeded and the token is dangerous
 *   skip        — the check does not apply to this pool type
 *   unverified  — the read failed (429 / timeout / RPC down). NOT a finding.
 *
 * 'unverified' is the entire point of this module. Any code path that
 * turns it into a 'fail' is reintroducing the bug this enum exists to kill.
 */
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'unverified';

export interface RiskCheck {
  id: string;
  name: string;
  status: CheckStatus;
  /** back-compat: true only for 'pass' and 'skip'. Never true for unverified. */
  passed: boolean;
  /** back-compat: true only when the check is inapplicable to this pool */
  skipped: boolean;
  /** true when the check could not be READ. Distinct from a failure. */
  unverified: boolean;
  severity: Severity;
  detail: string;
  /** raw value for the UI; never used in pass/fail logic */
  observed?: string | number | null;
}

export type Decision = 'ALLOW' | 'ALLOW_WITH_WARNINGS' | 'BLOCK' | 'UNVERIFIED';

export interface RiskVerdict {
  mintAddress: string;
  /**
   * ALLOW requires: nothing blocked AND nothing left unverified.
   * An unread check is not a pass. It is also not an accusation —
   * see `decision`, which keeps 'UNVERIFIED' separate from 'BLOCK'.
   */
  safe: boolean;
  decision: Decision;
  /**
   * 0-100 over VERIFIED checks only, 100 = cleanest.
   * null when no check could be read at all — a number here would be
   * invented, and an invented number is worse than an absent one.
   */
  riskScore: number | null;
  /** resolved / total, 0..1 — resolved counts pass, fail AND skip; only a
   *  failed read (unverified) is treated as a gap. */
  confidence: number;
  blocked: RiskCheck[];      // confirmed failures, severity 'block'
  warned: RiskCheck[];       // confirmed failures, severity 'warn'
  unverified: RiskCheck[];   // could not be read — NOT failures
  checks: RiskCheck[];
  evaluatedAt: number;
  cachedSeconds: number;
  /**
   * True when this verdict was served from cache past its TTL while a fresh
   * audit ran in the background (stale-while-revalidate). A stale ALLOW is
   * still an ALLOW — but silence about it would be a lie, so the log and the
   * UI read this flag and say "stale" out loud.
   */
  stale?: boolean;
  /** true when this mint's audit was still running when the cache was read */
  refreshing?: boolean;
  fetchErrors: number;
}

export interface RiskOptions {
  /** max % of supply the top-10 accounts may hold. default 60 */
  maxTop10Pct?: number;
  /** min % of LP supply that must sit in the burn address. default 90 */
  minLpBurnedPct?: number;
  /** skip the LP check entirely (pools without an LP token) */
  skipLiquidity?: boolean;
  /** explicit LP mint, bypasses DEX adapter resolution */
  lpMint?: string;
  /** explicit pool address, bypasses DEX adapter resolution */
  poolAddress?: string;
  /** cache TTL. default 60s */
  cacheSeconds?: number;
}

const DEFAULT_OPTS = {
  maxTop10Pct: 60,
  minLpBurnedPct: 90,
  cacheSeconds: 60,
};

/**
 * TTL for a verdict that came back with unverified checks. Short on purpose:
 * a rate-limited read is a transient network fact, and holding every trade for
 * a full minute on the strength of one 429 is its own kind of wrong.
 */
const RETRY_TTL_SECONDS = 10;

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

// ── Cache (mandatory — a 15s poll would re-request the same mint
//    constantly and rate-limit itself into failed checks) ────────
//
// THE CACHE IS PER-PROCESS MEMORY. It is a module-level Map, so a pre-warmer
// running anywhere else — the dashboard, a cron, another shell — warms
// nothing that the engine can see. Anything that wants to keep the engine's
// gate off the critical path has to run INSIDE the engine process. That is
// why solguard/warm.ts is wired into Cyborg_V5_Alpha_Solana.ts and not into
// a sidecar.

interface CacheEntry {
  verdict: RiskVerdict;
  at: number;
  /**
   * TTL for THIS entry. Unverified verdicts are stored with a shorter one so a
   * transient 429 clears itself in seconds instead of holding every trade for
   * the full window. See RETRY_TTL_SECONDS.
   */
  ttlSeconds: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * SINGLE-FLIGHT — one audit per mint, however many callers ask.
 *
 * Before this, ten candidates on one pair fired ten identical audits
 * simultaneously. Ten concurrent getTokenLargestAccounts calls on a free
 * endpoint is a self-inflicted 429 storm, and every check it breaks becomes
 * an UNVERIFIED, which holds every trade. The cure must not be the disease.
 *
 * Concurrent callers now share one promise and one RPC fan-out.
 */
const inflight = new Map<string, Promise<RiskVerdict>>();

export function clearRiskCache(): void { cache.clear(); }
export function riskCacheSize(): number { return cache.size; }
export function riskInflightCount(): number { return inflight.size; }

/** Seconds since this mint was last audited, or null if never. */
export function peekRiskAge(mintAddress: string): number | null {
  const hit = cache.get(mintAddress);
  return hit ? (Date.now() - hit.at) / 1000 : null;
}

/**
 * Would a read right now be wasted RPC? The pre-warmer asks this before every
 * mint so a 30s pass doesn't re-audit entries that are still good.
 */
export function isRiskFresh(
  mintAddress: string,
  ttlSeconds?: number,
): boolean {
  const hit = cache.get(mintAddress);
  if (!hit) return false;
  const ttl = ttlSeconds ?? hit.ttlSeconds ?? DEFAULT_OPTS.cacheSeconds;
  return (Date.now() - hit.at) / 1000 < ttl;
}

export function riskCacheSnapshot(): {
  size: number;
  inflight: number;
  mints: string[];
} {
  return { size: cache.size, inflight: inflight.size, mints: [...cache.keys()] };
}

/**
 * Stale-while-revalidate window, in seconds, beyond the TTL.
 *
 * Why this is acceptable for a pre-trade gate, stated honestly:
 *
 *   SAFE BY CONSTRUCTION for the two checks that matter most. Mint authority
 *   and freeze authority are MONOTONIC on SPL Token — once set to null they
 *   cannot be restored by anyone, ever. A stale read of those can therefore
 *   never be a stale "clean" hiding a newly-created danger; the danger can
 *   only move in one direction, and it can't move back.
 *
 *   NOT safe by construction for the market checks. Concentration, LP burn
 *   and sell route are mutable — a pool can drain, a route can vanish. That
 *   is exactly why the window is bounded (default 120s), why every verdict
 *   served this way is stamped `stale: true`, and why it is switchable:
 *   set SOLGUARD_SWR_SECONDS=0 to disable and always pay the full re-audit.
 *
 *   Worst case with the default: a 3-minute-old sell-route answer, clearly
 *   labelled as such, instead of a trade arriving 2.2s after the opportunity
 *   died. Both are imperfect. Only one of them is dishonest about it.
 */
function swrGraceSeconds(): number {
  const raw = process.env.SOLGUARD_SWR_SECONDS;
  if (raw === undefined) return 120;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}


// ── Small helpers ──────────────────────────────────────────────

function ok(id: string, name: string, detail: string, observed?: string | number | null): RiskCheck {
  return { id, name, status: 'pass', passed: true, skipped: false, unverified: false, severity: 'block', detail, observed };
}
function fail(id: string, name: string, detail: string, observed?: string | number | null, severity: Severity = 'block'): RiskCheck {
  return { id, name, status: 'fail', passed: false, skipped: false, unverified: false, severity, detail, observed };
}
function skip(id: string, name: string, detail: string): RiskCheck {
  return { id, name, status: 'skip', passed: true, skipped: true, unverified: false, severity: 'warn', detail, observed: null };
}
/**
 * The read failed. NOT a finding about the token.
 * severity 'warn' so it can never enter `blocked`; the verdict-level
 * decision is what escalates it to "hold for review".
 */
function unv(id: string, name: string, detail: string, observed?: string | number | null): RiskCheck {
  return { id, name, status: 'unverified', passed: false, skipped: false, unverified: true, severity: 'warn', detail, observed };
}
/** @deprecated name kept so no call site silently reverts to fail-closed-blocking. */
const err = unv;

// ── RPC resilience ─────────────────────────────────────────────
//
// The public endpoint rate-limits getTokenLargestAccounts aggressively.
// Before this existed, one 429 was enough to fabricate a BLOCK. Retrying
// with backoff means the check usually RESOLVES, and when it genuinely
// cannot, it reports unverified instead of inventing a danger.

const RPC_ATTEMPTS = 3;
const RPC_BASE_DELAY_MS = 350;

export function isRateLimited(e: any): boolean {
  const m = String(e?.message ?? e ?? '');
  return /429|too many requests|rate limit|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(m);
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let last: any;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      if (attempt === RPC_ATTEMPTS) break;
      // jittered exponential backoff — avoids hammering in lockstep
      const delay = RPC_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
      if (process.env.SOLGUARD_DEBUG) {
        console.warn(`[solguard] ${label} attempt ${attempt} failed (${e?.message ?? e}); retrying in ${delay}ms`);
      }
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw last;
}

// ── Check 1 + 2 : mint + freeze authority ──────────────────────
// Both come from ONE getParsedAccountInfo call, so they are one unit
// of work but two distinct verdicts.

interface MintFacts {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  isToken2022: boolean;
  extensions: string[];
}

async function readMint(connection: Connection, mint: PublicKey): Promise<MintFacts> {
  const info: any = await withRetry(
    () => connection.getParsedAccountInfo(mint),
    'getParsedAccountInfo(mint)',
  );
  if (!info?.value?.data) throw new Error('mint account not found or not owned by a token program');

  const data: any = info.value.data;
  const parsed = data.parsed;
  if (!parsed || parsed.type !== 'mint') {
    throw new Error(`account is not a mint (type=${parsed?.type ?? 'unknown'})`);
  }

  const i = parsed.info;
  const knownExts = ['transferHook', 'transferFeeConfig', 'permanentDelegate', 'mintCloseAuthority', 'defaultAccountState'];

  return {
    mintAuthority: i.mintAuthority ?? null,
    freezeAuthority: i.freezeAuthority ?? null,
    supply: BigInt(i.supply ?? '0'),
    decimals: Number(i.decimals ?? 0),
    isToken2022: data.program === 'spl-token-2022',
    extensions: (i.extensions ?? [])
      .map((e: any) => e.extension)
      .filter((e: string) => knownExts.includes(e)),
  };
}

function checkMintAuthority(f: MintFacts): RiskCheck {
  const id = 'mint_authority', name = 'Mint authority revoked';
  if (f.mintAuthority === null) {
    return ok(id, name, 'Mint authority is null — supply is fixed and cannot be inflated.');
  }
  return fail(
    id, name,
    `Mint authority is LIVE at ${f.mintAuthority}. The holder can mint unlimited supply and dilute any position to zero.`,
    f.mintAuthority,
  );
}

function checkFreezeAuthority(f: MintFacts): RiskCheck {
  const id = 'freeze_authority', name = 'Freeze authority revoked';
  if (f.freezeAuthority === null) {
    return ok(id, name, 'Freeze authority is null — token accounts cannot be frozen.');
  }
  return fail(
    id, name,
    `Freeze authority is LIVE at ${f.freezeAuthority}. This key can freeze your token account, making the position permanently unsellable after you buy.`,
    f.freezeAuthority,
  );
}

// ── Check 3 : liquidity burned or locked ───────────────────────

async function checkLiquidity(
  connection: Connection,
  lpMint: string | null,
  minPct: number,
): Promise<RiskCheck> {
  const id = 'lp_burn', name = 'Liquidity burned';

  if (!lpMint) {
    return skip(id, name, 'No LP mint resolved for this pool type — liquidity check skipped (not a pass).');
  }

  const info: any = await withRetry(
    () => connection.getParsedAccountInfo(new PublicKey(lpMint)),
    'getParsedAccountInfo(lpMint)',
  );
  const supplyStr = info?.value?.data?.parsed?.info?.supply;
  if (!supplyStr) throw new Error(`LP mint ${lpMint.slice(0, 8)} unreadable`);

  const supply = BigInt(supplyStr);
  if (supply === 0n) return fail(id, name, 'LP mint has zero supply — pool has no liquidity token.', '0');

  const largest = await withRetry(
    () => connection.getTokenLargestAccounts(new PublicKey(lpMint)),
    'getTokenLargestAccounts(lpMint)',
  );
  let burnBalance = 0n;
  for (const r of largest?.value ?? []) {
    if ((r as any).address === INCINERATOR) burnBalance += BigInt(r.amount);
  }

  // also ask directly in case the burn address is outside the top-20
  if (burnBalance === 0n) {
    const accts = await withRetry(
      () => connection.getParsedTokenAccountsByOwner(
        new PublicKey(INCINERATOR),
        { mint: new PublicKey(lpMint) },
      ),
      'getParsedTokenAccountsByOwner(incinerator)',
    );
    for (const a of accts.value) {
      burnBalance += BigInt((a.account.data as any).parsed.info.tokenAmount.amount);
    }
  }

  const pct = Number((burnBalance * 10000n) / supply) / 100;
  const observed = `${pct.toFixed(2)}%`;

  if (pct >= minPct) {
    return ok(id, name, `${pct.toFixed(2)}% of LP supply is in the incinerator — pool cannot be pulled.`, observed);
  }
  return fail(
    id, name,
    `Only ${pct.toFixed(2)}% of LP supply is burned (need ${minPct}%). The remaining LP can be withdrawn, draining the pool and taking your exit liquidity with it.`,
    observed,
  );
}

// ── Check 4 : holder concentration ─────────────────────────────

async function checkConcentration(
  connection: Connection,
  mint: PublicKey,
  supply: bigint,
  maxPct: number,
): Promise<RiskCheck> {
  const id = 'concentration', name = 'Holder concentration';

  if (supply === 0n) return fail(id, name, 'Mint supply is zero — nothing can be traded.', '0', 'warn');

  const largest = await withRetry(
    () => connection.getTokenLargestAccounts(mint),
    'getTokenLargestAccounts(mint)',
  );
  const rows = (largest?.value ?? []).slice(0, 10);
  if (rows.length === 0) return skip(id, name, 'No token accounts returned — token may be entirely untraded.');

  let top10 = 0n;
  for (const r of rows) top10 += BigInt(r.amount);

  const pct = Number((top10 * 10000n) / supply) / 100;
  const observed = `${pct.toFixed(2)}%`;

  // ~100% in the top 10 means very different things on a live market and on
  // a bonding curve, which holds its own unsold inventory by construction.
  // Only ask the extra question when the number is extreme, so the common
  // path costs no extra request. Confirmed live: NXA reads 100.00% and has
  // no DEX pair at all — flagging that as whale risk is an invented finding.
  if (pct >= 99) {
    const pairExists = await hasDexPair(mint.toBase58());
    if (pairExists === false) {
      return skip(
        id, name,
        `Top 10 accounts hold ${pct.toFixed(2)}% of supply, but this mint has no DEX pair yet — that is bonding-curve inventory, not a whale. Concentration becomes a meaningful signal after graduation.`,
      );
    }
  }

  // Warn, never block. Legitimate tokens are genuinely concentrated at launch.
  if (pct <= maxPct) {
    return { ...ok(id, name, `Top 10 accounts hold ${pct.toFixed(2)}% of supply (ceiling ${maxPct}%).`, observed), severity: 'warn' };
  }
  return fail(
    id, name,
    `Top 10 accounts hold ${pct.toFixed(2)}% of supply (ceiling ${maxPct}%). A small group can exit into your entry.`,
    observed,
    'warn',
  );
}

// ── Check 5 : sell route exists (honeypot proxy) ───────────────

// quote-api.jup.ag/v6 is RETIRED — every call died with "fetch failed".
// lite-api.jup.ag/swap/v1/quote is the keyless replacement, verified live.
const JUPITER_QUOTE_URLS = [
  'https://lite-api.jup.ag/swap/v1/quote',
  'https://api.jup.ag/swap/v1/quote',
];
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens';

// ── Numeraire guard ────────────────────────────────────────────
//
// The sell-route check asks one question: "if I bought this, could I
// sell it back?" That question is only meaningful about a token you
// might BUY. USDC, USDT and WSOL are the assets you buy WITH — they
// are the quote side of the market, not candidates for it.
//
// Auditing a numeraire is a category error, and for USDC it was also a
// live false accusation. Sequence, confirmed by reading the paths:
//
//   1. For a USDC-quoted pair the engine's resolver can return USDC
//      itself as the risk mint (ironically because pickRiskMint()
//      prefers the non-stable side and falls back to tokenMint when
//      BOTH sides are stable).
//   2. The probe below then quotes USDC → USDC.
//   3. No aggregator can ever route a self-swap. Jupiter answers 400.
//   4. hasDexPair() finds thousands of USDC pairs → "a market exists".
//   5. The old code concluded: "A DEX pair EXISTS but Jupiter still
//      cannot route a sell — treat as a potential honeypot."
//
// So SolGuard accused USDC — the definitionally sellable asset — of
// being a honeypot. The identical breakage hits any numeraire equal to
// the quote mint, and USDT/wSOL carry the same category error even
// when the quote happens to route fine.
//
// Fixed by refusing to run the check at all against a numeraire. Note
// this returns SKIP, never OK: a numeraire is not a "pass" of the
// honeypot check, the check simply does not apply. See `skip()` for
// why that distinction is load-bearing.
// Exported because integrate.ts needs the SAME set to decide that an
// opportunity is not auditable at all. Two copies of this list would drift,
// and a drifted numeraire list is exactly the bug this block documents.
export const NUMERAIRE_MINTS = new Map<string, string>([
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'],
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT'],
  ['So11111111111111111111111111111111111111112', 'WSOL'],
]);

export function numeraireName(mint: string): string | null {
  return NUMERAIRE_MINTS.get(mint) ?? null;
}

/**
 * Does any DEX pair exist for this mint?
 *   true  — a market exists, so a missing Jupiter route IS meaningful
 *   false — no market yet (normal pre-graduation for a curve token)
 *   null  — could not tell. Never treat null as 'false'.
 */
async function hasDexPair(mint: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${DEXSCREENER_URL}/${mint}`);
    if (!res.ok) return null;
    const data: any = await res.json();
    // DexScreener answers {"pairs":null} when it knows of NO pair — verified
    // live against NXA, which returns exactly that. It is a definitive
    // answer, not an error. Only a failed or malformed reply is 'unknown'.
    if (!data || !('pairs' in data)) return null;
    if (data.pairs === null) return false;
    return Array.isArray(data.pairs) && data.pairs.length > 0;
  } catch {
    return null; // unknown, NOT 'no pair'
  }
}

/** Impact on a probe this small already reads as thin liquidity.
 *  A FRACTION, not a percent — shared by the curve and aggregator paths so
 *  the two sources can never disagree about what "5%" means. */
const PROBE_IMPACT_WARN = 0.05;

/** Opt-in diagnostics for the DBC curve path.
 *  A silent fallback is precisely how a coverage hole hides: "this is not a
 *  DBC token" and "the read failed" are indistinguishable from the outside,
 *  and only one of them is a problem. Quiet by default, loud on request. */
function dbcDebug(msg: string): void {
  const flag = process.env.SOLGUARD_DEBUG_DBC;
  if (flag === '1' || flag === 'true') console.error(`[solguard:dbc] ${msg}`);
}

/**
 * DBC-native sell route.
 *
 * A pre-graduation token has no DEX pool, so an aggregator has nothing to
 * route through and the old answer was SKIP. During the bonding phase the
 * curve IS the market — and Meteora's own SDK can quote it in-process, from
 * accounts this module already reads.
 *
 * Returns null whenever this path does not apply or cannot be trusted: not a
 * DBC token, SDK absent, read failed, quote threw. Null means "fall through
 * to the aggregator path". It never means "fail", because a DBC read error is
 * a fact about the RPC endpoint and never a fact about the token.
 */
async function tryCurveSellRoute(
  connection: Connection,
  mint: PublicKey,
  probe: bigint,
): Promise<RiskCheck | null> {
  const id = 'sell_route', name = 'Sell route exists';
  // Lookup and quote are reported separately on purpose: "this mint has no DBC
  // pool" is normal and stays quiet, while "the lookup itself failed" is a
  // coverage hole and must be audible. Collapsing both into one silent null is
  // how a broken check impersonates a check that never applied.
  let ref: { poolAddress: string; accountKey: string | null } | null;
  try {
    ref = await findPoolByBaseMint(connection, mint.toBase58());
  } catch (e: any) {
    dbcDebug(`pool lookup failed for ${mint.toBase58()}: ${e?.message ?? e}`);
    return null;
  }
  if (!ref) {
    dbcDebug(`${mint.toBase58()} is not a DBC base mint — curve path not applicable`);
    return null;
  }

  try {
    const q = await quoteCurveSell(connection, ref.poolAddress, probe);
    const impactTxt =
      q.impactPct == null ? null : `impact ${(Math.abs(q.impactPct) * 100).toFixed(2)}%`;
    const observed = `Meteora DBC curve${impactTxt ? ' · ' + impactTxt : ''}`;

    if (q.outAmountRaw === '0') {
      return fail(
        id, name,
        `This token IS on a Meteora bonding curve (${ref.poolAddress}), and the curve returns nothing for a sell of ${probe} base units. During the bonding phase the curve is the only market — a zero-output curve is a genuine exit problem.`,
        observed, 'warn',
      );
    }

    if (q.impactPct != null && Math.abs(q.impactPct) > PROBE_IMPACT_WARN) {
      return fail(
        id, name,
        `Sell route exists on the Meteora bonding curve, but a probe of ${probe} base units already moves the price ${(Math.abs(q.impactPct) * 100).toFixed(2)}%. The curve is too thin to exit a real size.`,
        observed, 'warn',
      );
    }

    const tail = impactTxt
      ? ` ${impactTxt.charAt(0).toUpperCase()}${impactTxt.slice(1)} on probe size.`
      : ' Curve returned a live price.';

    return ok(
      id, name,
      `Sell route confirmed against the Meteora bonding curve at ${ref.poolAddress} — quoted in-process through Meteora's own SDK, with no aggregator and no third party.${tail}`,
      observed,
    );
  } catch (e: any) {
    // The curve exists but the quote failed. Fall through to the aggregator —
    // this is an RPC fact, never a fact about the token.
    dbcDebug(`curve quote failed for ${ref.poolAddress}: ${e?.message ?? e}`);
    return null;
  }
}

async function checkSellRoute(
  connection: Connection,
  mint: PublicKey,
  supply: bigint,
): Promise<RiskCheck> {
  const id = 'sell_route', name = 'Sell route exists';

  // Never audit the numeraire — see NUMERAIRE_MINTS above. Quoting
  // USDC→USDC is unrouteable by construction and produced a live false
  // accusation; the other two are simply not candidate tokens. Returning
  // skip (not ok) keeps the meaning honest: this check did not apply.
  const num = numeraireName(mint.toBase58());
  if (num) {
    return skip(
      id, name,
      `${num} is a numeraire — the asset this check quotes against, not a token you would buy. Asking whether ${num} can be sold is a category error, so this check does not apply.`,
    );
  }

  // probe with a tiny slice of supply so we need no funded wallet
  const probe = supply > 0n ? (supply / 100_000n || 1n) : 1n;

  // ── DBC-native path, tried FIRST ──────────────────────────────
  // During the bonding phase the curve IS the market, so Meteora's own SDK
  // answers this question better than any aggregator can — and it answers it
  // from accounts we already hold. Deliberately additive: a null return means
  // "this path does not apply here", never a finding about the token.
  const curve = await tryCurveSellRoute(connection, mint, probe);
  if (curve) return curve;

  const params = new URLSearchParams({
    inputMint: mint.toBase58(),
    outputMint: USDC_MINT,
    amount: probe.toString(),
    slippageBps: '300',
    onlyDirectRoutes: 'false',
  });

  let res: Awaited<ReturnType<typeof fetch>> | null = null;
  let noRoute = false;
  let lastStatus = 0;
  for (const base of JUPITER_QUOTE_URLS) {
    try {
      const r = await fetch(`${base}?${params.toString()}`);
      lastStatus = r.status;
      if (r.ok) { res = r; break; }
      // 429 / 5xx is the quoter's problem, not the token's.
      if (r.status === 429 || r.status >= 500) continue;
      // Jupiter refuses to quote with HTTP 400 when it cannot build a route.
      // An earlier version of this file parsed the error body for the word
      // "route" — which FAILED live against NXA: the body's reason string did
      // not contain it, so a routeless (and perfectly healthy) curve token
      // fell through to an accusation. Do not parse the reason.
      //
      // Whether a missing route means anything is a question about the
      // MARKET, and hasDexPair() below answers it properly. 400 means only:
      // "the quoter has nothing for you."
      if (r.status === 400) { noRoute = true; break; }
      return fail(id, name, `Jupiter returned HTTP ${r.status} for a token→USDC quote. No confirmed exit route.`, r.status, 'warn');
    } catch {
      lastStatus = 0;
    }
  }

  if (!res && !noRoute) {
    return unv(
      id, name,
      `Could not reach Jupiter (${lastStatus || 'network error'}). Sell route NOT disproven — an endpoint failure is not a finding about the token.`,
      lastStatus || 'unreachable',
    );
  }

  const data: any = res ? await res.json() : {};
  const out = data?.outAmount ?? data?.out_amount;
  if (noRoute || !out || out === '0') {
    // No route. Whether that means anything depends on whether a market
    // exists at all — ask before accusing.
    const pairExists = await hasDexPair(mint.toBase58());

    if (pairExists === null) {
      return unv(id, name, 'Jupiter returned no route and DexScreener was unreachable — sell route NOT disproven.', 'no route');
    }
    if (pairExists === false) {
      return skip(id, name, 'No DEX pair exists yet — pre-graduation curve token, so the curve IS the market. A missing aggregator route is expected here and is not a honeypot signal.');
    }
    return fail(id, name, 'A DEX pair EXISTS but Jupiter still cannot route a sell. Buyers may be unable to exit — treat as a potential honeypot until disproven.', 'no route', 'warn');
  }

  const impact = parseFloat(data.priceImpactPct ?? '0');
  const observed = `impact ${(impact * 100).toFixed(2)}%`;

  // Jupiter reports `priceImpactPct` as a DECIMAL FRACTION (0.05 = 5%), never a
  // percentage. The old `> 0.5` therefore only tripped at 50% impact while its
  // message implied 0.5% — a false CLEARANCE on a token barely sellable, which
  // is the mirror image of the false accusation this file was already burned
  // by, and the more dangerous of the two: a lie that reads as a pass.
  if (Math.abs(impact) > PROBE_IMPACT_WARN) {
    return fail(id, name, `Sell route exists but price impact on a tiny probe is ${(impact * 100).toFixed(2)}% — liquidity is too thin to exit a real size.`, observed, 'warn');
  }
  return ok(id, name, `Sell route confirmed via Jupiter (${(impact * 100).toFixed(2)}% impact on probe size).`, observed);
}

// ── Orchestration ──────────────────────────────────────────────

export interface EvaluateArgs {
  connection: Connection;
  mintAddress: string;
  adapter?: DexAdapter | null;
  opts?: RiskOptions;
}

/**
 * Cached read. This is what the engine's Tier-0 gate calls.
 *
 * Three behaviours, in order:
 *
 *   1. FRESH HIT — return at once. This is the case the pre-warmer exists to
 *                  make universal, and it turns a 2208ms audit into a Map
 *                  lookup.
 *   2. STALE HIT — inside the SWR grace window: hand back what we have NOW
 *                  and revalidate in the background. The caller never waits,
 *                  and the verdict is stamped `stale: true`.
 *   3. MISS      — full audit, single-flighted.
 */
export async function evaluateTokenRisk(args: EvaluateArgs): Promise<RiskVerdict> {
  const { mintAddress } = args;
  const o = { ...DEFAULT_OPTS, ...(args.opts ?? {}) };

  const hit = cache.get(mintAddress);
  if (hit) {
    const age = Date.now() - hit.at;
    const ageSeconds = Math.round(age / 1000);
    // The entry carries its own TTL — a rate-limited verdict expires fast.
    const ttlMs = (hit.ttlSeconds ?? o.cacheSeconds) * 1000;

    if (age < ttlMs) {
      return {
        ...hit.verdict,
        cachedSeconds: ageSeconds,
        stale: false,
        refreshing: inflight.has(mintAddress),
      };
    }

    const graceMs = swrGraceSeconds() * 1000;
    if (graceMs > 0 && age < ttlMs + graceMs) {
      // Serve the stale copy; revalidate behind the caller's back. A failed
      // refresh leaves the old entry in place rather than blanking the cache.
      void refreshTokenRisk(args).catch(() => { /* keep the stale copy */ });
      return { ...hit.verdict, cachedSeconds: ageSeconds, stale: true };
    }
  }

  return refreshTokenRisk(args);
}

/**
 * Force a re-audit, bypassing the cache. SINGLE-FLIGHT: if an audit for this
 * mint is already running, join it instead of starting a second one.
 *
 * The pre-warmer calls this directly, and so does stale-while-revalidate.
 */
export async function refreshTokenRisk(args: EvaluateArgs): Promise<RiskVerdict> {
  const { mintAddress } = args;

  const existing = inflight.get(mintAddress);
  if (existing) return existing;

  const run = (async () => {
    try {
      return await computeVerdict(args);
    } finally {
      inflight.delete(mintAddress);
    }
  })();

  inflight.set(mintAddress, run);
  return run;
}

/**
 * The actual work. Go through evaluateTokenRisk() or refreshTokenRisk() —
 * calling this directly skips both the cache and the single-flight guard.
 */
async function computeVerdict({
  connection, mintAddress, adapter, opts,
}: EvaluateArgs): Promise<RiskVerdict> {
  const o = { ...DEFAULT_OPTS, ...(opts ?? {}) };

  const mint = new PublicKey(mintAddress);
  const checks: RiskCheck[] = [];
  let fetchErrors = 0;

  // checks 1 + 2 share one RPC call
  let facts: MintFacts | null = null;
  try {
    facts = await readMint(connection, mint);
    checks.push(checkMintAuthority(facts));
    checks.push(checkFreezeAuthority(facts));

    // Token-2022 extra surface: a permanent delegate is functionally
    // the same risk as a live freeze authority.
    if (facts.extensions.includes('permanentDelegate')) {
      checks.push(fail('perm_delegate', 'No permanent delegate',
        'Token-2022 permanent delegate is set. That authority can move tokens out of ANY holder account, including yours, at any time.', 'permanentDelegate'));
    }
    if (facts.extensions.includes('transferHook')) {
      checks.push(fail('transfer_hook', 'No transfer hook',
        'Token-2022 transfer hook is set. An external program runs on every transfer and can reject your sell.', 'transferHook', 'warn'));
    }
  } catch (e: any) {
    fetchErrors++;
    checks.push(err('mint_authority', 'Mint authority revoked', `Could not read mint: ${e.message}`));
    checks.push(err('freeze_authority', 'Freeze authority revoked', `Could not read mint: ${e.message}`));
  }

  // check 3
  if (o.skipLiquidity) {
    checks.push(skip('lp_burn', 'Liquidity burned', 'Liquidity check disabled by config.'));
  } else {
    try {
      let lpMint = o.lpMint ?? null;
      if (!lpMint && adapter) {
        const ref = await adapter.resolvePool(mintAddress, o.poolAddress);
        lpMint = ref?.lpMint ?? null;
      }
      checks.push(await checkLiquidity(connection, lpMint, o.minLpBurnedPct));
    } catch (e: any) {
      fetchErrors++;
      checks.push(err('lp_burn', 'Liquidity burned', `LP check failed: ${e.message}`));
    }
  }

  // check 4
  try {
    if (!facts) throw new Error('mint facts unavailable');
    checks.push(await checkConcentration(connection, mint, facts.supply, o.maxTop10Pct));
  } catch (e: any) {
    fetchErrors++;
    checks.push(err('concentration', 'Holder concentration', `Concentration check failed: ${e.message}`));
  }

  // check 5
  try {
    if (!facts) throw new Error('mint facts unavailable');
    checks.push(await checkSellRoute(connection, mint, facts.supply));
  } catch (e: any) {
    fetchErrors++;
    checks.push(unv('sell_route', 'Sell route exists', `Route probe failed: ${e.message}. Sell route NOT disproven — could not reach the quoter.`));
  }

  // ── Aggregation ────────────────────────────────────────────────
  //
  // Three buckets, kept strictly apart:
  //   blocked    — the read SUCCEEDED and found danger
  //   warned     — the read SUCCEEDED and found something worth flagging
  //   unverified — the read FAILED. No opinion on the token either way.
  //
  // Only confirmed failures may enter the score. An unverified check is
  // excluded from the numerator AND the denominator, so a rate-limited
  // RPC cannot move the number in either direction.

  const blocked    = checks.filter(c => c.status === 'fail' && c.severity === 'block');
  const warned     = checks.filter(c => c.status === 'fail' && c.severity === 'warn');
  const unverified = checks.filter(c => c.status === 'unverified');

  const verified = checks.filter(c => c.status === 'pass' || c.status === 'fail').length;
  // A skip is a definitive answer ("this check does not apply here"), so it
  // counts toward how much of the picture we saw. Only 'unverified' — a read
  // that FAILED — is a genuine gap. Scoring skips as gaps understates
  // confidence on curve tokens, where three of five checks are expected to be
  // inapplicable rather than unknown.
  const resolved = checks.filter(c => c.status !== 'unverified').length;
  const confidence = checks.length ? resolved / checks.length : 0;

  // null when nothing could be read — an absent number beats an invented one.
  const riskScore: number | null = verified === 0
    ? null
    : Math.max(0, Math.round(100 - ((blocked.length + warned.length * 0.4) / verified) * 100));

  const decision: Decision = blocked.length > 0
    ? 'BLOCK'
    : unverified.length > 0
      ? 'UNVERIFIED'
      : warned.length > 0 ? 'ALLOW_WITH_WARNINGS' : 'ALLOW';

  const verdict: RiskVerdict = {
    mintAddress,
    safe: decision === 'ALLOW' || decision === 'ALLOW_WITH_WARNINGS',
    decision,
    riskScore,
    confidence,
    blocked, warned, unverified, checks,
    evaluatedAt: Date.now(),
    cachedSeconds: 0,
    fetchErrors,
  };

  // A verdict containing unverified checks is cached BRIEFLY, so a transient
  // 429 clears itself in seconds instead of holding every trade for the full
  // TTL. A clean or blocked verdict is stable and keeps the whole window.
  // This matters most for the pre-warmer: a warm pass that fails must not
  // poison the cache for a minute.
  const ttlSeconds = verdict.unverified.length > 0
    ? Math.min(o.cacheSeconds, RETRY_TTL_SECONDS)
    : o.cacheSeconds;

  cache.set(mintAddress, { verdict, at: Date.now(), ttlSeconds });
  return verdict;
}

/** Human-readable one-liner. Used by the UI and the Telegram alert. */
export function describeVerdict(v: RiskVerdict): string {
  const score = v.riskScore === null ? 'no score — nothing readable' : `score ${v.riskScore}`;

  if (v.decision === 'BLOCK') {
    return `BLOCKED — ${v.blocked.map(b => b.name).join(', ')} (${score})`;
  }
  if (v.decision === 'UNVERIFIED') {
    return `UNVERIFIED — ${v.unverified.length} check(s) could not be read: ${v.unverified.map(u => u.name).join(', ')}. Held for manual review, NOT accused (${score}, confidence ${(v.confidence * 100).toFixed(0)}%)`;
  }
  if (v.decision === 'ALLOW_WITH_WARNINGS') {
    return `SAFE WITH WARNINGS — ${v.warned.map(w => w.name).join(', ')} (${score})`;
  }
  // Never claim an inapplicable check "passed". Two of five checks passing on
  // a curve token is a different statement from five of five, and the summary
  // line is the sentence a human actually reads.
  const ran = v.checks.filter(c => c.status === 'pass' || c.status === 'fail').length;
  const inapplicable = v.checks.filter(c => c.status === 'skip').length;
  return inapplicable
    ? `SAFE — ${ran} check(s) passed, ${inapplicable} not applicable to this pool type (${score})`
    : `SAFE — all ${ran} checks passed (${score})`;
}

export const SOL_INCINERATOR = INCINERATOR;
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
