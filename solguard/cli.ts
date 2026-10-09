#!/usr/bin/env ts-node
// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — CLI
// ═══════════════════════════════════════════════════════════════
//
//  Usage:
//    npx ts-node cli.ts --mint <MINT>              generic token risk
//    npx ts-node cli.ts --dbc  <POOL>              Meteora DBC risk
//    npx ts-node cli.ts --mint <MINT> --out state.json
//    npx ts-node cli.ts --mint <MINT> --json       machine-readable
//
//  Read-only. No wallet. No signing. No transaction is ever built.

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import {
  evaluateTokenRisk,
  describeVerdict,
  clearRiskCache,
  riskCacheSize,
  type RiskVerdict,
} from './checks';
import { adapterForDex } from './adapters';
import { prewarmOnce, describeWarmth } from './warm';
import { assessDbcPool, describeDbc, type DbcAssessment } from './dbc';
import { discoverDbcPools, type DbcPoolSummary } from './discover';
import { loadProjectEnv, redact } from './env';

interface CliArgs {
  mint?: string;
  dbc?: string;
  dex?: string;
  pool?: string;
  lpMint?: string;
  rpc?: string;
  out?: string;
  json?: boolean;
  skipLiquidity?: boolean;
  cacheSeconds?: number;
  discover?: number;
  onlyActive?: boolean;
  /** `--warm [mint,mint,...]` — prove the pre-warmer turns the gate into a cache hit */
  warm?: string[];
  /** `--dbc-debug` — surface why the DBC curve path declined, instead of a silent fallback */
  dbcDebug?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case '--mint': a.mint = next(); break;
      case '--dbc': a.dbc = next(); break;
      case '--dex': a.dex = next(); break;
      case '--pool': a.pool = next(); break;
      case '--lp-mint': a.lpMint = next(); break;
      case '--rpc': a.rpc = next(); break;
      case '--out': a.out = next(); break;
      case '--cache-seconds': a.cacheSeconds = Number(next()); break;
      case '--skip-liquidity': a.skipLiquidity = true; break;
      case '--json': a.json = true; break;
      case '--only-active': a.onlyActive = true; break;
      case '--warm': {
        // `--warm <mint,mint,...>` or bare `--warm` (falls back to --mint).
        // Comma-separated because a demo should not need two flags to say
        // "warm these three mints".
        const v = argv[i + 1];
        if (v && !v.startsWith('--')) {
          a.warm = v.split(',').map(s => s.trim()).filter(Boolean);
          i++;
        } else {
          a.warm = [];
        }
        break;
      }
      case '--discover': {
        // Optional numeric argument: `--discover 25` or bare `--discover`.
        const v = argv[i + 1];
        if (v && !v.startsWith('--')) { a.discover = Number(v); i++; }
        else { a.discover = 10; }
        break;
      }
      case '--dbc-debug':
        // A silent fallback is how a coverage hole hides. This makes the curve
        // path explain itself on stderr, without changing a single verdict.
        a.dbcDebug = true;
        process.env.SOLGUARD_DEBUG_DBC = '1';
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (t.startsWith('--')) {
          console.error(`Unknown flag: ${t}`);
          printHelp();
          process.exit(1);
        }
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
SolGuard — pre-trade token risk gate (read-only)

  --mint <MINT>        base token mint to evaluate
  --dbc  <POOL>        Meteora DBC virtual pool address to assess
  --dex  <LABEL>       dex label (Raydium | Orca | Meteora DBC | ...)
  --pool <ADDRESS>     explicit pool address for LP resolution
  --lp-mint <MINT>     explicit LP mint (overrides DEX adapter)
  --rpc <URL>          RPC endpoint (default: env SOLANA_RPC_URL or public)
  --out <FILE>         write the JSON result to a file
  --cache-seconds <N>  verdict cache TTL (default 60)
  --skip-liquidity     skip the LP burn check
  --discover [N]       list live DBC pools read straight off-chain (default 10)
  --only-active        with --discover: hide already-migrated pools
  --warm [mints]       pre-warm test: clear cache, time one COLD gate call, run
                       one warm pass, then time the same call again. Proof that
                       the pre-warmer turns a 2s audit into a Map lookup.
                       Comma-separated; bare --warm falls back to --mint.
  --dbc-debug          explain why the DBC curve sell-quote declined (stderr)
  --json               emit JSON only
  -h, --help           this message

Nothing here signs or sends a transaction.
`);
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

function paint(s: string, c: keyof typeof C): string {
  return `${C[c]}${s}${C.reset}`;
}

function isValidPubkey(s: string): boolean {
  try { new PublicKey(s); return true; } catch { return false; }
}

function printVerdict(v: RiskVerdict): void {
  const banner = v.decision === 'BLOCK' ? paint('   BLOCKED   ', 'red')
    : v.decision === 'UNVERIFIED' ? paint('  INCONCLUSIVE ', 'yellow')
    : v.warned.length ? paint('  SAFE (WARNINGS)  ', 'yellow')
    : paint('    SAFE    ', 'green');

  const scoreText = v.riskScore === null
    ? paint('n/a — nothing readable', 'yellow')
    : `${paint(String(v.riskScore), v.riskScore > 70 ? 'green' : v.riskScore > 40 ? 'yellow' : 'red')}/100`;

  console.log('');
  console.log(paint('━'.repeat(64), 'gray'));
  console.log(`${banner}  risk score ${scoreText}  ${paint('confidence ' + (v.confidence * 100).toFixed(0) + '%', 'gray')}`);
  console.log(paint(`mint ${v.mintAddress}`, 'dim'));
  console.log(paint('━'.repeat(64), 'gray'));

  for (const c of v.checks) {
    const tag = c.status === 'skip' ? paint('SKIP', 'gray')
      : c.status === 'unverified' ? paint('UNVERIFIED', 'yellow')
      : c.status === 'pass' ? paint('PASS', 'green')
      : c.severity === 'block' ? paint('BLOCK', 'red')
      : paint('WARN', 'yellow');
    console.log(`${tag}  ${c.name}`);
    console.log(paint(`      ${c.detail}`, 'dim'));
  }

  if (v.unverified.length > 0) {
    console.log(paint(`\n  ${v.unverified.length} check(s) could not be read — held for review.`, 'yellow'));
    console.log(paint('  Not treated as passing, not scored as a finding.', 'yellow'));
    for (const u of v.unverified) console.log(paint(`    · ${u.name}: ${u.detail}`, 'gray'));
  }
  console.log('');
  console.log(paint('  → ' + describeVerdict(v), 'bold'));
}

function printDbc(a: DbcAssessment): void {
  console.log('');
  console.log(paint('━'.repeat(64), 'gray'));
  const banner = !a.available ? paint('  UNVERIFIED  ', 'yellow')
    : a.checks.some(c => !c.passed && c.severity === 'block') ? paint('   BLOCKED   ', 'red')
    : paint('  DBC CLEAR  ', 'green');
  console.log(banner);
  console.log(paint(`pool ${a.address}`, 'dim'));
  console.log(paint(`cluster ${redact(a.cluster)}`, 'gray'));
  console.log(paint('━'.repeat(64), 'gray'));

  if (a.unavailableReason) {
    console.log(paint(`  ${a.unavailableReason}`, 'yellow'));
  }

  for (const c of a.checks) {
    const tag = c.passed ? paint('PASS', 'green') : c.severity === 'block' ? paint('BLOCK', 'red') : paint('WARN', 'yellow');
    console.log(`${tag}  ${c.name}`);
    console.log(paint(`      ${c.detail}`, 'dim'));
  }

  console.log('');
  console.log(paint('  → ' + describeDbc(a), 'bold'));
}

function printDiscover(pools: DbcPoolSummary[], rpc: string): void {
  console.log('');
  console.log(paint('━'.repeat(96), 'gray'));
  console.log(`${paint('  LIVE DBC POOLS  ', 'cyan')}  ${pools.length} shown`);
  console.log(paint(`  via ${redact(rpc)}`, 'dim'));
  console.log(paint('━'.repeat(96), 'gray'));
  console.log(paint('  quoteReserve   migrated  t2022  baseMint                                    poolAddress', 'dim'));

  for (const p of pools) {
    const mig = p.isMigrated === true ? paint('yes', 'yellow') : paint('no ', 'green');
    // Three-state, both columns. `null` means UNKNOWN and must not render as a
    // clean 'no' — claiming "legacy SPL" for an account we could not classify
    // is the same lie as claiming [hook] for one we never checked.
    const t22 =
      p.isToken2022 === null
        ? paint('?  ', 'dim')
        : p.isToken2022 === true
          ? paint('yes', 'yellow')
          : paint('no ', 'green');
    const reserve = p.quoteReserve === null ? '         ?' : p.quoteReserve.toFixed(4).padStart(10);
    const mint = (p.baseMint ?? '?').padEnd(42);
    const hook =
      p.isTransferHookPool === true
        ? paint(' [hook]', 'red')
        : p.isTransferHookPool === null
          ? paint(' [hook?]', 'yellow')
          : '';
    console.log(`  ${reserve}   ${mig}       ${t22}    ${mint}  ${p.poolAddress}${hook}`);
  }

  console.log('');
  console.log(paint('  [hook]  = transferHookPool, read from the account discriminator', 'dim'));
  console.log(paint('  [hook?] = bytes unreadable; variant UNKNOWN, not cleared', 'dim'));
  console.log(paint('  Assess one:  npm run solguard -- --dbc <poolAddress>', 'bold'));
  console.log(paint('  Reserve is scaled by 9 decimals (SOL assumption) unless the account', 'dim'));
  console.log(paint('  exposes its own — the full assessment reads the real quote mint.', 'dim'));
}

/**
 * `--warm` — the pre-warmer's test bench.
 *
 * A cold audit costs ~2.2s of RPC: five checks, four of them network. The
 * entire claim of solguard/warm.ts is that a background pass rewrites that
 * cost into a Map lookup, which is the difference between a gate that can sit
 * in front of an arbitrage window and one that arrives after it has closed.
 *
 * This proves the claim in ONE process, and it has to be one process: the
 * cache in checks.ts is a module-level Map. Two separate CLI runs share
 * nothing, so a cold run followed by a warm run proves nothing at all.
 *
 *   phase 1  empty the cache, make one honest gate call, time it (COLD)
 *   phase 2  empty it again, run one serial gapped pre-warm pass
 *   phase 3  make the same gate call again — this is the number that matters
 *
 * Read-only. No wallet, no signing, no transaction is ever built.
 */
async function runWarmTest(
  connection: Connection,
  mints: string[],
  json: boolean,
): Promise<Record<string, unknown>> {
  const valid = mints.filter(isValidPubkey);
  if (valid.length === 0) {
    console.error(paint('  --warm needs at least one valid mint: --warm <mint> or --mint <mint>', 'red'));
    process.exit(1);
  }

  const report: Record<string, unknown> = {
    kind: 'warm-test',
    mints: valid,
    cacheEntriesAtStart: riskCacheSize(),
  };

  if (!json) {
    console.log('');
    console.log(paint('━'.repeat(74), 'gray'));
    console.log(`${paint('  PRE-WARM TEST  ', 'cyan')}  one process — the cache is module-level memory`);
    console.log(paint('━'.repeat(74), 'gray'));
    console.log(paint(`  mints: ${valid.length}    cache entries at start: ${riskCacheSize()}`, 'dim'));
  }

  // ── Phase 1: COLD ──────────────────────────────────────────────
  clearRiskCache();
  const probe = valid[0];
  const c0 = Date.now();
  const coldVerdict = await evaluateTokenRisk({ connection, mintAddress: probe });
  const coldMs = Date.now() - c0;

  if (!json) {
    console.log('');
    console.log(paint('  phase 1 — COLD gate call, cache emptied', 'bold'));
    console.log(
      `    ${probe}  ${paint(String(coldMs).padStart(7) + 'ms', 'yellow')}  ${coldVerdict.decision}` +
      (coldVerdict.riskScore === null ? '' : `  score ${coldVerdict.riskScore}`),
    );
  }

  // ── Phase 2: PRE-WARM ──────────────────────────────────────────
  clearRiskCache();
  const p0 = Date.now();
  const stats = await prewarmOnce(connection, valid, {
    gapMs: 300,
    cacheSeconds: 60,
    log: (line: string) => { if (!json) console.log(paint('    ' + line, 'dim')); },
  });
  const passMs = Date.now() - p0;

  if (!json) {
    console.log('');
    console.log(paint('  phase 2 — pre-warm pass (serial, gapped)', 'bold'));
    console.log(
      `    warmed ${stats.warmed}/${valid.length} in ${passMs}ms` +
      `   skipped-fresh ${stats.skippedFresh}  timed-out ${stats.timedOut}  failed ${stats.failed}`,
    );
    console.log(paint(`    cache entries now: ${riskCacheSize()}`, 'dim'));
  }

  // ── Phase 3: GATE HIT ──────────────────────────────────────────
  if (!json) {
    console.log('');
    console.log(paint('  phase 3 — the same gate call, now warm', 'bold'));
  }

  const hits: Array<Record<string, unknown>> = [];
  let slowest = 0;

  for (const m of valid) {
    const h0 = Date.now();
    const v = await evaluateTokenRisk({ connection, mintAddress: m });
    const ms = Date.now() - h0;
    if (ms > slowest) slowest = ms;

    hits.push({
      mint: m,
      gateMs: ms,
      decision: v.decision,
      riskScore: v.riskScore,
      confidence: v.confidence,
      stale: v.stale === true,
      warmth: describeWarmth(m),
    });

    if (!json) {
      const msText = String(ms).padStart(6) + 'ms';
      console.log(
        `    ${m}  ${paint(msText, ms < 50 ? 'green' : 'yellow')}` +
        `  ${v.decision.padEnd(11)} score ${String(v.riskScore ?? 'n/a').padEnd(4)}` +
        ` ${v.stale ? paint('STALE', 'yellow') : 'fresh'}`,
      );
    }
  }

  // ── Verdict ────────────────────────────────────────────────────
  const allWarmed = stats.warmed >= valid.length;
  const hitFast = slowest < 50;
  const pass = allWarmed && hitFast;
  const speedup = coldMs > 0 ? coldMs / Math.max(1, slowest) : 0;

  const summary = pass
    ? `warm gate call ${slowest}ms vs cold ${coldMs}ms — ${speedup.toFixed(0)}x faster`
    : !allWarmed
      ? `only ${stats.warmed}/${valid.length} warmed (${stats.timedOut} timed out, ${stats.failed} failed) — a failed warm is a cold gate`
      : `still ${slowest}ms warm — the cache did not serve`;

  if (!json) {
    console.log('');
    console.log(paint('━'.repeat(74), 'gray'));
    console.log(`${pass ? paint('  PRE-WARM OK  ', 'green') : paint('  PRE-WARM FAILED  ', 'red')}  ${summary}`);
    console.log(paint('  Cold is the cost of five RPC checks. Warm is the cost of a Map lookup.', 'dim'));
    console.log(paint('  Which is why the pre-warmer lives inside the engine process: the', 'dim'));
    console.log(paint('  cache is module memory, and a separate process shares none of it.', 'dim'));
    console.log(paint('━'.repeat(74), 'gray'));
  }

  report.phases = {
    coldMs,
    prewarmPassMs: passMs,
    slowestGateMs: slowest,
    speedup: Number(speedup.toFixed(2)),
  };
  report.prewarmStats = stats;
  report.hits = hits;
  report.pass = pass;
  report.summary = summary;

  return report;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const wantsDiscover = args.discover !== undefined;
  const wantsWarm = args.warm !== undefined;

  if (!args.mint && !args.dbc && !wantsDiscover && !wantsWarm) {
    printHelp();
    process.exit(1);
  }

  // Pick up .env.Solana automatically so the key never has to be typed
  // on a command line. Precedence: --rpc flag > real env > env file > public.
  const envFile = loadProjectEnv();

  const rpc = args.rpc
    || process.env.SOLANA_RPC_URL
    || process.env.SOLANA_RPC
    || process.env.RPC_URL
    || 'https://api.mainnet-beta.solana.com';

  const usingPublic = rpc === 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpc, 'confirmed');

  const result: Record<string, unknown> = {
    tool: 'solguard',
    version: '0.1.0',
    rpc: redact(rpc),
    envFile: envFile ? path.basename(envFile) : null,
    usingPublicRpc: usingPublic,
    generatedAt: new Date().toISOString(),
  };

  if (usingPublic && !args.json) {
    console.log(paint('  ! public RPC — getTokenLargestAccounts will be rate limited', 'yellow'));
  }

  if (args.mint && !isValidPubkey(args.mint)) {
    console.error(`Invalid mint address: ${args.mint}`);
    process.exit(1);
  }
  if (args.dbc && !isValidPubkey(args.dbc)) {
    console.error(`Invalid DBC pool address: ${args.dbc}`);
    process.exit(1);
  }

  // `--warm` takes over: it is a measurement, not an audit. Returns early so
  // the normal gate path cannot run on top of a cache the test just shaped.
  if (wantsWarm) {
    const warmMints = (args.warm && args.warm.length > 0)
      ? args.warm
      : (args.mint ? [args.mint] : []);
    result.warm = await runWarmTest(connection, warmMints, args.json === true);
    if (args.json) {
      console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    }
    return;
  }

  if (wantsDiscover) {
    const pools = await discoverDbcPools(connection, {
      limit: args.discover,
      onlyActive: args.onlyActive,
    });
    result.discovered = pools;
    if (!args.json) printDiscover(pools, rpc);
  }

  if (args.mint) {
    const adapter = args.dex ? adapterForDex(args.dex) : null;
    const verdict = await evaluateTokenRisk({
      connection,
      mintAddress: args.mint,
      adapter,
      opts: {
        lpMint: args.lpMint,
        poolAddress: args.pool,
        skipLiquidity: args.skipLiquidity,
        cacheSeconds: args.cacheSeconds,
      },
    });
    result.verdict = verdict;
    if (!args.json) printVerdict(verdict);
  }

  if (args.dbc) {
    const assessment = await assessDbcPool(connection, args.dbc);
    result.dbc = assessment;
    if (!args.json) printDbc(assessment);
  }

  if (args.json) {
    console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    console.log(paint(`\n  wrote ${outPath}`, 'cyan'));
  }
}

main().catch((e) => {
  console.error(paint(`\nSolGuard failed: ${e?.message ?? e}`, 'red'));
  process.exit(2);
});
