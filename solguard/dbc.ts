// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — Meteora DBC Risk Module
// ═══════════════════════════════════════════════════════════════
//
//  WHY THIS FILE EXISTS
//
//  A generic rug-scanner asks "is the LP burned?". That question is
//  meaningless on a DBC virtual pool: there IS no LP token. Liquidity
//  during the bonding phase is the curve itself, and the quote reserve
//  is held by the DBC program.
//
//  So DBC needs its own risk questions:
//
//    1. GRADUATION PROGRESS — quote reserve vs the migration
//       threshold. A curve that never fills traps every buyer in a
//       pool that can never reach DAMM v2 liquidity.
//    2. STUCK CURVE — a pool with meaningful quote reserve but no
//       migration path is capital in limbo.
//    3. SURPLUS / FEE EXTRACTION — who can still claim value out of
//       the pool, and how much of the fee stream is redirected away
//       from liquidity providers.
//    4. TOKEN-2022 HOOK SURFACE — DBC supports Token-2022
//       transfer-hook pools, which can reject sells.
//
//  DATA SOURCE
//  We read live state through Meteora's own SDK. We deliberately do
//  NOT hand-roll account deserialisation: guessing byte offsets for a
//  program this complex is how you ship a lie that looks like a
//  feature. If the SDK is absent we say so, loudly, and the UI shows
//  an UNVERIFIED badge rather than a fake pass.

import { Connection, PublicKey } from '@solana/web3.js';
import type { RiskCheck, CheckStatus, Severity } from './checks';

export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const DBC_SDK_PACKAGE = '@meteora-ag/dynamic-bonding-curve-sdk';
export const DBC_SDK_PINNED = '1.5.11';

/**
 * Anchor account discriminators, read from the SDK's own bundled IDL.
 *
 * WHY THESE EXIST
 *
 * `virtualPool` and `transferHookPool` are DIFFERENT account types, but the
 * IDL declares BOTH as a struct with a single field named `poolState`:
 *
 *   { name: 'transferHookPool', fields: [ { name: 'poolState' } ] }
 *   { name: 'virtualPool',      fields: [ { name: 'poolState' } ] }
 *
 * Their decoded shapes are therefore INDISTINGUISHABLE. An earlier version of
 * this file used "does `.poolState` exist?" as the transfer-hook test — which
 * is true for every pool on the chain, so every curve was reported as a
 * transfer-hook pool and BLOCKED. The discriminator is the program's own
 * declaration of which account type this is, so read the first 8 bytes.
 */
export const DBC_ACCOUNT_DISCRIMINATORS = {
  virtualPool: Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]),
  transferHookPool: Buffer.from([237, 219, 184, 23, 42, 189, 169, 35]),
} as const;

// ── Types ──────────────────────────────────────────────────────

export interface DbcState {
  poolAddress: string;
  baseMint: string | null;
  quoteMint: string | null;
  creator: string | null;
  /** quote tokens accumulated on the curve, in human units */
  quoteReserve: number | null;
  /** quote tokens required to graduate, in human units */
  migrationQuoteThreshold: number | null;
  /** 0..1 — how far along the curve is */
  migrationProgress: number | null;
  /** true once the quote reserve met the threshold */
  graduated: boolean | null;
  /** percent (0-100) of the trading fee routed to the creator */
  creatorTradingFeePct: number | null;
  /** percent (0-100) of the trading fee routed to the launchpad partner */
  partnerTradingFeePct: number | null;
  /** true if the config disables the partner's trading fee entirely */
  partnerFeeDisabled: boolean | null;
  /** true if the base mint uses the Token-2022 program */
  isToken2022: boolean | null;
  /** base trading fee in basis points, read from poolConfig.poolFees.baseFee */
  baseFeeBps: number | null;
  /** true if a transfer hook is configured on the base mint */
  hasTransferHook: boolean | null;
  /** raw SDK payload, kept for the UI inspector drawer */
  raw: unknown;
}

export interface DbcAssessment {
  address: string;
  available: boolean;
  /** why it is unavailable, when available === false */
  unavailableReason?: string;
  state: DbcState | null;
  checks: RiskCheck[];
  /** JSON-RPC cluster the state was read from */
  cluster: string;
  readAt: number;
}

// ── Reader ─────────────────────────────────────────────────────

export interface DbcReader {
  read(connection: Connection, address: string): Promise<DbcState>;
}

/** Thrown when we cannot read state — always fail closed upward. */
export class DbcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbcUnavailableError';
  }
}

/**
 * Classify DBC account bytes into a variant — PURE, no RPC.
 *
 * Split out from the reader below because the byte test is needed in more than
 * one place. Discovery already holds raw account data (it just fetched it to
 * check ownership), so making discovery pay for a second `getAccountInfo` per
 * pool — or worse, guess the variant from the decoded shape — would be waste
 * on one side and a lie on the other.
 *
 * Returns null when the bytes are unreadable or match neither variant, which
 * is deliberately distinct from 'virtualPool'.
 */
export function classifyPoolAccount(
  data: Buffer | Uint8Array | null | undefined,
): 'transferHookPool' | 'virtualPool' | null {
  if (!data) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
  if (buf.length < 8) return null;
  const disc = buf.subarray(0, 8);
  if (DBC_ACCOUNT_DISCRIMINATORS.transferHookPool.equals(disc)) return 'transferHookPool';
  if (DBC_ACCOUNT_DISCRIMINATORS.virtualPool.equals(disc)) return 'virtualPool';
  return null;
}

/**
 * The byte test as a boolean, for callers that already hold the data.
 *
 *   true  — transferHookPool (the base mint's token has a transfer hook)
 *   false — virtualPool (standard pool; no hook surface)
 *   null  — bytes unreadable or unrecognised, so the variant is UNKNOWN
 *
 * `null` is deliberately distinct from `false`. Collapsing the two is how a
 * real transfer hook would slip through as a pass.
 */
export function isTransferHookFromBytes(
  data: Buffer | Uint8Array | null | undefined,
): boolean | null {
  const kind = classifyPoolAccount(data);
  if (kind === 'transferHookPool') return true;
  if (kind === 'virtualPool') return false;
  return null;
}

/**
 * Which DBC account variant is at this address? Fetches, then classifies.
 *
 * The gate uses this form; discovery uses `isTransferHookFromBytes` on data it
 * already has. Both share the same byte test, so the two can never disagree.
 */
async function isTransferHookPoolAccount(
  connection: Connection,
  address: string,
): Promise<boolean | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(address));
    return isTransferHookFromBytes(info?.data as any);
  } catch {
    return null;
  }
}

/**
 * Live reader backed by Meteora's own SDK (pinned 1.5.11).
 *
 * The SDK is imported dynamically so this module type-checks and runs
 * even in an environment where the Meteora package is not installed.
 * In that case read() throws DbcUnavailableError and the assessment
 * degrades to "unverified" instead of inventing numbers.
 */
export const sdkReader: DbcReader = {
  async read(connection: Connection, address: string): Promise<DbcState> {
    let DynamicBondingCurveClient: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ DynamicBondingCurveClient } = require(DBC_SDK_PACKAGE));
    } catch {
      throw new DbcUnavailableError(
        `Meteora SDK '${DBC_SDK_PACKAGE}' not installed. Run: npm i ${DBC_SDK_PACKAGE}@${DBC_SDK_PINNED}`,
      );
    }

    // Documented factory is `DynamicBondingCurveClient.create(connection, commitment)`;
    // the constructor is also public. Prefer the factory, fall back to `new`.
    const client =
      typeof DynamicBondingCurveClient?.create === 'function'
        ? DynamicBondingCurveClient.create(connection, 'confirmed')
        : new DynamicBondingCurveClient(connection, 'confirmed');
    const state = client.state;

    // State reader — verified against the INSTALLED 1.5.13 declarations, not
    // the docs page:
    //   getPool(poolAddress: PublicKey | string): Promise<VirtualPool | null>
    //
    // For a standard virtual pool the decoded account comes back DIRECTLY.
    // Only the transfer-hook variant (account `transferHookPool`) nests its
    // fields under `.poolState` — which is exactly why the docs example shows
    // `poolState.poolState.config`. That example is about the transfer-hook
    // shape and would be wrong for a normal pool. We unwrap defensively so
    // both resolve correctly.
    const getPool = state?.getPool?.bind(state);
    if (!getPool) {
      throw new DbcUnavailableError(
        'Meteora SDK present but `client.state.getPool` is missing — version mismatch, expected 1.5.x.',
      );
    }

    let raw: any;
    try {
      raw = await getPool(new PublicKey(address));
    } catch (e: any) {
      throw new DbcUnavailableError(`DBC pool read failed for ${address}: ${e?.message ?? e}`);
    }
    if (!raw) throw new DbcUnavailableError(`DBC pool ${address} not found on this cluster.`);

    // WHICH ACCOUNT TYPE IS THIS? Not answerable from the decoded shape.
    // See DBC_ACCOUNT_DISCRIMINATORS above: both variants expose `.poolState`,
    // so `raw.poolState != null` is true for every pool ever created.
    const isTransferHookPool = await isTransferHookPoolAccount(connection, address);
    const p: any = raw.poolState ?? raw;

    // PoolConfig carries the fee and migration settings, and is a SEPARATE read:
    //   getPoolConfig(configAddress: PublicKey | string): Promise<PoolConfig | null>
    // Verified present on poolConfig: `tokenType` (u8) and `migrationQuoteThreshold` (u64).
    let cfg: any = {};
    if (p?.config && typeof state?.getPoolConfig === 'function') {
      try {
        const cfgRaw = await state.getPoolConfig(p.config);
        cfg = cfgRaw?.poolConfig ?? cfgRaw ?? {};
      } catch {
        // Non-fatal by design. Fee/migration detail degrades to UNKNOWN,
        // which the checks below report as unverified — never as a pass.
        cfg = {};
      }
    }

    const asNum = (v: any): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return Number(v);
      if (typeof v?.toNumber === 'function') return v.toNumber();
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const str = (v: any): string | null =>
      v == null ? null : (v.toBase58?.() ?? String(v));

    // Reserves are BN in base units; convert using the quote mint's
    // decimals when the SDK exposes them, else assume 9 (SOL) and say so.
    const quoteReserveRaw = asNum(p.quoteReserve ?? p.quote_reserve ?? p.quoteAmount);
    // The migration threshold lives on the PoolConfig, not the pool account.
    const thresholdRaw =
      asNum(p.migrationQuoteThreshold ?? p.migration_quote_threshold ?? p.migrationThreshold) ??
      asNum(cfg.migrationQuoteThreshold ?? cfg.migration_quote_threshold ?? cfg.migrationThreshold);

    const quoteDecimals = asNum(p.quoteDecimals ?? p.quote_decimals) ?? 9;
    const scale = Math.pow(10, quoteDecimals);

    const quoteReserve = quoteReserveRaw === null ? null : quoteReserveRaw / scale;
    const migrationQuoteThreshold = thresholdRaw === null ? null : thresholdRaw / scale;

    const progress =
      quoteReserve !== null && migrationQuoteThreshold && migrationQuoteThreshold > 0
        ? Math.min(1, quoteReserve / migrationQuoteThreshold)
        : null;

    // Token type. Ground truth from the installed declarations: the virtual
    // pool's poolState carries `poolType` (u8, docs: "pool type, spl token or
    // token2022") and poolConfig carries `tokenType` (u8). TokenType enum:
    // 0 = SPL Token, 1 = Token-2022. Prefer the pool's own field, since that
    // describes THIS pool; the config describes the template it was built from.
    const poolTypeNum = asNum(p.poolType ?? p.pool_type);
    const cfgTokenTypeNum = asNum(cfg.tokenType ?? cfg.token_type);
    const tokenTypeNum = poolTypeNum ?? cfgTokenTypeNum;
    const isToken2022 = tokenTypeNum === null ? null : tokenTypeNum === 1;

    // `isMigrated` is a u8 flag on poolState (0/1), NOT a boolean. Reading it
    // as a boolean would make `0` truthy and mark every live curve as migrated.
    const isMigratedNum = asNum(p.isMigrated ?? p.is_migrated);
    const graduated =
      isMigratedNum !== null ? isMigratedNum === 1 : progress !== null ? progress >= 1 : null;

    // Base trading fee in basis points. poolConfig.poolFees.baseFee.cliffFeeNumerator
    // is a numerator over FEE_DENOMINATOR (1e9), per the SDK constants.
    const cliffFeeNumerator = asNum(
      cfg.poolFees?.baseFee?.cliffFeeNumerator ?? cfg.poolFees?.baseFee?.cliff_fee_numerator,
    );
    const baseFeeBps = cliffFeeNumerator === null ? null : (cliffFeeNumerator / 1e9) * 10_000;

    return {
      poolAddress: address,
      baseMint: str(p.baseMint ?? p.base_mint),
      // The quote mint is not on poolState — it lives on the config. Fall back
      // to the pool shape only if the config read failed.
      quoteMint: str(cfg.quoteMint ?? cfg.quote_mint ?? p.quoteMint ?? p.quote_mint),
      creator: str(p.creator),
      quoteReserve,
      migrationQuoteThreshold,
      // Ratio 0..1 computed here from the reserves. NOT the SDK's own
      // `migrationProgress` field, which is a u8 status code.
      migrationProgress: progress,
      graduated,
      baseFeeBps,
      creatorTradingFeePct: asNum(
        cfg.creatorTradingFeePercentage ??
          cfg.creator_trading_fee_percentage ??
          p.creatorTradingFeePercentage,
      ),
      partnerTradingFeePct: asNum(
        cfg.partnerTradingFeePercentage ??
          cfg.partner_trading_fee_percentage ??
          p.partnerTradingFeePercentage,
      ),
      partnerFeeDisabled: cfg.partnerFeeDisabled ?? cfg.partner_fee_disabled ?? null,
      isToken2022,
      // `true` only when the discriminator says transferHookPool. `false` when
      // it says virtualPool — a definitive clean, not an unknown. `null` only
      // when the account could not be read at all.
      hasTransferHook: isTransferHookPool,
      raw: p,
    };
  },
};

// ── Assessment ─────────────────────────────────────────────────

function mk(
  id: string, name: string, passed: boolean,
  detail: string, observed?: string | number | null,
  severity: Severity = 'block',
  unverified = false,
): RiskCheck {
  // An unverified check is forced to severity 'warn' so it can never be
  // counted as a block by dbcBlocked(). Same rule as checks.ts.
  const effSeverity: Severity = unverified ? 'warn' : severity;
  const status: CheckStatus = unverified ? 'unverified' : (passed ? 'pass' : 'fail');
  return { id, name, status, passed, skipped: false, unverified, severity: effSeverity, detail, observed };
}

/**
 * Assess a DBC pool's risk surface.
 * Returns available:false (with zero fabricated checks) when state
 * cannot be read. Never invents a reserve figure.
 */
export async function assessDbcPool(
  connection: Connection,
  address: string,
  reader: DbcReader = sdkReader,
): Promise<DbcAssessment> {
  const base: DbcAssessment = {
    address,
    available: false,
    state: null,
    checks: [],
    cluster: (connection as any)?._rpcEndpoint ?? 'unknown',
    readAt: Date.now(),
  };

  let state: DbcState;
  try {
    state = await reader.read(connection, address);
  } catch (e: any) {
    return {
      ...base,
      unavailableReason: e?.message ?? String(e),
      checks: [
        mk('dbc_state', 'DBC state readable', false,
          `Could not read DBC pool state: ${e?.message ?? e}. Unverified — treat as unknown, not safe.`,
          null, 'block'),
      ],
    };
  }

  const checks: RiskCheck[] = [
    mk('dbc_state', 'DBC state readable', true,
      'Live DBC pool state read successfully via the Meteora SDK.', DBC_SDK_PINNED),
  ];

  // 1. Graduation
  if (state.migrationProgress === null) {
    checks.push(mk('dbc_graduation', 'Graduation progress known', false,
      'Could not determine migration progress (reserve or threshold missing from the SDK payload).',
      null, 'warn'));
  } else {
    const pctTxt = `${(state.migrationProgress * 100).toFixed(1)}%`;
    const stuck = state.quoteReserve !== null && state.quoteReserve > 0 && state.migrationProgress < 0.05;
    checks.push(mk(
      'dbc_graduation',
      'Graduation progress',
      !stuck,
      stuck
        ? `Curve holds ${state.quoteReserve} quote but sits at only ${pctTxt} of its migration threshold. Momentum is close to zero — buyers here may never reach DAMM v2 liquidity.`
        : `${pctTxt} of the migration threshold reached (${state.quoteReserve} / ${state.migrationQuoteThreshold} quote).`,
      pctTxt,
      'warn',
    ));
  }

  // 2. Stuck curve — reserve present, no graduation path
  if (state.graduated === false && (state.migrationProgress ?? 0) < 0.5) {
    checks.push(mk('dbc_stuck', 'Curve not stalled', false,
      'Pool has not graduated and is under halfway. Capital on this curve is illiquid until the threshold is met.',
      state.migrationProgress, 'warn'));
  } else if (state.graduated === true) {
    checks.push(mk('dbc_stuck', 'Curve graduated', true,
      'Curve completed and migrated — liquidity now sits in a DAMM pool.', 'graduated'));
  } else {
    checks.push(mk('dbc_stuck', 'Curve not stalled', true,
      'Curve is progressing normally toward graduation.', state.migrationProgress));
  }

  // 3. Fee extraction — how much of the fee stream leaves the pool
  const creatorFee = state.creatorTradingFeePct ?? 0;
  const partnerFee = state.partnerTradingFeePct ?? 0;
  const totalFee = creatorFee + partnerFee;
  if (totalFee > 30) {
    checks.push(mk('dbc_fee_diversion', 'Fee extraction tolerable', false,
      `${totalFee}% of every trade's fee is routed to the creator (${creatorFee}%) and partner (${partnerFee}%) rather than staying in the pool. High extraction slows curve progress and reduces LP compensation.`,
      `${totalFee}%`, 'warn'));
  } else {
    checks.push(mk('dbc_fee_diversion', 'Fee extraction tolerable', true,
      `${totalFee}% of trade fees flows to creator/partner.`, `${totalFee}%`));
  }

  // 4. Token-2022 hook surface
  //
  // Three outcomes, kept distinct on purpose. `true` is the only blocking
  // case. `false` is a genuine pass derived from the account discriminator.
  // `null` means the account type could not be read — that is UNVERIFIED,
  // never a silent pass, because a catch-all `else → pass` is exactly how a
  // real transfer hook would have slipped through.
  if (state.hasTransferHook === true) {
    checks.push(mk('dbc_hook', 'No transfer hook', false,
      'Base mint uses a Token-2022 transfer hook. An external program runs on every transfer and can reject your sell.',
      'transferHook', 'block'));
  } else if (state.hasTransferHook === false) {
    checks.push(mk('dbc_hook', 'No transfer hook', true,
      state.isToken2022 === true
        ? 'Token-2022 mint, and the pool is a standard virtualPool account — no transfer hook.'
        : 'Legacy SPL token — no hook surface.',
      state.isToken2022 === true ? 'token-2022' : 'spl-token'));
  } else {
    checks.push(mk('dbc_hook', 'No transfer hook', false,
      'Could not read the pool account discriminator — account type unverified.',
      'unreadable', 'warn', true));
  }

  return { ...base, available: true, state, checks };
}

/** True when any blocking check failed. Drives the UI's red banner. */
export function dbcBlocked(a: DbcAssessment): boolean {
  return a.checks.some(c => !c.passed && c.severity === 'block');
}

/**
 * Plain-language summary of a DBC assessment.
 * This is the string the veto card displays and the string an LLM
 * would later turn into prose — the facts here are deterministic.
 */
export function describeDbc(a: DbcAssessment): string {
  if (!a.available) return `DBC UNVERIFIED — ${a.unavailableReason ?? 'state unavailable'}`;
  const failed = a.checks.filter(c => !c.passed);
  if (failed.length === 0) return 'DBC CLEAR — curve healthy, no blocking risks';
  return `DBC ${dbcBlocked(a) ? 'BLOCKED' : 'WARN'} — ${failed.map(c => c.name).join(', ')}`;
}

// ── Mint → pool resolution ─────────────────────────────────────
//
// `getPools()` enumerates the ENTIRE program through getProgramAccounts. That
// is heavy, and on a free RPC endpoint it can hang far past any sane timeout
// (observed live on Helius free tier: still running after 300s). For a single
// token there is no reason to pay that price. The installed 1.5.13
// declarations also expose:
//
//   getPoolByBaseMint(baseMint: PublicKey | string): Promise<ProgramAccount<VirtualPool> | null>
//
// which turns "which curve is this token on?" into a couple of cheap account
// reads. This is what lets `--mint <TOKEN>` attach live DBC curve state with
// no program-wide scan at all.
//
// Returns null when no pool is found — an honest "not a DBC token", not an
// error. Throws DbcUnavailableError only when the SDK itself is missing.

export interface DbcPoolRef {
  poolAddress: string;
  /** account key of the pool, when the SDK returned a ProgramAccount wrapper */
  accountKey: string | null;
}

export async function findPoolByBaseMint(
  connection: Connection,
  baseMint: string,
): Promise<DbcPoolRef | null> {
  let DynamicBondingCurveClient: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DynamicBondingCurveClient } = require(DBC_SDK_PACKAGE));
  } catch {
    throw new DbcUnavailableError(
      `Meteora SDK '${DBC_SDK_PACKAGE}' not installed. Run: npm i ${DBC_SDK_PACKAGE}@${DBC_SDK_PINNED}`,
    );
  }

  const client =
    typeof DynamicBondingCurveClient?.create === 'function'
      ? DynamicBondingCurveClient.create(connection, 'confirmed')
      : new DynamicBondingCurveClient(connection, 'confirmed');

  const state = client.state;
  if (typeof state?.getPoolByBaseMint !== 'function') {
    throw new DbcUnavailableError(
      'Meteora SDK is missing `client.state.getPoolByBaseMint` — version mismatch, expected 1.5.x.',
    );
  }

  const found: any = await state.getPoolByBaseMint(new PublicKey(baseMint));
  if (!found) return null;

  // ProgramAccount<T> is { publicKey, account }. Tolerate a bare T as well.
  const key =
    found.publicKey ??
    found.account?.publicKey ??
    found.account?.poolAddress ??
    found.poolAddress ??
    null;
  const poolAddress = key?.toBase58?.() ?? (typeof key === 'string' ? key : null);
  if (!poolAddress) return null;

  return { poolAddress, accountKey: found.publicKey ? poolAddress : null };
}

// ── DBC-native sell quote ──────────────────────────────────────
//
// WHY A RISK MODULE QUOTES A CURVE
//
// "Can I sell this token?" is the question every rug scanner asks, and the
// one none of them can answer for a token that has not graduated — because
// there is no DEX pool for an aggregator to route through. The previous
// honest answer was SKIP. Honest, and useless.
//
// But during the bonding phase the curve IS the market, and Meteora ships
// the arithmetic. `client.pool.swapQuote()` is a PURE FUNCTION over
// (VirtualPool, PoolConfig): no network, no aggregator, no third party, no
// key. Both accounts are already read to draw the curve panel, so the answer
// costs arithmetic and nothing else.
//
// SERVICE SPLIT — verified against the INSTALLED 1.5.13 declarations, not
// the docs page: `client.state` is a StateService and carries NO quote
// method. Quotes live on `client.pool` (PoolService). Calling
// `client.state.swapQuote(...)` throws at runtime.

export interface CurveSellQuote {
  poolAddress: string;
  /** base units we asked the curve to absorb */
  probeRaw: string;
  /** base units the curve reported consuming */
  actualInputRaw: string;
  /** base units of quote the curve returns */
  outAmountRaw: string;
  /** human-unit quote received, when decimals are known */
  outAmountHuman: number;
  /**
   * Executed price versus spot price, as a FRACTION (0.01 = 1%) — deliberately
   * the same unit as Jupiter's `priceImpactPct`, so the two sources can be
   * compared without a conversion nobody will remember later.
   * Negative for a sell, because dumping base pushes its price down.
   */
  impactPct: number | null;
  tradingFeeRaw: string;
  protocolFeeRaw: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** spot quote-per-base in raw units, from the pool's Q64.64 sqrt price */
  spotRaw: number | null;
  /** share of the probe the curve consumed (1 = fully absorbed) */
  absorbedRatio: number | null;
  tookMs: number;
}

function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v?.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const Q64 = Math.pow(2, 64);

/**
 * Ask the bonding curve what a sell would actually return.
 *
 * Direction is fixed: `swapBaseForQuote: true` swaps the BASE token out for
 * the QUOTE token. That is a SELL, and it is the only direction a risk gate
 * cares about — a token you can buy but never exit is the whole threat model.
 *
 * Throws DbcUnavailableError when the curve cannot be read or quoted. The
 * caller is expected to treat that as "this path does not apply" and fall
 * back, never as a finding about the token.
 */
export async function quoteCurveSell(
  connection: Connection,
  poolAddress: string,
  baseAmountRaw: bigint,
  currentPointOverride?: number,
): Promise<CurveSellQuote> {
  const t0 = Date.now();

  let sdk: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require(DBC_SDK_PACKAGE);
  } catch {
    throw new DbcUnavailableError(
      `Meteora SDK '${DBC_SDK_PACKAGE}' not installed. Run: npm i ${DBC_SDK_PACKAGE}@${DBC_SDK_PINNED}`,
    );
  }
  // Prefer the SDK's own BN so the quote math gets a value it recognises;
  // fall back to the hoisted package. Duck-typing covers the rest.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BN = sdk.BN ?? require('bn.js');

  const client =
    typeof sdk.DynamicBondingCurveClient?.create === 'function'
      ? sdk.DynamicBondingCurveClient.create(connection, 'confirmed')
      : new sdk.DynamicBondingCurveClient(connection, 'confirmed');

  const state = client.state;
  const pool = client.pool;

  if (typeof pool?.swapQuote !== 'function') {
    throw new DbcUnavailableError(
      'Meteora SDK is missing `client.pool.swapQuote` — version mismatch, expected 1.5.x.',
    );
  }

  let virtualPool: any;
  try {
    virtualPool = await state.getPool(new PublicKey(poolAddress));
  } catch (e: any) {
    throw new DbcUnavailableError(`DBC pool read failed for ${poolAddress}: ${e?.message ?? e}`);
  }
  if (!virtualPool) {
    throw new DbcUnavailableError(`DBC pool ${poolAddress} not found on this cluster.`);
  }

  // Same defensive unwrap as read(): only transfer-hook pools nest fields
  // one level down under `.poolState`.
  const p: any = virtualPool.poolState ?? virtualPool;

  let config: any = null;
  try {
    const cfgRaw = await state.getPoolConfig(p.config);
    config = cfgRaw?.poolConfig ?? cfgRaw ?? null;
  } catch {
    config = null;
  }
  if (!config) {
    throw new DbcUnavailableError('DBC pool config unreadable — cannot quote without it.');
  }

  // `currentPoint` is the clock the fee schedule reads: unix seconds for
  // timestamp-activated pools, slot for slot-activated ones. Resolve it
  // honestly rather than guessing, because a wrong clock silently misreports
  // the fee — and a misreported fee is a lie that looks like a feature.
  let currentPoint: any;
  if (currentPointOverride != null) {
    currentPoint = new BN(currentPointOverride);
  } else if (toNum(p.activationType ?? p.activation_type) === 1) {
    currentPoint = new BN(Math.floor(Date.now() / 1000));
  } else {
    try {
      currentPoint = new BN(await connection.getSlot());
    } catch {
      currentPoint = new BN(0);
    }
  }

  const result: any = pool.swapQuote({
    virtualPool,
    config,
    swapBaseForQuote: true,
    amountIn: new BN(baseAmountRaw.toString()),
    slippageBps: 300,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });

  if (!result) throw new DbcUnavailableError('Meteora swapQuote returned nothing.');

  const actualInputRaw = BigInt(result.actualInputAmount?.toString?.() ?? '0');
  const outAmountRaw = BigInt(result.outputAmount?.toString?.() ?? '0');

  // Spot price from the pool's Q64.64 sqrt price — the IDL documents this
  // field as 'current price'. price = (sqrtPrice / 2^64)^2, in raw
  // quote-per-base units. Comparing raw to raw cancels the decimals, which is
  // exactly why the impact ratio below needs no decimal handling at all.
  // Float64 carries ~16 significant digits; for a risk estimate that is ample,
  // and we say "estimate" rather than pretend to exactness we do not have.
  let spotRaw: number | null = null;
  const sqrtRaw = p.sqrtPrice ?? p.sqrt_price;
  if (sqrtRaw != null) {
    const q = Number(sqrtRaw.toString()) / Q64;
    spotRaw = q * q;
  }

  let impactPct: number | null = null;
  if (spotRaw && spotRaw > 0 && actualInputRaw > 0n && outAmountRaw > 0n) {
    impactPct = Number(outAmountRaw) / Number(actualInputRaw) / spotRaw - 1;
  }

  const baseDecimals = toNum(p.baseDecimals ?? p.base_decimals) ?? 6;
  const quoteDecimals = toNum(p.quoteDecimals ?? p.quote_decimals) ?? 9;
  const probeBig = BigInt(baseAmountRaw.toString());

  return {
    poolAddress,
    probeRaw: probeBig.toString(),
    actualInputRaw: actualInputRaw.toString(),
    outAmountRaw: outAmountRaw.toString(),
    outAmountHuman: Number(outAmountRaw) / Math.pow(10, quoteDecimals),
    impactPct,
    tradingFeeRaw: result.tradingFee?.toString?.() ?? '0',
    protocolFeeRaw: result.protocolFee?.toString?.() ?? '0',
    baseDecimals,
    quoteDecimals,
    spotRaw,
    absorbedRatio: probeBig > 0n ? Number(actualInputRaw) / Number(probeBig) : null,
    tookMs: Date.now() - t0,
  };
}
