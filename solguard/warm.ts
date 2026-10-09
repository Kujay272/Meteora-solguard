// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — pre-warmer
// ═══════════════════════════════════════════════════════════════
//
//  WHY THIS EXISTS
//  ---------------
//  A cold audit costs ~2.2s of RPC round-trips (five checks, four of them
//  network). An arbitrage window is measured in hundreds of milliseconds.
//  Paying 2.2s inside executeArb() means the safety verdict arrives after the
//  opportunity is already dead — the gate is correct and useless at once.
//
//  The fix is not to make the gate faster. It is to make sure the gate is
//  never cold. This walks the engine's own candidate universe on a background
//  timer and audits each mint BEFORE it is needed, so the lookup that actually
//  matters is a Map hit.
//
//  TWO HARD RULES, both learned the expensive way
//  ----------------------------------------------
//   1. IT RUNS INSIDE THE ENGINE PROCESS.
//      checks.ts caches to a module-level Map — per-process memory. A
//      pre-warmer in the dashboard, a cron job or another shell warms exactly
//      nothing the engine can see. This module is therefore wired into
//      Cyborg_V5_Alpha_Solana.ts, not into a sidecar.
//
//   2. IT IS STRICTLY SERIAL, GAPPED, AND SKIPS FRESH ENTRIES.
//      A pre-warmer that fans out in parallel is a self-inflicted 429
//      generator. Every 429 it causes becomes an UNVERIFIED check, and every
//      UNVERIFIED holds a trade. The cure must not become the disease.
//
//  READ-ONLY. Never signs, never sends, never builds a transaction. It only
//  reads and populates a cache.

import type { Connection } from '@solana/web3.js';
import { refreshTokenRisk, isRiskFresh, peekRiskAge } from './checks';
import { adapterForDex } from './adapters';
import type { PairMintResolver } from './integrate';
import { pickRiskMint } from './integrate';

// ── Types ──────────────────────────────────────────────────────

interface WarmTarget {
  mint: string;
  dexLabel?: string;
}

export interface PrewarmerOptions {
  connection: Connection;
  /** how often a background pass runs. default 30000ms */
  intervalMs?: number;
  /** pause between individual mints, so we never burst. default 250ms */
  gapMs?: number;
  /** cap on mints per pass, so one pass cannot run forever. default 24 */
  maxPerPass?: number;
  /**
   * Cache TTL handed to the audit. Must match what the gate uses, or the
   * pre-warmer will consider things fresh that the gate considers stale.
   * default 60
   */
  cacheSeconds?: number;
  /**
   * Skip a mint whose cached verdict is younger than this. default is half
   * the TTL — no point re-reading something the gate will serve from cache.
   */
  skipIfYoungerThanSeconds?: number;
  /** abandon a single audit after this long. default 12000ms */
  timeoutMs?: number;
  /** optional logger; defaults to silence so library use stays quiet */
  log?: (line: string) => void;
}

export interface PrewarmStats {
  passes: number;
  warmed: number;
  skippedFresh: number;
  timedOut: number;
  failed: number;
  blocked: number;
  unverified: number;
  staleServed: number;
  lastPassAt: number | null;
  lastPassMs: number | null;
  lastError: string | null;
  lastWarmed: string[];
  queue: number;
  running: boolean;
}

const MINTSHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Bounded wait. A hung RPC must not be able to wedge the warm pass — the
 * outer pass would stall, the queue would grow, and the cache would go cold
 * exactly when it was needed. Note that the underlying request is NOT
 * cancelled; single-flight in checks.ts means a late completion still lands
 * in the cache, which is fine.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

// ── The pre-warmer ─────────────────────────────────────────────

export class Prewarmer {
  private readonly connection: Connection;
  private readonly intervalMs: number;
  private readonly gapMs: number;
  private readonly maxPerPass: number;
  private readonly cacheSeconds: number;
  private readonly skipIfYoungerThan: number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  /** mint → target. A Map, so re-queueing the same mint is free and idempotent. */
  private readonly queue = new Map<string, WarmTarget>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private passRunning = false;
  private stopped = true;

  private stats: PrewarmStats = {
    passes: 0,
    warmed: 0,
    skippedFresh: 0,
    timedOut: 0,
    failed: 0,
    blocked: 0,
    unverified: 0,
    staleServed: 0,
    lastPassAt: null,
    lastPassMs: null,
    lastError: null,
    lastWarmed: [],
    queue: 0,
    running: false,
  };

  constructor(opts: PrewarmerOptions) {
    this.connection = opts.connection;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.gapMs = opts.gapMs ?? 250;
    this.maxPerPass = opts.maxPerPass ?? 24;
    this.cacheSeconds = opts.cacheSeconds ?? 60;
    this.skipIfYoungerThan = opts.skipIfYoungerThanSeconds
      ?? Math.max(10, Math.floor(this.cacheSeconds * 0.5));
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.log = opts.log ?? (() => { /* quiet by default */ });
  }

  // ── Queueing ─────────────────────────────────────────────────

  /**
   * Queue raw mints. Invalid or missing values are ignored rather than
   * throwing — a malformed mint from the engine must not kill a scan cycle.
   * Returns how many were newly added.
   */
  queueMints(mints: (string | null | undefined)[], dexLabel?: string): number {
    let added = 0;
    for (const m of mints) {
      if (!m || typeof m !== 'string') continue;
      if (!MINTSHAPE.test(m)) continue;
      if (this.queue.has(m)) continue;
      this.queue.set(m, { mint: m, dexLabel });
      added++;
    }
    return added;
  }

  /**
   * Resolve engine pair labels through the same mapping the gate uses, and
   * queue the resulting mints. Labels that do not resolve are skipped here —
   * the gate reports those loudly on its own, and a pre-warmer has no business
   * doing policy.
   */
  queuePairs(pairLabels: string[], resolve: PairMintResolver, dexLabel?: string): number {
    const mints: string[] = [];
    for (const label of pairLabels) {
      const mint = pickRiskMint(label, resolve);
      if (mint) mints.push(mint);
    }
    return this.queueMints(mints, dexLabel);
  }

  queueSize(): number {
    return this.queue.size;
  }

  clearQueue(): void {
    this.queue.clear();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.runPass(); }, this.intervalMs);
    // Don't let the warm timer alone hold the process open.
    if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
    // Run one pass immediately: the whole point is that the cache is hot
    // before the first gate call, not 30s after it.
    void this.runPass();
    this.log(`[prewarm] started — pass every ${this.intervalMs}ms, gap ${this.gapMs}ms, max ${this.maxPerPass}/pass`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.log('[prewarm] stopped');
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  /**
   * Is a pass executing RIGHT NOW? Deliberately distinct from isRunning():
   * the timer can be armed with no pass in flight. The engine asks this before
   * kicking a drain, so a queue that fills mid-pass does not emit a skip log
   * on every scan cycle.
   */
  isPassRunning(): boolean {
    return this.passRunning;
  }

  statsSnapshot(): PrewarmStats {
    return {
      ...this.stats,
      lastWarmed: [...this.stats.lastWarmed],
      queue: this.queue.size,
      running: !this.stopped,
    };
  }

  // ── The pass ─────────────────────────────────────────────────

  /**
   * One serial pass over the queue. Never throws. Returns a snapshot.
   *
   * Overlap is refused: if a pass is still running when the timer fires again,
   * the tick is skipped. Two concurrent passes would defeat the gap and put us
   * straight back into 429 territory.
   */
  async runPass(): Promise<PrewarmStats> {
    if (this.passRunning) {
      this.log('[prewarm] previous pass still running — skipping this tick');
      return this.statsSnapshot();
    }
    this.passRunning = true;
    const startedAt = Date.now();
    this.stats.passes++;

    const targets: WarmTarget[] = [];
    for (const t of this.queue.values()) {
      if (targets.length >= this.maxPerPass) break;
      targets.push(t);
    }

    const warmed: string[] = [];

    try {
      for (const t of targets) {
        this.queue.delete(t.mint);

        // Someone (the gate itself, or a previous pass) already did this work.
        if (isRiskFresh(t.mint, this.skipIfYoungerThan)) {
          this.stats.skippedFresh++;
          continue;
        }

        try {
          const verdict = await withTimeout(
            refreshTokenRisk({
              connection: this.connection,
              mintAddress: t.mint,
              adapter: t.dexLabel ? adapterForDex(t.dexLabel) : null,
              opts: { cacheSeconds: this.cacheSeconds },
            }),
            this.timeoutMs,
            `prewarm ${t.mint.slice(0, 6)}`,
          );

          warmed.push(t.mint);
          this.stats.warmed++;
          if (verdict.decision === 'BLOCK') this.stats.blocked++;
          else if (verdict.decision === 'UNVERIFIED') this.stats.unverified++;
          this.stats.lastError = null;

          this.log(
            `[prewarm] ${t.mint.slice(0, 6)}… ${verdict.decision}` +
            `${verdict.riskScore === null ? '' : ` score ${verdict.riskScore}`}` +
            ` (${verdict.checks.filter(c => c.status === 'pass').length} pass, ` +
            `${verdict.checks.filter(c => c.status === 'skip').length} skip, ` +
            `${verdict.unverified.length} unverified)`,
          );
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (/timed out/i.test(msg)) this.stats.timedOut++;
          else this.stats.failed++;
          this.stats.lastError = msg;
          // A failed warm is not fatal and must not poison anything — the
          // short RETRY_TTL in checks.ts means the next pass tries again.
          this.log(`[prewarm] ${t.mint.slice(0, 6)}… FAILED: ${msg}`);
        }

        // The gap is the whole anti-429 mechanism. Keep it, and keep it here.
        if (this.gapMs > 0 && this.queue.size > 0) await sleep(this.gapMs);
      }
    } finally {
      this.stats.lastPassAt = Date.now();
      this.stats.lastPassMs = Date.now() - startedAt;
      this.stats.lastWarmed = warmed;
      this.passRunning = false;
    }

    return this.statsSnapshot();
  }

  /**
   * Warm a specific set of mints right now, ignoring the queue, and wait for
   * it. For boot-time seeding and for tests. Still serial and still gapped.
   */
  async warmNow(mints: string[], dexLabel?: string): Promise<PrewarmStats> {
    this.queueMints(mints, dexLabel);
    return this.runPass();
  }
}

// ── One-shot helper ────────────────────────────────────────────

/**
 * Convenience for scripts and tests: warm a list of mints once and report.
 * Creates a throwaway Prewarmer so no timer is left behind.
 */
export async function prewarmOnce(
  connection: Connection,
  mints: string[],
  opts: Omit<PrewarmerOptions, 'connection'> = {},
): Promise<PrewarmStats> {
  const p = new Prewarmer({ connection, ...opts });
  p.queueMints(mints);
  return p.runPass();
}

/** Human-readable age of a cached verdict, for logs and the UI. */
export function describeWarmth(mint: string): string {
  const age = peekRiskAge(mint);
  if (age === null) return 'cold';
  return `warm (${Math.round(age)}s old)`;
}
