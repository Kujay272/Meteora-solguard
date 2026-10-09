#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — Black & Gold local UI server
// ═══════════════════════════════════════════════════════════════
//
//  Zero external dependencies on purpose: Node built-ins plus the
//  @solana/web3.js the engine already has. Nothing here can fail
//  because a UI package isn't installed.
//
//  Usage:
//    npx ts-node solguard/ui-server.ts
//    npx ts-node solguard/ui-server.ts --open     (opens the browser)
//
//  READ-ONLY. This server never signs, never sends, never holds a key.
//  It runs the same deterministic checks the engine's gate runs, so
//  what you see in the browser is what the engine would decide.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Connection } from '@solana/web3.js';
import { evaluateTokenRisk, describeVerdict, clearRiskCache, riskCacheSize } from './checks';
import { adapterForDex, KNOWN_DEXES, ADAPTERS } from './adapters';
import { assessDbcPool, describeDbc, dbcBlocked } from './dbc';
import { loadProjectEnv, redact } from './env';

  // ── RPC configuration ────────────────────────────────────────
  // Reads SOLANA_RPC / SOLANA_RPC_URL from the project's own .env.Solana
  // so the key never has to be exported into a shell or pasted into
  // source. Everything printed goes through redact() first: an API key
  // that lands in a screenshot is a leaked key.

  // Configuration and secret hygiene live in ./env so the CLI and the UI
  // resolve the RPC identically and nothing is ever printed unredacted.
  loadProjectEnv();

const PORT = Number(process.env.SOLGUARD_PORT || 7778);
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.SOLANA_RPC ||   // V5 Alpha names it SOLANA_RPC in .env.Solana
  process.env.RPC_URL ||
  PUBLIC_RPC;
const USING_PUBLIC = RPC === PUBLIC_RPC;

const connection = new Connection(RPC, 'confirmed');
const UI_FILE = path.join(__dirname, 'ui.html');

const M = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  gold: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', gray: '\x1b[90m',
};

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function isPubkey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

async function handleScan(q: URLSearchParams): Promise<{ code: number; body: unknown }> {
  const mint = (q.get('mint') || '').trim();
  const dex = (q.get('dex') || '').trim();
  const pool = (q.get('pool') || '').trim() || undefined;

  if (!mint) return { code: 400, body: { error: 'missing parameter: mint' } };
  if (!isPubkey(mint)) return { code: 400, body: { error: `not a valid base58 pubkey: ${mint}` } };

  const t0 = Date.now();
  try {
    const verdict = await evaluateTokenRisk({
      connection,
      mintAddress: mint,
      adapter: dex ? adapterForDex(dex) : null,
      opts: { poolAddress: pool, cacheSeconds: 0 },
    });
    return {
      code: 200,
      body: {
        ok: true,
        kind: 'token',
        tookMs: Date.now() - t0,
        verdict,
        summary: describeVerdict(verdict),
        dex: dex || '(none)',
        rpc: RPC,
      },
    };
  } catch (e: any) {
    return { code: 500, body: { ok: false, error: e?.message ?? String(e) } };
  }
}

async function handleDbc(q: URLSearchParams): Promise<{ code: number; body: unknown }> {
  const pool = (q.get('pool') || '').trim();
  if (!pool) return { code: 400, body: { error: 'missing parameter: pool' } };
  if (!isPubkey(pool)) return { code: 400, body: { error: `not a valid base58 pubkey: ${pool}` } };

  const t0 = Date.now();
  const assessment = await assessDbcPool(connection, pool);
  return {
    code: 200,
    body: {
      ok: true,
      kind: 'dbc',
      tookMs: Date.now() - t0,
      dbc: assessment,
      summary: describeDbc(assessment),
      blocked: dbcBlocked(assessment),
      rpc: RPC,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(UI_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/meta') {
      sendJson(res, 200, {
        ok: true,
        rpc: RPC,
        port: PORT,
        dexes: KNOWN_DEXES,
        adapters: Object.fromEntries(
          Object.entries(ADAPTERS).map(([k, a]) => [k, a.name]),
        ),
        cacheSize: riskCacheSize(),
      });
      return;
    }

    if (url.pathname === '/api/scan') {
      const r = await handleScan(url.searchParams);
      sendJson(res, r.code, r.body);
      return;
    }

    if (url.pathname === '/api/dbc') {
      const r = await handleDbc(url.searchParams);
      sendJson(res, r.code, r.body);
      return;
    }

    if (url.pathname === '/api/cache/clear') {
      clearRiskCache();
      sendJson(res, 200, { ok: true, cacheSize: riskCacheSize() });
      return;
    }

    sendJson(res, 404, { error: `no route: ${url.pathname}` });
  } catch (e: any) {
    sendJson(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log(`${M.gold}${M.bold}  SOLGUARD${M.reset} ${M.gray}— DBC-native risk monitor${M.reset}`);
  console.log(`${M.gray}  ─────────────────────────────────────────${M.reset}`);
  console.log(`  UI      ${M.bold}http://localhost:${PORT}${M.reset}`);
  console.log(`  RPC     ${M.gray}${redact(RPC)}${M.reset}`);
  if (USING_PUBLIC) {
    console.log(`  ${M.gold}⚠ PUBLIC RPC — getTokenLargestAccounts WILL be rate limited.${M.reset}`);
    console.log(`  ${M.gray}  Set SOLANA_RPC in .env.Solana for a real scan.${M.reset}`);
  }
  console.log(`  Mode    ${M.green}READ-ONLY${M.reset} ${M.gray}(no wallet, no signing, no tx)${M.reset}`);
  console.log('');
  console.log(`${M.gray}  Ctrl+C to stop.${M.reset}`);
  console.log('');

  if (process.argv.includes('--open')) {
    exec(`start "" http://localhost:${PORT}`, (err) => {
      if (err) console.log(`${M.gray}  (could not auto-open browser: ${err.message})${M.reset}`);
    });
  }
});

process.on('SIGINT', () => {
  console.log(`\n${M.gold}  SolGuard shutting down.${M.reset}\n`);
  server.close(() => process.exit(0));
});
