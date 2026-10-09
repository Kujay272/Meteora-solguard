// ═══════════════════════════════════════════════════════════════
//  JITO BUNDLE MODULE — Solana Atomic Execution Engine
//  Built by Nxvana for Leon 🔥
// ═══════════════════════════════════════════════════════════════
//
//  Jito bundles execute transactions atomically on Solana.
//  If one tx fails, the entire bundle is rejected — this is
//  how real Solana arb bots protect against front-running and
//  partial fills.
//
//  Bundle format: [buyTx, sellTx, tipTx]
//  All three land together or none do.
//
//  Reference: https://jito-foundation.gitbook.io/mev
// ═══════════════════════════════════════════════════════════════

import {
  VersionedTransaction,
  Transaction,
  PublicKey,
  SystemProgram,
  Connection,
  Keypair,
} from '@solana/web3.js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.Solana' });

// ── Config (self-contained — reads env directly) ───────────────

const JITO_ENABLED = (process.env.JITO_ENABLED || 'false').trim().toLowerCase() === 'true';
const JITO_BLOCK_ENGINE_URL = (process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf').trim();
const JITO_TIP_LAMPORTS = parseInt((process.env.JITO_TIP_LAMPORTS || '10000').trim(), 10);
const JITO_TIP_ACCOUNT = (process.env.JITO_TIP_ACCOUNT || '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZ8N4mTGqkaHftq').trim();

// ── Known Jito tip accounts (fallbacks) ────────────────────────

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZ8N4mTGqkaHftq', // Jito Tip #1
  'HFqU5x63VTqvQss8hp11i4ETtMoVGvttKtVPz79GtoFP', // Jito Tip #2
  'ADaUMid9yfUytqMBgopwjb2DTLSofTZN2QmK6wKfKmZA', // Jito Tip #3
  'DttWaMuVvTiduZRnguLF7jN23TvTL1KPcdu1Y4V2xWVJ', // Jito Tip #4
];

// ── Types ──────────────────────────────────────────────────────

interface JitoRpcResponse {
  result?: any;
  error?: { message?: string; code?: number; data?: any };
}

export interface JitoBundleResult {
  success: boolean;
  bundleId?: string;
  error?: string;
}

export interface JitoBundleStatus {
  bundleId: string;
  status: 'pending' | 'landed' | 'failed';
  slot?: number;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────

function txToBase64(tx: Transaction | VersionedTransaction): string {
  if (tx instanceof VersionedTransaction) {
    return Buffer.from(tx.serialize()).toString('base64');
  }
  return tx.serialize({ requireAllSignatures: true }).toString('base64');
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API — exported for V5 Alpha
// ═══════════════════════════════════════════════════════════════

/**
 * Return the active Jito tip account.
 * Called by V5 for status displays and logging.
 */
export function getTipAccount(): string {
  try {
    new PublicKey(JITO_TIP_ACCOUNT);
    return JITO_TIP_ACCOUNT;
  } catch {
    return JITO_TIP_ACCOUNTS[0];
  }
}

/**
 * Simulate a bundle through Jito's simulation endpoint.
 * Catches errors without spending SOL on doomed bundles.
 *
 * @param txs        Signed transactions to simulate
 * @param connection Solana RPC connection (for fallback simulation)
 */
export async function simulateJitoBundle(
  txs: (Transaction | VersionedTransaction)[],
  connection: Connection,
): Promise<{ success: boolean; error?: string }> {
  try {
    const serialized = txs.map(txToBase64);

    // Try Jito simulation first
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateBundle',
      params: [serialized],
    });

    const resp = await fetch(`${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.ok) {
      const data: JitoRpcResponse = await resp.json();
      if (data?.result?.summary === 'succeeded') {
        return { success: true };
      }
      return { success: false, error: data?.result?.summary || 'Simulation failed' };
    }

    // Fallback: simulate against RPC directly
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      let result;
      if (tx instanceof VersionedTransaction) {
        result = await connection.simulateTransaction(tx);
      } else {
        result = await connection.simulateTransaction(tx);
      }
      if (result.value.err) {
        return { success: false, error: `tx[${i}] failed: ${JSON.stringify(result.value.err)}` };
      }
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Send a bundle to the Jito Block Engine.
 *
 * @param txs  Signed transactions [buyTx, sellTx, tipTx]
 * @returns    Bundle result with ID for status tracking
 */
export async function sendJitoBundle(
  txs: (Transaction | VersionedTransaction)[],
): Promise<JitoBundleResult> {
  if (!JITO_ENABLED) {
    return { success: false, error: 'Jito is disabled (JITO_ENABLED=false)' };
  }

  if (txs.length > 5) {
    return { success: false, error: `Bundle too large: ${txs.length} txs (max 5)` };
  }

  try {
    const serialized = txs.map(txToBase64);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serialized],
    });

    const resp = await fetch(`${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `HTTP ${resp.status}: ${errText}` };
    }

    const data: JitoRpcResponse = await resp.json();

    if (data.error) {
      return {
        success: false,
        error: `Jito rejected: ${data.error.message || JSON.stringify(data.error)}`,
      };
    }

    const bundleId: string = data.result;
    return { success: true, bundleId };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Execute an arbitrage through Jito bundle.
 *
 * This is the MAIN entry point. V5 calls this when:
 *   PAPER_TRADING=false + JITO_ENABLED=true
 *
 * Flow:
 *   1. Simulate the bundle (don't waste SOL on doomed txs)
 *   2. If simulation passes, submit to Jito Block Engine
 *   3. Return bundle ID for status tracking
 *
 * @param buyTx      Signed buy swap transaction
 * @param sellTx     Signed sell swap transaction
 * @param tipTx      Signed tip transaction
 * @param connection Solana RPC connection
 */
export async function executeArbViaJito(
  buyTx: Transaction | VersionedTransaction,
  sellTx: Transaction | VersionedTransaction,
  tipTx: Transaction | VersionedTransaction,
  connection: Connection,
): Promise<JitoBundleResult> {
  if (!JITO_ENABLED) {
    return { success: false, error: 'Jito is disabled' };
  }

  // Step 1: Pre-flight simulation
  const sim = await simulateJitoBundle([buyTx, sellTx, tipTx], connection);
  if (!sim.success) {
    return { success: false, error: `Pre-flight failed: ${sim.error}` };
  }

  // Step 2: Submit to Jito
  return sendJitoBundle([buyTx, sellTx, tipTx]);
}

// ── Boot Log ───────────────────────────────────────────────────

if (JITO_ENABLED) {
  console.log(
    `🔥 Jito Bundle Engine ACTIVE\n` +
    `   Block Engine: ${JITO_BLOCK_ENGINE_URL}\n` +
    `   Tip: ${JITO_TIP_LAMPORTS} lamports → ${getTipAccount().slice(0, 8)}...`
  );
} else {
  console.log('💤 Jito Bundle Engine dormant (JITO_ENABLED=false)');
}
