// ═══════════════════════════════════════════════════════════════
//  CYBORG V5 ALPHA — SOLANA EDITION 🔥
//  Raydium + Orca + Binance + Kraken Arbitrage Bot
//  Ported from Ethereum by Nxvana for Leon
// ═══════════════════════════════════════════════════════════════

import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
// spl-token imports added when swap execution is built
import { Decimal } from 'decimal.js';
import TelegramBot from 'node-telegram-bot-api';
import winston from 'winston';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { executeArbViaJito, getTipAccount, simulateJitoBundle, sendJitoBundle } from './jito_bundle';
import {
  runSafetyGate,
  gateLogLine,
  resolveRiskTarget,
  unresolvedMintWarning,
  numeraireSkipNote,
  gateCountersSummary,
  noteGateError,
  noteGateNotApplicable,
} from './solguard/integrate';
import { Prewarmer, describeWarmth } from './solguard/warm';

dotenv.config({ path: '.env.Solana' });

const STATE_FILE = 'paper_state.json';
const STATE_SAVE_INTERVAL = 10; // auto-save every N scan cycles

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

interface TokenConfig {
  name: string;
  mint: string;
  decimals: number;
}

interface PoolConfig {
  name: string;                // 'Raydium' | 'Orca'
  pairLabel: string;           // e.g. 'SOL-USDC'
  poolAddress: string;
  tokenAMint: string;
  tokenBMint: string;
  feeBps: number;              // e.g. 25 = 0.25%
}

interface PoolPrice {
  dex: string;
  pairLabel: string;
  price: Decimal;              // tokenB per tokenA (e.g. USDC per SOL)
  reserveA: Decimal;
  reserveB: Decimal;
  timestamp: number;
  quoteTimestamp: number;     // when this price was fetched (Phase 2)
}

interface ArbOpportunity {
  buyDex: string;
  sellDex: string;
  pairLabel: string;
  buyPrice: Decimal;
  sellPrice: Decimal;
  spreadBps: number;
  estimatedProfitBps: number;  // after fees
  tradeSizeSol: number;
  // Pool reserves for liquidity-aware execution
  buyReserveA: Decimal;
  buyReserveB: Decimal;
  sellReserveA: Decimal;
  sellReserveB: Decimal;
}

interface Position {
  holding: boolean;
  entryPrice: number;
  entrySol: number;
}

interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PriceHistory {
  [tokenName: string]: number[];
}

interface OHLCHistory {
  [tokenName: string]: OHLC[];
}

interface SignalState {
  lastSignal: 'BUY' | 'SELL' | 'HOLD';
  lastSignalCycle: number;
  consecutiveSame: number;
}

interface ExchangePrice {
  exchange: string;            // 'Binance' | 'Kraken'
  pairLabel: string;
  bidPrice: Decimal;           // sell into this (CEX bid)
  askPrice: Decimal;           // buy from this (CEX ask)
  lastPrice: Decimal;          // for spread reference
  timestamp: number;
}

interface JupiterQuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: { amount: string; feeBps: number } | null;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

interface ExecutionCostBreakdown {
  grossProfitSol: number;
  dexFeesSol: number;
  flashLoanFeeSol: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  networkFeeSol: number;
  slippageEstimateSol: number;
  safetyBufferSol: number;
  expectedNetProfitSol: number;
  executeDecision: 'YES' | 'NO';
}

// ═══════════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════════

const logLevel = process.env.LOG_LEVEL || 'info';
const logFile = process.env.LOG_FILE || 'cyborg_solana_trades.log';
const logErrorFile = logFile.replace('.log', '_errors.log');

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: logFile }),
    new winston.transports.File({ filename: logErrorFile, level: 'error' })
  ]
});

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // RPC
  rpcUrl: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',

  // Wallet
  privateKey: process.env.SOLANA_PRIVATE_KEY || '',

  // Trading
  solSpend: parseFloat(process.env.SOL_SPEND || '0.01'),            // maximum trade size cap
  compoundPct: parseFloat(process.env.COMPOUND_PCT || '1'),         // % of balance per trade (1 = 1%)
  minTradeSizeSol: parseFloat(process.env.MIN_TRADE_SIZE_SOL || '0.001'), // floor to prevent dust
  minSolBuffer: parseFloat(process.env.MIN_SOL_BUFFER || '0.005'),
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL || '15000', 10),
  slippageBps: parseInt(process.env.SLIPPAGE_BPS || '2', 10),      // 0.02% — realistic for 0.01 SOL trades

  // Arb thresholds
  minSpreadBps: parseInt(process.env.MIN_SPREAD_BPS || '20', 10),   // 0.2% minimum spread (was 0.8%)
  minProfitBps: parseInt(process.env.MIN_PROFIT_BPS || '1', 10),    // 0.01% minimum profit after fees

  // Strategy
  strategyMode: (process.env.STRATEGY_MODE || 'hybrid') as 'arbitrage' | 'trend' | 'hybrid',
  cexScanEnabled: (process.env.CEX_SCAN_ENABLED || 'true').toLowerCase() === 'true',
  cexMinSpreadBps: parseInt(process.env.CEX_MIN_SPREAD_BPS || process.env.MIN_SPREAD_BPS || '20', 10),
  bbWindow: parseInt(process.env.BB_WINDOW || '20', 10),
  bbK: parseFloat(process.env.BB_K || '2'),
  rsiPeriod: parseInt(process.env.RSI_PERIOD || '14', 10),
  rsiOverbought: parseFloat(process.env.RSI_OVERBOUGHT || '70'),
  rsiOversold: parseFloat(process.env.RSI_OVERSOLD || '30'),
  priceHistorySize: parseInt(process.env.PRICE_HISTORY_SIZE || '100', 10),
  statusPingInterval: parseInt(process.env.STATUS_PING_INTERVAL || '10', 10), // balance ping every N cycles

  // ═══ TA Strategy (ported from Morpheus Binary) ═══
  taStrategy: (process.env.TA_STRATEGY || 'RSI_BB').toUpperCase(), // RSI_BB | RSI_SMA | DEM_BB | ALLIGATOR | DEM_MOM | ABYSSAL_TRI | ECHO_BLADE
  // Signal cooldown
  taSignalCooldownCycles: parseInt(process.env.TA_SIGNAL_COOLDOWN_CYCLES || '3', 10),
  taSignalMaxConsecutive: parseInt(process.env.TA_SIGNAL_MAX_CONSECUTIVE || '3', 10),
  // RSI
  taRsiPeriod: parseInt(process.env.TA_RSI_PERIOD || '7', 10),
  taRsiOb: parseFloat(process.env.TA_RSI_OB || '75'),
  taRsiOs: parseFloat(process.env.TA_RSI_OS || '25'),
  // SMA
  taSmaFast: parseInt(process.env.TA_SMA_FAST || '5', 10),
  taSmaSlow: parseInt(process.env.TA_SMA_SLOW || '14', 10),
  // BB
  taBbPeriod: parseInt(process.env.TA_BB_PERIOD || '20', 10),
  taBbStdDev: parseFloat(process.env.TA_BB_STDDEV || '2'),
  // DeMarker
  taDemPeriod: parseInt(process.env.TA_DEM_PERIOD || '14', 10),
  taDemOb: parseFloat(process.env.TA_DEM_OB || '0.7'),
  taDemOs: parseFloat(process.env.TA_DEM_OS || '0.3'),
  // Alligator
  taAllJawPeriod: parseInt(process.env.TA_ALL_JAW_PERIOD || '15', 10),
  taAllTeethPeriod: parseInt(process.env.TA_ALL_TEETH_PERIOD || '7', 10),
  taAllLipsPeriod: parseInt(process.env.TA_ALL_LIPS_PERIOD || '10', 10),
  taAllJawShift: parseInt(process.env.TA_ALL_JAW_SHIFT || '6', 10),
  taAllTeethShift: parseInt(process.env.TA_ALL_TEETH_SHIFT || '5', 10),
  taAllLipsShift: parseInt(process.env.TA_ALL_LIPS_SHIFT || '4', 10),
  taAllTolerance: parseFloat(process.env.TA_ALL_TOLERANCE || '0.0'),
  // Momentum
  taMomPeriod: parseInt(process.env.TA_MOM_PERIOD || '12', 10),
  taMomThreshold: parseFloat(process.env.TA_MOM_THRESHOLD || '0.001'),
  taMomNormalize: process.env.TA_MOM_NORMALIZE === 'true',
  // Abyssal Tri
  taTriStrict: process.env.TA_TRI_STRICT !== 'false', // default true
  // ECHO_BLADE (Stochastic + ZigZag + EMA)
  taStochK: parseInt(process.env.TA_STOCH_K || '14', 10),
  taStochD: parseInt(process.env.TA_STOCH_D || '3', 10),
  taStochSmooth: parseInt(process.env.TA_STOCH_SMOOTH || '3', 10),
  taStochOb: parseFloat(process.env.TA_STOCH_OB || '80'),
  taStochOs: parseFloat(process.env.TA_STOCH_OS || '20'),
  taZigDepth: parseInt(process.env.TA_ZIG_DEPTH || '3', 10),
  taZigLookback: parseInt(process.env.TA_ZIG_LOOKBACK || '30', 10),
  taEmaLength: parseInt(process.env.TA_EMA_LENGTH || '0', 10), // 0 = disabled
  taOhlcCandles: parseInt(process.env.TA_OHLC_CANDLES || '50', 10),

  // Risk
  stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '5'),
  takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '10'),
  maxPositionSizeSol: parseFloat(process.env.MAX_POSITION_SIZE_SOL || '1.0'),
  dailyLossLimitSol: parseFloat(process.env.DAILY_LOSS_LIMIT_SOL || '0.5'),
  cooldownAfterTradeMs: parseInt(process.env.COOLDOWN_AFTER_TRADE_MS || '10000', 10),

  // Circuit Breaker
  circuitBreakerMaxFailures: parseInt(process.env.CIRCUIT_BREAKER_MAX_FAILURES || '3', 10),
  circuitBreakerWindowSize: parseInt(process.env.CIRCUIT_BREAKER_WINDOW_SIZE || '10', 10),

  // Dynamic Slippage
  dynamicSlippageEnabled: (process.env.DYNAMIC_SLIPPAGE_ENABLED || 'true').trim().toLowerCase() === 'true',
  dynamicSlippageMinBps: parseInt(process.env.DYNAMIC_SLIPPAGE_MIN_BPS || '1', 10),
  dynamicSlippageMaxBps: parseInt(process.env.DYNAMIC_SLIPPAGE_MAX_BPS || '10', 10),

  // Paper Trading
  paperTrading: (process.env.PAPER_TRADING || '').trim().toLowerCase() === 'true',
  paperInitialSol: parseFloat((process.env.PAPER_INITIAL_SOL || '10.0').trim()),

  // Flash Loan Simulation
  flashLoanEnabled: (process.env.FLASH_LOAN_ENABLED || '').trim().toLowerCase() === 'true',
  flashLoanAmountSol: parseFloat((process.env.FLASH_LOAN_AMOUNT_SOL || '1000').trim()),
  flashLoanFeeBps: parseFloat((process.env.FLASH_LOAN_FEE_BPS || '9').trim()),
  flashLoanMaxBorrowPct: parseFloat((process.env.FLASH_LOAN_MAX_BORROW_PCT || '2').trim()),

  // Jupiter Quote API — exact on-chain pricing
  jupiterQuoteEnabled: (process.env.JUPITER_QUOTE_ENABLED || 'false').trim().toLowerCase() === 'true',
  jupiterQuoteAmountSol: parseFloat((process.env.JUPITER_QUOTE_AMOUNT_SOL || '0.01').trim()),

  // SolGuard — Tier 0 read-only token safety gate. Never signs, never sends.
  // On by default: the gate is the safety net, so absence must not disable it.
  solguardEnabled: (process.env.SOLGUARD_ENABLED || 'true').trim().toLowerCase() === 'true',
  // A check that could not be READ (RPC 429 / timeout) is not a finding about
  // the token. Default holds the trade. Set true only if you knowingly accept
  // unverified risk on a rate-limited public endpoint.
  solguardAllowUnverified: (process.env.SOLGUARD_ALLOW_UNVERIFIED || 'false').trim().toLowerCase() === 'true',
  // If a pair has no mint mapping there is nothing to audit. Default is to log
  // that loudly and keep trading — the opportunity is UNAUDITED, which is not
  // the same as proven bad. Set true for the strictest possible posture.
  solguardRequireResolvedMint: (process.env.SOLGUARD_REQUIRE_RESOLVED_MINT || 'false').trim().toLowerCase() === 'true',
  // Pre-warm the audit cache in the background so the gate is never cold in the
  // hot path. A cold audit is ~2.2s; an arb window is ~hundreds of ms.
  solguardPrewarm: (process.env.SOLGUARD_PREWARM || 'true').trim().toLowerCase() === 'true',
  solguardPrewarmIntervalMs: parseInt((process.env.SOLGUARD_PREWARM_INTERVAL_MS || '30000').trim(), 10),
  solguardSummaryEveryCycles: parseInt((process.env.SOLGUARD_SUMMARY_EVERY_CYCLES || '20').trim(), 10),

  // Jito Bundles — Atomic Execution Engine
  jitoEnabled: (process.env.JITO_ENABLED || 'false').trim().toLowerCase() === 'true',
  jitoBlockEngineUrl: (process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf').trim(),
  jitoTipLamports: parseInt((process.env.JITO_TIP_LAMPORTS || '10000').trim(), 10),
  jitoTipAccount: (process.env.JITO_TIP_ACCOUNT || '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZ8N4mTGqkaHftq').trim(),

  // Devnet — live pipeline testing without real SOL
  devnetMode: (process.env.DEVNET_MODE || 'false').trim().toLowerCase() === 'true',
  devnetRpcUrl: (process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com').trim(),

  // Tx fee estimation — deducted from all profit calculations
  txFeeBufferPct: parseInt((process.env.TX_FEE_BUFFER_PCT || '20').trim(), 10),

  // Price Age Tracking (Phase 2)
  maxQuoteAgeMs: parseInt((process.env.MAX_QUOTE_AGE_MS || '500').trim(), 10), // Reject quotes older than 500ms

  // Telegram
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
};

// ═══════════════════════════════════════════════════════════════
//  TOKENS & POOLS
// ═══════════════════════════════════════════════════════════════

// Diagnostic: confirm paper trading state on boot
logger.info(`🔍 Paper trading config: ${CONFIG.paperTrading} (initial: ${CONFIG.paperInitialSol} SOL)`);

const TOKENS: TokenConfig[] = [
  { name: 'SOL',  mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  { name: 'USDC',  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { name: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  { name: 'JUP',    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  { name: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', decimals: 9 },
  { name: 'BOME',   mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', decimals: 6 },
  { name: 'MEW',    mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', decimals: 5 },
  { name: 'WIF',    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  { name: 'TRUMP',  mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', decimals: 6 },
];

// Pool addresses — verified mainnet addresses
// Raydium AMMv4 program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
// Orca Whirlpools program ID: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
const POOLS: PoolConfig[] = [
  // SOL-USDC on Raydium (verified mainnet)
  {
    name: 'Raydium',
    pairLabel: 'SOL-USDC',
    poolAddress: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    tokenAMint: 'So11111111111111111111111111111111111111112',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeBps: 25,
  },
  // SOL-USDC on Orca Whirlpool (verified mainnet)
  {
    name: 'Orca',
    pairLabel: 'SOL-USDC',
    poolAddress: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ',
    tokenAMint: 'So11111111111111111111111111111111111111112',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeBps: 30,
  },
  // SOL-BONK on Raydium (verified via GeckoTerminal: Bonk/SOL — base=BONK, quote=SOL)
  {
    name: 'Raydium',
    pairLabel: 'SOL-BONK',
    poolAddress: 'HVNwzt7Pxfu76KHCMQPTLuTCLTm6WnQ1esLv4eizseSv',
    tokenAMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 25,
  },
  // SOL-BONK on Orca Whirlpool (verified via GeckoTerminal; on-chain: tokenA=BONK, tokenB=wSOL — swapped here so price=SOL/BONK)
  {
    name: 'Orca',
    pairLabel: 'SOL-BONK',
    poolAddress: '3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1',
    tokenAMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 30,
  },
  // SOL-USDT on Orca Whirlpool (verified mainnet)
  {
    name: 'Orca',
    pairLabel: 'SOL-USDT',
    poolAddress: 'B6LL9aCWVuo1tTcJoYvCTDqYrq1vjMfci8uHxsm4UxTR',
    tokenAMint: 'So11111111111111111111111111111111111111112',
    tokenBMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    feeBps: 30,
  },
  // JUP-USDC on Raydium AMM v4 (verified via GeckoTerminal, ~$267 liq)
  {
    name: 'Raydium',
    pairLabel: 'JUP-USDC',
    poolAddress: '7RJ5qmsgmvUKK5QtCLT9qHpQMegkiULppHRBNuWso12E',
    tokenAMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeBps: 25,
  },
  // JUP-USDC on Orca Whirlpool (verified via GeckoTerminal, ~$19K liq)
  {
    name: 'Orca',
    pairLabel: 'JUP-USDC',
    poolAddress: 'FYmLrqgfrZ6u1Qvfo48wnhGp4HxXeQP7SQB5USQyQCPQ',
    tokenAMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeBps: 30,
  },
  // JUP-SOL on Orca Whirlpool (verified via GeckoTerminal, ~$236K liq — high volume)
  {
    name: 'Orca',
    pairLabel: 'JUP-SOL',
    poolAddress: 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz',
    tokenAMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 30,
  },
  // USDC-USDT on Orca Whirlpool (verified mainnet)
  {
    name: 'Orca',
    pairLabel: 'USDC-USDT',
    poolAddress: '4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4',
    tokenAMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenBMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    feeBps: 5,
  },

  // ── POPCAT-USDC ──────────────────────────────────────────
  {
    name: 'Raydium',
    pairLabel: 'POPCAT-USDC',
    poolAddress: 'HBS7a3br8GMMWuqVa7VB3SMFa7xVi1tSFdoF5w4ZZ3kS',
    tokenAMint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeBps: 25,
  },
  {
    name: 'Orca',
    pairLabel: 'POPCAT-USDC',
    poolAddress: '82vnbMa6vxm1a9TWy54s1dYRCYeGYZUPQnn7iVLBvmtx',
    tokenAMint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    tokenBMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    feeBps: 30,
  },

  // ── BOME-SOL ─────────────────────────────────────────────
  {
    name: 'Raydium',
    pairLabel: 'BOME-SOL',
    poolAddress: 'DSUvc5qf5LJHHV5e2tD184ixotSnCnwj7i4jJa4Xsrmt',
    tokenAMint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 25,
  },
  {
    name: 'Orca',
    pairLabel: 'BOME-SOL',
    poolAddress: 'DfUcPcAYUE5Vqi7wirnSkAVJdAKu4d6JC3o5roTVBz5N',
    tokenAMint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 30,
  },

  // ── MEW-SOL ──────────────────────────────────────────────
  {
    name: 'Raydium',
    pairLabel: 'MEW-SOL',
    poolAddress: '879F697iuDJGMevRkRcnW21fcXiAeLJK1ffsw2ATebce',
    tokenAMint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 25,
  },
  {
    name: 'Orca',
    pairLabel: 'MEW-SOL',
    poolAddress: '8Pak7BFHaSYg9pBTmNkJarh5dMKbhLGpAsoWbABoK6L1',
    tokenAMint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 30,
  },

  // ── WIF-SOL ──────────────────────────────────────────────
  {
    name: 'Raydium',
    pairLabel: 'WIF-SOL',
    poolAddress: 'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx',
    tokenAMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 25,
  },
  {
    name: 'Orca',
    pairLabel: 'WIF-SOL',
    poolAddress: 'D6NdKrKNQPmRZCCnG1GqXtF7MMoHB7qR6GU5TkG59Qz1',
    tokenAMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    tokenBMint: 'So11111111111111111111111111111111111111112',
    feeBps: 30,
  },

];

// ═══════════════════════════════════════════════════════════════
//  CEX CONFIG — Binance & Kraken (public REST, no auth)
// ═══════════════════════════════════════════════════════════════

interface CexConfig {
  name: string;
  baseUrl: string;
  symbolMap: { [pairLabel: string]: string };
}

const CEX_CONFIG: CexConfig[] = [
  {
    name: 'Binance',
    baseUrl: process.env.BINANCE_API_URL || 'https://api.binance.com/api/v3',
    symbolMap: {
      'SOL-USDC': 'SOLUSDC',
      'SOL-USDT': 'SOLUSDT',
      'JUP-USDT': 'JUPUSDT',   // Binance lists JUP against USDT, not USDC
    },
  },
  {
    name: 'Kraken',
    baseUrl: process.env.KRAKEN_API_URL || 'https://api.kraken.com/0/public',
    symbolMap: {
      'SOL-USDC': 'SOLUSDC',
      'SOL-USDT': 'SOLUSDT',
    },
  },
  {
    name: 'Bybit',
    baseUrl: process.env.BYBIT_API_URL || 'https://api.bybit.com/v5/market',
    symbolMap: {
      'SOL-USDC': 'SOLUSDC',
      'SOL-USDT': 'SOLUSDT',
      'JUP-USDT': 'JUPUSDT',
      'BONK-USDT': 'BONKUSDT',
      'WIF-USDT': 'WIFUSDT',
      'POPCAT-USDT': 'POPCATUSDT',
    },
  },
];

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════

let connection: Connection;
let wallet: Keypair;
let telegramBot: TelegramBot | null = null;

// Tx fee cache — refreshed every 5 min via RPC
let txFeeCache = { feePerTxSol: 5000 / LAMPORTS_PER_SOL, lastFetched: 0 };

const priceHistory: PriceHistory = {};
TOKENS.forEach(t => { priceHistory[t.name] = []; });

const positions: { [tokenName: string]: Position } = {};
TOKENS.forEach(t => { positions[t.name] = { holding: false, entryPrice: 0, entrySol: 0 }; });

// ═══════════════════════════════════════════════════════════════
//  PAPER TRADING STATE
// ═══════════════════════════════════════════════════════════════

interface PaperArbTrade {
  timestamp: string;
  pairLabel: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  spreadBps: number;
  profitBps: number;
  profitSol: number;
  tradeSizeSol: number;
  balanceAfterSol: number;
}

let paperBalanceSol = CONFIG.paperInitialSol;
let totalPaperTrades = 0;
let totalPaperProfitBps = 0;
let scanCycleCount = 0;

// ── SolGuard pre-warmer (singleton) ─────────────────────────────
// Lives inside THIS process on purpose. checks.ts caches to a module-level
// Map, so a pre-warmer running in the dashboard, a cron job or another shell
// would warm exactly nothing the gate can see. Created lazily because
// `connection` is only assigned inside init().
let solguardPrewarmer: Prewarmer | null = null;

function getSolguardPrewarmer(): Prewarmer {
  if (!solguardPrewarmer) {
    solguardPrewarmer = new Prewarmer({
      connection,
      intervalMs: CONFIG.solguardPrewarmIntervalMs,
      log: (line: string) => logger.info(line),
    });
  }
  return solguardPrewarmer;
}
let cyclePaused = false;
let cycleStopped = false;
const paperTradeLog: PaperArbTrade[] = [];

// Devnet pipeline testing
let lastDevnetTestCycle = -999; // first test fires on cycle 5
let devnetPipelineHealthy = false;
let devnetBalanceSol = 0;
const DEVNET_TEST_INTERVAL_CYCLES = 5;

// Flash loan paper tracking
let flashLoanBalanceSol = CONFIG.flashLoanAmountSol;
let totalFlashLoanTrades = 0;
let totalFlashLoanProfitBps = 0;

// ── Tier 1 Safety Guards ──
// Circuit breaker: tracks last N execution outcomes (true = success, false = failure)
const circuitBreakerHistory: boolean[] = [];
let circuitBreakerTripped = false;
let dailyLossLimitTripped = false;
// Daily loss tracking
let dailyLossSol = 0;
let dailyLossDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

/** Save paper trading state to disk so V5 can resume after restart. */
function saveState(): void {
  const state = {
    balance: paperBalanceSol,
    trades: totalPaperTrades,
    totalProfitBps: totalPaperProfitBps,
    flashLoanBalance: flashLoanBalanceSol,
    flashLoanTrades: totalFlashLoanTrades,
    flashLoanProfitBps: totalFlashLoanProfitBps,
    timestamp: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.info(`💾 State saved: ${paperBalanceSol.toFixed(4)} SOL, ${totalPaperTrades} trades`);
  } catch (err: any) {
    logger.error(`Failed to save state: ${err.message}`);
  }
}

/** Load paper trading state from disk. Returns true if state was restored. */
function loadState(): boolean {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      logger.info('No saved state found — starting fresh');
      return false;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (typeof state.balance === 'number' && state.balance > 0) {
      paperBalanceSol = state.balance;
      totalPaperTrades = state.trades || 0;
      totalPaperProfitBps = state.totalProfitBps || 0;
      flashLoanBalanceSol = state.flashLoanBalance || CONFIG.flashLoanAmountSol;
      totalFlashLoanTrades = state.flashLoanTrades || 0;
      totalFlashLoanProfitBps = state.flashLoanProfitBps || 0;
      logger.info(`📂 State restored: ${paperBalanceSol.toFixed(4)} SOL, ${totalPaperTrades} trades (saved ${state.timestamp})`);
      return true;
    }
    logger.warn('Saved state data invalid — starting fresh');
    return false;
  } catch (err: any) {
    logger.warn(`Failed to load state: ${err.message} — starting fresh`);
    return false;
  }
}

/** Clear paper trading balance back to initial. */
function clearPaperBalance(): void {
  paperBalanceSol = CONFIG.paperInitialSol;
  totalPaperTrades = 0;
  totalPaperProfitBps = 0;
  paperTradeLog.length = 0;
  saveState();
  logger.info('🧻 Paper balance cleared — reset to initial');
}

/** Clear flash loan fund back to initial borrow amount. */
function clearFlashLoanBalance(): void {
  flashLoanBalanceSol = CONFIG.flashLoanAmountSol;
  totalFlashLoanTrades = 0;
  totalFlashLoanProfitBps = 0;
  saveState();
  logger.info('⚡ Flash loan balance cleared — reset to initial');
}

// ═══════════════════════════════════════════════════════════════
//  TIER 1 SAFETY GUARDS
// ═══════════════════════════════════════════════════════════════

/** Check and update daily loss tracker. Returns true if limit breached. */
function checkDailyLossLimit(lossSol: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyLossDate !== today) {
    dailyLossSol = 0;
    dailyLossDate = today;
  }
  dailyLossSol += Math.abs(lossSol);
  if (dailyLossSol > CONFIG.dailyLossLimitSol) {
    logger.error(`🛑 Daily loss limit HIT: ${dailyLossSol.toFixed(4)} SOL > ${CONFIG.dailyLossLimitSol} SOL`);
    return true;
  }
  return false;
}

/** Record trade outcome and check circuit breaker. Returns true if breaker tripped. */
function checkCircuitBreaker(success: boolean): boolean {
  circuitBreakerHistory.push(success);
  // Trim to window size
  while (circuitBreakerHistory.length > CONFIG.circuitBreakerWindowSize) {
    circuitBreakerHistory.shift();
  }
  // Need at least window size entries to make a decision
  if (circuitBreakerHistory.length < CONFIG.circuitBreakerWindowSize) return false;

  const failures = circuitBreakerHistory.filter(s => !s).length;
  if (failures >= CONFIG.circuitBreakerMaxFailures) {
    logger.error(`🛑 Circuit breaker TRIPPED: ${failures}/${circuitBreakerHistory.length} failures`);
    circuitBreakerTripped = true;
    cycleStopped = true;
    saveState();
    return true;
  }
  return false;
}

/** Reset circuit breaker — called by /start or /reset_circuit. */
function resetCircuitBreaker(): void {
  circuitBreakerHistory.length = 0;
  circuitBreakerTripped = false;
  dailyLossLimitTripped = false;
  logger.info('🔌 Circuit breaker / loss limit reset');
}

/**
 * Dynamic slippage based on pool depth.
 * Thin pools get wider slippage to account for price impact.
 * Deep pools get tighter slippage since price doesn't move much.
 */
function getDynamicSlippageBps(opportunity: ArbOpportunity): number {
  if (!CONFIG.dynamicSlippageEnabled) return CONFIG.slippageBps;

  // Estimate SOL-side liquidity for buy and sell pools
  // For SOL-paired tokens: reserveA is SOL, reserveB is token
  // For USDC-paired: we need to think in SOL terms via the SOL-USDC rate
  const pairIsSolBased = opportunity.pairLabel.includes('SOL');

  let buyPoolDepthSol: Decimal;
  let sellPoolDepthSol: Decimal;

  if (pairIsSolBased) {
    // reserveA is the base (SOL or token). If pair is TOKEN-SOL, reserveA is token
    // Actually need to check: BOME-SOL means reserveA=BOME, reserveB=SOL
    // So reserveB is the SOL side
    buyPoolDepthSol = opportunity.buyReserveB;
    sellPoolDepthSol = opportunity.sellReserveB;
  } else {
    // USDC pairs: approximate SOL depth as reserveB / ~76 (SOL price)
    const solPrice = new Decimal(76);
    buyPoolDepthSol = opportunity.buyReserveB.div(solPrice);
    sellPoolDepthSol = opportunity.sellReserveB.div(solPrice);
  }

  const minDepth = Decimal.min(buyPoolDepthSol, sellPoolDepthSol);
  const tradeSize = new Decimal(opportunity.tradeSizeSol);

  if (minDepth.isZero()) return CONFIG.dynamicSlippageMaxBps;

  // Ratio: trade size / pool depth. Higher ratio = thinner pool = wider slippage
  const depthRatio = tradeSize.div(minDepth);

  // Scale: 0% ratio → min slippage, 5%+ ratio → max slippage
  const ratioNum = depthRatio.toNumber();
  const scaled = CONFIG.dynamicSlippageMinBps +
    (CONFIG.dynamicSlippageMaxBps - CONFIG.dynamicSlippageMinBps) * Math.min(1, ratioNum / 0.05);

  return Math.round(Math.max(CONFIG.dynamicSlippageMinBps, Math.min(CONFIG.dynamicSlippageMaxBps, scaled)));
}

/**
 * Simulate a transaction before submission.
 * Returns { success, error } — avoids burning SOL on doomed swaps.
 */
async function simulateTransaction(
  transaction: Transaction | VersionedTransaction
): Promise<{ success: boolean; error?: string; unitsConsumed?: number }> {
  try {
    const result = await connection.simulateTransaction(transaction as VersionedTransaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (result.value.err) {
      return { success: false, error: JSON.stringify(result.value.err) };
    }
    return { success: true, unitsConsumed: result.value.unitsConsumed || undefined };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Cached tx fee estimator for paper/flash profit deduction.
 * Calls getRecentPrioritizationFees (cached 5 min), returns SOL per tx.
 * Falls back to 5000 lamports base + 0 priority if RPC fails.
 */
async function getEstimatedTxFeeSol(): Promise<number> {
  const now = Date.now();
  if (now - txFeeCache.lastFetched < 300_000) return txFeeCache.feePerTxSol;

  try {
    let feeLamports = 5000; // base
    const recentFees = await connection.getRecentPrioritizationFees();
    if (recentFees && recentFees.length > 0) {
      const sorted = recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      feeLamports += sorted[Math.floor(sorted.length / 2)];
    }
    txFeeCache.feePerTxSol = (feeLamports * (1 + CONFIG.txFeeBufferPct / 100)) / LAMPORTS_PER_SOL;
  } catch {
    // Keep previous estimate or fallback
    if (txFeeCache.lastFetched === 0) txFeeCache.feePerTxSol = 5000 / LAMPORTS_PER_SOL;
  }
  txFeeCache.lastFetched = now;
  return txFeeCache.feePerTxSol;
}

/**
 * Estimate real transaction fee including priority fee.
 * Falls back to 5000 lamports if RPC call fails.
 */
async function estimateRealFee(transaction: Transaction | VersionedTransaction): Promise<number> {
  try {
    // Get base fee for the message
    const message = 'message' in transaction
      ? (transaction as VersionedTransaction).message
      : (transaction as Transaction).compileMessage();
    const feeResponse = await connection.getFeeForMessage(message, 'confirmed');
    let feeLamports = feeResponse.value || 5000;

    // Add recent prioritization fee estimate (median of last 100 blocks)
    try {
      const recentFees = await connection.getRecentPrioritizationFees();
      if (recentFees && recentFees.length > 0) {
        const sorted = recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        feeLamports += median;
      }
    } catch {
      // Prioritization fee fetch failed — use base only
    }

    return feeLamports / LAMPORTS_PER_SOL; // Return in SOL
  } catch {
    return 5000 / LAMPORTS_PER_SOL; // 0.000005 SOL fallback
  }
}

/** Calculate compound trade size as % of current balance.
 *  Scales with balance growth, capped at solSpend, floored at minTradeSizeSol. */
function getCompoundTradeSize(liquidityCapSol: number): number {
  const compoundSize = Math.min(
    CONFIG.solSpend,
    Math.max(CONFIG.minTradeSizeSol, paperBalanceSol * CONFIG.compoundPct / 100)
  );
  return Math.min(compoundSize, liquidityCapSol);
}

// ═══════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════

async function init(): Promise<void> {
  // Connection
  connection = new Connection(CONFIG.rpcUrl, 'confirmed');

  // Wallet
  if (!CONFIG.privateKey) {
    throw new Error('SOLANA_PRIVATE_KEY not set in .env.Solana');
  }
  const secretKey = Uint8Array.from(JSON.parse(CONFIG.privateKey));
  wallet = Keypair.fromSecretKey(secretKey);

  logger.info(`Wallet loaded: ${wallet.publicKey.toBase58()}`);

  // Telegram
  if (CONFIG.telegramToken && CONFIG.telegramChatId) {
    telegramBot = new TelegramBot(CONFIG.telegramToken, { polling: true });
    logger.info('Telegram bot initialized');

    // ═══════════════════════════════════════════════
    //  CONTROL COMMANDS
    // ═══════════════════════════════════════════════

    telegramBot.onText(/\/start/, async (msg) => {
      if (msg.chat.id.toString() !== CONFIG.telegramChatId) return;
      cycleStopped = false;
      cyclePaused = false;
      resetCircuitBreaker(); // clear any tripped breaker on resume
      await sendTelegram('▶️ Bot resumed — scanning active');
      scanCycle(); // fire immediately instead of waiting for next interval
    });

    telegramBot.onText(/\/reset_circuit/, async (msg) => {
      if (msg.chat.id.toString() !== CONFIG.telegramChatId) return;
      resetCircuitBreaker();
      cycleStopped = false;
      await sendTelegram('🔌 Circuit breaker reset — bot can trade again. Use /start to resume.');
    });

    telegramBot.onText(/\/stop/, async (msg) => {
      if (msg.chat.id.toString() !== CONFIG.telegramChatId) return;
      cycleStopped = true;
      cyclePaused = false;
      saveState();
      await sendTelegram('⏹️ Bot stopped — state saved. Use /start to resume');
    });

    telegramBot.onText(/\/pause/, async (msg) => {
      if (msg.chat.id.toString() !== CONFIG.telegramChatId) return;
      cyclePaused = true;
      await sendTelegram('⏸️ Bot paused — trades frozen. Use /start to resume');
    });

    telegramBot.onText(/\/clear_paper/, async (msg) => {
      if (msg.chat.id.toString() !== CONFIG.telegramChatId) return;
      clearPaperBalance();
      await sendTelegram(`🧻 Paper balance reset to ${CONFIG.paperInitialSol} SOL — 0 trades, fresh start`);
    });

    telegramBot.onText(/\/clear_flash/, async (msg) => {
      if (msg.chat.id.toString() !== CONFIG.telegramChatId) return;
      clearFlashLoanBalance();
      await sendTelegram(`⚡ Flash loan fund reset to ${CONFIG.flashLoanAmountSol} SOL — 0 trades, fresh start`);
    });
  }

  // Check balance with retry — public RPCs hiccup often
  let solBalance = 0;
  let retries = 3;
  while (retries >= 0) {
    try {
      const balance = await connection.getBalance(wallet.publicKey);
      solBalance = balance / LAMPORTS_PER_SOL;
      logger.info(`SOL balance: ${solBalance.toFixed(4)} SOL`);
      break;
    } catch (err: any) {
      if (retries > 0) {
        logger.warn(`Balance fetch failed, retrying... (${retries} left): ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 800));
        retries--;
      } else {
        logger.warn(`Balance fetch failed after all retries: ${err.message}`);
        logger.warn('Continuing anyway — paper trading mode may still work');
        solBalance = 0;
      }
    }
  }

  if (solBalance < CONFIG.minSolBuffer + CONFIG.solSpend) {
    logger.warn(`Low balance: ${solBalance.toFixed(4)} SOL. Need at least ${(CONFIG.minSolBuffer + CONFIG.solSpend).toFixed(4)} SOL`);
  }

  // Paper trading balance
  if (CONFIG.paperTrading) {
    const restored = loadState();
    if (!restored) {
      logger.info(`📊 Paper balance: ${paperBalanceSol.toFixed(2)} SOL (fresh start)`);
    }
    if (CONFIG.flashLoanEnabled) {
      logger.info(`⚡ Flash loan mode: ${CONFIG.flashLoanMaxBorrowPct}% of fund borrow cap, ${CONFIG.flashLoanFeeBps} bps fee`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  POOL PRICE FETCHING
// ═══════════════════════════════════════════════════════════════

async function fetchRaydiumPrice(pool: PoolConfig): Promise<PoolPrice | null> {
  try {
    // Raydium AMM v4 — fetch pool state via getAccountInfo
    const poolPubkey = new PublicKey(pool.poolAddress);
    const accountInfo = await connection.getAccountInfo(poolPubkey);

    if (!accountInfo) {
      logger.warn(`Raydium pool not found: ${pool.poolAddress}`);
      return null;
    }

    // Raydium AMMv4 pool account layout (verified from raydium-sdk layout.ts):
    // Accounts have an 8-byte Anchor discriminator — layout struct starts at offset 8
    // After discriminator: 32×u64 fields (256 bytes), then swap fields (80 bytes)
    // baseVault at struct offset 336 → raw offset 336+8 = 344
    // quoteVault at struct offset 368 → raw offset 368+8 = 376
    const data = accountInfo.data;

    // Vault addresses include Anchor discriminator: +8 bytes
    const vaultAPubkey = new PublicKey(data.slice(336, 368));
    const vaultBPubkey = new PublicKey(data.slice(368, 400));

    // Read actual token balances from vault accounts
    const vaultABalance = await connection.getTokenAccountBalance(vaultAPubkey);
    const vaultBBalance = await connection.getTokenAccountBalance(vaultBPubkey);

    const reserveA = new Decimal(vaultABalance.value.amount);
    const reserveB = new Decimal(vaultBBalance.value.amount);

    if (reserveA.isZero() || reserveB.isZero()) {
      return null;
    }

    // Price = reserveB / reserveA (quote / base)
    const price = reserveB.div(reserveA);
    const now = Date.now();

    return {
      dex: 'Raydium',
      pairLabel: pool.pairLabel,
      price,
      reserveA,
      reserveB,
      timestamp: now,
      quoteTimestamp: now,
    };
  } catch (err: any) {
    logger.error(`Raydium fetch error [${pool.pairLabel}]: ${err.message}`);
    return null;
  }
}

async function fetchOrcaPrice(pool: PoolConfig): Promise<PoolPrice | null> {
  try {
    // Orca Whirlpool — fetch pool state
    const poolPubkey = new PublicKey(pool.poolAddress);
    const accountInfo = await connection.getAccountInfo(poolPubkey);

    if (!accountInfo) {
      logger.warn(`Orca pool not found: ${pool.poolAddress}`);
      return null;
    }

    // Orca Whirlpool layout (verified from whirlpool.rs source)
    // Offset 0:  8 bytes  Anchor discriminator
    // Offset 8:  32 bytes whirlpoolsConfig
    // Offset 40: 1 byte   whirlpoolBump
    // Offset 41: 2 bytes  tickSpacing
    // Offset 43: 2 bytes  feeTierIndexSeed
    // Offset 45: 2 bytes  feeRate
    // Offset 47: 2 bytes  protocolFeeRate
    // Offset 49: 16 bytes liquidity (u128)
    // Offset 65: 16 bytes sqrtPrice (u128)
    // Offset 81: 4 bytes  tickCurrentIndex (i32)
    // Offset 85: 8 bytes  protocolFeeOwedA
    // Offset 93: 8 bytes  protocolFeeOwedB
    // Offset 101:32 bytes tokenMintA
    // Offset 133:32 bytes tokenVaultA
    // Offset 165:16 bytes feeGrowthGlobalA
    // Offset 181:32 bytes tokenMintB
    // Offset 213:32 bytes tokenVaultB
    const data = accountInfo.data;

    // sqrtPrice is u128 at offset 65
    const sqrtPriceBytes = data.slice(65, 81);
    const low = sqrtPriceBytes.readBigUInt64LE(0);
    const high = sqrtPriceBytes.readBigUInt64LE(8);
    const sqrtPriceU128 = (high << BigInt(64)) | low;
    const sqrtPrice = new Decimal(sqrtPriceU128.toString());

    // Price = (sqrtPrice / 2^64)^2
    const q64 = new Decimal(2).pow(64);
    const priceRatio = sqrtPrice.div(q64);
    let price = priceRatio.pow(2);

    // Invert price if the pool's internal token order differs from our config.
    // Orca Whirlpool stores its own tokenMintA / tokenMintB at known offsets.
    // If those don't match our configured tokenAMint / tokenBMint, flip the price.
    const poolTokenAMint = new PublicKey(data.slice(101, 133)).toBase58();
    const poolTokenBMint = new PublicKey(data.slice(181, 213)).toBase58();

    // Our config expects tokenA = pool.tokenAMint, tokenB = pool.tokenBMint.
    // If the pool's on-chain token order doesn't match our config, invert.
    const configA = pool.tokenAMint;
    const configB = pool.tokenBMint;
    const needsInvert = poolTokenAMint !== configA;
    if (needsInvert) {
      price = new Decimal(1).div(price);
    }

    // Estimate reserves from vault balances
    const vaultAPubkey = new PublicKey(data.slice(133, 165));
    const vaultBPubkey = new PublicKey(data.slice(213, 245));

    const vaultABalance = await connection.getTokenAccountBalance(vaultAPubkey);
    const vaultBBalance = await connection.getTokenAccountBalance(vaultBPubkey);

    const reserveA = new Decimal(vaultABalance.value.amount);
    const reserveB = new Decimal(vaultBBalance.value.amount);
    const now = Date.now();

    return {
      dex: 'Orca',
      pairLabel: pool.pairLabel,
      price,
      reserveA,
      reserveB,
      timestamp: now,
      quoteTimestamp: now,
    };
  } catch (err: any) {
    logger.error(`Orca fetch error [${pool.pairLabel}]: ${err.message}`);
    return null;
  }
}

async function fetchAllPrices(): Promise<PoolPrice[]> {
  const prices: PoolPrice[] = [];

  // Fetch sequentially with stagger + retry to avoid 429 rate-limiting
  for (let i = 0; i < POOLS.length; i++) {
    const pool = POOLS[i];
    const fetchFn = pool.name === 'Raydium' ? fetchRaydiumPrice : fetchOrcaPrice;
    let retries = 2;
    while (retries >= 0) {
      try {
        const price = await fetchFn(pool);
        if (price) prices.push(price);
        break;
      } catch {
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
          retries--;
        } else {
          break;
        }
      }
    }
    // Stagger: 150ms between requests to stay under RPC rate limits
    if (i < POOLS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  return prices;
}

// ═══════════════════════════════════════════════════════════════
//  CEX PRICE FETCHERS — Binance & Kraken (public, no auth)
// ═══════════════════════════════════════════════════════════════

async function fetchBinancePrice(pairLabel: string, symbol: string): Promise<ExchangePrice | null> {
  try {
    const cfg = CEX_CONFIG.find(c => c.name === 'Binance')!;
    const [tickerRes, bookRes] = await Promise.all([
      fetch(`${cfg.baseUrl}/ticker/price?symbol=${symbol}`),
      fetch(`${cfg.baseUrl}/ticker/bookTicker?symbol=${symbol}`),
    ]);

    if (!tickerRes.ok || !bookRes.ok) return null;

    const tickerData = await tickerRes.json() as { price: string };
    const bookData = await bookRes.json() as { bidPrice: string; askPrice: string };

    return {
      exchange: 'Binance',
      pairLabel,
      bidPrice: new Decimal(bookData.bidPrice),
      askPrice: new Decimal(bookData.askPrice),
      lastPrice: new Decimal(tickerData.price),
      timestamp: Date.now(),
    };
  } catch (err: any) {
    logger.error(`Binance fetch error [${pairLabel}]: ${err.message}`);
    return null;
  }
}

async function fetchKrakenPrice(pairLabel: string, symbol: string): Promise<ExchangePrice | null> {
  try {
    const cfg = CEX_CONFIG.find(c => c.name === 'Kraken')!;
    const res = await fetch(`${cfg.baseUrl}/Ticker?pair=${symbol}`);

    if (!res.ok) return null;

    const data = await res.json() as { error?: any[]; result: Record<string, { a: string[]; b: string[]; c: string[] }> };
    if (data.error && data.error.length > 0) return null;

    // Kraken: { result: { PAIR: { a: [ask], b: [bid], c: [last] } } }
    const pairData = Object.values(data.result)[0];

    return {
      exchange: 'Kraken',
      pairLabel,
      bidPrice: new Decimal(pairData.b[0]),
      askPrice: new Decimal(pairData.a[0]),
      lastPrice: new Decimal(pairData.c[0]),
      timestamp: Date.now(),
    };
  } catch (err: any) {
    logger.error(`Kraken fetch error [${pairLabel}]: ${err.message}`);
    return null;
  }
}

async function fetchBybitPrice(pairLabel: string, symbol: string): Promise<ExchangePrice | null> {
  try {
    const cfg = CEX_CONFIG.find(c => c.name === 'Bybit')!;
    const res = await fetch(`${cfg.baseUrl}/tickers?category=spot&symbol=${symbol}`);

    if (!res.ok) return null;

    const data = await res.json() as { retCode: number; retMsg: string; result: { list: Array<{ bid1Price: string; ask1Price: string; lastPrice: string }> } };
    if (data.retCode !== 0 || !data.result.list || data.result.list.length === 0) return null;

    const tickerData = data.result.list[0];

    return {
      exchange: 'Bybit',
      pairLabel,
      bidPrice: new Decimal(tickerData.bid1Price),
      askPrice: new Decimal(tickerData.ask1Price),
      lastPrice: new Decimal(tickerData.lastPrice),
      timestamp: Date.now(),
    };
  } catch (err: any) {
    logger.error(`Bybit fetch error [${pairLabel}]: ${err.message}`);
    return null;
  }
}

async function fetchAllCexPrices(): Promise<ExchangePrice[]> {
  const prices: ExchangePrice[] = [];
  const fetchPromises: Promise<void>[] = [];

  for (const cex of CEX_CONFIG) {
    for (const [pairLabel, symbol] of Object.entries(cex.symbolMap)) {
      let fetchFn: (pairLabel: string, symbol: string) => Promise<ExchangePrice | null>;
      if (cex.name === 'Binance') {
        fetchFn = fetchBinancePrice;
      } else if (cex.name === 'Kraken') {
        fetchFn = fetchKrakenPrice;
      } else if (cex.name === 'Bybit') {
        fetchFn = fetchBybitPrice;
      } else {
        continue;
      }
      fetchPromises.push(
        fetchFn(pairLabel, symbol).then(price => {
          if (price) prices.push(price);
        })
      );
    }
  }

  await Promise.all(fetchPromises);
  // DEBUG: log every CEX price with bid/ask
  for (const p of prices) {
    logger.info(`  CEX ${p.exchange} ${p.pairLabel}: bid=${p.bidPrice.toFixed(6)} ask=${p.askPrice.toFixed(6)}`);
  }
  return prices;
}

// ═══════════════════════════════════════════════════════════════
//  JUPITER QUOTE API — EXACT ON-CHAIN PRICING
// ═══════════════════════════════════════════════════════════════

const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';

/**
 * Maps pairLabel → { tokenMint, quoteMint } for Jupiter routing.
 * tokenMint = the non-quote token (BOME, WIF, etc.)
 * quoteMint = SOL or USDC/USDT
 */
function getPairMints(pairLabel: string): { tokenMint: string; quoteMint: string } | null {
  const solPairs: Record<string, string> = {
    'SOL-USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'SOL-USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'SOL-BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'BOME-SOL': 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    'MEW-SOL': 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
    'WIF-SOL': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    'JUP-SOL': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  };
  const usdcPairs: Record<string, string> = {
    'JUP-USDC': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'POPCAT-USDC': '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    'USDC-USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  };

  if (solPairs[pairLabel]) {
    return {
      tokenMint: solPairs[pairLabel],
      quoteMint: 'So11111111111111111111111111111111111111112',
    };
  }
  if (usdcPairs[pairLabel]) {
    return {
      tokenMint: usdcPairs[pairLabel],
      quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };
  }
  return null;
}

/**
 * Fetch a Jupiter quote for swapping `amount` lamports of `inputMint` → `outputMint`,
 * optionally filtering to a specific DEX via `dexes` whitelist.
 */
async function fetchJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  dexFilter?: string
): Promise<{ inAmount: number; outAmount: number; priceImpactPct: number; routeDexes: string[] } | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(Math.floor(amountLamports)),
    slippageBps: String(CONFIG.slippageBps),
    onlyDirectRoutes: 'true',
  });

  if (dexFilter) {
    params.append('dexes', dexFilter);
  }

  const url = `${JUPITER_API_URL}/quote?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn(`Jupiter quote failed (${response.status}): ${inputMint.slice(0, 6)}→${outputMint.slice(0, 6)}`);
      return null;
    }
    const data: any = await response.json();
    return {
      inAmount: parseInt(data.inAmount),
      outAmount: parseInt(data.outAmount),
      priceImpactPct: parseFloat(data.priceImpactPct || '0'),
      routeDexes: (data.routePlan || []).map((step: any) => step.swapInfo?.label || 'Unknown'),
    };
  } catch (err) {
    logger.warn(`Jupiter quote error: ${err}`);
    return null;
  }
}

/**
 * Validate a DEX→DEX arbitrage opportunity using Jupiter quotes.
 * Runs two real quotes — buy on the expected DEX, sell on the expected DEX.
 * Returns the Jupiter-calculated profit in SOL (positive = profitable).
 */
async function validateArbWithJupiter(opportunity: ArbOpportunity): Promise<{
  valid: boolean;
  jupiterProfitSol: number;
  jupiterProfitBps: number;
  buyOutAmount: number;
  sellOutAmount: number;
  buyDexes: string[];
  sellDexes: string[];
}> {
  const empty = { valid: false, jupiterProfitSol: 0, jupiterProfitBps: 0, buyOutAmount: 0, sellOutAmount: 0, buyDexes: [] as string[], sellDexes: [] as string[] };

  const mints = getPairMints(opportunity.pairLabel);
  if (!mints) {
    logger.warn(`Jupiter: no mint mapping for ${opportunity.pairLabel}`);
    return empty;
  }

  const isSolPair = mints.quoteMint === 'So11111111111111111111111111111111111111112';
  const isUsdcPair = mints.quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const tradeSizeNative = opportunity.tradeSizeSol;

  let amountLamports: number;
  if (isSolPair) {
    amountLamports = Math.floor(tradeSizeNative * LAMPORTS_PER_SOL);
  } else if (isUsdcPair) {
    amountLamports = Math.floor(tradeSizeNative * 1_000_000);
  } else {
    amountLamports = Math.floor(tradeSizeNative * LAMPORTS_PER_SOL);
  }

  // Step 1: Buy side — quote amount → token through expected DEX
  const buyQuote = await fetchJupiterQuote(
    mints.quoteMint,
    mints.tokenMint,
    amountLamports,
    opportunity.buyDex
  );

  if (!buyQuote) return empty;

  // Step 2: Sell side — token → quote amount through expected DEX
  const sellQuote = await fetchJupiterQuote(
    mints.tokenMint,
    mints.quoteMint,
    buyQuote.outAmount,
    opportunity.sellDex
  );

  if (!sellQuote) {
    return { ...empty, buyOutAmount: buyQuote.outAmount, buyDexes: buyQuote.routeDexes };
  }

  const sellOutNative = isSolPair
    ? sellQuote.outAmount / LAMPORTS_PER_SOL
    : isUsdcPair
      ? sellQuote.outAmount / 1_000_000
      : sellQuote.outAmount / LAMPORTS_PER_SOL;

  const buyInNative = tradeSizeNative;
  const profitNative = sellOutNative - buyInNative;
  const profitBps = buyInNative > 0 ? (profitNative / buyInNative) * 10000 : 0;

  return {
    valid: profitNative > 0,
    jupiterProfitSol: profitNative,
    jupiterProfitBps: profitBps,
    buyOutAmount: buyQuote.outAmount,
    sellOutAmount: sellQuote.outAmount,
    buyDexes: buyQuote.routeDexes,
    sellDexes: sellQuote.routeDexes,
  };
}

// ═══════════════════════════════════════════════════════════════
//  ARBITRAGE DETECTION
// ═══════════════════════════════════════════════════════════════

function detectArb(prices: PoolPrice[], cexPrices: ExchangePrice[] = []): ArbOpportunity[] {
  const opportunities: ArbOpportunity[] = [];

  // Group prices by pair label
  const pairs = new Map<string, PoolPrice[]>();
  for (const p of prices) {
    const existing = pairs.get(p.pairLabel) || [];
    existing.push(p);
    pairs.set(p.pairLabel, existing);
  }

  for (const [pairLabel, pairPrices] of pairs) {
    if (pairPrices.length < 2) continue; // need both DEXes

    const raydiumPrice = pairPrices.find(p => p.dex === 'Raydium');
    const orcaPrice = pairPrices.find(p => p.dex === 'Orca');

    if (!raydiumPrice || !orcaPrice) continue;

    // ── Reciprocal cross-check ────────────────────────────────
    // If Orca price ≈ 1 / Raydium price (within 2%), the Orca price
    // is directionally inverted. Flip it before spread calculation.
    const reciprocalOrca = new Decimal(1).div(orcaPrice.price);
    const reciprocalDiff = reciprocalOrca.sub(raydiumPrice.price).abs().div(raydiumPrice.price);
    if (reciprocalDiff.lt(0.02)) {
      orcaPrice.price = reciprocalOrca;
    }

    // Determine which is cheaper
    let buyDex: PoolPrice;
    let sellDex: PoolPrice;

    if (raydiumPrice.price.lt(orcaPrice.price)) {
      buyDex = raydiumPrice;
      sellDex = orcaPrice;
    } else {
      buyDex = orcaPrice;
      sellDex = raydiumPrice;
    }

    // Guard: skip same-DEX comparisons (only one DEX has this pair)
    if (buyDex.dex === sellDex.dex) continue;

    // Calculate spread in bps
    const spread = sellDex.price.sub(buyDex.price).div(buyDex.price).mul(10000);
    const spreadBps = spread.toNumber();

    // Guard: skip absurd spreads (>1M bps) — indicates price direction mismatch
    if (spreadBps > 1_000_000) continue;

    // Calculate fees
    const buyFeeBps = POOLS.find(p => p.name === buyDex.dex && p.pairLabel === pairLabel)?.feeBps || 25;
    const sellFeeBps = POOLS.find(p => p.name === sellDex.dex && p.pairLabel === pairLabel)?.feeBps || 30;
    const totalFeeBps = buyFeeBps + sellFeeBps;

    // Estimated profit after fees — use dynamic slippage if enabled
    let effectiveSlippageBps = CONFIG.slippageBps;
    if (CONFIG.dynamicSlippageEnabled) {
      // Estimate SOL-side pool depth for slippage scaling
      const pairIsSolBased = pairLabel.includes('SOL');
      let buyDepth: Decimal, sellDepth: Decimal;
      if (pairIsSolBased) {
        buyDepth = buyDex.reserveB;
        sellDepth = sellDex.reserveB;
      } else {
        const solPrice = new Decimal(76);
        buyDepth = buyDex.reserveB.div(solPrice);
        sellDepth = sellDex.reserveB.div(solPrice);
      }
      const minDepth = Decimal.min(buyDepth, sellDepth);
      const nominalTrade = new Decimal(CONFIG.maxPositionSizeSol);
      const depthRatio = minDepth.gt(0) ? nominalTrade.div(minDepth).toNumber() : 1;
      effectiveSlippageBps = Math.round(
        CONFIG.dynamicSlippageMinBps + (CONFIG.dynamicSlippageMaxBps - CONFIG.dynamicSlippageMinBps) * Math.min(1, depthRatio / 0.05)
      );
      effectiveSlippageBps = Math.max(CONFIG.dynamicSlippageMinBps, Math.min(CONFIG.dynamicSlippageMaxBps, effectiveSlippageBps));
    }
    const estimatedProfitBps = spreadBps - totalFeeBps - effectiveSlippageBps;

    // DEBUG: log every pair's arb math
    const slipLabel = CONFIG.dynamicSlippageEnabled ? `dynslip` : `slip`;
    logger.info(`  🔍 ${pairLabel}: spread=${spreadBps.toFixed(2)}bps fees=${totalFeeBps}bps ${slipLabel}=${effectiveSlippageBps}bps → profit=${estimatedProfitBps.toFixed(2)}bps (need ≥${CONFIG.minProfitBps}bps profit & ≥${CONFIG.minSpreadBps}bps spread)`);

    if (estimatedProfitBps >= CONFIG.minProfitBps && spreadBps >= CONFIG.minSpreadBps) {
      // Build opportunity with liquidity-aware trade sizing
      const rawOpp: ArbOpportunity = {
        buyDex: buyDex.dex,
        sellDex: sellDex.dex,
        pairLabel,
        buyPrice: buyDex.price,
        sellPrice: sellDex.price,
        spreadBps,
        estimatedProfitBps,
        tradeSizeSol: CONFIG.maxPositionSizeSol, // placeholder, recomputed below
        buyReserveA: buyDex.reserveA,
        buyReserveB: buyDex.reserveB,
        sellReserveA: sellDex.reserveA,
        sellReserveB: sellDex.reserveB,
      };
      const liquiditySize = getLiquidityAwareTradeSize(rawOpp, CONFIG.maxPositionSizeSol);
      if (liquiditySize > 0) {
        rawOpp.tradeSizeSol = getCompoundTradeSize(liquiditySize);
        opportunities.push(rawOpp);
      }
    }
  }

  // ── DEX ↔ CEX Cross-Venue Arbitrage ──────────────────────
  const CEX_FEE_BPS = 10; // 0.1% typical CEX taker fee

  for (const cexPrice of cexPrices) {
    // Find matching DEX prices for this pair
    const dexPrices = prices.filter(p => p.pairLabel === cexPrice.pairLabel);
    if (dexPrices.length === 0) continue;

    // Best (cheapest) DEX price to buy from
    const cheapestDex = dexPrices.reduce((best, p) =>
      p.price.lt(best.price) ? p : best
    );

    // Best (most expensive) DEX price to sell into
    const mostExpensiveDex = dexPrices.reduce((best, p) =>
      p.price.gt(best.price) ? p : best
    );

    // ── Strategy 1: Buy on DEX (cheap), sell on CEX (bid) ──
    const dexBuyPrice = cheapestDex.price;
    const cexBidPrice = cexPrice.bidPrice;
    const spread1Bps = cexBidPrice.sub(dexBuyPrice).div(dexBuyPrice).mul(10000).toNumber();

    if (spread1Bps > 0 && spread1Bps < 1_000_000) {
      const dexFeeBps = POOLS.find(p => p.name === cheapestDex.dex && p.pairLabel === cexPrice.pairLabel)?.feeBps || 25;
      const totalFeeBps = dexFeeBps + CEX_FEE_BPS + CONFIG.slippageBps;
      const profitBps = spread1Bps - totalFeeBps;

      logger.info(`  🔍 DEX→CEX ${cexPrice.pairLabel} (buy ${cheapestDex.dex} → sell ${cexPrice.exchange}): spread=${spread1Bps.toFixed(2)}bps fees=${totalFeeBps}bps slip=${CONFIG.slippageBps}bps → profit=${profitBps.toFixed(2)}bps (need ≥${CONFIG.minProfitBps}bps profit & ≥${CONFIG.cexMinSpreadBps}bps spread)`);

      if (profitBps >= CONFIG.minProfitBps && spread1Bps >= CONFIG.cexMinSpreadBps) {
        opportunities.push({
          buyDex: cheapestDex.dex,
          sellDex: cexPrice.exchange,
          pairLabel: cexPrice.pairLabel,
          buyPrice: dexBuyPrice,
          sellPrice: cexBidPrice,
          spreadBps: spread1Bps,
          estimatedProfitBps: profitBps,
          tradeSizeSol: getCompoundTradeSize(cheapestDex.reserveA.mul(0.1).toNumber() / LAMPORTS_PER_SOL),
          buyReserveA: cheapestDex.reserveA,
          buyReserveB: cheapestDex.reserveB,
          sellReserveA: new Decimal(0),
          sellReserveB: new Decimal(0),
        });
      }
    }

    // ── Strategy 2: Buy on CEX (ask), sell on DEX (high) ──
    const cexAskPrice = cexPrice.askPrice;
    const dexSellPrice = mostExpensiveDex.price;
    const spread2Bps = dexSellPrice.sub(cexAskPrice).div(cexAskPrice).mul(10000).toNumber();

    if (spread2Bps > 0 && spread2Bps < 1_000_000) {
      const dexFeeBps = POOLS.find(p => p.name === mostExpensiveDex.dex && p.pairLabel === cexPrice.pairLabel)?.feeBps || 30;
      const totalFeeBps = dexFeeBps + CEX_FEE_BPS + CONFIG.slippageBps;
      const profitBps = spread2Bps - totalFeeBps;

      logger.info(`  🔍 CEX→DEX ${cexPrice.pairLabel} (buy ${cexPrice.exchange} → sell ${mostExpensiveDex.dex}): spread=${spread2Bps.toFixed(2)}bps fees=${totalFeeBps}bps slip=${CONFIG.slippageBps}bps → profit=${profitBps.toFixed(2)}bps (need ≥${CONFIG.minProfitBps}bps profit & ≥${CONFIG.cexMinSpreadBps}bps spread)`);

      if (profitBps >= CONFIG.minProfitBps && spread2Bps >= CONFIG.cexMinSpreadBps) {
        opportunities.push({
          buyDex: cexPrice.exchange,
          sellDex: mostExpensiveDex.dex,
          pairLabel: cexPrice.pairLabel,
          buyPrice: cexAskPrice,
          sellPrice: dexSellPrice,
          spreadBps: spread2Bps,
          estimatedProfitBps: profitBps,
          tradeSizeSol: getCompoundTradeSize(CONFIG.maxPositionSizeSol),
          buyReserveA: new Decimal(0),
          buyReserveB: new Decimal(0),
          sellReserveA: mostExpensiveDex.reserveA,
          sellReserveB: mostExpensiveDex.reserveB,
        });
      }
    }
  }

  return opportunities;
}

// ═══════════════════════════════════════════════════════════════
//  LIQUIDITY-AWARE TRADE SIZING
// ═══════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Find the SOL-side liquidity (in SOL units) from a pool's reserves.
 * Returns 0 if neither reserve is SOL.
 */
function getSolLiquidityFromPool(
  reserveA: Decimal,
  tokenAMint: string,
  reserveB: Decimal,
  tokenBMint: string
): Decimal {
  let solReserve = new Decimal(0);
  if (tokenAMint === SOL_MINT) {
    solReserve = reserveA.div(new Decimal(LAMPORTS_PER_SOL));
  }
  if (tokenBMint === SOL_MINT) {
    const reserveBSol = reserveB.div(new Decimal(LAMPORTS_PER_SOL));
    if (solReserve.isZero() || reserveBSol.lt(solReserve)) {
      solReserve = reserveBSol;
    }
  }
  return solReserve;
}

/**
 * Calculate the maximum trade size (in SOL) that can be executed without
 * excessive slippage, based on actual pool reserves.
 * 
 * Constant-product AMM slippage: for trade of x SOL through a pool with R SOL,
 * slippage ≈ x / (R + x) in bps. We solve for max x given a slippage threshold.
 * Also caps at 10% of pool depth as a conservative safety rail.
 */
function getLiquidityAwareTradeSize(
  opportunity: ArbOpportunity,
  maxTradeSol: number,
  maxSlippageBps: number = 50
): number {
  const buyPool = POOLS.find(p => p.name === opportunity.buyDex && p.pairLabel === opportunity.pairLabel);
  const sellPool = POOLS.find(p => p.name === opportunity.sellDex && p.pairLabel === opportunity.pairLabel);

  let maxSizeFromLiquidity = new Decimal(maxTradeSol);

  // Check buy-side liquidity
  if (buyPool && !opportunity.buyReserveA.isZero()) {
    const buySolLiq = getSolLiquidityFromPool(
      opportunity.buyReserveA, buyPool.tokenAMint,
      opportunity.buyReserveB, buyPool.tokenBMint
    );
    if (!buySolLiq.isZero()) {
      const slippageFraction = maxSlippageBps / (10000 - maxSlippageBps);
      const maxFromBuy = buySolLiq.mul(slippageFraction);
      const depthCap = buySolLiq.mul(0.1);
      const buyCap = Decimal.min(maxFromBuy, depthCap);
      if (buyCap.lt(maxSizeFromLiquidity)) {
        maxSizeFromLiquidity = buyCap;
      }
    }
  }

  // Check sell-side liquidity
  if (sellPool && !opportunity.sellReserveA.isZero()) {
    const sellSolLiq = getSolLiquidityFromPool(
      opportunity.sellReserveA, sellPool.tokenAMint,
      opportunity.sellReserveB, sellPool.tokenBMint
    );
    if (!sellSolLiq.isZero()) {
      const slippageFraction = maxSlippageBps / (10000 - maxSlippageBps);
      const maxFromSell = sellSolLiq.mul(slippageFraction);
      const depthCap = sellSolLiq.mul(0.1);
      const sellCap = Decimal.min(maxFromSell, depthCap);
      if (sellCap.lt(maxSizeFromLiquidity)) {
        maxSizeFromLiquidity = sellCap;
      }
    }
  }

  // Floor — don't bother with dust
  const minTrade = new Decimal(0.001);
  if (maxSizeFromLiquidity.lt(minTrade)) {
    return 0;
  }

  return maxSizeFromLiquidity.toNumber();
}

// ═══════════════════════════════════════════════════════════════
//  EXECUTION COST ENGINE (Phase 1)
// ═══════════════════════════════════════════════════════════════

function calculateExecutionCostBreakdown(
  grossProfitSol: number,
  tradeSizeSol: number,
  buyFeeBps: number,
  sellFeeBps: number
): ExecutionCostBreakdown {
  // DEX Fees (buy + sell)
  const dexFeesSol = (tradeSizeSol * (buyFeeBps + sellFeeBps)) / 10000;

  // Flash Loan Fee (0.1% = 10 bps for Jupiter Lend, 0.3% = 30 bps for Kamino)
  const flashLoanFeeBps = CONFIG.flashLoanEnabled ? CONFIG.flashLoanFeeBps : 0;
  const flashLoanFeeSol = (tradeSizeSol * flashLoanFeeBps) / 10000;

  // Priority Fee (estimated)
  const priorityFeeSol = 0.00005; // ~0.00005 SOL base

  // Jito Tip (if enabled)
  const jitoTipSol = CONFIG.jitoEnabled ? (CONFIG.jitoTipLamports / 1_000_000_000) : 0;

  // Network Fee (base transaction fee)
  const networkFeeSol = 0.000005; // ~0.000005 SOL per signature

  // Expected Slippage (dynamic based on trade size vs liquidity)
  const slippageBps = CONFIG.slippageBps;
  const slippageEstimateSol = (tradeSizeSol * slippageBps) / 10000;

  // Safety Buffer (20% of total costs as configured)
  const totalCostsSoFar = dexFeesSol + flashLoanFeeSol + priorityFeeSol + jitoTipSol + networkFeeSol + slippageEstimateSol;
  const safetyBufferSol = totalCostsSoFar * (CONFIG.txFeeBufferPct / 100);

  // Expected Net Profit
  const expectedNetProfitSol = grossProfitSol - totalCostsSoFar - safetyBufferSol;

  // Execute Decision
  const executeDecision = expectedNetProfitSol > 0 ? 'YES' : 'NO';

  return {
    grossProfitSol,
    dexFeesSol,
    flashLoanFeeSol,
    priorityFeeSol,
    jitoTipSol,
    networkFeeSol,
    slippageEstimateSol,
    safetyBufferSol,
    expectedNetProfitSol,
    executeDecision,
  };
}

function logExecutionCostBreakdown(breakdown: ExecutionCostBreakdown): void {
  logger.info(`Gross Profit:        ${breakdown.grossProfitSol.toFixed(5)} SOL`);
  logger.info(`DEX Fees:           -${breakdown.dexFeesSol.toFixed(5)} SOL`);
  logger.info(`Flash Loan Fee:     -${breakdown.flashLoanFeeSol.toFixed(5)} SOL`);
  logger.info(`Priority Fee:       -${breakdown.priorityFeeSol.toFixed(5)} SOL`);
  logger.info(`Jito Tip:           -${breakdown.jitoTipSol.toFixed(5)} SOL`);
  logger.info(`Network Fee:        -${breakdown.networkFeeSol.toFixed(5)} SOL`);
  logger.info(`Slippage Estimate:  -${breakdown.slippageEstimateSol.toFixed(5)} SOL`);
  logger.info(`Safety Buffer:      -${breakdown.safetyBufferSol.toFixed(5)} SOL`);
  logger.info(`Expected Net:        ${breakdown.expectedNetProfitSol.toFixed(5)} SOL`);
  logger.info(`EXECUTE = ${breakdown.executeDecision}`);
}

// ═══════════════════════════════════════════════════════════════
//  SLIPPAGE MODEL (Phase 3)
// ═══════════════════════════════════════════════════════════════

interface SlippageStressTest {
  scenario: string;
  buyPriceAdjustment: number;  // percentage adjustment to buy price
  sellPriceAdjustment: number; // percentage adjustment to sell price
  adjustedGrossProfitSol: number;
  adjustedNetProfitSol: number;
  survives: boolean;
}

function runSlippageStressTests(
  opportunity: ArbOpportunity,
  tradeSizeSol: number,
  buyFeeBps: number,
  sellFeeBps: number
): SlippageStressTest[] {
  const tests: SlippageStressTest[] = [];
  const baseGrossProfitSol = (tradeSizeSol * opportunity.spreadBps) / 10000;

  // Scenario 1: Mild slippage (0.01% worse on both sides)
  const mildBuyAdj = 1.0001;
  const mildSellAdj = 0.9999;
  const mildGross = baseGrossProfitSol * (mildSellAdj / mildBuyAdj - 1);
  const mildCosts = calculateExecutionCostBreakdown(mildGross, tradeSizeSol, buyFeeBps, sellFeeBps);
  tests.push({
    scenario: 'Mild Slippage (±0.01%)',
    buyPriceAdjustment: 0.01,
    sellPriceAdjustment: -0.01,
    adjustedGrossProfitSol: mildGross,
    adjustedNetProfitSol: mildCosts.expectedNetProfitSol,
    survives: mildCosts.executeDecision === 'YES',
  });

  // Scenario 2: Moderate slippage (0.03% worse on both sides)
  const modBuyAdj = 1.0003;
  const modSellAdj = 0.9997;
  const modGross = baseGrossProfitSol * (modSellAdj / modBuyAdj - 1);
  const modCosts = calculateExecutionCostBreakdown(modGross, tradeSizeSol, buyFeeBps, sellFeeBps);
  tests.push({
    scenario: 'Moderate Slippage (±0.03%)',
    buyPriceAdjustment: 0.03,
    sellPriceAdjustment: -0.03,
    adjustedGrossProfitSol: modGross,
    adjustedNetProfitSol: modCosts.expectedNetProfitSol,
    survives: modCosts.executeDecision === 'YES',
  });

  // Scenario 3: Severe slippage (0.05% worse on both sides)
  const severeBuyAdj = 1.0005;
  const severeSellAdj = 0.9995;
  const severeGross = baseGrossProfitSol * (severeSellAdj / severeBuyAdj - 1);
  const severeCosts = calculateExecutionCostBreakdown(severeGross, tradeSizeSol, buyFeeBps, sellFeeBps);
  tests.push({
    scenario: 'Severe Slippage (±0.05%)',
    buyPriceAdjustment: 0.05,
    sellPriceAdjustment: -0.05,
    adjustedGrossProfitSol: severeGross,
    adjustedNetProfitSol: severeCosts.expectedNetProfitSol,
    survives: severeCosts.executeDecision === 'YES',
  });

  return tests;
}

function logSlippageStressTests(tests: SlippageStressTest[]): void {
  logger.info(`🧪 Slippage Stress Tests:`);
  for (const test of tests) {
    const status = test.survives ? '✅' : '❌';
    logger.info(`  ${status} ${test.scenario}: Net ${test.adjustedNetProfitSol.toFixed(5)} SOL`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  CONFIDENCE SCORE SYSTEM (Phase 4)
// ═══════════════════════════════════════════════════════════════

interface ConfidenceScore {
  totalScore: number;  // 0-100
  spreadScore: number;  // 0-25
  liquidityScore: number;  // 0-25
  latencyScore: number;  // 0-25
  routeStabilityScore: number;  // 0-25
  historicalSuccessScore: number;  // 0-25 (bonus)
  executeDecision: 'YES' | 'NO';
}

// Track historical success rate per pair
const historicalSuccessRates: Record<string, { successful: number; total: number }> = {};

function calculateConfidenceScore(
  opportunity: ArbOpportunity,
  slippageTests: SlippageStressTest[]
): ConfidenceScore {
  // Spread Score (0-25): Higher spread = higher confidence
  const spreadScore = Math.min(25, (opportunity.spreadBps / 100) * 25);

  // Liquidity Score (0-25): Based on minimum reserve depth
  const minReserve = Decimal.min(opportunity.buyReserveA, opportunity.sellReserveA);
  const liquidityScore = Math.min(25, (minReserve.toNumber() / 10000) * 25);

  // Latency Score (0-25): Lower quote age = higher confidence
  // For now, use a placeholder since full quote age tracking needs ArbOpportunity enhancement
  const latencyScore = 20; // Placeholder - will be calculated with full Phase 2 implementation

  // Route Stability Score (0-25): Based on surviving slippage tests
  const survivingTests = slippageTests.filter(t => t.survives).length;
  const routeStabilityScore = (survivingTests / slippageTests.length) * 25;

  // Historical Success Score (0-25): Based on past performance
  const pairKey = `${opportunity.buyDex}-${opportunity.sellDex}-${opportunity.pairLabel}`;
  const history = historicalSuccessRates[pairKey] || { successful: 0, total: 0 };
  const historicalSuccessScore = history.total > 0 ? (history.successful / history.total) * 25 : 12.5; // Default to neutral if no history

  // Calculate total score (max 100, but can exceed with bonus)
  const totalScore = spreadScore + liquidityScore + latencyScore + routeStabilityScore + historicalSuccessScore;

  // Execute decision based on minimum confidence threshold
  const minConfidenceThreshold = 50; // 50/100 minimum
  const executeDecision = totalScore >= minConfidenceThreshold ? 'YES' : 'NO';

  return {
    totalScore,
    spreadScore,
    liquidityScore,
    latencyScore,
    routeStabilityScore,
    historicalSuccessScore,
    executeDecision,
  };
}

function logConfidenceScore(score: ConfidenceScore, pairKey: string): void {
  logger.info(`🎯 Confidence Score: ${score.totalScore.toFixed(1)}/100`);
  logger.info(`  Spread: ${score.spreadScore.toFixed(1)}/25`);
  logger.info(`  Liquidity: ${score.liquidityScore.toFixed(1)}/25`);
  logger.info(`  Latency: ${score.latencyScore.toFixed(1)}/25`);
  logger.info(`  Route Stability: ${score.routeStabilityScore.toFixed(1)}/25`);
  logger.info(`  Historical Success: ${score.historicalSuccessScore.toFixed(1)}/25`);
  logger.info(`  EXECUTE = ${score.executeDecision}`);
}

// ═══════════════════════════════════════════════════════════════
//  OPPORTUNITY REPLAY SYSTEM (Phase 5)
// ═══════════════════════════════════════════════════════════════

interface OpportunityReplayData {
  timestamp: string;
  pairLabel: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  spreadBps: number;
  tradeSizeSol: number;
  estimatedProfitBps: number;
  costBreakdown: ExecutionCostBreakdown;
  slippageTests: SlippageStressTest[];
  confidenceScore: ConfidenceScore;
  executionDecision: 'EXECUTED' | 'REJECTED';
  rejectionReason?: string;
}

const OPPORTUNITY_REPLAY_FILE = 'opportunity_replay.jsonl';

function saveOpportunityForReplay(
  opportunity: ArbOpportunity,
  costBreakdown: ExecutionCostBreakdown,
  slippageTests: SlippageStressTest[],
  confidenceScore: ConfidenceScore,
  executionDecision: 'EXECUTED' | 'REJECTED',
  rejectionReason?: string
): void {
  const replayData: OpportunityReplayData = {
    timestamp: new Date().toISOString(),
    pairLabel: opportunity.pairLabel,
    buyDex: opportunity.buyDex,
    sellDex: opportunity.sellDex,
    buyPrice: opportunity.buyPrice.toNumber(),
    sellPrice: opportunity.sellPrice.toNumber(),
    spreadBps: opportunity.spreadBps,
    tradeSizeSol: opportunity.tradeSizeSol,
    estimatedProfitBps: opportunity.estimatedProfitBps,
    costBreakdown,
    slippageTests,
    confidenceScore,
    executionDecision,
    rejectionReason,
  };

  try {
    fs.appendFileSync(OPPORTUNITY_REPLAY_FILE, JSON.stringify(replayData) + '\n');
  } catch (err: any) {
    logger.error(`Failed to save opportunity replay data: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  TRADE EXECUTION
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  PAPER ARB EXECUTION
// ═══════════════════════════════════════════════════════════════

async function executeArb(opportunity: ArbOpportunity): Promise<boolean> {
  const mode = CONFIG.paperTrading ? '📊 PAPER' : '💰 LIVE';
  // Circuit breaker: refuse to execute if tripped
  if (circuitBreakerTripped) {
    logger.warn(`🔌 Circuit breaker tripped — skipping ${opportunity.pairLabel}`);
    return false;
  }

  // Tier 1 Safety: Jupiter on-chain quote validation — prevents mirage profits
  if (CONFIG.jupiterQuoteEnabled && CONFIG.paperTrading) {
    const validation = await validateArbWithJupiter(opportunity);
    if (!validation.valid && validation.sellOutAmount > 0) {
      logger.warn(
        `⚠️ Jupiter REJECTED ${opportunity.pairLabel}: ` +
        `pool-profit=${opportunity.estimatedProfitBps.toFixed(2)}bps, ` +
        `jupiter-profit=${validation.jupiterProfitBps.toFixed(2)}bps. Skipping.`
      );
      return false;
    }
    if (validation.valid) {
      logger.info(
        `✅ Jupiter CONFIRMED ${opportunity.pairLabel}: ` +
        `pool=${opportunity.estimatedProfitBps.toFixed(2)}bps, ` +
        `jupiter=${validation.jupiterProfitBps.toFixed(2)}bps ` +
        `(buy: ${validation.buyDexes.join('→')}, sell: ${validation.sellDexes.join('→')})`
      );
    }
  }

  // Tier 0 Safety: SolGuard — read-only token gate. Runs BEFORE any execution
  // logic. Builds no transaction, signs nothing, sends nothing. It answers one
  // question: "is this token safe to touch at all?"
  //
  // A check that could not be READ (RPC 429 / timeout) is NOT a finding about
  // the token. It holds the trade for review instead of accusing the token and
  // instead of silently passing it.
  if (CONFIG.solguardEnabled) {
    try {
      const target = resolveRiskTarget(opportunity.pairLabel, getPairMints);

      if (target.status === 'unresolved') {
        // This used to be `if (riskMint)` and fell straight through: an
        // unauditable pair was traded with no audit and no log line. A gate
        // that quietly declines to run is worse than no gate — it reads as
        // protection. So it says so, out loud, every single time.
        logger.warn(unresolvedMintWarning(target));

        if (CONFIG.solguardRequireResolvedMint) {
          logger.warn(
            `⛔ SolGuard HOLD ${opportunity.pairLabel} — no mint mapping and ` +
            `SOLGUARD_REQUIRE_RESOLVED_MINT=true. No audit, no trade.`
          );
          return false;
        }
      } else if (target.status === 'not_applicable') {
        // Both sides are numeraires (SOL-USDC, SOL-USDT, USDC-USDT). There is
        // no token-risk question to ask, so the gate does not run and does not
        // hold. This is NOT a pass of the honeypot checks — it is the checks
        // not applying — and noteGateNotApplicable() keeps it out of the audit
        // call count so the gate's coverage is not overstated.
        //
        // Never sets solguardRequireResolvedMint: that flag is about the gate
        // being BLINDED by a missing mapping, which this is not.
        logger.info(numeraireSkipNote(target));
        noteGateNotApplicable(target.mint);
      } else {
        const gate = await runSafetyGate({
          connection,
          mintAddress: target.mint,
          dexLabel: opportunity.buyDex,
        });
        logger.info(`${gateLogLine(gate)} [cache: ${describeWarmth(target.mint)}]`);

        if (gate.outcome === 'BLOCK') {
          logger.warn(`⛔ SolGuard BLOCK ${opportunity.pairLabel} — ${gate.reasons.join(' | ')}`);
          return false;
        }

        if (gate.outcome === 'UNVERIFIED' && !CONFIG.solguardAllowUnverified) {
          logger.warn(
            `⚠️ SolGuard INCONCLUSIVE ${opportunity.pairLabel} — ` +
            `${gate.verdict.unverified.length} check(s) unreadable, holding this cycle. ` +
            `Not a finding about the token; point SOLANA_RPC at a dedicated endpoint.`
          );
          return false;
        }
      }
    } catch (e: any) {
      // Fail OPEN, loudly. A safety gate that takes the bot down when it errors
      // is a liability, not a shield. Log it and let the existing tiers decide.
      // Counted too, so "errors" shows up in the periodic summary instead of
      // existing only as a log line somebody has to scroll back for.
      noteGateError();
      logger.warn(`⚠️ SolGuard error (failing open, not blocking): ${e?.message ?? e}`);
    }
  }

  logger.info(`${mode} Executing arb: Buy ${opportunity.pairLabel} on ${opportunity.buyDex}, sell on ${opportunity.sellDex}`);

  // Phase 2: Price Age Check
  const now = Date.now();
  // Note: Full quote age tracking requires adding quoteTimestamp to ArbOpportunity interface
  // For now, we log current time and will implement full tracking in next iteration
  logger.info(`⏱️ Execution timestamp: ${now}ms (max quote age: ${CONFIG.maxQuoteAgeMs}ms)`);

  try {
    if (CONFIG.paperTrading) {
      // ── Paper Trading Path ──
      const netProfitBps = opportunity.estimatedProfitBps;
      const tradeSizeSol = opportunity.tradeSizeSol;

      // For flash loan cost calculations, use flash loan amount instead of paper trade size
      const costCalcSize = CONFIG.flashLoanEnabled ? CONFIG.flashLoanAmountSol : tradeSizeSol;
      const grossProfitSol = (costCalcSize * netProfitBps) / 10000;

      // Get DEX fees for this pair
      const buyPool = POOLS.find(p => p.name === opportunity.buyDex && p.pairLabel === opportunity.pairLabel);
      const sellPool = POOLS.find(p => p.name === opportunity.sellDex && p.pairLabel === opportunity.pairLabel);
      const buyFeeBps = buyPool?.feeBps || 25;
      const sellFeeBps = sellPool?.feeBps || 30;

      // Calculate detailed execution cost breakdown
      const costBreakdown = calculateExecutionCostBreakdown(grossProfitSol, costCalcSize, buyFeeBps, sellFeeBps);

      // Log the detailed cost breakdown
      logExecutionCostBreakdown(costBreakdown);

      // Phase 3: Run slippage stress tests (use flash loan amount if enabled)
      const slippageTests = runSlippageStressTests(opportunity, costCalcSize, buyFeeBps, sellFeeBps);
      logSlippageStressTests(slippageTests);

      // Check if opportunity survives stress tests
      const survivingTests = slippageTests.filter(t => t.survives);
      if (survivingTests.length === 0) {
        logger.info(`⛔ Execution rejected - opportunity fails all slippage stress tests`);
        saveOpportunityForReplay(opportunity, costBreakdown, slippageTests, { totalScore: 0, spreadScore: 0, liquidityScore: 0, latencyScore: 0, routeStabilityScore: 0, historicalSuccessScore: 0, executeDecision: 'NO' }, 'REJECTED', 'Failed slippage stress tests');
        return false;
      }

      // Phase 4: Calculate confidence score
      const pairKey = `${opportunity.buyDex}-${opportunity.sellDex}-${opportunity.pairLabel}`;
      const confidenceScore = calculateConfidenceScore(opportunity, slippageTests);
      logConfidenceScore(confidenceScore, pairKey);

      // Reject if confidence score is too low
      if (confidenceScore.executeDecision === 'NO') {
        logger.info(`⛔ Execution rejected - confidence score ${confidenceScore.totalScore.toFixed(1)} below threshold`);
        saveOpportunityForReplay(opportunity, costBreakdown, slippageTests, confidenceScore, 'REJECTED', 'Low confidence score');
        return false;
      }

      // Only execute if decision is YES
      if (costBreakdown.executeDecision === 'NO') {
        logger.info(`⛔ Execution rejected by cost engine - net profit would be negative`);
        saveOpportunityForReplay(opportunity, costBreakdown, slippageTests, confidenceScore, 'REJECTED', 'Negative net profit');
        return false;
      }

      // Use the expected net profit from cost breakdown
      const profitSol = costBreakdown.expectedNetProfitSol;

      // Simulate execution
      paperBalanceSol += profitSol;
      totalPaperTrades++;
      totalPaperProfitBps += netProfitBps;

      // Update historical success rate for this pair
      if (!historicalSuccessRates[pairKey]) {
        historicalSuccessRates[pairKey] = { successful: 0, total: 0 };
      }
      historicalSuccessRates[pairKey].total++;
      historicalSuccessRates[pairKey].successful++;

      // Phase 5: Save executed opportunity for replay analysis
      saveOpportunityForReplay(opportunity, costBreakdown, slippageTests, confidenceScore, 'EXECUTED');

      // Tier 1 Safety: daily loss limit — stops bot if today's losses exceed threshold
      if (profitSol < 0) {
        if (checkDailyLossLimit(Math.abs(profitSol))) {
          dailyLossLimitTripped = true;
          cycleStopped = true;
          await sendTelegram(`🛑 DAILY LOSS LIMIT HIT: ${dailyLossSol.toFixed(4)} SOL > ${CONFIG.dailyLossLimitSol} SOL\nBot halted. Use /start tomorrow or /reset_circuit to override.`);
        }
      }

      // Tier 1 Safety: circuit breaker — trips on consecutive execution failures
      if (checkCircuitBreaker(true)) {
        await sendTelegram(`🛑 CIRCUIT BREAKER TRIPPED: ${circuitBreakerHistory.filter(s => !s).length}/${circuitBreakerHistory.length} failures\nBot halted. Use /reset_circuit to clear and /start to resume.`);
      }

      const trade: PaperArbTrade = {
        timestamp: new Date().toISOString(),
        pairLabel: opportunity.pairLabel,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex,
        buyPrice: opportunity.buyPrice.toNumber(),
        sellPrice: opportunity.sellPrice.toNumber(),
        spreadBps: opportunity.spreadBps,
        profitBps: netProfitBps,
        profitSol: profitSol,
        tradeSizeSol: tradeSizeSol,
        balanceAfterSol: paperBalanceSol,
      };
      paperTradeLog.push(trade);

      // Append to paper trades file
      fs.appendFileSync('paper_trades_solana.jsonl', JSON.stringify(trade) + '\n');

      // ── Flash Loan Simulation Path ──
      let flashLoanMsg = '';
      let flashLoanProfitBps = 0;
      let flashLoanProfitSol = 0;
      if (CONFIG.flashLoanEnabled) {
        flashLoanProfitBps = netProfitBps - CONFIG.flashLoanFeeBps;
        if (flashLoanProfitBps > 0) {
          // Dynamic borrow cap: % of current flash loan fund (compounds as fund grows)
          // Pool liquidity still wins if it's lower
          const dynamicMaxBorrow = flashLoanBalanceSol * (CONFIG.flashLoanMaxBorrowPct / 100);
          const maxFlashSize = getLiquidityAwareTradeSize(opportunity, dynamicMaxBorrow);
          const flashBorrowSol = Math.min(dynamicMaxBorrow, maxFlashSize);
          flashLoanProfitSol = (flashBorrowSol * flashLoanProfitBps) / 10000;
          flashLoanBalanceSol += flashLoanProfitSol;
          totalFlashLoanTrades++;
          totalFlashLoanProfitBps += flashLoanProfitBps;
          const flAvg = totalFlashLoanTrades > 0
            ? (totalFlashLoanProfitBps / totalFlashLoanTrades).toFixed(2) : '0.00';
          flashLoanMsg =
            `\\n⚡ FLASH LOAN (${flashBorrowSol.toFixed(1)} SOL borrow):\\n` +
            `• Profit: ${flashLoanProfitBps.toFixed(2)} bps (${flashLoanProfitSol.toFixed(6)} SOL)\\n` +
            `• Flash Loan Fund: ${flashLoanBalanceSol.toFixed(4)} SOL\\n` +
            `• Flash Loan Trades: ${totalFlashLoanTrades} | Avg: ${flAvg} bps`;
          logger.info(
            `⚡ FLASH LOAN Arb | ${opportunity.pairLabel} | ` +
            `Borrow: ${flashBorrowSol.toFixed(1)} SOL | Profit: ${flashLoanProfitBps.toFixed(2)} bps (${flashLoanProfitSol.toFixed(6)} SOL) | ` +
            `Fund: ${flashLoanBalanceSol.toFixed(4)} SOL | Trades: ${totalFlashLoanTrades}`
          );
        } else {
          flashLoanMsg =
            `\\n⚡ FLASH LOAN: Skipped — net profit ${flashLoanProfitBps.toFixed(2)} bps ≤ fee (${CONFIG.flashLoanFeeBps} bps)`;
          logger.info(
            `⚡ FLASH LOAN Skipped | ${opportunity.pairLabel} | ` +
            `Net ${netProfitBps.toFixed(2)}bps - fee ${CONFIG.flashLoanFeeBps}bps = ${flashLoanProfitBps.toFixed(2)}bps`
          );
        }
      }

      // Save state after every trade
      saveState();

      const dualMode = CONFIG.flashLoanEnabled ? '📊 PAPER + ⚡ FLASH' : '📊 PAPER';

      logger.info(
        `${mode} Arb | ${opportunity.pairLabel} | ` +
        `Buy ${opportunity.buyDex} → Sell ${opportunity.sellDex} | ` +
        `Profit: ${netProfitBps.toFixed(2)} bps (${profitSol.toFixed(6)} SOL) | ` +
        `Balance: ${paperBalanceSol.toFixed(4)} SOL | ` +
        `Trades: ${totalPaperTrades}`
      );

      await sendTelegram(
        `${mode} Arb executed:\n` +
        `• Pair: ${opportunity.pairLabel}\n` +
        `• Buy: ${opportunity.buyDex} @ ${opportunity.buyPrice.toFixed(6)}\n` +
        `• Sell: ${opportunity.sellDex} @ ${opportunity.sellPrice.toFixed(6)}\n` +
        `• Spread: ${opportunity.spreadBps.toFixed(2)} bps\n` +
        `• Profit: ${netProfitBps.toFixed(2)} bps (${profitSol.toFixed(6)} SOL)\n` +
        `• Paper Balance: ${paperBalanceSol.toFixed(4)} SOL\n` +
        `• Total Trades: ${totalPaperTrades}` +
        (flashLoanMsg ? `\n${flashLoanMsg}` : '')
      );
    } else {
      // ── LIVE Trading Path with Jito Bundles ──
      logger.info(
        `💰 LIVE Arb signal | ${opportunity.pairLabel} | ` +
        `Buy ${opportunity.buyDex} → Sell ${opportunity.sellDex} | ` +
        `Spread: ${opportunity.spreadBps.toFixed(2)} bps | ` +
        `Est. Profit: ${opportunity.estimatedProfitBps.toFixed(2)} bps`
      );

      // ── Circuit breaker / daily loss guard ──
      if (circuitBreakerTripped) {
        logger.warn('LIVE blocked: Circuit breaker tripped');
        await sendTelegram('⚠️ LIVE trade blocked — circuit breaker active. /reset_circuit');
        return false;
      }
      if (dailyLossLimitTripped) {
        logger.warn('LIVE blocked: Daily loss limit reached');
        await sendTelegram('⚠️ LIVE trade blocked — daily loss limit reached.');
        return false;
      }

      // ── Pre-execution validation (tx simulation, fee check) ──
      // Tier 1 guard: simulate before broadcasting
      // TODO: const simResult = await simulateTransaction(transaction, connection);
      // TODO: const feeEstimate = await estimateRealFee(transaction, connection);

      // ── Jito Bundle Execution ──
      if (CONFIG.jitoEnabled) {
        // TODO (Tier 2): Swap SDK integration
        // const buyTx = await buildSwapTx(opportunity.buyDex, opportunity.pairLabel, 'buy', tradeSizeSol);
        // const sellTx = await buildSwapTx(opportunity.sellDex, opportunity.pairLabel, 'sell', tradeSizeSol);
        // const tipTx = await buildTipTx(wallet.publicKey, CONFIG.jitoTipAccount, CONFIG.jitoTipLamports);
        //
        // const jitoResult = await executeArbViaJito(buyTx, sellTx, tipTx, connection);
        // if (jitoResult.success) {
        //   logger.info(`🔥 Jito bundle landed: ${jitoResult.bundleId}`);
        //   await sendTelegram(`🔥 LIVE Arb via Jito!\n• Pair: ${opportunity.pairLabel}\n• Bundle: ${jitoResult.bundleId}`);
        // } else {
        //   logger.error(`Jito bundle rejected: ${jitoResult.error}`);
        //   await sendTelegram(`❌ Jito failed: ${jitoResult.error}`);
        // }

        logger.info(
          `🔥 Jito LIVE ready | ${opportunity.pairLabel} | ` +
          `Tip: ${getTipAccount().slice(0, 8)}... | ` +
          `Swap SDK pending (Tier 2)`
        );
        await sendTelegram(
          `🔍 LIVE Arb detected (Jito ready):\n` +
          `• Pair: ${opportunity.pairLabel}\n` +
          `• Buy: ${opportunity.buyDex} @ ${opportunity.buyPrice.toFixed(6)}\n` +
          `• Sell: ${opportunity.sellDex} @ ${opportunity.sellPrice.toFixed(6)}\n` +
          `• Spread: ${opportunity.spreadBps.toFixed(2)} bps\n` +
          `• Est. Profit: ${opportunity.estimatedProfitBps.toFixed(2)} bps\n` +
          `• Engine: Jito Bundle → ${getTipAccount().slice(0, 8)}...\n` +
          `⚠️ Swap SDK pending — signal detected, execution queued for Tier 2`
        );
      } else {
        // ── Jito disabled — alert user ──
        logger.info(
          `💰 LIVE signal (no Jito) | ${opportunity.pairLabel} | ` +
          `Set JITO_ENABLED=true for atomic execution`
        );
        await sendTelegram(
          `🔍 LIVE Arb detected:\n` +
          `• Pair: ${opportunity.pairLabel}\n` +
          `• Buy: ${opportunity.buyDex} @ ${opportunity.buyPrice.toFixed(6)}\n` +
          `• Sell: ${opportunity.sellDex} @ ${opportunity.sellPrice.toFixed(6)}\n` +
          `• Spread: ${opportunity.spreadBps.toFixed(2)} bps\n` +
          `• Est. Profit: ${opportunity.estimatedProfitBps.toFixed(2)} bps\n` +
          `⚠️ Jito disabled — set JITO_ENABLED=true in .env.Solana`
        );
      }
    }

    return true;
  } catch (err: any) {
    logger.error(`Arb execution failed: ${err.message}`);
    if (CONFIG.paperTrading) {
      await sendTelegram(`📊 PAPER Arb error: ${err.message}`);
    } else {
      await sendTelegram(`❌ Arb failed: ${err.message}`);
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  PAPER STATS COMMAND
// ═══════════════════════════════════════════════════════════════

function getPaperStats(): string {
  if (!CONFIG.paperTrading) return 'Paper trading is disabled.';

  const avgProfitBps = totalPaperTrades > 0
    ? (totalPaperProfitBps / totalPaperTrades).toFixed(2)
    : '0.00';

  const pnl = (paperBalanceSol - CONFIG.paperInitialSol).toFixed(6);
  const pnlSign = parseFloat(pnl) >= 0 ? '+' : '';

  return [
    `📊 PAPER TRADING STATS`,
    `─────────────────────────`,
    `Balance:    ${paperBalanceSol.toFixed(4)} SOL`,
    `Started:    ${CONFIG.paperInitialSol.toFixed(1)} SOL`,
    `P&L:        ${pnlSign}${pnl} SOL`,
    `Trades:     ${totalPaperTrades}`,
    `Avg Profit: ${avgProfitBps} bps/trade`,
    `─────────────────────────`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════
//  STRATEGY INDICATORS (ported from V5 Alpha)
// ═══════════════════════════════════════════════════════════════

function calculateSMA(prices: number[], window: number): number {
  if (prices.length < window) return 0;
  const slice = prices.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / window;
}

function calculateStdDev(prices: number[], window: number): number {
  if (prices.length < window) return 0;
  const slice = prices.slice(-window);
  const mean = calculateSMA(slice, window);
  const squaredDiffs = slice.map(p => Math.pow(p - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / window);
}

function calculateBollingerBands(prices: number[], window: number, k: number) {
  const sma = calculateSMA(prices, window);
  const std = calculateStdDev(prices, window);
  return {
    upper: sma + k * std,
    middle: sma,
    lower: sma - k * std,
  };
}

function calculateRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50;

  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let gains = 0, losses = 0;
  for (const change of changes) {
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ═══════════════════════════════════════════════════════════════
//  MORPHEUS BINARY INDICATORS (ported for V5 Solana)
// ═══════════════════════════════════════════════════════════════

function calculateDeMarker(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0.5;
  let deMax = 0, deMin = 0;
  const start = prices.length - period;
  for (let i = start + 1; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta > 0) deMax += delta;
    else deMin -= delta;
  }
  if (deMax + deMin === 0) return 0.5;
  return deMax / (deMax + deMin);
}

function calculateMomentum(prices: number[], period: number, normalize: boolean): number {
  if (prices.length < period + 1) return 0;
  const ref = prices[prices.length - 1 - period];
  const mom = prices[prices.length - 1] - ref;
  if (normalize && ref !== 0) return mom / ref;
  return mom;
}

function calculateAlligator(
  prices: number[],
  jawPeriod: number, teethPeriod: number, lipsPeriod: number,
  jawShift: number, teethShift: number, lipsShift: number
) {
  const smaShifted = (data: number[], period: number, shift: number): number => {
    const end = data.length - shift;
    if (end < period) return data[data.length - 1];
    return calculateSMA(data.slice(end - period, end), period);
  };
  return {
    jaw: smaShifted(prices, jawPeriod, jawShift),
    teeth: smaShifted(prices, teethPeriod, teethShift),
    lips: smaShifted(prices, lipsPeriod, lipsShift),
  };
}

function calculateStochastic(
  prices: number[], kPeriod: number, dPeriod: number, smooth: number
): { k: number; d: number } {
  if (prices.length < kPeriod + dPeriod) return { k: 50, d: 50 };
  const kValues: number[] = [];
  for (let i = kPeriod; i <= prices.length; i++) {
    const slice = prices.slice(i - kPeriod, i);
    const high = Math.max(...slice);
    const low = Math.min(...slice);
    if (high === low) { kValues.push(50); continue; }
    kValues.push(((prices[i - 1] - low) / (high - low)) * 100);
  }
  const dValues: number[] = [];
  for (let i = dPeriod; i <= kValues.length; i++) {
    dValues.push(kValues.slice(i - dPeriod, i).reduce((a, b) => a + b, 0) / dPeriod);
  }
  return {
    k: kValues[kValues.length - 1],
    d: dValues[dValues.length - 1],
  };
}

function calculateZigZag(prices: number[], depth: number, lookback: number): { swingHigh: boolean; swingLow: boolean } {
  if (prices.length < lookback + depth) return { swingHigh: false, swingLow: false };
  const len = prices.length;
  const current = prices[len - 1];
  let swingHigh = true, swingLow = true;
  for (let i = 1; i <= lookback && i < len; i++) {
    if (prices[len - 1 - i] >= current) swingHigh = false;
  }
  for (let i = 1; i <= lookback && i < len; i++) {
    if (prices[len - 1 - i] <= current) swingLow = false;
  }
  return { swingHigh, swingLow };
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return calculateSMA(prices, prices.length);
  const multiplier = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

// ═══════════════════════════════════════════════════════════════
//  TA STRATEGY DISPATCHER (Morpheus Binary → V5 Solana)
// ═══════════════════════════════════════════════════════════════

const taSignalCooldowns = new Map<string, number>();
const taLastSignal = new Map<string, { type: string; count: number }>();

type TaSignal = { type: 'BUY' | 'SELL' | null; metadata: string };

function analyzeTA(tokenName: string, hist: number[]): TaSignal {
  const currentPrice = hist[hist.length - 1];

  // Cooldown check
  const cd = taSignalCooldowns.get(tokenName) || 0;
  if (cd > 0) return { type: null, metadata: `cooldown(${cd})` };

  let signal: TaSignal = { type: null, metadata: '' };

  switch (CONFIG.taStrategy) {
    // ── RSI_BB ──
    case 'RSI_BB': {
      if (hist.length < Math.max(CONFIG.taBbPeriod, CONFIG.taRsiPeriod)) break;
      const bb = calculateBollingerBands(hist, CONFIG.taBbPeriod, CONFIG.taBbStdDev);
      const rsi = calculateRSI(hist, CONFIG.taRsiPeriod);
      if (currentPrice < bb.lower && rsi < CONFIG.taRsiOs)
        signal = { type: 'BUY', metadata: `BB:${bb.lower.toFixed(6)} RSI:${rsi.toFixed(1)}` };
      else if (currentPrice > bb.upper && rsi > CONFIG.taRsiOb)
        signal = { type: 'SELL', metadata: `BB:${bb.upper.toFixed(6)} RSI:${rsi.toFixed(1)}` };
      break;
    }

    // ── RSI_SMA ──
    case 'RSI_SMA': {
      if (hist.length < Math.max(CONFIG.taSmaSlow, CONFIG.taRsiPeriod)) break;
      const smaFast = calculateSMA(hist, CONFIG.taSmaFast);
      const smaSlow = calculateSMA(hist, CONFIG.taSmaSlow);
      const rsi = calculateRSI(hist, CONFIG.taRsiPeriod);
      if (smaFast > smaSlow && rsi < CONFIG.taRsiOs)
        signal = { type: 'BUY', metadata: `SMA:${smaFast.toFixed(6)}>${smaSlow.toFixed(6)} RSI:${rsi.toFixed(1)}` };
      else if (smaFast < smaSlow && rsi > CONFIG.taRsiOb)
        signal = { type: 'SELL', metadata: `SMA:${smaFast.toFixed(6)}<${smaSlow.toFixed(6)} RSI:${rsi.toFixed(1)}` };
      break;
    }

    // ── DEM_BB ──
    case 'DEM_BB': {
      if (hist.length < Math.max(CONFIG.taBbPeriod, CONFIG.taDemPeriod)) break;
      const bb = calculateBollingerBands(hist, CONFIG.taBbPeriod, CONFIG.taBbStdDev);
      const dem = calculateDeMarker(hist, CONFIG.taDemPeriod);
      if (currentPrice < bb.lower && dem < CONFIG.taDemOs)
        signal = { type: 'BUY', metadata: `BB:${bb.lower.toFixed(6)} DeM:${dem.toFixed(4)}` };
      else if (currentPrice > bb.upper && dem > CONFIG.taDemOb)
        signal = { type: 'SELL', metadata: `BB:${bb.upper.toFixed(6)} DeM:${dem.toFixed(4)}` };
      break;
    }

    // ── ALLIGATOR ──
    case 'ALLIGATOR': {
      const needPeriods = Math.max(CONFIG.taAllJawPeriod + CONFIG.taAllJawShift, CONFIG.taAllTeethPeriod + CONFIG.taAllTeethShift, CONFIG.taAllLipsPeriod + CONFIG.taAllLipsShift);
      if (hist.length < needPeriods) break;
      const all = calculateAlligator(hist, CONFIG.taAllJawPeriod, CONFIG.taAllTeethPeriod, CONFIG.taAllLipsPeriod, CONFIG.taAllJawShift, CONFIG.taAllTeethShift, CONFIG.taAllLipsShift);
      const tol = CONFIG.taAllTolerance;
      // Lips > Teeth > Jaw = uptrend (buy); Lips < Teeth < Jaw = downtrend (sell)
      const spreadUp = all.lips - all.jaw;
      const spreadDn = all.jaw - all.lips;
      if (all.lips > all.teeth + tol && all.teeth > all.jaw + tol)
        signal = { type: 'BUY', metadata: `Lips:${all.lips.toFixed(6)}>Teeth:${all.teeth.toFixed(6)}>Jaw:${all.jaw.toFixed(6)}` };
      else if (all.lips + tol < all.teeth && all.teeth + tol < all.jaw)
        signal = { type: 'SELL', metadata: `Lips:${all.lips.toFixed(6)}<Teeth:${all.teeth.toFixed(6)}<Jaw:${all.jaw.toFixed(6)}` };
      break;
    }

    // ── DEM_MOM ──
    case 'DEM_MOM': {
      if (hist.length < Math.max(CONFIG.taDemPeriod, CONFIG.taMomPeriod)) break;
      const dem = calculateDeMarker(hist, CONFIG.taDemPeriod);
      const mom = calculateMomentum(hist, CONFIG.taMomPeriod, CONFIG.taMomNormalize);
      if (dem < CONFIG.taDemOs && mom > CONFIG.taMomThreshold)
        signal = { type: 'BUY', metadata: `DeM:${dem.toFixed(4)} Mom:${mom.toFixed(6)}` };
      else if (dem > CONFIG.taDemOb && mom < -CONFIG.taMomThreshold)
        signal = { type: 'SELL', metadata: `DeM:${dem.toFixed(4)} Mom:${mom.toFixed(6)}` };
      break;
    }

    // ── ABYSSAL_TRI ──
    case 'ABYSSAL_TRI': {
      const needPeriods = Math.max(
        CONFIG.taAllJawPeriod + CONFIG.taAllJawShift,
        CONFIG.taDemPeriod, CONFIG.taMomPeriod
      );
      if (hist.length < needPeriods) break;
      const all = calculateAlligator(hist, CONFIG.taAllJawPeriod, CONFIG.taAllTeethPeriod, CONFIG.taAllLipsPeriod, CONFIG.taAllJawShift, CONFIG.taAllTeethShift, CONFIG.taAllLipsShift);
      const dem = calculateDeMarker(hist, CONFIG.taDemPeriod);
      const mom = calculateMomentum(hist, CONFIG.taMomPeriod, CONFIG.taMomNormalize);
      const strict = CONFIG.taTriStrict;

      const allBull = all.lips > all.teeth && all.teeth > all.jaw;
      const allBear = all.lips < all.teeth && all.teeth < all.jaw;
      const demBull = dem < CONFIG.taDemOs;
      const demBear = dem > CONFIG.taDemOb;
      const momBull = mom > CONFIG.taMomThreshold;
      const momBear = mom < -CONFIG.taMomThreshold;

      const buyVotes = [allBull, demBull, momBull].filter(Boolean).length;
      const sellVotes = [allBear, demBear, momBear].filter(Boolean).length;

      if (strict) {
        if (allBull && demBull && momBull)
          signal = { type: 'BUY', metadata: `TRI(3/3) DeM:${dem.toFixed(4)} Mom:${mom.toFixed(6)}` };
        else if (allBear && demBear && momBear)
          signal = { type: 'SELL', metadata: `TRI(3/3) DeM:${dem.toFixed(4)} Mom:${mom.toFixed(6)}` };
      } else {
        if (buyVotes >= 2)
          signal = { type: 'BUY', metadata: `TRI(${buyVotes}/3) DeM:${dem.toFixed(4)} Mom:${mom.toFixed(6)}` };
        else if (sellVotes >= 2)
          signal = { type: 'SELL', metadata: `TRI(${sellVotes}/3) DeM:${dem.toFixed(4)} Mom:${mom.toFixed(6)}` };
      }
      break;
    }

    // ── ECHO_BLADE ──
    case 'ECHO_BLADE': {
      if (hist.length < Math.max(CONFIG.taStochK + CONFIG.taStochD, CONFIG.taZigLookback + CONFIG.taZigDepth)) break;
      const stoch = calculateStochastic(hist, CONFIG.taStochK, CONFIG.taStochD, CONFIG.taStochSmooth);
      const zig = calculateZigZag(hist, CONFIG.taZigDepth, CONFIG.taZigLookback);
      let emaVal = 0;
      if (CONFIG.taEmaLength > 0) {
        emaVal = calculateEMA(hist, CONFIG.taEmaLength);
      }

      // BUY: stochastic oversold + swing low forming + price above EMA (if enabled)
      const buyStoch = stoch.k < CONFIG.taStochOs && stoch.d < CONFIG.taStochOs;
      const sellStoch = stoch.k > CONFIG.taStochOb && stoch.d > CONFIG.taStochOb;
      const emaOk = CONFIG.taEmaLength === 0 || (emaVal > 0 && currentPrice > emaVal);
      const emaShortOk = CONFIG.taEmaLength === 0 || (emaVal > 0 && currentPrice < emaVal);

      if (buyStoch && zig.swingLow && emaOk)
        signal = { type: 'BUY', metadata: `Stoch K:${stoch.k.toFixed(1)} D:${stoch.d.toFixed(1)} ZigLow${emaVal ? ` EMA:${emaVal.toFixed(6)}` : ''}` };
      else if (sellStoch && zig.swingHigh && emaShortOk)
        signal = { type: 'SELL', metadata: `Stoch K:${stoch.k.toFixed(1)} D:${stoch.d.toFixed(1)} ZigHigh${emaVal ? ` EMA:${emaVal.toFixed(6)}` : ''}` };
      break;
    }
  }

  // Apply cooldown + consecutive signal limiter
  if (signal.type) {
    taSignalCooldowns.set(tokenName, CONFIG.taSignalCooldownCycles);
    const last = taLastSignal.get(tokenName);
    if (last && last.type === signal.type) {
      const newCount = last.count + 1;
      taLastSignal.set(tokenName, { type: signal.type, count: newCount });
      if (newCount > CONFIG.taSignalMaxConsecutive) {
        return { type: null, metadata: `max-consecutive(${newCount})` };
      }
    } else {
      taLastSignal.set(tokenName, { type: signal.type, count: 1 });
    }
  }

  return signal;
}

// ═══════════════════════════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════════════════════════

async function sendTelegram(message: string): Promise<void> {
  if (!telegramBot) return;
  try {
    await telegramBot.sendMessage(CONFIG.telegramChatId, message, { parse_mode: 'Markdown' });
  } catch (err: any) {
    logger.error(`Telegram send error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN LOOP
// ═══════════════════════════════════════════════════════════════

async function scanCycle(): Promise<void> {
  scanCycleCount++;
  if (cycleStopped || cyclePaused) return;

  // ── Devnet pipeline test (every N cycles, non-blocking) ──
  if (CONFIG.devnetMode && scanCycleCount - lastDevnetTestCycle >= DEVNET_TEST_INTERVAL_CYCLES) {
    lastDevnetTestCycle = scanCycleCount;
    testDevnetLivePipeline().catch(e =>
      logger.warn(`🧪 [DEVNET] Unhandled pipeline error: ${e.message}`)
    );
  }

  try {
    logger.info('--- Scan cycle ---');

    // 1. Fetch prices from all pools
    const prices = await fetchAllPrices();
    logger.info(`Fetched ${prices.length} pool prices`);

    if (prices.length === 0) {
      logger.warn('No prices fetched — check RPC and pool addresses');
      return;
    }

    // 2. Log current prices
    for (const p of prices) {
      logger.info(`${p.dex} ${p.pairLabel}: ${p.price.toFixed(6)}`);
    }

    // 3. Update price history for strategy indicators
    for (const p of prices) {
      const tokenName = p.pairLabel.split('-')[0];
      if (priceHistory[tokenName]) {
        priceHistory[tokenName].push(p.price.toNumber());
        if (priceHistory[tokenName].length > CONFIG.priceHistorySize) {
          priceHistory[tokenName].shift();
        }
      }
    }

    // 4. Detect arbitrage opportunities (arbitrage / hybrid mode)
    if (CONFIG.strategyMode === 'arbitrage' || CONFIG.strategyMode === 'hybrid') {
      const cexPrices = CONFIG.cexScanEnabled ? await fetchAllCexPrices() : [];
      if (CONFIG.cexScanEnabled) logger.info(`Fetched ${cexPrices.length} CEX prices`);
      const arbOpportunities = detectArb(prices, cexPrices);

      // SolGuard pre-warm: queue every pair this cycle actually saw, so the
      // audit cache is hot BEFORE the gate needs it. Deliberately not awaited —
      // the pass is serial and gapped in the background, and nothing here may
      // slow the scan loop down.
      if (CONFIG.solguardEnabled && CONFIG.solguardPrewarm) {
        try {
          const pre = getSolguardPrewarmer();
          const queued = pre.queuePairs(prices.map(p => p.pairLabel), getPairMints);
          if (queued > 0) {
            logger.info(`🛡️ SolGuard pre-warm: queued ${queued} new mint(s) (${pre.queueSize()} in queue)`);
          }
          if (!pre.isRunning()) {
            pre.start();            // arms the timer and runs one pass immediately
          } else if (queued > 0 && !pre.isPassRunning()) {
            // Drain now rather than waiting up to a full interval for the tick.
            // A mint queued here may be needed by the NEXT cycle, so 30s of idle
            // time is 30s of cold gate. runPass() refuses overlap, so calling it
            // from the scan loop cannot stampede the RPC.
            void pre.runPass();
          }
        } catch (e: any) {
          logger.warn(`⚠️ SolGuard pre-warm failed (ignored): ${e?.message ?? e}`);
        }
      }

      if (arbOpportunities.length > 0) {
        logger.info(`🔥 ${arbOpportunities.length} arb opportunity(ies) found!`);
        for (const opp of arbOpportunities) {
          logger.info(`  ${opp.pairLabel}: Buy ${opp.buyDex} @ ${opp.buyPrice.toFixed(6)} → Sell ${opp.sellDex} @ ${opp.sellPrice.toFixed(6)} | Profit: ${opp.estimatedProfitBps.toFixed(2)} bps`);
          await executeArb(opp);
        }
      } else {
        logger.info('No arb opportunities found');
      }
    } else {
      logger.info(`Strategy mode '${CONFIG.strategyMode}' — skipping arb scan`);
    }

    // 5. TA Strategy signals (Morpheus Binary → Solana) — dispatcher
    if (['trend', 'hybrid'].includes(CONFIG.strategyMode)) {
      for (const token of TOKENS) {
        const hist = priceHistory[token.name];
        if (!hist || hist.length < 5) continue;

        const pos = positions[token.name];
        if (pos.holding) continue; // no TA signals while holding (managed by trade logic)

        const sig = analyzeTA(token.name, hist);
        if (!sig.type) continue;

        const currentPrice = hist[hist.length - 1];
        const emoji = sig.type === 'BUY' ? '📈' : '📉';
        const label = sig.type === 'BUY' ? 'BUY' : 'SELL';
        const metaStr = sig.metadata ? ` (${sig.metadata})` : '';

        logger.info(`${emoji} ${label} signal: ${token.name} @ ${currentPrice}${metaStr}`);
        await sendTelegram(`${emoji} ${label} signal: ${token.name}\nPrice: ${currentPrice}\nStrategy: ${CONFIG.taStrategy}${metaStr}\n• Paper Balance: ${paperBalanceSol.toFixed(4)} SOL\n• Total Trades: ${totalPaperTrades}`);
      }
    }

    // Decrement TA cooldowns
    for (const [token, cd] of taSignalCooldowns) {
      if (cd > 0) taSignalCooldowns.set(token, cd - 1);
    }

    // 6. Periodic balance ping (paper mode)
    if (CONFIG.paperTrading && scanCycleCount > 0 && scanCycleCount % CONFIG.statusPingInterval === 0) {
      const avgProfit = totalPaperTrades > 0 ? (totalPaperProfitBps / totalPaperTrades).toFixed(2) : '0.00';
      let statusMsg = `📊 Status #${scanCycleCount}\n• Paper Balance: ${paperBalanceSol.toFixed(4)} SOL\n• Total Trades: ${totalPaperTrades}\n• Avg Profit: ${avgProfit} bps`;
      if (CONFIG.flashLoanEnabled) {
        const flAvg = totalFlashLoanTrades > 0 ? (totalFlashLoanProfitBps / totalFlashLoanTrades).toFixed(2) : '0.00';
        statusMsg += `\n⚡ Flash Loan Fund: ${flashLoanBalanceSol.toFixed(4)} SOL\n• Flash Loan Trades: ${totalFlashLoanTrades} | Avg: ${flAvg} bps`;
      }
      // Jito engine status
      if (CONFIG.jitoEnabled) {
        statusMsg += `\n🔥 Jito: Armed → ${getTipAccount().slice(0, 8)}...`;
      } else {
        statusMsg += `\n💤 Jito: Dormant`;
      }
      // Devnet pipeline health
      if (CONFIG.devnetMode) {
        statusMsg += `\n🧪 Devnet Pipeline: ${devnetPipelineHealthy ? `✅ Healthy (${devnetBalanceSol.toFixed(4)} SOL)` : '⚠️ Check logs'}`;
      }
      await sendTelegram(statusMsg);
    }

    // 6b. SolGuard gate health — proof the gate is actually gating, and that
    // "unresolved" (NOT audited) is visible rather than buried in a log scroll.
    if (
      CONFIG.solguardEnabled &&
      scanCycleCount > 0 &&
      CONFIG.solguardSummaryEveryCycles > 0 &&
      scanCycleCount % CONFIG.solguardSummaryEveryCycles === 0
    ) {
      logger.info(gateCountersSummary());
      if (CONFIG.solguardPrewarm && solguardPrewarmer) {
        const w = solguardPrewarmer.statsSnapshot();
        logger.info(
          `🛡️ SolGuard pre-warm: ${w.passes} pass(es), ${w.warmed} warmed, ` +
          `${w.skippedFresh} already fresh, ${w.timedOut} timeout(s), ${w.failed} failed, ` +
          `queue ${w.queue}${w.lastPassMs === null ? '' : `, last pass ${w.lastPassMs}ms`}`
        );
      }
    }

  } catch (err: any) {
    logger.error(`Scan cycle error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEVNET LIVE PIPELINE TEST
//  Tests sign → simulate → submit → confirm on devnet
//  Costs 0 real SOL. Validates the entire live execution path.
// ═══════════════════════════════════════════════════════════════

async function testDevnetLivePipeline(): Promise<void> {
  const start = Date.now();
  logger.info('🧪 [DEVNET] Pipeline test starting...');

  try {
    // ── 1. Connect to devnet ──
    const devConn = new Connection(CONFIG.devnetRpcUrl, 'confirmed');

    // ── 2. Check devnet SOL balance — abort if broke ──
    const devBalance = await devConn.getBalance(wallet.publicKey);
    if (devBalance < 5000) {
      // 5000 lamports = 0.000005 SOL minimum
      logger.warn(
        `🧪 [DEVNET] Insufficient devnet SOL: ${(devBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
        `(wallet: ${wallet.publicKey.toBase58().slice(0, 8)}...). ` +
        `Drip from solfaucet.com — target devnet address.`
      );
      devnetPipelineHealthy = false;
      return;
    }

    // ── 3. Build self-transfer (tests full pipeline, no external API needed) ──
    const { blockhash, lastValidBlockHeight } = await devConn.getLatestBlockhash();
    const transferLamports = 100; // 0.0000001 SOL — microscopic

    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: transferLamports,
        }),
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);

    // ── 6. Simulate ──
    const simResult = await devConn.simulateTransaction(tx, {
      sigVerify: false,
      commitment: 'confirmed',
    });

    if (simResult.value.err) {
      logger.warn(
        `🧪 [DEVNET] Simulation failed: ${JSON.stringify(simResult.value.err).slice(0, 120)}`
      );
      devnetPipelineHealthy = false;
      return;
    }

    const simUnits = simResult.value.unitsConsumed || 0;
    logger.info(`🧪 [DEVNET] Simulation OK — ${simUnits} CU consumed`);

    // ── 7. Submit ──
    const sig = await devConn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    logger.info(`🧪 [DEVNET] Submitted: ${sig.slice(0, 12)}...`);

    // ── 8. Confirm ──
    const confirmation = await devConn.confirmTransaction(sig, 'confirmed');
    if (confirmation.value.err) {
      logger.warn(
        `🧪 [DEVNET] Confirmation error: ${JSON.stringify(confirmation.value.err).slice(0, 120)}`
      );
      devnetPipelineHealthy = false;
      return;
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    devnetPipelineHealthy = true;
    devnetBalanceSol = devBalance / LAMPORTS_PER_SOL;
    logger.info(
      `✅ [DEVNET] Pipeline healthy: signed + simulated + confirmed in ${elapsed}s | ` +
      `sig: ${sig.slice(0, 16)}... | balance: ${devnetBalanceSol.toFixed(4)} SOL`
    );
  } catch (err: any) {
    devnetPipelineHealthy = false;
    logger.warn(`🧪 [DEVNET] Pipeline test error: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  ENTRY POINT
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════════');
  logger.info('  CYBORG V5 ALPHA — SOLANA EDITION');
  logger.info('  Raydium + Orca + Binance + Kraken Arbitrage Bot');
  logger.info('  Built for Leon by Nxvana 🔥');
  logger.info('═══════════════════════════════════════════════');

  await init();

  // Jito engine status
  if (CONFIG.jitoEnabled) {
    logger.info(`🔥 Jito Bundle Engine ARMED — Tip: ${getTipAccount().slice(0, 8)}...`);
  } else {
    logger.info('💤 Jito Bundle Engine dormant (JITO_ENABLED=false)');
  }

  // Devnet pipeline test status
  if (CONFIG.devnetMode) {
    logger.info('🧪 Devnet pipeline testing ARMED — every 5 scan cycles');
  }

  // SolGuard pre-warm engine. Started before the first scan so that the first
  // gate call is more likely to be a cache hit than a cold ~2.2s round-trip.
  if (CONFIG.solguardEnabled && CONFIG.solguardPrewarm) {
    getSolguardPrewarmer().start();
    logger.info(`🛡️ SolGuard pre-warm ARMED — pass every ${CONFIG.solguardPrewarmIntervalMs / 1000}s`);
  } else {
    logger.info('🛡️ SolGuard pre-warm dormant');
  }

  // Initial scan
  await scanCycle();

  // Scheduled scans
  setInterval(scanCycle, CONFIG.scanIntervalMs);

  logger.info(`Bot running — scanning every ${CONFIG.scanIntervalMs / 1000}s`);
  await sendTelegram('🚀 Cyborg V5 Alpha (Solana) is live!');
}

main().catch(async (err: Error) => {
  logger.error(`Fatal: ${err.message}`);
  await sendTelegram(`🚨 Cyborg V5 Solana CRASHED: ${err.message}`);
  process.exit(1);
});
