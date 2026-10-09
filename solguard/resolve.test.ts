// ═══════════════════════════════════════════════════════════════
//  SOLGUARD — numeraire refusal regression test
// ═══════════════════════════════════════════════════════════════
//
//  Run:  npm run solguard:test
//
//  WHY A TRANSCRIPTION AND NOT AN IMPORT
//  getPairMints() lives in Cyborg_V5_Alpha_Solana.ts, is not exported, and
//  the engine has NO main-guard (no require.main / import.meta.url check).
//  Importing the engine therefore EXECUTES the trading bot as a side effect
//  of loading a test. So the mapping is transcribed below, verbatim, from
//  Cyborg_V5_Alpha_Solana.ts L1272-1301.
//
//  ⚠️ DRIFT HAZARD — this fixture is a copy and copies rot. If you add a pair
//     to getPairMints(), add it here too, or this test silently passes while
//     the engine disagrees with itself.
//
//  WHAT IT PROVES
//  1. The three all-numeraire pairs are refused as 'not_applicable', so they
//     are no longer audited against themselves and no longer BLOCK.
//  2. The seven real pairs still resolve to their memecoin and are still
//     audited — the fix must not have quietly disabled the gate.
//  3. A genuinely unmappable pair is still 'unresolved' — a real gap, and it
//     must stay distinguishable from 'not_applicable'.
//  4. noteGateNotApplicable() does not inflate the audit call count.

import {
  resolveRiskTarget,
  noteGateNotApplicable,
  resetGateCounters,
  readGateCounters,
} from './integrate';

// ── Fixture: transcribed from Cyborg_V5_Alpha_Solana.ts L1272-1301 ──

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const SOL_PAIRS: Record<string, string> = {
  'SOL-USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'SOL-USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'SOL-BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'BOME-SOL': 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
  'MEW-SOL': 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
  'WIF-SOL': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'JUP-SOL': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};

const USDC_PAIRS: Record<string, string> = {
  'JUP-USDC': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'POPCAT-USDC': '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  'USDC-USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

function getPairMintsFixture(pairLabel: string): { tokenMint: string; quoteMint: string } | null {
  if (SOL_PAIRS[pairLabel]) {
    return { tokenMint: SOL_PAIRS[pairLabel], quoteMint: WSOL };
  }
  if (USDC_PAIRS[pairLabel]) {
    return { tokenMint: USDC_PAIRS[pairLabel], quoteMint: USDC };
  }
  return null;
}

// ── Expected outcomes ─────────────────────────────────────────

const EXPECT_NA: Array<[string, string]> = [
  ['SOL-USDC', 'USDC'],
  ['SOL-USDT', 'USDT'],
  ['USDC-USDT', 'USDT'], // tokenMint fallback: both sides are numeraires
];

const EXPECT_RESOLVED: Array<[string, string]> = [
  ['SOL-BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
  ['BOME-SOL', 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'],
  ['MEW-SOL', 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5'],
  ['WIF-SOL', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'],
  ['JUP-SOL', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['JUP-USDC', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['POPCAT-USDC', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'],
];

let failures = 0;
let checks = 0;

function ok(label: string, detail: string): void {
  checks++;
  console.log(`  ✅ ${label} — ${detail}`);
}

function bad(label: string, detail: string): void {
  checks++;
  failures++;
  console.log(`  ❌ ${label} — ${detail}`);
}

console.log('\n═══ SolGuard numeraire refusal ═══\n');

// 1. All-numeraire pairs must be refused, and named correctly.
console.log('— all-numeraire pairs (expect not_applicable)');
for (const [pair, expectedNum] of EXPECT_NA) {
  const t = resolveRiskTarget(pair, getPairMintsFixture);
  if (t.status !== 'not_applicable') {
    bad(pair, `expected not_applicable, got '${t.status}' — this pair WOULD be audited against itself`);
  } else if (t.numeraire !== expectedNum) {
    bad(pair, `expected numeraire ${expectedNum}, got ${t.numeraire}`);
  } else {
    ok(pair, `not_applicable (numeraire ${t.numeraire}) — allowed without audit`);
  }
}

// 2. Real pairs must still resolve, so the gate is not silently disabled.
console.log('\n— real token pairs (expect resolved, still audited)');
for (const [pair, expectedMint] of EXPECT_RESOLVED) {
  const t = resolveRiskTarget(pair, getPairMintsFixture);
  if (t.status !== 'resolved') {
    bad(pair, `expected resolved, got '${t.status}' — the gate was disabled for a real token`);
  } else if (t.mint !== expectedMint) {
    bad(pair, `expected mint ${expectedMint}, got ${t.mint}`);
  } else {
    ok(pair, `resolved → ${t.mint.slice(0, 6)}… (audited)`);
  }
}

// 3. A genuine gap must stay a gap, not become N/A.
console.log('\n— unmapped pair (expect unresolved, NOT not_applicable)');
{
  const t = resolveRiskTarget('DOGE-SOL', getPairMintsFixture);
  if (t.status !== 'unresolved') {
    bad('DOGE-SOL', `expected unresolved, got '${t.status}' — a coverage gap is being reported as harmless N/A`);
  } else {
    ok('DOGE-SOL', `unresolved — "${t.reason.slice(0, 48)}…"`);
  }
}

// 4. N/A must not inflate the audit call count.
console.log('\n— coverage accounting');
{
  resetGateCounters();
  noteGateNotApplicable(USDC);
  noteGateNotApplicable(USDT);
  const c = readGateCounters();
  if (c.calls !== 0) {
    bad('calls', `expected 0 audit calls after 2 N/A, got ${c.calls} — gate coverage is overstated`);
  } else if (c.notApplicable !== 2) {
    bad('notApplicable', `expected 2, got ${c.notApplicable}`);
  } else {
    ok('coverage', `2 numeraire N/A recorded, 0 audit calls claimed`);
  }
  resetGateCounters();
}

// ── Summary ───────────────────────────────────────────────────

const totalPairs = EXPECT_NA.length + EXPECT_RESOLVED.length + 1;
console.log(`\n═══ ${checks} assertion(s) across ${totalPairs} pairs ═══`);
if (failures === 0) {
  console.log('PASS — numeraire refusal correct, real pairs still audited.\n');
  process.exit(0);
} else {
  console.log(`FAIL — ${failures} assertion(s) failed.\n`);
  process.exit(1);
}
