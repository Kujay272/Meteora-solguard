// ═══════════════════════════════════════════════════════════════
//  SOLGUARD ↔ V5 ALPHA — integration helpers
// ═══════════════════════════════════════════════════════════════
//
//  This module lives INSIDE the V5 Alpha SOL Mainnet project, at
//  solguard/integrate.ts, and is imported by Cyborg_V5_Alpha_Solana.ts.
//
//  The gate is read-only: no wallet, no signing, no transaction is
//  ever built here. It answers one question — "is this token safe to
//  touch at all?" — and hands the answer back to the engine.

import { Connection, PublicKey } from '@solana/web3.js';
import { evaluateTokenRisk, describeVerdict, numeraireName, type RiskVerdict, type RiskOptions } from './checks';
import { adapterForDex } from './adapters';
import { assessDbcPool, type DbcAssessment } from './dbc';

// ── Result shape the engine consumes ───────────────────────────

export type GateOutcome = 'ALLOW' | 'BLOCK' | 'ALLOW_WITH_WARNINGS' | 'UNVERIFIED';

export interface SafetyGateResult {
  outcome: GateOutcome;
  verdict: RiskVerdict;
  summary: string;
  /** one line per failed check, in the same spirit as the engine's
   *  existing rejectionReason strings in opportunity_replay.jsonl */
  reasons: string[];
}

// ── Mint resolution ────────────────────────────────────────────
//
// The engine's ArbOpportunity carries pairLabel and buyDex/sellDex,
// but NOT a mint address. getPairMints() in the engine maps a pair
// label to mints, so we reuse that mapping rather than duplicating it.

export type PairMintResolver = (pairLabel: string) => { tokenMint: string; quoteMint: string } | null;

/**
 * Pick the risk-relevant mint for an opportunity.
 *
 * For 'SOL-USDC' the base token is SOL and the quote is USDC — both
 * blue-chip, so the gate is a formality. The gate earns its keep on
 * pairs like 'SOL-BONK', where the base token is a memecoin that can
 * genuinely be a honeypot.
 *
 * We evaluate the NON-stable mint. If both look stable we still run
 * the checks; they are cheap and cached.
 */
export function pickRiskMint(
  pairLabel: string,
  resolve: PairMintResolver,
): string | null {
  const mints = resolve(pairLabel);
  if (!mints) return null;

  // Was a local STABLES set duplicating the list in checks.ts. Prefer the
  // non-numeraire side, but only as a preference — resolveRiskTarget() below
  // refuses outright when BOTH sides are numeraires.
  if (numeraireName(mints.tokenMint) === null) return mints.tokenMint;
  if (numeraireName(mints.quoteMint) === null) return mints.quoteMint;
  return mints.tokenMint;
}

// ── Mint resolution, and the failure that used to be silent ────
//
// pickRiskMint() returns null when the pair label is not in the engine's map.
// The first version of the gate read that as `if (riskMint) { ... }` and simply
// fell through — so an unresolvable pair was traded with NO audit at all, and
// nothing in the log said so. The trade looked gated. It wasn't.
//
// That is worse than having no gate, because it reads as protection. A safety
// check that quietly declines to run is a lie told by omission.
//
// resolveRiskTarget() turns the null case into a first-class outcome with a
// reason attached, so the engine can log it loudly and apply policy openly.

// A third state, and it is NOT an error case.
//
// 'unresolved' means "we wanted to audit and could not" — a gap in the gate.
// 'not_applicable' means "there was never anything here to audit" — the gate
// is working correctly by declining. Collapsing the two would be a lie in
// whichever direction we chose: reporting a numeraire as an unaudited gap
// would cry wolf on SOL-USDC forever, and reporting it as 'resolved' would
// run checks whose subject is the quote asset itself.
//
// Auditing a numeraire is a category error. USDC/USDT/WSOL are what you buy
// WITH, not what you buy. There is no honeypot question to ask about them.
export type RiskTarget =
  | { status: 'resolved'; mint: string }
  | { status: 'unresolved'; pairLabel: string; reason: string }
  | { status: 'not_applicable'; pairLabel: string; mint: string; numeraire: string; reason: string };

export function resolveRiskTarget(
  pairLabel: string,
  resolve: PairMintResolver,
): RiskTarget {
  let mints: { tokenMint: string; quoteMint: string } | null = null;

  try {
    mints = resolve(pairLabel);
  } catch (e: any) {
    return { status: 'unresolved', pairLabel, reason: `mint resolver threw: ${e?.message ?? e}` };
  }

  if (!mints) {
    return {
      status: 'unresolved',
      pairLabel,
      reason: 'pair label has no mint mapping (not present in getPairMints)',
    };
  }

  const mint = pickRiskMint(pairLabel, () => mints);
  if (!mint) {
    return { status: 'unresolved', pairLabel, reason: `mapping for '${pairLabel}' produced no usable mint` };
  }

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return { status: 'unresolved', pairLabel, reason: `mapping produced a malformed mint '${mint}'` };
  }

  // The numeraire refusal. This is what stops SOL-USDC, SOL-USDT and
  // USDC-USDT from being audited against themselves — three of the ten
  // engine pairs, and three of the most liquid markets on Solana.
  //
  // `mint` here is what pickRiskMint() settled on, which for an all-numeraire
  // pair is the tokenMint fallback. Whatever it landed on, if it is a
  // numeraire there is no token-risk question to answer about this pair.
  const num = numeraireName(mint);
  if (num) {
    return {
      status: 'not_applicable',
      pairLabel,
      mint,
      numeraire: num,
      reason:
        `${num} is a numeraire — the asset this pair is quoted IN, not a token ` +
        `to assess. Both sides of '${pairLabel}' are quote assets, so there is ` +
        `no honeypot question to ask.`,
    };
  }

  return { status: 'resolved', mint };
}

/**
 * The line the engine logs when it cannot resolve a mint. Deliberately blunt:
 * it says out loud that no audit happened, so nobody later reads the absence of
 * a SolGuard rejection as a pass.
 */
export function unresolvedMintWarning(
  t: Extract<RiskTarget, { status: 'unresolved' }>,
): string {
  return (
    `⚠️ SolGuard DID NOT RUN for '${t.pairLabel}' — ${t.reason}. ` +
    `This opportunity was NOT safety-audited. Add the pair to getPairMints(), ` +
    `or set SOLGUARD_REQUIRE_RESOLVED_MINT=true to hold it instead.`
  );
}

/**
 * The line the engine logs for an all-numeraire pair.
 *
 * Uses an info glyph (⏭️), NOT the warning glyph (⚠️) that
 * unresolvedMintWarning() uses. The two are opposites and the log must not
 * blur them: 'unresolved' is a hole in the gate's coverage and deserves
 * attention every cycle; 'not_applicable' is the gate correctly declining to
 * answer a question that has no meaning. Warning noise on every SOL-USDC cycle
 * is how people learn to ignore warnings.
 */
export function numeraireSkipNote(
  t: Extract<RiskTarget, { status: 'not_applicable' }>,
): string {
  return (
    `⏭️ SolGuard N/A for '${t.pairLabel}' — ${t.reason} ` +
    `Allowed without audit; no gate coverage was skipped that should have run.`
  );
}

// ── Gate counters ──────────────────────────────────────────────
//
// In-process tallies. Without these the only evidence that the gate ran is a
// log line you have to scroll for, and "did it actually gate anything?" becomes
// a question of faith. The engine prints a summary periodically.

export interface GateCounters {
  calls: number;
  allow: number;
  allowWithWarnings: number;
  block: number;
  unverified: number;
  unresolved: number;
  /** Pairs skipped because they are all-numeraire. Tracked separately and
   *  deliberately NOT counted in `calls` — nothing was audited, so folding
   *  them into the call count would inflate the apparent coverage of the
   *  gate. A high number here is healthy, not a problem. */
  notApplicable: number;
  errors: number;
  totalMs: number;
  lastOutcome: GateOutcome | 'UNRESOLVED' | 'NOT_APPLICABLE' | null;
  lastMint: string | null;
}

const gateCounters: GateCounters = {
  calls: 0,
  allow: 0,
  allowWithWarnings: 0,
  block: 0,
  unverified: 0,
  unresolved: 0,
  notApplicable: 0,
  errors: 0,
  totalMs: 0,
  lastOutcome: null,
  lastMint: null,
};

export function noteGateOutcome(
  outcome: GateOutcome | 'UNRESOLVED',
  ms: number,
  mint?: string,
): void {
  gateCounters.calls++;
  gateCounters.totalMs += ms;
  gateCounters.lastOutcome = outcome;
  gateCounters.lastMint = mint ?? gateCounters.lastMint;

  if (outcome === 'ALLOW') gateCounters.allow++;
  else if (outcome === 'ALLOW_WITH_WARNINGS') gateCounters.allowWithWarnings++;
  else if (outcome === 'BLOCK') gateCounters.block++;
  else if (outcome === 'UNVERIFIED') gateCounters.unverified++;
  else if (outcome === 'UNRESOLVED') gateCounters.unresolved++;
}

/**
 * A numeraire pair passed by the gate because the gate does not apply to it.
 *
 * Separate from noteGateOutcome() on purpose: this must not increment `calls`,
 * because no audit occurred. `totalMs` is untouched for the same reason — an
 * N/A costs nothing and should not drag the average latency around.
 */
export function noteGateNotApplicable(mint?: string): void {
  gateCounters.notApplicable++;
  gateCounters.lastOutcome = 'NOT_APPLICABLE';
  gateCounters.lastMint = mint ?? gateCounters.lastMint;
}

export function noteGateError(): void {
  gateCounters.errors++;
  gateCounters.calls++;
}

export function readGateCounters(): GateCounters {
  return { ...gateCounters };
}

export function resetGateCounters(): void {
  gateCounters.calls = 0;
  gateCounters.allow = 0;
  gateCounters.allowWithWarnings = 0;
  gateCounters.block = 0;
  gateCounters.unverified = 0;
  gateCounters.unresolved = 0;
  gateCounters.notApplicable = 0;
  gateCounters.errors = 0;
  gateCounters.totalMs = 0;
  gateCounters.lastOutcome = null;
  gateCounters.lastMint = null;
}

export function gateCountersSummary(): string {
  const c = readGateCounters();
  // Both zero — not just calls. A run that only ever saw numeraire pairs has
  // plenty to report, and "no gate calls yet" would be the wrong story.
  if (c.calls === 0 && c.notApplicable === 0) return '🛡️ SolGuard: no gate calls yet.';

  const nA = c.notApplicable > 0 ? `${c.notApplicable} numeraire N/A, ` : '';
  const avg = c.calls === 0 ? 0 : Math.round(c.totalMs / Math.max(1, c.calls));
  return (
    `🛡️ SolGuard gate: ${c.calls} call(s) — ` +
    `${c.allow} allow, ${c.allowWithWarnings} warn, ${c.block} block, ` +
    `${c.unverified} unverified, ${c.unresolved} unresolved (NOT audited), ` +
    `${nA}${c.errors} error(s). Avg ${avg}ms.`
  );
}

// ── The gate ───────────────────────────────────────────────────

export interface GateArgs {
  connection: Connection;
  mintAddress: string;
  /** 'Raydium' | 'Orca' | 'Meteora DBC' | ... — straight from the engine */
  dexLabel?: string;
  poolAddress?: string;
  opts?: RiskOptions;
  /**
   * Optional: run the DBC assessment too, when the pool is a DBC pool.
   * Kept separate from the generic checks because the questions differ.
   */
  dbcPoolAddress?: string;
}

/**
 * Run the safety gate. Read-only: no wallet, no signing, no tx.
 *
 * Returns ALLOW only when no blocking check failed. Warnings do NOT
 * block — they surface on the veto card so a human decides.
 */
export async function runSafetyGate(args: GateArgs): Promise<SafetyGateResult> {
  const { connection, mintAddress, dexLabel, poolAddress, opts, dbcPoolAddress } = args;
  const t0 = Date.now();

  const adapter = dexLabel ? adapterForDex(dexLabel) : null;

  const verdict = await evaluateTokenRisk({
    connection,
    mintAddress,
    adapter,
    opts: { ...(opts ?? {}), poolAddress: poolAddress ?? opts?.poolAddress },
  });

  const reasons = [
    ...verdict.blocked.map(c => `${c.name}: ${c.detail}`),
    ...verdict.warned.map(c => `WARN ${c.name}: ${c.detail}`),
    ...verdict.unverified.map(c => `UNVERIFIED ${c.name}: ${c.detail}`),
  ];

  let dbc: DbcAssessment | null = null;
  if (dbcPoolAddress) {
    dbc = await assessDbcPool(connection, dbcPoolAddress);
    for (const c of dbc.checks) {
      if (!c.passed) reasons.push(`DBC ${c.name}: ${c.detail}`);
    }
  }

  const dbcBlocks = dbc ? dbc.checks.some(c => !c.passed && c.severity === 'block') : false;

  // Map the verdict's decision straight through. UNVERIFIED is its own
  // outcome, not a block: the engine holds the opportunity for review
  // instead of killing it on the strength of an RPC failure.
  const outcome: GateOutcome = (dbcBlocks || verdict.decision === 'BLOCK')
    ? 'BLOCK'
    : verdict.decision === 'UNVERIFIED' ? 'UNVERIFIED'
    : (verdict.warned.length > 0 ? 'ALLOW_WITH_WARNINGS' : 'ALLOW');

  const summary = [
    describeVerdict(verdict),
    dbc ? ` | ${dbc.available ? 'DBC assessed' : 'DBC unverified'}` : '',
  ].join('');

  noteGateOutcome(outcome, Date.now() - t0, mintAddress);

  return { outcome, verdict, summary, reasons };
}

/**
 * Shape a gate result for the engine's existing replay log.
 * opportunity_replay.jsonl already stores `executionDecision` and
 * `rejectionReason`, so SolGuard rejections land in the same file and
 * the existing replay tooling reads them with zero changes.
 */
export function toReplayFields(r: SafetyGateResult): {
  executionDecision: 'EXECUTED' | 'REJECTED';
  rejectionReason?: string;
} {
  if (r.outcome === 'BLOCK') {
    return {
      executionDecision: 'REJECTED',
      rejectionReason: `SOLGUARD BLOCK — ${r.verdict.blocked.map(c => `${c.name}: ${c.detail}`).join(' | ')}`,
    };
  }
  if (r.outcome === 'UNVERIFIED') {
    // Held, not accused. The engine does not trade a token it could not
    // read, but the log says plainly this was an RPC failure, not a finding.
    return {
      executionDecision: 'REJECTED',
      rejectionReason: `SOLGUARD UNVERIFIED (not a block) — ${r.verdict.unverified.map(c => c.name).join(', ')}. Re-run against a dedicated RPC.`,
    };
  }
  return { executionDecision: 'EXECUTED' };
}

/** One-line log message in the engine's emoji style. */
export function gateLogLine(r: SafetyGateResult): string {
  if (r.outcome === 'BLOCK') return `⛔ SolGuard BLOCKED — ${r.verdict.blocked.map(c => c.name).join(', ')}`;
  if (r.outcome === 'UNVERIFIED') return `⚠️ SolGuard INCONCLUSIVE — ${r.verdict.unverified.length} check(s) unreadable, held for review (confidence ${(r.verdict.confidence * 100).toFixed(0)}%)`;
  if (r.outcome === 'ALLOW_WITH_WARNINGS') return `🛡️ SolGuard passed with warnings — ${r.verdict.warned.map(c => c.name).join(', ')}`;
  return `🛡️ SolGuard CLEAR (score ${r.verdict.riskScore}/100)`;
}
