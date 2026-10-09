#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════
//  V5 ALPHA — SOLANA · LIVE DASHBOARD
// ═══════════════════════════════════════════════════════════════
//
//  A read-only window onto a running engine.
//
//  It does NOT instrument, import or modify Cyborg_V5_Alpha_Solana.ts.
//  It only tails the files the engine already writes:
//
//    paper_trades_solana.jsonl   executed (paper) trades
//    opportunity_replay.jsonl    every opportunity the engine saw
//    logs/solana_bot.log         the engine's own narration
//    paper_state.json            live balance / trade count
//
//  Because it shares nothing with the engine but the filesystem, the
//  dashboard can start, stop or crash without ever touching the trading
//  loop. A UI must never be load-bearing for a trade.
//
//  The SolGuard button reuses the same evaluateTokenRisk() the engine's
//  Tier-0 gate calls, so a scan here returns the same verdict the engine
//  would reach.
//
//  READ-ONLY. No wallet, no signing, no transaction, ever.
//
//  Port 7780 (V5_UI_PORT to override) — deliberately not 7778, so the
//  SolGuard standalone UI can run alongside without a port clash.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Connection } from '@solana/web3.js';
import { evaluateTokenRisk, describeVerdict, type RiskVerdict } from './checks';
import { adapterForDex, KNOWN_DEXES } from './adapters';
import { assessDbcPool, describeDbc, dbcBlocked } from './dbc';
import { loadProjectEnv, redact } from './env';

// Configuration and secret hygiene live in ./env so this server and the
// CLI resolve the RPC identically and nothing prints unredacted.
loadProjectEnv();

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.V5_UI_PORT || 7780);
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const RPC =
  process.env.SOLANA_RPC_URL ||
  process.env.SOLANA_RPC || // V5 Alpha names it SOLANA_RPC in .env.Solana
  process.env.RPC_URL ||
  PUBLIC_RPC;
const USING_PUBLIC = RPC === PUBLIC_RPC;

const connection = new Connection(RPC, 'confirmed');

const F = {
  trades: path.join(ROOT, 'paper_trades_solana.jsonl'),
  replay: path.join(ROOT, 'opportunity_replay.jsonl'),
  log: path.join(ROOT, 'logs', 'solana_bot.log'),
  state: path.join(ROOT, 'paper_state.json'),
  mints: path.join(__dirname, 'mints.json'),
};

const UI_FILE = path.join(__dirname, 'dashboard.html');

// ── small helpers ──────────────────────────────────────────────

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

function safeParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  // \r too: the engine's log file is CRLF, and a stray CR inside a
  // pre-wrap block renders as a spurious line break.
  return String(s).replace(ANSI, '').replace(/\r/g, '');
}

/**
 * Read trailing bytes of a file and return the complete lines in it.
 * The first line is dropped when we started mid-file, because it is
 * almost certainly a partial record.
 */
function readTailLines(file: string, maxBytes: number): string[] {
  let fh: number | undefined;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fh = fs.openSync(file, 'r');
    fs.readSync(fh, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim().length > 0);
    if (start > 0 && lines.length) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fh !== undefined) fs.closeSync(fh);
  }
}

// ── incremental file tailer ────────────────────────────────────
// Polling stat() once a second is boring and reliable, including on
// Windows where fs.watch is famously moody. Rotation is handled free.

class Tailer {
  private offset = 0;
  private carry = '';

  constructor(private readonly file: string) {}

  /** Start at the end of the file so we never replay a 6 MB log. */
  prime(bytes: number): void {
    try {
      const st = fs.statSync(this.file);
      this.offset = Math.max(0, st.size - bytes);
    } catch {
      this.offset = 0;
    }
    this.carry = '';
  }

  /** Return complete lines appended since the previous call. */
  readNew(): string[] {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return [];
    }

    if (st.size < this.offset) {
      // rotated or truncated — restart from the top
      this.offset = 0;
      this.carry = '';
    }
    if (st.size === this.offset) return [];

    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    let fh: number | undefined;
    try {
      fh = fs.openSync(this.file, 'r');
      fs.readSync(fh, buf, 0, len, this.offset);
    } catch {
      return [];
    } finally {
      if (fh !== undefined) fs.closeSync(fh);
    }

    this.offset = st.size;
    const parts = (this.carry + buf.toString('utf8')).split('\n');
    this.carry = parts.pop() ?? '';
    return parts.filter(l => l.trim().length > 0);
  }
}

// ── trade accounting ───────────────────────────────────────────
//
// DATA QUALITY NOTE: the paper trader has been observed writing rows
// whose buyPrice and sellPrice are in DIFFERENT units (one SOL-
// denominated, one USD-denominated), producing profitSol values in the
// hundreds of thousands. Those rows are real file contents, so we show
// them — but we tag them. Rendering a 221,771 SOL "profit" as though it
// were a result would be a lie. A row is 'suspect' when it falls outside
// any range an honest arb could produce. That tag is a prompt to fix the
// simulation, not a bug in the dashboard.

interface TradeRow {
  timestamp?: string;
  pairLabel?: string;
  buyDex?: string;
  sellDex?: string;
  spreadBps?: number;
  profitBps?: number;
  profitSol?: number;
  tradeSizeSol?: number;
  balanceAfterSol?: number;
  [k: string]: unknown;
}

const SUSPECT_PROFIT_SOL = 100;
const SUSPECT_PROFIT_BPS = 10_000;

function isSuspect(r: TradeRow): boolean {
  const p = Number(r?.profitSol ?? 0);
  const b = Math.abs(Number(r?.profitBps ?? 0));
  if (!isFinite(p)) return true;
  return Math.abs(p) > SUSPECT_PROFIT_SOL || b > SUSPECT_PROFIT_BPS;
}

function decorate(r: TradeRow): TradeRow & { suspect: boolean } {
  return { ...r, suspect: isSuspect(r) };
}

const stats = {
  trades: 0,
  wins: 0,
  losses: 0,
  totalProfitSol: 0,
  /** Sum excluding rows flagged suspect — the only figure worth showing. */
  cleanProfitSol: 0,
  cleanTrades: 0,
  bestProfitSol: 0,
  bestPair: null as string | null,
  firstSeen: null as string | null,
  lastSeen: null as string | null,
  suspectRows: 0,
};

function accountTrade(r: TradeRow): void {
  if (!r || typeof r !== 'object') return;
  const p = Number(r.profitSol ?? 0);
  stats.trades += 1;
  if (p >= 0) stats.wins += 1;
  else stats.losses += 1;
  if (isFinite(p)) {
    stats.totalProfitSol += p;
    if (p > stats.bestProfitSol) {
      stats.bestProfitSol = p;
      stats.bestPair = typeof r.pairLabel === 'string' ? r.pairLabel : null;
    }
  }
  if (isSuspect(r)) {
    stats.suspectRows += 1;
  } else {
    stats.cleanTrades += 1;
    if (isFinite(p)) stats.cleanProfitSol += p;
  }
  if (typeof r.timestamp === 'string') {
    if (!stats.firstSeen) stats.firstSeen = r.timestamp;
    stats.lastSeen = r.timestamp;
  }
}

// Warm the counters from the tail of the trade log, then follow live.
for (const line of readTailLines(F.trades, 512 * 1024)) {
  const row = safeParse(line);
  if (row) accountTrade(row);
}

const tradesTailer = new Tailer(F.trades);
const replayTailer = new Tailer(F.replay);
const logTailer = new Tailer(F.log);

tradesTailer.prime(0);
replayTailer.prime(0);
logTailer.prime(64 * 1024);

// ── server-sent events ─────────────────────────────────────────
// SSE rather than WebSockets: zero dependencies, native in the browser,
// and it degrades gracefully when a tab is backgrounded or a proxy
// decides to be interesting.

const clients = new Set<http.ServerResponse>();

function push(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

/**
 * Optional pairLabel -> mint map (solguard/mints.json). The engine's
 * JSONL streams carry no mint address, so without this registry a trade
 * card cannot be linked to a SolGuard scan. The engine stays untouched;
 * this is a plain JSON file the operator fills in by hand.
 */
function loadMintRegistry(): Record<string, string> {
  const raw = readJson<Record<string, string>>(F.mints);
  return raw && typeof raw === 'object' ? raw : {};
}

function snapshot() {
  const trades = readTailLines(F.trades, 128 * 1024)
    .slice(-40)
    .map(safeParse)
    .filter(Boolean)
    .map(decorate);

  const opportunities = readTailLines(F.replay, 64 * 1024)
    .slice(-20)
    .map(safeParse)
    .filter(Boolean);

  const log = readTailLines(F.log, 48 * 1024).slice(-60).map(stripAnsi);

  return {
    ok: true,
    rpc: redact(RPC),
    usingPublicRpc: USING_PUBLIC,
    port: PORT,
    dexes: KNOWN_DEXES,
    state: readJson(F.state),
    stats: { ...stats },
    trades,
    opportunities,
    log,
    mints: loadMintRegistry(),
    serverTime: new Date().toISOString(),
  };
}

// ── handlers ───────────────────────────────────────────────────

async function handleScan(q: URLSearchParams): Promise<{ code: number; body: unknown }> {
  const mint = (q.get('mint') || '').trim();
  const dex = (q.get('dex') || '').trim();
  const pool = (q.get('pool') || '').trim() || undefined;

  if (!mint) return { code: 400, body: { error: 'missing parameter: mint' } };
  if (!isPubkey(mint)) return { code: 400, body: { error: `not a valid base58 pubkey: ${mint}` } };

  const t0 = Date.now();
  try {
    const verdict: RiskVerdict = await evaluateTokenRisk({
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
        rpc: redact(RPC),
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
  try {
    const dbc = await assessDbcPool(connection, pool);
    return {
      code: 200,
      body: {
        ok: true,
        kind: 'dbc',
        tookMs: Date.now() - t0,
        dbc,
        summary: describeDbc(dbc),
        blocked: dbcBlocked(dbc),
        rpc: redact(RPC),
      },
    };
  } catch (e: any) {
    return { code: 500, body: { ok: false, error: e?.message ?? String(e) } };
  }
}

// ── server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(UI_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      return;
    }

    if (url.pathname === '/api/snapshot') {
      sendJson(res, 200, snapshot());
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

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        clients: clients.size,
        rpc: redact(RPC),
        usingPublicRpc: USING_PUBLIC,
        trades: stats.trades,
      });
      return;
    }

    sendJson(res, 404, { error: `no route: ${url.pathname}` });
  } catch (e: any) {
    sendJson(res, 500, { ok: false, error: e?.message ?? String(e) });
  }
});

// ── the one-second tick ────────────────────────────────────────

let beat = 0;

setInterval(() => {
  for (const line of tradesTailer.readNew()) {
    const row = safeParse(line);
    if (!row) continue;
    accountTrade(row);
    push('trade', decorate(row));
    push('stats', { ...stats });
  }

  for (const line of replayTailer.readNew()) {
    const row = safeParse(line);
    if (row) push('opportunity', row);
  }

  for (const line of logTailer.readNew()) push('log', stripAnsi(line));

  if (++beat % 20 === 0) {
    for (const c of clients) {
      try {
        c.write(': ping\n\n');
      } catch {
        clients.delete(c);
      }
    }
  }
}, 1000);

// ── self-test ──────────────────────────────────────────────────
// Exercises the real tail + stats path against the real files and
// exits without binding a port. `npm run v5:ui -- --selftest`

if (process.argv.includes('--selftest')) {
  const s = snapshot();
  console.log(
    JSON.stringify(
      {
        ok: s.ok,
        rpc: s.rpc,
        usingPublicRpc: s.usingPublicRpc,
        tradesInTail: s.trades.length,
        opportunitiesInTail: s.opportunities.length,
        logLines: s.log.length,
        stats: s.stats,
        state: s.state,
        sampleTrade: s.trades[s.trades.length - 1] ?? null,
        sampleLog: s.log[s.log.length - 1] ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const G = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', gold: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m' };

server.listen(PORT, () => {
  console.log('');
  console.log(`${G.gold}${G.bold}  V5 ALPHA${G.reset} ${G.gray}· SOLANA — live dashboard${G.reset}`);
  console.log(`${G.gray}  ─────────────────────────────────────────────${G.reset}`);
  console.log(`  UI      ${G.bold}http://localhost:${PORT}${G.reset}`);
  console.log(`  RPC     ${G.gray}${redact(RPC)}${G.reset}`);
  console.log(`  Feed    ${G.gray}paper_trades_solana.jsonl · opportunity_replay.jsonl · logs/${G.reset}`);
  console.log(`  Mode    ${G.green}READ-ONLY${G.reset} ${G.gray}(no wallet, no signing, no tx)${G.reset}`);
  if (USING_PUBLIC) {
    console.log(`  ${G.gold}⚠ PUBLIC RPC — SolGuard scans will be rate limited.${G.reset}`);
    console.log(`  ${G.gray}  Set SOLANA_RPC in .env.Solana for real scans.${G.reset}`);
  }
  console.log('');
  console.log(`${G.gray}  Ctrl+C to stop. The engine is unaffected either way.${G.reset}`);
  console.log('');

  if (process.argv.includes('--open')) {
    exec(`start "" http://localhost:${PORT}`, err => {
      if (err) console.log(`${G.gray}  (could not auto-open browser: ${err.message})${G.reset}`);
    });
  }
});

process.on('SIGINT', () => {
  console.log(`\n${G.gold}  Dashboard shutting down. Engine keeps running.${G.reset}\n`);
  for (const c of clients) {
    try {
      c.end();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
});
