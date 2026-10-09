// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — DBC Pool Discovery
// ═══════════════════════════════════════════════════════════════
//
//  WHY THIS EXISTS
//
//  Bonding-curve tokens are short-lived. Bitquery states it plainly: any mint
//  hardcoded into a docs page "stops returning rows within days". So there is
//  no canonical test pool address to hardcode — the honest answer is to ask
//  the chain which curves are live right now.
//
//  This is also half of the gap Meteora named in the track itself:
//  "Data Streams or Developer Tooling for trading terminals and builders".
//  Screening a pool is only useful if you can enumerate the pools.
//
//  TWO WAYS TO FIND A POOL, AND WHY BOTH EXIST
//
//  1. RECENT ACTIVITY (preferred). Every DBC swap or pool-creation
//     transaction already names the pool account it touched. So we read the
//     program's recent signatures, pull the accounts out of those
//     transactions, and keep the ones the DBC program owns. Cheap, bounded,
//     and it works on a free RPC endpoint.
//
//  2. FULL SWEEP (fallback). getProgramAccounts over the whole program. This
//     needs a dedicated endpoint — the public api.mainnet-beta endpoint
//     throttles or refuses it, and we have observed it still running after
//     300s with no error. Kept only because it is exhaustive when a good RPC
//     is configured. Its failure is reported as an endpoint limit, never as
//     "no pools found", which would be a lie.

import { Connection, PublicKey } from '@solana/web3.js';
import { DBC_SDK_PACKAGE, DBC_PROGRAM_ID, isTransferHookFromBytes } from './dbc';

export interface DbcPoolSummary {
  poolAddress: string;
  baseMint: string | null;
  config: string | null;
  creator: string | null;
  /** quote tokens currently on the curve, human units */
  quoteReserve: number | null;
  /** accumulated protocol fee, human units */
  protocolQuoteFee: number | null;
  /** accumulated partner fee, human units */
  partnerQuoteFee: number | null;
  /** u8 flag from poolState: 0 = live on curve, 1 = migrated */
  isMigrated: boolean | null;
  /** u8 poolType: 0 = SPL Token, 1 = Token-2022 */
  isToken2022: boolean | null;
  /** true|false from the account's own discriminator; null when unreadable */
  isTransferHookPool: boolean | null;
  /** how this row was found */
  via: 'activity' | 'sweep';
  /** raw decoded account, only when withRaw is set */
  raw?: unknown;
}

export interface DiscoverOptions {
  /** max rows to return; 0 or negative = all */
  limit?: number;
  /** only pools that have not migrated yet (still trading on the curve) */
  onlyActive?: boolean;
  /** attach the raw decoded account (large) */
  withRaw?: boolean;
}

function asNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v?.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: any): string | null {
  if (v === null || v === undefined) return null;
  return typeof v?.toBase58 === 'function' ? v.toBase58() : String(v);
}

function keyStr(v: any): string {
  return typeof v?.toBase58 === 'function' ? v.toBase58() : String(v);
}

/**
 * Map a decoded DBC account into a summary row.
 *
 * Shared deliberately: a pool must look IDENTICAL whichever route found it,
 * otherwise the two discovery paths silently disagree and the UI starts
 * showing "different" pools that are the same account.
 *
 * THE VARIANT IS NOT DERIVABLE FROM THE DECODED SHAPE. Both `transferHookPool`
 * and `virtualPool` are declared in the IDL as a struct with a single field
 * named `poolState`, so the SDK decodes BOTH into `{ poolState: {...} }`. An
 * earlier version of this function read `rawAccount?.poolState != null` as the
 * transfer-hook test — which is true for every pool ever created, so every
 * discovered curve was tagged `[hook]`, including legacy SPL pools where a
 * transfer hook is not even possible. The caller passes the answer in, taken
 * from the account's own discriminator bytes. See dbc.ts.
 *
 * `isTransferHook` is therefore `boolean | null` and the null is load-bearing:
 * unknown must never render as clean.
 *
 * `.poolState` is still the right place to read FIELDS from (both variants nest
 * there), just never to read IDENTITY from.
 *
 * Assumption worth stating: the DBC account does not carry quote-mint
 * decimals, so amounts are scaled by 9 (SOL) unless the account exposes them.
 * Wrong decimals mis-state magnitude, never direction — and the full
 * assessment reads the real mint, so this is discovery-only.
 */
function summarize(
  poolAddress: string,
  rawAccount: any,
  via: 'activity' | 'sweep',
  withRaw: boolean,
  isTransferHook: boolean | null,
): DbcPoolSummary {
  const p: any = rawAccount?.poolState ?? rawAccount;

  const quoteDecimals = asNum(p?.quoteDecimals ?? p?.quote_decimals) ?? 9;
  const scale = Math.pow(10, quoteDecimals);

  const reserveRaw = asNum(p?.quoteReserve ?? p?.quote_reserve);
  const protocolFeeRaw = asNum(p?.protocolQuoteFee ?? p?.protocol_quote_fee);
  const partnerFeeRaw = asNum(p?.partnerQuoteFee ?? p?.partner_quote_fee);
  const isMigratedNum = asNum(p?.isMigrated ?? p?.is_migrated);
  const poolTypeNum = asNum(p?.poolType ?? p?.pool_type);

  return {
    poolAddress,
    baseMint: str(p?.baseMint ?? p?.base_mint),
    config: str(p?.config),
    creator: str(p?.creator),
    quoteReserve: reserveRaw === null ? null : reserveRaw / scale,
    protocolQuoteFee: protocolFeeRaw === null ? null : protocolFeeRaw / scale,
    partnerQuoteFee: partnerFeeRaw === null ? null : partnerFeeRaw / scale,
    isMigrated: isMigratedNum === null ? null : isMigratedNum === 1,
    isToken2022: poolTypeNum === null ? null : poolTypeNum === 1,
    isTransferHookPool: isTransferHook,
    via,
    ...(withRaw ? { raw: p } : {}),
  };
}

/** Sort + trim, applied identically by both paths. */
function finish(rows: DbcPoolSummary[], opts: DiscoverOptions): DbcPoolSummary[] {
  let result = rows;
  if (opts.onlyActive) result = result.filter((r) => r.isMigrated !== true);

  // Most-funded curve first — those are the ones with real traders on them.
  result.sort((a, b) => (b.quoteReserve ?? 0) - (a.quoteReserve ?? 0));

  const limit = opts.limit ?? 10;
  return limit > 0 ? result.slice(0, limit) : result;
}

/**
 * Find live pools by walking RECENT PROGRAM ACTIVITY.
 *
 * We do not need every pool the program ever made. We need SOME live curves,
 * and every DBC swap or pool creation already names the pool account it
 * touched. So: read the program's recent signatures, pull the accounts out
 * of those transactions, and keep the ones the DBC program owns.
 *
 * Cost: one getSignaturesForAddress, a handful of getTransaction calls, one
 * batched getMultipleAccountsInfo, then one decoder read per surviving
 * candidate. Versus one unbounded whole-program sweep.
 */
export async function discoverDbcPoolsViaActivity(
  connection: Connection,
  client: any,
  opts: DiscoverOptions = {},
): Promise<DbcPoolSummary[]> {
  const SIGNATURE_LIMIT = 40;
  const TX_SAMPLE = 14;

  const sigs = await connection.getSignaturesForAddress(new PublicKey(DBC_PROGRAM_ID), {
    limit: SIGNATURE_LIMIT,
  });
  if (!sigs.length) {
    throw new Error('DBC program has no recent activity on this cluster.');
  }

  // Collect every account key named by recent transactions.
  const candidates = new Map<string, true>();
  for (const s of sigs.slice(0, TX_SAMPLE)) {
    let tx: any;
    try {
      tx = await connection.getTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch {
      continue; // one unreadable transaction must not sink the whole pass
    }
    if (!tx?.transaction?.message) continue;

    const msg = tx.transaction.message;
    for (const k of msg.staticAccountKeys ?? []) candidates.set(keyStr(k), true);

    // v0 transactions carry extra addresses out of band. Missing these would
    // silently drop pool accounts on exactly the newest traffic.
    const loaded = tx.meta?.loadedAddresses;
    for (const k of [...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]) {
      candidates.set(keyStr(k), true);
    }
  }

  const keys = [...candidates.keys()].filter((k) => k !== DBC_PROGRAM_ID);
  if (!keys.length) return [];

  // One batched read, then keep exactly the accounts the DBC program owns.
  // The variant is classified HERE, from the bytes this read already returned:
  // no second RPC, and no chance for discovery to disagree with the gate.
  const owned: string[] = [];
  const hookFlags = new Map<string, boolean | null>();
  const BATCH = 100;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    let infos: any[];
    try {
      infos = await connection.getMultipleAccountsInfo(slice.map((k) => new PublicKey(k)));
    } catch {
      continue;
    }
    infos.forEach((info: any, idx: number) => {
      const key = slice[idx];
      const isHook = isTransferHookFromBytes(info?.data as any);
      // Record the variant for EVERY account we can classify, not just the
      // ones the program owns — the flag is keyed by address, so keeping it
      // for non-pools is harmless and avoids a second branch here.
      hookFlags.set(key, isHook);
      if (info?.owner && keyStr(info.owner) === DBC_PROGRAM_ID) owned.push(key);
    });
  }
  if (!owned.length) return [];

  // Decode with the SDK's own reader, then keep only accounts that actually
  // decode to a virtual pool. The DBC program also owns configs, vaults and
  // metadata; a base mint is what separates a pool from those.
  const state = client.state;
  const rows: DbcPoolSummary[] = [];
  for (const pk of owned) {
    let decoded: any;
    try {
      decoded = await state.getPool(new PublicKey(pk));
    } catch {
      continue;
    }
    if (!decoded) continue;
    const row = summarize(pk, decoded, 'activity', !!opts.withRaw, hookFlags.get(pk) ?? null);
    if (!row.baseMint) continue;
    rows.push(row);
  }

  return finish(rows, opts);
}

/**
 * Enumerate virtual pools straight from the DBC program.
 *
 * Tries the bounded activity walk first and only falls back to the full
 * sweep. We use the SDK's own readers rather than hand-rolling a
 * getProgramAccounts filter: a filter built on a guessed discriminator or
 * byte offset returns a silently wrong set, which is far worse than a loud
 * error.
 */
export async function discoverDbcPools(
  connection: Connection,
  opts: DiscoverOptions = {},
): Promise<DbcPoolSummary[]> {
  let DynamicBondingCurveClient: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DynamicBondingCurveClient } = require(DBC_SDK_PACKAGE));
  } catch {
    throw new Error(
      `Meteora SDK '${DBC_SDK_PACKAGE}' not installed. Run: npm i ${DBC_SDK_PACKAGE}`,
    );
  }

  const client =
    typeof DynamicBondingCurveClient?.create === 'function'
      ? DynamicBondingCurveClient.create(connection, 'confirmed')
      : new DynamicBondingCurveClient(connection, 'confirmed');

  const state = client.state;
  if (typeof state?.getPools !== 'function') {
    throw new Error(
      'Meteora SDK present but `client.state.getPools` is missing — version mismatch.',
    );
  }

  // Path 1 — recent activity. Bounded, specific, works on a free endpoint.
  // A failure here is NOT fatal: it is a reason to try the sweep, and its
  // reason is carried forward so a total failure can name both causes.
  let activityNote = '';
  try {
    const viaActivity = await discoverDbcPoolsViaActivity(connection, client, opts);
    if (viaActivity.length) return viaActivity;
    activityNote = `\nRecent-activity walk found no DBC pools in the last ${40} program transactions.`;
  } catch (e: any) {
    activityNote = `\nRecent-activity walk failed: ${e?.message ?? e}`;
  }

  // Path 2 — full sweep. getProgramAccounts sweeps the whole program. On a
  // free endpoint it can hang indefinitely — observed live: still running
  // after 300s, no error. An unbounded await here hangs the CLI, and on a
  // demo stage a hang is indistinguishable from a crash. Bound it and fail
  // WITH A REASON.
  const DISCOVER_TIMEOUT_MS = 90_000;
  let accounts: any[];
  let discoverTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    accounts = await Promise.race([
      state.getPools(),
      new Promise<never>((_, reject) => {
        discoverTimer = setTimeout(
          () => reject(new Error(`getPools() exceeded ${DISCOVER_TIMEOUT_MS / 1000}s`)),
          DISCOVER_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e: any) {
    throw new Error(
      `DBC pool enumeration failed: ${e?.message ?? e}${activityNote}\n` +
        'getProgramAccounts needs a dedicated RPC. Set SOLANA_RPC_URL to a ' +
        'Helius / QuickNode / Triton endpoint — the public api.mainnet-beta ' +
        'endpoint throttles or blocks it.',
    );
  } finally {
    if (discoverTimer) clearTimeout(discoverTimer);
  }

  const out: DbcPoolSummary[] = [];
  for (const acc of accounts ?? []) {
    const rawAccount: any = acc?.account ?? {};
    // Classify from raw bytes when the SDK handed them over. If this route
    // yields decoded accounts with no `.data`, the variant is genuinely
    // UNKNOWN and we report null — never a guessed `false`, which would mark
    // an unreadable pool as verified-clean.
    out.push(
      summarize(
        str(acc?.publicKey) ?? '',
        rawAccount,
        'sweep',
        !!opts.withRaw,
        isTransferHookFromBytes(rawAccount?.data),
      ),
    );
  }

  return finish(out, opts);
}
