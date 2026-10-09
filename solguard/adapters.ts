// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — DEX Adapters
//  Resolves "given a mint, what pool holds its liquidity, and does
//  that pool have an LP token worth checking for burns?"
// ═══════════════════════════════════════════════════════════════
//
//  Adapters are registered per DEX. An adapter that cannot resolve a
//  pool returns null, which makes the LP check report SKIPPED rather
//  than PASSED. That distinction is deliberate and load-bearing:
//  "we could not check" must never look like "we checked and it's fine".

import { Connection, PublicKey } from '@solana/web3.js';

export interface PoolRef {
  dex: string;
  poolAddress: string | null;
  /** null when the pool type has no fungible LP token (positions are NFTs) */
  lpMint: string | null;
  /** human note explaining why lpMint is null, shown in the UI */
  note?: string;
}

export interface DexAdapter {
  name: string;
  /** optional on-chain program id, used for labelling in the UI */
  poolProgram?: string;
  resolvePool(mintAddress: string, hintPoolAddress?: string): Promise<PoolRef | null>;
}

// ── Program IDs ────────────────────────────────────────────────

export const PROGRAMS = {
  RAYDIUM_AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  METEORA_DAMM_V2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  METEORA_DBC: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  PUMP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
} as const;

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOC_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const RAYDIUM_AUTHORITY_V4 = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

// ── Raydium AMM v4 ─────────────────────────────────────────────
// v4 pools DO have an LP mint, derivable as a PDA, so the burn check
// is meaningful here.

export const raydiumAmmV4: DexAdapter = {
  name: 'Raydium AMM v4',
  poolProgram: PROGRAMS.RAYDIUM_AMM_V4,

  async resolvePool(mintAddress: string): Promise<PoolRef | null> {
    // If we were handed a pool address we trust it; otherwise we need
    // the market id, which we do not have from the mint alone.
    // Returning null here is honest: no fabrication.
    return null;
  },
};

/** Derive the LP mint PDA for a known Raydium v4 pool. Deterministic. */
export function deriveRaydiumV4LpMint(poolAddress: string): string {
  const [lp] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(poolAddress).toBuffer(),
      new PublicKey(TOKEN_PROGRAM).toBuffer(),
      new PublicKey(RAYDIUM_AUTHORITY_V4).toBuffer(),
    ],
    new PublicKey(PROGRAMS.RAYDIUM_AMM_V4),
  );
  return lp.toBase58();
}

/**
 * Explicit-pool adapter for Raydium v4. Only resolves when a pool
 * address is supplied, because the LP mint cannot be derived from a
 * mint alone without scanning the whole program.
 */
export const raydiumExplicit: DexAdapter = {
  name: 'Raydium AMM v4 (explicit pool)',
  poolProgram: PROGRAMS.RAYDIUM_AMM_V4,
  async resolvePool(_mintAddress: string, hintPoolAddress?: string): Promise<PoolRef | null> {
    if (!hintPoolAddress) return null;
    return {
      dex: this.name,
      poolAddress: hintPoolAddress,
      lpMint: deriveRaydiumV4LpMint(hintPoolAddress),
    };
  },
};

// ── Orca Whirlpool ─────────────────────────────────────────────
// Positions are NFTs, not fungible LP. There is no LP supply to burn,
// so the correct answer is "skipped", not "passed".

export const orcaWhirlpool: DexAdapter = {
  name: 'Orca Whirlpool',
  poolProgram: PROGRAMS.ORCA_WHIRLPOOL,
  async resolvePool(): Promise<PoolRef | null> {
    return {
      dex: this.name,
      poolAddress: null,
      lpMint: null,
      note: 'Whirlpool positions are NFTs. There is no fungible LP supply, so burn cannot be measured. Liquidity safety must be judged by position concentration instead.',
    };
  },
};

// ── Meteora DLMM ───────────────────────────────────────────────

export const meteoraDlmm: DexAdapter = {
  name: 'Meteora DLMM',
  poolProgram: PROGRAMS.METEORA_DLMM,
  async resolvePool(): Promise<PoolRef | null> {
    return {
      dex: this.name,
      poolAddress: null,
      lpMint: null,
      note: 'DLMM liquidity sits in NFT position accounts, not an LP mint. Burn is not measurable; use position concentration.',
    };
  },
};

// ── Meteora DAMM v2 ────────────────────────────────────────────
// Position NFTs again — this is the graduation target for DBC pools.

export const meteoraDammV2: DexAdapter = {
  name: 'Meteora DAMM v2',
  poolProgram: PROGRAMS.METEORA_DAMM_V2,
  async resolvePool(): Promise<PoolRef | null> {
    return {
      dex: this.name,
      poolAddress: null,
      lpMint: null,
      note: 'DAMM v2 positions are NFTs, not a fungible LP mint. Liquidity can be LOCKED via escrow instead — check lock state, not burn.',
    };
  },
};

// ── Meteora DBC ────────────────────────────────────────────────
// The interesting one. A DBC *virtual* pool has no LP token at all:
// liquidity is the curve itself, and the quote reserve is held by the
// DBC program until graduation. So "is LP burned" is the wrong
// question. The right questions are:
//   1. Has it graduated, or is quote still stuck on the curve?
//   2. How close to the migration threshold is it?
//   3. Who can claim the creator/partner surplus?
// Those live in dbc.ts, not here.

export const meteoraDbc: DexAdapter = {
  name: 'Meteora DBC',
  poolProgram: PROGRAMS.METEORA_DBC,
  async resolvePool(): Promise<PoolRef | null> {
    return {
      dex: this.name,
      poolAddress: null,
      lpMint: null,
      note: 'DBC virtual pool has no LP mint. Safety is governed by curve state — see dbc.ts for graduation, reserve and surplus analysis.',
    };
  },
};

// ── PumpSwap ───────────────────────────────────────────────────

export const pumpSwap: DexAdapter = {
  name: 'PumpSwap',
  poolProgram: PROGRAMS.PUMP_AMM,
  async resolvePool(): Promise<PoolRef | null> {
    return {
      dex: this.name,
      poolAddress: null,
      lpMint: null,
      note: 'PumpSwap pools hold reserves directly with no LP token. Burn is not measurable.',
    };
  },
};

// ── Registry ───────────────────────────────────────────────────

export const ADAPTERS: Record<string, DexAdapter> = {
  raydium: raydiumExplicit,
  orca: orcaWhirlpool,
  meteora_dlmm: meteoraDlmm,
  meteora_damm_v2: meteoraDammV2,
  meteora_dbc: meteoraDbc,
  pumpswap: pumpSwap,
};

/**
 * Pick an adapter from the V5 engine's own DEX label.
 * The engine uses 'Raydium' and 'Orca' as pool names, so this maps
 * those strings onto the adapter registry without changing the engine.
 */
export function adapterForDex(dexLabel: string): DexAdapter | null {
  const k = dexLabel.trim().toLowerCase();
  if (k.includes('raydium')) return raydiumExplicit;
  if (k.includes('orca')) return orcaWhirlpool;
  if (k.includes('dbc')) return meteoraDbc;
  if (k.includes('damm')) return meteoraDammV2;
  if (k.includes('dlmm')) return meteoraDlmm;
  if (k.includes('pump')) return pumpSwap;
  return null;
}

export const KNOWN_DEXES = Object.keys(ADAPTERS);
export { WSOL, ASSOC_TOKEN_PROGRAM };
