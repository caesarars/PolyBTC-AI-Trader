import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import type { ServerResponse } from "http";
import axios from "axios";
import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { MongoClient, Db, Collection } from "mongodb";
import { analyzeMarket } from "./src/services/gemini.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\uFEFF/g, "")
    .replace(/âœ“|✓/g, "[OK]")
    .replace(/âœ—|✗/g, "[SKIP]")
    .replace(/âœ–|✖/g, "[ERR]")
    .replace(/âš¡|⚡/g, "[FAST]")
    .replace(/âš |⚠/g, "[WARN]")
    .replace(/ðŸ’°|💰/g, "$")
    .replace(/â–²|▲/g, "^")
    .replace(/â–¼|▼/g, "v")
    .replace(/â†’|→/g, "->")
    .replace(/â†|←/g, "<-")
    .replace(/â‰¥|≥/g, ">=")
    .replace(/â‰¤|≤/g, "<=")
    .replace(/â€¦|…/g, "...")
    .replace(/Â¢|¢/g, "c")
    .replace(/â€”|—|–/g, "-")
    .replace(/âœ¦|♦/g, "*")
    .replace(/â•”|â•š|â•‘|â•|╔|╚|║|═/g, "=")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/ {2,}/g, " ")
    .trimEnd();
}

const rawConsoleLog = console.log.bind(console);
const rawConsoleWarn = console.warn.bind(console);
const rawConsoleError = console.error.bind(console);

console.log = (...args: any[]) => rawConsoleLog(...args.map((arg) => typeof arg === "string" ? sanitizeTerminalText(arg) : arg));
console.warn = (...args: any[]) => rawConsoleWarn(...args.map((arg) => typeof arg === "string" ? sanitizeTerminalText(arg) : arg));
console.error = (...args: any[]) => rawConsoleError(...args.map((arg) => typeof arg === "string" ? sanitizeTerminalText(arg) : arg));

// â”€â”€ Persistence: data/ directory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DATA_DIR        = path.join(__dirname, "data");
const LOSS_MEMORY_FILE = path.join(DATA_DIR, "loss_memory.json");
const TRADE_LOG_FILE   = path.join(DATA_DIR, "trade_log.jsonl");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

interface TradeLogEntry {
  ts: string;                       // ISO timestamp
  market: string;
  direction: "UP" | "DOWN";
  confidence: number;
  edge: number;
  betAmount: number;
  entryPrice: number;
  pnl: number;
  result: "WIN" | "LOSS";
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  divergenceDirection?: string;
  divergenceStrength?: string;
  btcDelta30s?: number;
  yesDelta30s?: number;
  windowElapsedSeconds: number;
  orderId: string | null;
}

interface CopyTraderPosition {
  assetId: string;
  market: string;
  outcome: string;
  size: string;
  averagePrice: string;
  currentPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
  endDate: string | null;
  eventSlug: string | null;
}

interface PingProbeResult {
  key: string;
  label: string;
  target: string;
  latencyMs: number | null;
  ok: boolean;
  status: number | null;
  error?: string;
}

const PRICE_LAG_PING_TARGETS: Array<{ key: string; label: string; target: string }> = [
  { key: "clob", label: "Polymarket CLOB", target: "https://clob.polymarket.com/" },
  { key: "gamma", label: "Polymarket Gamma", target: "https://gamma-api.polymarket.com/markets?limit=1" },
  { key: "data", label: "Polymarket Data", target: "https://data-api.polymarket.com/leaderboard?limit=1" },
  { key: "binance", label: "Binance Spot", target: "https://api.binance.com/api/v3/time" },
  { key: "coinbase", label: "Coinbase Spot", target: "https://api.exchange.coinbase.com/time" },
];

function gradeLatency(latencyMs: number | null): "excellent" | "good" | "usable" | "slow" | "down" {
  if (latencyMs == null) return "down";
  if (latencyMs <= 80) return "excellent";
  if (latencyMs <= 150) return "good";
  if (latencyMs <= 250) return "usable";
  return "slow";
}

async function probeHttpLatency(
  key: string,
  label: string,
  target: string
): Promise<PingProbeResult & { grade: ReturnType<typeof gradeLatency> }> {
  const startedAt = process.hrtime.bigint();
  try {
    const response = await axios.get(target, {
      timeout: 5000,
      validateStatus: () => true,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    return {
      key,
      label,
      target,
      latencyMs: Math.round(latencyMs),
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      grade: gradeLatency(Math.round(latencyMs)),
    };
  } catch (error: any) {
    return {
      key,
      label,
      target,
      latencyMs: null,
      ok: false,
      status: null,
      error: error?.message || "Ping failed",
      grade: "down",
    };
  }
}

function saveTradeLog(entry: TradeLogEntry): void {
  try {
    fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (e: any) {
    console.error("[Persist] Failed to write trade_log.jsonl:", e.message);
  }
}

function loadTradeLog(): TradeLogEntry[] {
  try {
    if (!fs.existsSync(TRADE_LOG_FILE)) return [];
    return fs.readFileSync(TRADE_LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TradeLogEntry);
  } catch (e: any) {
    console.error("[Persist] Failed to read trade_log.jsonl:", e.message);
    return [];
  }
}

interface PersistedLearning {
  lossMemory: LossMemory[];
  winMemory: WinMemory[];
  consecutiveLosses: number;
  consecutiveWins: number;
  adaptiveConfidenceBoost: number;
  adaptiveLossPenaltyEnabled?: boolean;
  savedAt: string;
}

function saveLearning(): void {
  try {
    const payload: PersistedLearning = {
      lossMemory,
      winMemory,
      consecutiveLosses,
      consecutiveWins,
      adaptiveConfidenceBoost,
      adaptiveLossPenaltyEnabled,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(LOSS_MEMORY_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (e: any) {
    console.error("[Persist] Failed to save loss_memory.json:", e.message);
  }
}

function loadLearning(): void {
  try {
    if (!fs.existsSync(LOSS_MEMORY_FILE)) return;
    const raw = fs.readFileSync(LOSS_MEMORY_FILE, "utf8");
    const data: PersistedLearning = JSON.parse(raw);
    lossMemory.push(...(data.lossMemory || []));
    winMemory.push(...(data.winMemory || []));
    consecutiveLosses       = data.consecutiveLosses       ?? 0;
    consecutiveWins         = data.consecutiveWins         ?? 0;
    adaptiveConfidenceBoost = data.adaptiveConfidenceBoost ?? 0;
    adaptiveLossPenaltyEnabled = data.adaptiveLossPenaltyEnabled ?? true;
    console.log(`[Persist] Loaded learning state: ${lossMemory.length} loss / ${winMemory.length} win patterns, streak=${consecutiveLosses}L/${consecutiveWins}W, boost=+${adaptiveConfidenceBoost}%`);
  } catch (e: any) {
    console.error("[Persist] Failed to load loss_memory.json:", e.message);
  }
}

// 5-minute market session window in seconds
const MARKET_SESSION_SECONDS = 300;

// Initialize CLOB Client and Wallet lazily
let clobClient: ClobClient | null = null;
let clobWallet: ethers.Wallet | null = null;
let clobClientInitPromise: Promise<ClobClient | null> | null = null;
const POLYGON_NETWORK = { name: "polygon", chainId: 137 };
const POLYGON_RPC_URLS = (
  process.env.POLYGON_RPC_URLS ||
  [
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://polygon-mainnet.public.blastapi.io",
  ].join(",")
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const POLYGON_USDC_TOKENS = [
  { symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
  { symbol: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
];
const POLYMARKET_SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || "0");
const POLYMARKET_FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS || undefined;

function createPolygonProvider() {
  if (POLYGON_RPC_URLS.length === 0) {
    throw new Error("No Polygon RPC URLs configured. Set POLYGON_RPC_URLS in .env.");
  }

  return new ethers.providers.FallbackProvider(
    POLYGON_RPC_URLS.map(
      (url) =>
        new ethers.providers.StaticJsonRpcProvider(
          { url, timeout: 8000, allowGzip: true },
          POLYGON_NETWORK
        )
    ),
    1
  );
}

type BtcCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  price: number;
  volume: number;
};

// â”€â”€ Multi-asset support: BTC, ETH, SOL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type TradingAsset = "BTC" | "ETH" | "SOL";
const ENABLED_ASSETS: TradingAsset[] = (
  (process.env.ENABLED_ASSETS || "BTC,ETH,SOL").split(",").map(s => s.trim().toUpperCase()) as TradingAsset[]
);
const ASSET_CONFIG: Record<TradingAsset, {
  binanceSymbol: string;
  coinbaseProduct: string;
  coinGeckoId: string;
  krakenPair: string;
  polySlugPrefix: string;
  divergenceStrong: number; // absolute price $ threshold for STRONG divergence in 30s
  divergenceMod: number;
  divergenceWeak: number;
  label: string;
}> = {
  BTC: { binanceSymbol: "BTCUSDT", coinbaseProduct: "BTC-USD", coinGeckoId: "bitcoin",  krakenPair: "XBTUSD",  polySlugPrefix: "btc-updown-5m", divergenceStrong: 100, divergenceMod: 60,  divergenceWeak: 30,  label: "Bitcoin" },
  ETH: { binanceSymbol: "ETHUSDT", coinbaseProduct: "ETH-USD", coinGeckoId: "ethereum", krakenPair: "ETHUSD",  polySlugPrefix: "eth-updown-5m", divergenceStrong: 6,   divergenceMod: 3.5, divergenceWeak: 1.5, label: "Ethereum" },
  SOL: { binanceSymbol: "SOLUSDT", coinbaseProduct: "SOL-USD", coinGeckoId: "solana",   krakenPair: "SOLUSD",  polySlugPrefix: "sol-updown-5m", divergenceStrong: 2,   divergenceMod: 1,   divergenceWeak: 0.4, label: "Solana" },
};

// Per-asset in-memory caches (BTC uses legacy single vars below for backward compat)
const assetHistoryCaches = new Map<TradingAsset, { data: BtcCandle[]; expiresAt: number }>();
const assetPriceCaches   = new Map<TradingAsset, { data: { symbol: string; price: string; source?: string }; expiresAt: number }>();
const assetIndicatorsCaches = new Map<TradingAsset, { data: any; expiresAt: number }>();

let btcHistoryCache: { data: BtcCandle[]; expiresAt: number } | null = null;
let btcPriceCache: { data: { symbol: string; price: string; source?: string }; expiresAt: number } | null = null;
let btcIndicatorsCache: { data: any; expiresAt: number } | null = null;
let mongoDb: Db | null = null;
let mongoInitPromise: Promise<Db | null> | null = null;
let btcSyncInterval: NodeJS.Timeout | null = null;
let positionAutomationInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let lastHeartbeatId: string = "";
let positionAutomationRunning = false;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "polybtc";
const MONGODB_CACHE_COLLECTION = process.env.MONGODB_CACHE_COLLECTION || "market_cache";
const MONGODB_PRICE_SNAPSHOTS_COLLECTION = process.env.MONGODB_PRICE_SNAPSHOTS_COLLECTION || "btc_price_snapshots";
const MONGODB_CHART_COLLECTION = process.env.MONGODB_CHART_COLLECTION || "chart";
const MONGODB_POSITION_AUTOMATION_COLLECTION =
  process.env.MONGODB_POSITION_AUTOMATION_COLLECTION || "position_automation";
const BTC_PRICE_CACHE_MS = 5_000;
const BTC_HISTORY_CACHE_MS = 15_000;
const BTC_INDICATORS_CACHE_MS = 15_000;
const BTC_PRICE_SNAPSHOT_TTL_SECONDS = Number(process.env.BTC_PRICE_SNAPSHOT_TTL_SECONDS || 60 * 60 * 24 * 14);
const BTC_CANDLE_TTL_SECONDS = Number(process.env.BTC_CANDLE_TTL_SECONDS || 60 * 60 * 24 * 30);
const BTC_BACKGROUND_SYNC_MS = Number(process.env.BTC_BACKGROUND_SYNC_MS || 5_000);
const POSITION_AUTOMATION_SYNC_MS = Number(process.env.POSITION_AUTOMATION_SYNC_MS || 3_000);
const ANALYSIS_MIN_ENTRY_WINDOW_SECONDS = 120;
const ANALYSIS_MAX_ENTRY_WINDOW_SECONDS = 179;
const ANALYSIS_COIN_FLIP_MIN_PRICE = 0.49;
const ANALYSIS_COIN_FLIP_MAX_PRICE = 0.52;

// â”€â”€ Bot configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BOT_SCAN_INTERVAL_MS = Number(process.env.BOT_SCAN_INTERVAL_MS || 5_000);
const BOT_MIN_CONFIDENCE = Number(process.env.BOT_MIN_CONFIDENCE || 65);
const BOT_MIN_EDGE = Number(process.env.BOT_MIN_EDGE || 0.10);
const BOT_KELLY_FRACTION = Number(process.env.BOT_KELLY_FRACTION || 0.40);
const BOT_MAX_BET_USDC = Number(process.env.BOT_MAX_BET_USDC || 250);
const BOT_FIXED_TRADE_USDC_DEFAULT = Number(process.env.BOT_FIXED_TRADE_USDC || 2);

// Runtime-overrideable thresholds for the active price-lag mispricing strategy
let priceLagMinConfidence = BOT_MIN_CONFIDENCE;
let priceLagMinEdge       = BOT_MIN_EDGE;

function getPriceLagConfig() {
  return {
    minConfidence:    priceLagMinConfidence,
    minEdge:          priceLagMinEdge,
    kellyFraction:    BOT_KELLY_FRACTION,
    maxBetUsdc:       BOT_MAX_BET_USDC,
    balanceCap:       0.25,
    earlyDeadZoneEnd: 19,
    bestLagZoneStart: 20,
    bestLagZoneEnd:   150,
    lateNoTradeStart: 151,
  };
}

type PriceLagTimingZone = "EARLY_DEAD_ZONE" | "BEST_LAG_ZONE" | "LATE_NO_TRADE_ZONE";

function getPriceLagTiming(windowElapsedSeconds: number): {
  zone: PriceLagTimingZone;
  allowTrading: boolean;
  reason: string;
} {
  const cfg = getPriceLagConfig();
  if (windowElapsedSeconds <= cfg.earlyDeadZoneEnd) {
    return {
      zone: "EARLY_DEAD_ZONE",
      allowTrading: false,
      reason: `Early dead zone (${windowElapsedSeconds}s) - waiting for market structure and lag buffers`,
    };
  }
  if (windowElapsedSeconds <= cfg.bestLagZoneEnd) {
    return {
      zone: "BEST_LAG_ZONE",
      allowTrading: true,
      reason: `Best lag zone (${cfg.bestLagZoneStart}-${cfg.bestLagZoneEnd}s)`,
    };
  }
  return {
    zone: "LATE_NO_TRADE_ZONE",
    allowTrading: false,
    reason: `Late no-trade zone (${windowElapsedSeconds}s) - too close to expiry for lag scalp`,
  };
}

// â”€â”€ Dynamic Kelly fraction based on confidence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Price-lag mispricing strategy scales the fraction with conviction level:
//   65â€“74% â†’ 0.25  (borderline signal, bet small)
//   75â€“84% â†’ 0.50  (normal, use base fraction)
//   85â€“89% â†’ 0.55  (strong signal, size up)
//   90%+   â†’ 0.65  (very high conviction, max size)
function dynamicKellyFraction(confidence: number): number {
  if (confidence >= 90) return 0.65;
  if (confidence >= 85) return 0.55;
  if (confidence >= 75) return 0.50;
  return 0.25;
}

// â”€â”€ Bot runtime state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let botEnabled = process.env.BOT_AUTO_START === "true";
let botRunning = false;
let botInterval: NodeJS.Timeout | null = null;
let botSessionStartBalance: number | null = null;
let botSessionTradesCount = 0;
let botLastWindowStart = 0;
let botFixedTradeUsdc = Number.isFinite(BOT_FIXED_TRADE_USDC_DEFAULT)
  ? Math.max(1, Math.min(5, Math.round(BOT_FIXED_TRADE_USDC_DEFAULT)))
  : 2;
// Per-asset analyzed-this-window tracking (keyed by asset â†’ Set of market IDs)
const botAnalyzedThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC", "ETH", "SOL"] as TradingAsset[]).map(a => [a, new Set<string>()])
);
// Backward-compat alias (used by BTC path until loop refactor is complete)
const botAnalyzedThisWindow = botAnalyzedThisWindowByAsset.get("BTC")!;

// â”€â”€ Auto-calibrator state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// When enabled, runs a FastLoop backtest at the start of each new window and
// uses win-rate to adjust FastLoop minimum strength + confidence boost for that window.
let autoCalibrateEnabled = false;
interface CalibrationState {
  runAt: number;           // unix seconds
  totalWindows: number;
  signaledCount: number;
  correctCount: number;
  winRate: number | null;  // % e.g. 62.5
  // Derived adjustments applied to the bot this window:
  fastLoopMinStrength: "STRONG" | "MODERATE"; // min strength to count as signal
  confidenceDelta: number;                    // +/- applied to effectiveMinConf
  note: string;
}
let calibrationState: CalibrationState | null = null;

async function runAutoCalibration(): Promise<void> {
  try {
    const historyResult = await getBtcHistory();
    if (!historyResult?.history?.length) return;
    const history = historyResult.history;
    const minStart = 20;
    const maxWindows = Math.floor((history.length - minStart - 5) / 3);
    const actualWindows = Math.min(40, maxWindows);
    let signaledCount = 0, correctCount = 0;
    for (let w = 0; w < actualWindows; w++) {
      const endIdx = minStart + w * 3;
      if (endIdx + 5 >= history.length) break;
      const slice = history.slice(0, endIdx + 1);
      const future = history.slice(endIdx + 1, endIdx + 6);
      let fastMom: FastLoopMomentum | null = null;
      try { fastMom = computeFastLoopMomentum(slice); } catch {}
      const entryClose = history[endIdx].close;
      const exitClose = future.length > 0 ? future[future.length - 1].close : null;
      const actualDir = exitClose != null ? (exitClose > entryClose ? "UP" : exitClose < entryClose ? "DOWN" : "NEUTRAL") : null;
      const signaled = !!(fastMom && fastMom.strength !== "WEAK" && fastMom.direction !== "NEUTRAL");
      if (signaled) {
        signaledCount++;
        if (actualDir !== null && fastMom!.direction === actualDir) correctCount++;
      }
    }
    const winRate = signaledCount > 0 ? parseFloat(((correctCount / signaledCount) * 100).toFixed(1)) : null;

    // Derive adjustments based on win rate
    let fastLoopMinStrength: CalibrationState["fastLoopMinStrength"] = "MODERATE";
    let confidenceDelta = 0;
    let note = "";
    if (winRate === null || signaledCount < 5) {
      note = "Not enough signal samples â€” using defaults";
    } else if (winRate >= 65) {
      fastLoopMinStrength = "MODERATE";
      confidenceDelta = -2; // slightly easier threshold
      note = `Win rate ${winRate}% â€” GOOD signal quality, -2% conf threshold`;
    } else if (winRate >= 50) {
      fastLoopMinStrength = "MODERATE";
      confidenceDelta = 0;
      note = `Win rate ${winRate}% â€” AVERAGE signal quality, no adjustment`;
    } else {
      fastLoopMinStrength = "STRONG"; // only trust STRONG signals
      confidenceDelta = +5;           // require higher confidence
      note = `Win rate ${winRate}% â€” WEAK signal quality, require STRONG only +5% conf`;
    }

    calibrationState = {
      runAt: Math.floor(Date.now() / 1000),
      totalWindows: actualWindows,
      signaledCount,
      correctCount,
      winRate,
      fastLoopMinStrength,
      confidenceDelta,
      note,
    };
    console.log(`[Calibrator] Win rate=${winRate ?? "?"}% (${correctCount}/${signaledCount} signals) â†’ minStrength=${fastLoopMinStrength} confDelta=${confidenceDelta > 0 ? "+" : ""}${confidenceDelta}%`);
  } catch { /* non-fatal */ }
}

// â”€â”€ Fast loop momentum history ring buffer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface MomentumHistoryPoint {
  ts: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
  vw: number;
  raw: number;
  accel: number;
}
const momentumHistory: MomentumHistoryPoint[] = [];
const MOMENTUM_HISTORY_MAX = 60;

// â”€â”€ Last known STRONG divergence timestamp (for notification dedup) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let lastStrongDivergenceNotifiedAt = 0;

// â”€â”€ Divergence fast-path state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const activeBotMarketByAsset = new Map<TradingAsset, any>(); // per-asset active market
let activeBotMarket: any = null;          // kept for backward-compat with divergence tracker sync (line below)
let lastKnownBalance: number | null = null; // most recent balance fetch, used by fast path
let lastDivergenceFastTradeAt = 0;        // unix-seconds cooldown tracker
let divergenceFastTradeRunning = false;   // mutex â€” prevents concurrent fast-path execution


// â”€â”€ Per-window AI result cache (reuse rec across cycles, only re-check price) â”€â”€
let currentWindowAiCache: { windowStart: number; marketId: string; asset: TradingAsset; rec: any } | null = null;

// â”€â”€ Divergence tracker (asset price vs YES token lag detector) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface PricePoint { ts: number; price: number; }
const btcRingBuffer: PricePoint[] = [];   // 5s samples, 10-min window (named btc for compat)
const yesRingBuffer: PricePoint[] = [];   // YES token ask price
const currentWindowYesTokenIdByAsset = new Map<TradingAsset, string | null>();
const currentWindowNoTokenIdByAsset  = new Map<TradingAsset, string | null>();
// Convenience accessors used by divergence tracker (always reflects currentDivergenceAsset)
let currentWindowYesTokenId: string | null = null;
let currentWindowNoTokenId:  string | null = null;
let currentDivergenceAsset: TradingAsset = "BTC"; // tracks which asset divergence monitors

interface DivergenceState {
  btcDelta30s: number;       // raw $ BTC change in last 30s
  btcDelta60s: number;       // raw $ BTC change in last 60s
  yesDelta30s: number;       // YES token Â¢ change in last 30s
  divergence: number;        // 0.0â€“1.0+ normalized score
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK" | "NONE";
  currentBtcPrice: number | null;
  currentYesAsk:   number | null;
  currentNoAsk:    number | null;
  updatedAt: number;         // unix seconds
}
const divergenceStateByAsset = new Map<TradingAsset, DivergenceState>();
let divergenceTrackerInterval: NodeJS.Timeout | null = null;

// â”€â”€ Current entry snapshot (shown in dashboard widget) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface EntrySnapshot {
  market: string;
  windowStart: number;
  yesPrice: number | null;
  noPrice: number | null;
  direction: string | null;
  confidence: number | null;
  edge: number | null;
  riskLevel: string | null;
  estimatedBet: number | null;
  btcPrice: number | null;
  asset?: TradingAsset;
  divergence: { direction: string; strength: string; btcDelta30s: number; yesDelta30s: number; } | null;
  fastLoopMomentum: { direction: string; strength: string; vw: number; } | null;
  updatedAt: string;
}
let currentEntrySnapshot: EntrySnapshot | null = null;

interface BotLogEntry {
  timestamp: string;
  market: string;
  decision: string;
  direction: string;
  confidence: number;
  edge: number;
  riskLevel: string;
  reasoning: string;
  tradeExecuted: boolean;
  tradeAmount?: number;
  tradePrice?: number;
  orderId?: string | null;
  error?: string;
}
const botLog: BotLogEntry[] = [];

interface RawLogEntry {
  ts: string;
  level: string;
  msg: string;
}
const rawLog: RawLogEntry[] = [];
const cexLog: RawLogEntry[] = [];

// â”€â”€ SSE clients for real-time push â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const sseClients = new Set<ServerResponse>();
function pushSSE(event: string, data: unknown): void {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

interface PendingResult {
  eventSlug: string;
  marketId: string;
  market: string;
  tokenId: string;
  direction: string;
  outcome: string;
  entryPrice: number;
  betAmount: number;
  orderId: string | null;
  windowEnd: number;
  // Context captured at trade time â€” used for learning
  confidence: number;
  edge: number;
  reasoning: string;
  windowElapsedSeconds: number;
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  asset?: TradingAsset;
}
const pendingResults = new Map<string, PendingResult>();

// â”€â”€ Adaptive learning state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface LossMemory {
  timestamp: string;
  market: string;
  asset?: TradingAsset;
  direction: string;
  confidence: number;
  edge: number;
  entryPrice: number;
  betAmount: number;
  pnl: number;
  windowElapsedSeconds: number;
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  reasoning: string;
  lesson: string;
}
const lossMemory: LossMemory[] = [];

interface WinMemory {
  timestamp: string;
  market: string;
  asset?: TradingAsset;
  direction: string;
  confidence: number;
  edge: number;
  entryPrice: number;
  betAmount: number;
  pnl: number;
  windowElapsedSeconds: number;
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  lesson: string;
}
const winMemory: WinMemory[] = [];

const consecutiveLossesByAsset   = new Map<TradingAsset, number>([["BTC",0],["ETH",0],["SOL",0]]);
const consecutiveWinsByAsset     = new Map<TradingAsset, number>([["BTC",0],["ETH",0],["SOL",0]]);
const adaptiveConfidenceByAsset  = new Map<TradingAsset, number>([["BTC",0],["ETH",0],["SOL",0]]);
// Global aliases kept for persistence (sum/avg not needed â€” persist per entry in lossMemory)
let consecutiveLosses = 0;
let consecutiveWins   = 0;
let adaptiveConfidenceBoost = 0; // legacy â€” used only for saveLearning() backward-compat
let adaptiveLossPenaltyEnabled = true;

function generateLesson(pending: PendingResult): string {
  const rules: string[] = [];
  const { direction, rsi, emaCross, signalScore, windowElapsedSeconds, confidence, entryPrice, imbalanceSignal } = pending;

  // â”€â”€ Momentum contradictions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (direction === "UP"   && rsi !== undefined && rsi > 65)  rules.push(`RSI overbought (${rsi.toFixed(0)}) on UP â€” reversal risk`);
  if (direction === "DOWN" && rsi !== undefined && rsi < 35)  rules.push(`RSI oversold (${rsi.toFixed(0)}) on DOWN â€” reversal risk`);
  if (direction === "UP"   && rsi !== undefined && rsi > 55 && rsi <= 65) rules.push(`RSI elevated (${rsi.toFixed(0)}) on UP â€” limited upside room`);
  if (direction === "DOWN" && rsi !== undefined && rsi < 45 && rsi >= 35) rules.push(`RSI depressed (${rsi.toFixed(0)}) on DOWN â€” limited downside room`);
  if (direction === "UP"   && emaCross === "BEARISH") rules.push("EMA cross BEARISH contradicts UP direction");
  if (direction === "DOWN" && emaCross === "BULLISH") rules.push("EMA cross BULLISH contradicts DOWN direction");

  // â”€â”€ Signal score alignment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (direction === "UP"   && signalScore !== undefined && signalScore < 0) rules.push(`Signal score ${signalScore} opposes UP direction`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore > 0) rules.push(`Signal score +${signalScore} opposes DOWN direction`);
  if (direction === "UP"   && signalScore !== undefined && signalScore === 0) rules.push(`Signal score neutral (0) â€” no technical edge on UP`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore === 0) rules.push(`Signal score neutral (0) â€” no technical edge on DOWN`);

  // â”€â”€ Entry price zone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (entryPrice >= 0.48 && entryPrice <= 0.53) rules.push(`Entry at coin-flip zone (${(entryPrice * 100).toFixed(0)}Â¢) â€” maximum binary market uncertainty`);
  if (entryPrice > 0.60) rules.push(`High entry price (${(entryPrice * 100).toFixed(0)}Â¢) â€” limited upside, asymmetric loss risk`);

  // â”€â”€ Order book pressure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (direction === "UP"   && imbalanceSignal === "SELL_PRESSURE") rules.push("Order book SELL_PRESSURE contradicted UP entry (crowd was selling YES)");
  if (direction === "DOWN" && imbalanceSignal === "BUY_PRESSURE")  rules.push("Order book BUY_PRESSURE contradicted DOWN entry (crowd was buying YES)");
  if (!imbalanceSignal || imbalanceSignal === "?")                  rules.push("Order book data unavailable at entry â€” blind entry without crowd signal");

  // â”€â”€ Timing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (windowElapsedSeconds > 180) rules.push(`Late entry at ${windowElapsedSeconds}s â€” only ${300 - windowElapsedSeconds}s remaining`);
  if (windowElapsedSeconds >= 30 && windowElapsedSeconds <= 90)    rules.push(`Mid-window entry at ${windowElapsedSeconds}s â€” high-noise zone, FastLoop not yet stable`);
  if (windowElapsedSeconds < 20)  rules.push(`Very early entry at ${windowElapsedSeconds}s â€” insufficient market data`);

  // â”€â”€ Confidence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (confidence < 75) rules.push(`Borderline confidence (${confidence}%) â€” below strong conviction threshold`);

  return rules.length > 0 ? rules.join(" | ") : "Loss without clear signal contradictions â€” review divergence context";
}

function generateWinLesson(pending: PendingResult): string {
  const reasons: string[] = [];
  const { direction, rsi, emaCross, signalScore, windowElapsedSeconds, confidence } = pending;

  if (direction === "UP"   && rsi !== undefined && rsi < 45) reasons.push(`RSI oversold (${rsi.toFixed(0)}) on UP â€” momentum room available`);
  if (direction === "DOWN" && rsi !== undefined && rsi > 55) reasons.push(`RSI overbought (${rsi.toFixed(0)}) on DOWN â€” reversal confirmed`);
  if (direction === "UP"   && emaCross === "BULLISH")         reasons.push("EMA cross BULLISH aligned with UP direction");
  if (direction === "DOWN" && emaCross === "BEARISH")         reasons.push("EMA cross BEARISH aligned with DOWN direction");
  if (direction === "UP"   && signalScore !== undefined && signalScore > 0) reasons.push(`Strong positive signal score (+${signalScore}) on UP trade`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore < 0) reasons.push(`Strong negative signal score (${signalScore}) on DOWN trade`);
  if (windowElapsedSeconds <= 150) reasons.push(`Early entry at ${windowElapsedSeconds}s â€” maximum time for move to develop`);
  if (confidence >= 72)            reasons.push(`High confidence entry (${confidence}%) â€” strong conviction`);

  return reasons.length > 0 ? reasons.join(" | ") : "Aligned signals with good timing";
}

type CacheDocument<T> = {
  _id: string;
  payload: T;
  source: string;
  fetchedAt: Date;
};

type BtcPriceSnapshotDocument = {
  symbol: string;
  price: number;
  source: string;
  fetchedAt: Date;
};

type BtcCandleDocument = {
  symbol: string;
  interval: "1m";
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  fetchedAt: Date;
};

type PositionAutomationDocument = {
  assetId: string;
  market: string;
  outcome: string;
  averagePrice: string;
  size: string;
  takeProfit: string;
  stopLoss: string;
  trailingStop: string;
  armed: boolean;
  windowEnd?: number;       // unix seconds â€” when the 5-min market resolves
  highestPrice?: string;
  trailingStopPrice?: string;
  lastPrice?: string;
  status?: string;
  lastExitOrderId?: string | null;
  updatedAt: Date;
  lastTriggeredAt?: Date | null;
};

async function getMongoDb() {
  if (!MONGODB_URI) return null;
  if (mongoDb) return mongoDb;
  if (mongoInitPromise) return mongoInitPromise;

  mongoInitPromise = (async () => {
    try {
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      mongoDb = MONGODB_DB_NAME ? client.db(MONGODB_DB_NAME) : client.db();
      return mongoDb;
    } catch (error: any) {
      console.warn("MongoDB connection failed. Continuing without persistent BTC cache.", error?.message || error);
      return null;
    } finally {
      mongoInitPromise = null;
    }
  })();

  return mongoInitPromise;
}

async function getCacheCollection() {
  const db = await getMongoDb();
  return db?.collection<CacheDocument<any>>(MONGODB_CACHE_COLLECTION) || null;
}

async function getPriceSnapshotsCollection() {
  const db = await getMongoDb();
  return db?.collection<BtcPriceSnapshotDocument>(MONGODB_PRICE_SNAPSHOTS_COLLECTION) || null;
}

async function getCandlesCollection() {
  const db = await getMongoDb();
  return db?.collection<BtcCandleDocument>(MONGODB_CHART_COLLECTION) || null;
}

async function getPositionAutomationCollection() {
  const db = await getMongoDb();
  return db?.collection<PositionAutomationDocument>(MONGODB_POSITION_AUTOMATION_COLLECTION) || null;
}

async function ensureMongoCollections() {
  try {
    const db = await getMongoDb();
    if (!db) return;

    const marketCache = db.collection(MONGODB_CACHE_COLLECTION);
    const priceSnapshots = db.collection(MONGODB_PRICE_SNAPSHOTS_COLLECTION);
    const candles = db.collection(MONGODB_CHART_COLLECTION);
    const automations = db.collection(MONGODB_POSITION_AUTOMATION_COLLECTION);

    await Promise.all([
      marketCache.createIndex({ fetchedAt: -1 }),
      priceSnapshots.createIndex({ symbol: 1, fetchedAt: -1 }),
      priceSnapshots.createIndex({ fetchedAt: -1 }),
      priceSnapshots.createIndex(
        { fetchedAt: 1 },
        { expireAfterSeconds: BTC_PRICE_SNAPSHOT_TTL_SECONDS, name: "btc_price_ttl" }
      ),
      candles.createIndex({ symbol: 1, interval: 1, time: -1 }, { unique: true }),
      candles.createIndex({ fetchedAt: -1 }),
      candles.createIndex(
        { fetchedAt: 1 },
        { expireAfterSeconds: BTC_CANDLE_TTL_SECONDS, name: "btc_candle_ttl" }
      ),
      automations.createIndex({ assetId: 1 }, { unique: true }),
      automations.createIndex({ armed: 1, updatedAt: -1 }),
    ]);
  } catch (error: any) {
    console.warn("MongoDB index initialization failed:", error?.message || error);
  }
}

async function readPersistentCache<T>(id: string, maxAgeMs: number) {
  const collection = await getCacheCollection();
  if (!collection) return null;

  const doc = await collection.findOne({ _id: id });
  if (!doc) return null;

  const ageMs = Date.now() - new Date(doc.fetchedAt).getTime();
  return {
    payload: doc.payload as T,
    source: ageMs <= maxAgeMs ? "mongo-cache" : "mongo-stale-cache",
    fetchedAt: doc.fetchedAt,
    stale: ageMs > maxAgeMs,
  };
}

async function writePersistentCache<T>(id: string, payload: T, source: string) {
  const collection = await getCacheCollection();
  if (!collection) return;

  await collection.updateOne(
    { _id: id },
    {
      $set: {
        payload,
        source,
        fetchedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function writeBtcPriceSnapshot(payload: { symbol: string; price: string; source?: string }) {
  const collection = await getPriceSnapshotsCollection();
  if (!collection) return;

  const numericPrice = Number(payload.price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

  await collection.insertOne({
    symbol: payload.symbol,
    price: numericPrice,
    source: payload.source || "unknown",
    fetchedAt: new Date(),
  });
}

async function writeBtcCandles(history: BtcCandle[], source: string) {
  const collection = await getCandlesCollection();
  if (!collection || !history.length) return;

  await collection.bulkWrite(
    history.map((candle) => ({
      updateOne: {
        filter: { symbol: "BTCUSDT", interval: "1m", time: candle.time },
        update: {
          $set: {
            symbol: "BTCUSDT",
            interval: "1m",
            time: candle.time,
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
            volume: Number(candle.volume || 0),
            source,
            fetchedAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

async function persistBtcHistory(history: BtcCandle[], source: string) {
  const results = await Promise.allSettled([
    writePersistentCache("btc-history-1m", history, source),
    writeBtcCandles(history, source),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("BTC history persistence failed:", result.reason?.message || result.reason);
    }
  }
}

async function persistBtcPrice(payload: { symbol: string; price: string; source?: string }) {
  const results = await Promise.allSettled([
    writePersistentCache("btc-price-latest", payload, payload.source || "unknown"),
    writeBtcPriceSnapshot(payload),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("BTC price persistence failed:", result.reason?.message || result.reason);
    }
  }
}

async function persistBtcIndicators(indicators: any, source: string) {
  try {
    await writePersistentCache("btc-indicators-latest", indicators, source);
  } catch (error: any) {
    console.warn("BTC indicators persistence failed:", error?.message || error);
  }
}

function getCacheMeta(expiresAt?: number) {
  const now = Date.now();
  const ageMs = expiresAt ? Math.max(0, expiresAt - now) : null;
  return {
    stale: expiresAt ? expiresAt <= now : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    ttlRemainingMs: ageMs,
  };
}

async function getMongoCacheDebug() {
  const [cacheCollection, priceCollection, candleCollection] = await Promise.all([
    getCacheCollection(),
    getPriceSnapshotsCollection(),
    getCandlesCollection(),
  ]);

  const [priceCacheDoc, historyCacheDoc, indicatorsCacheDoc, latestPriceSnapshot, latestCandle, counts] =
    await Promise.all([
      cacheCollection?.findOne({ _id: "btc-price-latest" }),
      cacheCollection?.findOne({ _id: "btc-history-1m" }),
      cacheCollection?.findOne({ _id: "btc-indicators-latest" }),
      priceCollection?.findOne({}, { sort: { fetchedAt: -1 } }),
      candleCollection?.findOne({}, { sort: { time: -1 } }),
      Promise.all([
        priceCollection?.countDocuments({}) || 0,
        candleCollection?.countDocuments({}) || 0,
      ]),
    ]);

  return {
    enabled: Boolean(MONGODB_URI),
    dbName: MONGODB_DB_NAME || null,
    collections: {
      cache: MONGODB_CACHE_COLLECTION,
      priceSnapshots: MONGODB_PRICE_SNAPSHOTS_COLLECTION,
      chart: MONGODB_CHART_COLLECTION,
    },
    backgroundSyncMs: BTC_BACKGROUND_SYNC_MS,
    ttlPolicy: {
      priceSnapshotsSeconds: BTC_PRICE_SNAPSHOT_TTL_SECONDS,
      candlesSeconds: BTC_CANDLE_TTL_SECONDS,
    },
    cacheDocs: {
      btcPriceLatest: priceCacheDoc
        ? { fetchedAt: priceCacheDoc.fetchedAt, source: priceCacheDoc.source }
        : null,
      btcHistoryLatest: historyCacheDoc
        ? { fetchedAt: historyCacheDoc.fetchedAt, source: historyCacheDoc.source }
        : null,
      btcIndicatorsLatest: indicatorsCacheDoc
        ? { fetchedAt: indicatorsCacheDoc.fetchedAt, source: indicatorsCacheDoc.source }
        : null,
    },
    snapshots: {
      priceCount: counts[0],
      candleCount: counts[1],
      latestPriceSnapshot,
      latestCandle,
    },
    inMemory: {
      btcPrice: btcPriceCache ? getCacheMeta(btcPriceCache.expiresAt) : null,
      btcHistory: btcHistoryCache ? getCacheMeta(btcHistoryCache.expiresAt) : null,
      btcIndicators: btcIndicatorsCache ? getCacheMeta(btcIndicatorsCache.expiresAt) : null,
    },
  };
}

async function runBtcBackgroundSync() {
  try {
    await Promise.all([getBtcHistory(true), getBtcPrice(true), getBtcIndicators(true)]);
  } catch (error: any) {
    console.warn("BTC background sync failed:", error?.message || error);
  }
}

function startBtcBackgroundSync() {
  if (!MONGODB_URI || btcSyncInterval) return;

  void runBtcBackgroundSync();
  btcSyncInterval = setInterval(() => {
    void runBtcBackgroundSync();
  }, BTC_BACKGROUND_SYNC_MS);
}

async function fetchBtcPriceFromBinance() {
  const binanceHosts = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
  ];

  for (const host of binanceHosts) {
    try {
      const response = await axios.get(`${host}/api/v3/ticker/price`, {
        params: { symbol: "BTCUSDT" },
        timeout: 5000,
      });
      return { symbol: "BTCUSDT", price: String(response.data.price), source: host };
    } catch {
      // try next host
    }
  }

  return null;
}

async function fetchBtcPriceFromCoinbase() {
  try {
    const response = await axios.get("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      timeout: 5000,
    });
    return {
      symbol: "BTCUSDT",
      price: String(response.data?.data?.amount),
      source: "coinbase",
    };
  } catch {
    return null;
  }
}

async function fetchBtcPriceFromKraken() {
  try {
    const response = await axios.get("https://api.kraken.com/0/public/Ticker", {
      params: { pair: "XBTUSD" },
      timeout: 5000,
    });
    const ticker = response.data?.result?.XXBTZUSD || response.data?.result?.XBTUSD;
    const price = ticker?.c?.[0];
    if (!price) return null;
    return { symbol: "BTCUSDT", price: String(price), source: "kraken" };
  } catch {
    return null;
  }
}

async function fetchBtcPriceFromCoinGecko() {
  try {
    const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: { ids: "bitcoin", vs_currencies: "usd" },
      timeout: 8000,
    });
    const price = response.data?.bitcoin?.usd;
    if (price == null) return null;
    return { symbol: "BTCUSDT", price: String(price), source: "coingecko" };
  } catch {
    return null;
  }
}

async function fetchBtcHistoryFromBinance() {
  const binanceHosts = [
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
  ];

  for (const host of binanceHosts) {
    try {
      const response = await axios.get(`${host}/api/v3/klines`, {
        params: { symbol: "BTCUSDT", interval: "1m", limit: 60 },
        timeout: 5000,
      });
      const history = response.data.map((k: any) => ({
        time: Math.floor(k[0] / 1000),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        price: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      })) as BtcCandle[];
      return { history, source: host };
    } catch {
      // try next host
    }
  }

  return null;
}

async function fetchBtcHistoryFromCoinGecko() {
  try {
    const response = await axios.get("https://api.coingecko.com/api/v3/coins/bitcoin/ohlc", {
      params: { vs_currency: "usd", days: 1 },
      timeout: 10000,
    });
    const history = response.data.slice(-60).map((k: number[]) => ({
      time: Math.floor(k[0] / 1000),
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      price: k[4],
      volume: 0,
    })) as BtcCandle[];
    return { history, source: "coingecko" };
  } catch {
    return null;
  }
}

async function fetchBtcHistoryFromCoinbase() {
  try {
    const response = await axios.get("https://api.exchange.coinbase.com/products/BTC-USD/candles", {
      params: { granularity: 60 },
      timeout: 8000,
      headers: { Accept: "application/json" },
    });
    const history = (response.data || [])
      .slice(0, 60)
      .map((k: number[]) => ({
        time: Number(k[0]),
        low: Number(k[1]),
        high: Number(k[2]),
        open: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5] || 0),
        price: Number(k[4]),
      }))
      .sort((a: BtcCandle, b: BtcCandle) => a.time - b.time) as BtcCandle[];

    if (!history.length) return null;
    return { history, source: "coinbase" };
  } catch {
    return null;
  }
}

// â”€â”€ Generic multi-asset fetchers (ETH, SOL via Binance/Coinbase) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetchAssetPriceFromBinance(asset: TradingAsset) {
  const cfg = ASSET_CONFIG[asset];
  const binanceHosts = ["https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com"];
  for (const host of binanceHosts) {
    try {
      const r = await axios.get(`${host}/api/v3/ticker/price`, { params: { symbol: cfg.binanceSymbol }, timeout: 5000 });
      return { symbol: cfg.binanceSymbol, price: String(r.data.price), source: host };
    } catch { /* try next */ }
  }
  return null;
}

async function fetchAssetPriceFromCoinbase(asset: TradingAsset) {
  try {
    const r = await axios.get(`https://api.coinbase.com/v2/prices/${ASSET_CONFIG[asset].coinbaseProduct}/spot`, { timeout: 5000 });
    return { symbol: ASSET_CONFIG[asset].binanceSymbol, price: String(r.data?.data?.amount), source: "coinbase" };
  } catch { return null; }
}

async function fetchAssetHistoryFromBinance(asset: TradingAsset) {
  const cfg = ASSET_CONFIG[asset];
  const binanceHosts = ["https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com"];
  for (const host of binanceHosts) {
    try {
      const r = await axios.get(`${host}/api/v3/klines`, { params: { symbol: cfg.binanceSymbol, interval: "1m", limit: 60 }, timeout: 5000 });
      const history: BtcCandle[] = r.data.map((k: any) => ({
        time: Math.floor(k[0] / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), price: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
      return { history, source: host };
    } catch { /* try next */ }
  }
  return null;
}

async function fetchAssetHistoryFromCoinbase(asset: TradingAsset) {
  try {
    const r = await axios.get(`https://api.exchange.coinbase.com/products/${ASSET_CONFIG[asset].coinbaseProduct}/candles`, {
      params: { granularity: 60 }, timeout: 8000, headers: { Accept: "application/json" },
    });
    const history: BtcCandle[] = (r.data || []).slice(0, 60).map((k: number[]) => ({
      time: Number(k[0]), low: Number(k[1]), high: Number(k[2]), open: Number(k[3]),
      close: Number(k[4]), volume: Number(k[5] || 0), price: Number(k[4]),
    })).sort((a: BtcCandle, b: BtcCandle) => a.time - b.time);
    if (!history.length) return null;
    return { history, source: "coinbase" };
  } catch { return null; }
}

async function getAssetPrice(asset: TradingAsset, forceRefresh = false): Promise<{ symbol: string; price: string; source?: string } | null> {
  if (asset === "BTC") return getBtcPrice(forceRefresh);
  const cached = assetPriceCaches.get(asset);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;
  const result = (await fetchAssetPriceFromBinance(asset)) || (await fetchAssetPriceFromCoinbase(asset));
  if (result?.price) {
    assetPriceCaches.set(asset, { data: result, expiresAt: Date.now() + BTC_PRICE_CACHE_MS });
    return result;
  }
  return cached?.data ?? null;
}

async function getAssetHistory(asset: TradingAsset, forceRefresh = false): Promise<{ history: BtcCandle[]; source: string } | null> {
  if (asset === "BTC") return getBtcHistory(forceRefresh);
  const cached = assetHistoryCaches.get(asset);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return { history: cached.data, source: "cache" };
  const result = (await fetchAssetHistoryFromBinance(asset)) || (await fetchAssetHistoryFromCoinbase(asset));
  if (result?.history?.length) {
    assetHistoryCaches.set(asset, { data: result.history, expiresAt: Date.now() + BTC_HISTORY_CACHE_MS });
    return result;
  }
  return cached ? { history: cached.data, source: "stale-cache" } : null;
}

async function getAssetIndicators(asset: TradingAsset, forceRefresh = false) {
  if (asset === "BTC") return getBtcIndicators(forceRefresh);
  const cached = assetIndicatorsCaches.get(asset);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;
  const histResult = await getAssetHistory(asset, forceRefresh);
  if (!histResult?.history?.length) return cached?.data ?? null;
  try {
    const indicators = computeBtcIndicatorsFromHistory(histResult.history);
    assetIndicatorsCaches.set(asset, { data: indicators, expiresAt: Date.now() + BTC_INDICATORS_CACHE_MS });
    return indicators;
  } catch { return cached?.data ?? null; }
}

const dynamicAssetPriceCache = new Map<string, { data: { symbol: string; price: string; source?: string }; expiresAt: number }>();
const lagAssetPriceBuffers = new Map<string, PricePoint[]>();
const lagYesPriceBuffers = new Map<string, PricePoint[]>();
const lagNoPriceBuffers = new Map<string, PricePoint[]>();
const botTradedThisWindowMarketIds = new Set<string>();

interface DynamicLagMarket {
  market: any;
  assetSymbol: string;
  slug: string;
  yesPrice: number | null;
  noPrice: number | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  liquidity: number;
  volume24hr: number;
}

interface PriceLagSignal {
  decision: "TRADE" | "NO_TRADE";
  direction: "UP" | "DOWN" | "NONE";
  confidence: number;
  estimatedEdge: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  reasoning: string;
  assetMove10Pct: number;
  assetMove30Pct: number;
  assetMove60Pct: number;
  targetDelta10Cents: number;
  opposingDelta10Cents: number;
  yesDelta30Cents: number;
  noDelta30Cents: number;
  lagGapCents: number;
  expectedCatchupCents: number;
  maxEntryPrice: number;
}

function parseJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseCryptoSymbolFromSlug(slug: string | null | undefined): string | null {
  const normalized = String(slug || "").trim().toLowerCase();
  const match = normalized.match(/^([a-z0-9]+)-updown-5m-/);
  return match ? match[1].toUpperCase() : null;
}

function pushLagSample(target: Map<string, PricePoint[]>, key: string, price: number, ts: number): void {
  if (!(price > 0)) return;
  const buffer = target.get(key) ?? [];
  buffer.push({ ts, price });
  while (buffer.length > 120) buffer.shift();
  target.set(key, buffer);
}

function findLagReference(buffer: PricePoint[] | undefined, targetTs: number): PricePoint | null {
  if (!buffer || buffer.length === 0) return null;
  let best: PricePoint | null = null;
  for (const point of buffer) {
    if (point.ts > targetTs) continue;
    if (!best || Math.abs(point.ts - targetTs) < Math.abs(best.ts - targetTs)) best = point;
  }
  return best;
}

function getLagThresholds(assetPrice: number) {
  if (assetPrice >= 10_000) return { minMove30Pct: 0.08, minMove60Pct: 0.12, minLagGapCents: 1.5, baseMaxEntryPrice: 0.64 };
  if (assetPrice >= 1_000) return { minMove30Pct: 0.12, minMove60Pct: 0.18, minLagGapCents: 1.6, baseMaxEntryPrice: 0.64 };
  if (assetPrice >= 100) return { minMove30Pct: 0.18, minMove60Pct: 0.27, minLagGapCents: 1.8, baseMaxEntryPrice: 0.63 };
  if (assetPrice >= 10) return { minMove30Pct: 0.25, minMove60Pct: 0.35, minLagGapCents: 2.0, baseMaxEntryPrice: 0.62 };
  return { minMove30Pct: 0.40, minMove60Pct: 0.55, minLagGapCents: 2.3, baseMaxEntryPrice: 0.60 };
}

function computePriceLagSignal(params: {
  assetSymbol: string;
  assetNow: number;
  assetRef10: number;
  assetRef30: number;
  assetRef60: number;
  yesNow: number;
  yesRef10: number;
  yesRef30: number;
  noNow: number;
  noRef10: number;
  noRef30: number;
}): PriceLagSignal {
  const {
    assetSymbol,
    assetNow,
    assetRef10,
    assetRef30,
    assetRef60,
    yesNow,
    yesRef10,
    yesRef30,
    noNow,
    noRef10,
    noRef30,
  } = params;

  if (!(assetNow > 0 && assetRef10 > 0 && assetRef30 > 0 && assetRef60 > 0 && yesNow > 0 && yesRef10 > 0 && yesRef30 > 0 && noNow > 0 && noRef10 > 0 && noRef30 > 0)) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      riskLevel: "HIGH",
      reasoning: "Lag buffers not ready yet",
      assetMove10Pct: 0,
      assetMove30Pct: 0,
      assetMove60Pct: 0,
      targetDelta10Cents: 0,
      opposingDelta10Cents: 0,
      yesDelta30Cents: 0,
      noDelta30Cents: 0,
      lagGapCents: 0,
      expectedCatchupCents: 0,
      maxEntryPrice: 0.60,
    };
  }

  const assetMove10Pct = ((assetNow - assetRef10) / assetRef10) * 100;
  const assetMove30Pct = ((assetNow - assetRef30) / assetRef30) * 100;
  const assetMove60Pct = ((assetNow - assetRef60) / assetRef60) * 100;
  const yesDelta10Cents = (yesNow - yesRef10) * 100;
  const yesDelta30Cents = (yesNow - yesRef30) * 100;
  const noDelta10Cents = (noNow - noRef10) * 100;
  const noDelta30Cents = (noNow - noRef30) * 100;
  const absMove30 = Math.abs(assetMove30Pct);
  const thresholds = getLagThresholds(assetNow);

  if (absMove30 < thresholds.minMove30Pct) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      riskLevel: "HIGH",
      reasoning: `${assetSymbol} move too small for lag scalp (${assetMove30Pct.toFixed(3)}%)`,
      assetMove10Pct,
      assetMove30Pct,
      assetMove60Pct,
      targetDelta10Cents: 0,
      opposingDelta10Cents: 0,
      yesDelta30Cents,
      noDelta30Cents,
      lagGapCents: 0,
      expectedCatchupCents: 0,
      maxEntryPrice: thresholds.baseMaxEntryPrice,
    };
  }

  const direction: "UP" | "DOWN" = assetMove30Pct > 0 ? "UP" : "DOWN";
  const persistentMove = assetMove30Pct * assetMove60Pct > 0 && Math.abs(assetMove60Pct) >= thresholds.minMove60Pct * 0.6;
  const freshImpulse =
    assetMove10Pct * assetMove30Pct > 0 &&
    Math.abs(assetMove10Pct) >= thresholds.minMove30Pct * 0.18;
  const reversalDetected =
    assetMove10Pct * assetMove30Pct < 0 &&
    Math.abs(assetMove10Pct) >= thresholds.minMove30Pct * 0.14;
  const targetDelta10Cents = direction === "UP" ? Math.max(0, yesDelta10Cents) : Math.max(0, noDelta10Cents);
  const opposingDelta10Cents = direction === "UP" ? Math.max(0, noDelta10Cents) : Math.max(0, yesDelta10Cents);
  const targetTokenDelta = direction === "UP" ? Math.max(0, yesDelta30Cents) : Math.max(0, noDelta30Cents);
  const opposingTokenDelta = direction === "UP" ? Math.max(0, noDelta30Cents) : Math.max(0, yesDelta30Cents);
  const expectedCatchupCents = Math.min(10, Math.max(2, (absMove30 / thresholds.minMove30Pct) * 2.6));
  const lagGapCents = expectedCatchupCents - targetTokenDelta;
  const entryPrice = direction === "UP" ? yesNow : noNow;

  if (reversalDetected) {
    return {
      decision: "NO_TRADE",
      direction,
      confidence: 0,
      estimatedEdge: 0,
      riskLevel: "HIGH",
      reasoning: `${assetSymbol} micro move already reversing against ${direction} setup`,
      assetMove10Pct,
      assetMove30Pct,
      assetMove60Pct,
      targetDelta10Cents,
      opposingDelta10Cents,
      yesDelta30Cents,
      noDelta30Cents,
      lagGapCents,
      expectedCatchupCents,
      maxEntryPrice: thresholds.baseMaxEntryPrice,
    };
  }

  if (lagGapCents < thresholds.minLagGapCents) {
    return {
      decision: "NO_TRADE",
      direction,
      confidence: 0,
      estimatedEdge: 0,
      riskLevel: "HIGH",
      reasoning: `${assetSymbol} moved but ${direction} token already caught up (${targetTokenDelta.toFixed(2)}c)`,
      assetMove10Pct,
      assetMove30Pct,
      assetMove60Pct,
      targetDelta10Cents,
      opposingDelta10Cents,
      yesDelta30Cents,
      noDelta30Cents,
      lagGapCents,
      expectedCatchupCents,
      maxEntryPrice: thresholds.baseMaxEntryPrice,
    };
  }

  const alreadyCatchingUpFast =
    targetDelta10Cents >= Math.max(0.9, lagGapCents * 0.65) ||
    targetDelta10Cents >= expectedCatchupCents * 0.45;

  if (alreadyCatchingUpFast) {
    return {
      decision: "NO_TRADE",
      direction,
      confidence: 0,
      estimatedEdge: 0,
      riskLevel: "HIGH",
      reasoning: `${assetSymbol} lag already being filled too fast (${targetDelta10Cents.toFixed(2)}c in 10s)`,
      assetMove10Pct,
      assetMove30Pct,
      assetMove60Pct,
      targetDelta10Cents,
      opposingDelta10Cents,
      yesDelta30Cents,
      noDelta30Cents,
      lagGapCents,
      expectedCatchupCents,
      maxEntryPrice: thresholds.baseMaxEntryPrice,
    };
  }

  if (!freshImpulse && !persistentMove) {
    return {
      decision: "NO_TRADE",
      direction,
      confidence: 0,
      estimatedEdge: 0,
      riskLevel: "HIGH",
      reasoning: `${assetSymbol} lag exists but impulse is stale`,
      assetMove10Pct,
      assetMove30Pct,
      assetMove60Pct,
      targetDelta10Cents,
      opposingDelta10Cents,
      yesDelta30Cents,
      noDelta30Cents,
      lagGapCents,
      expectedCatchupCents,
      maxEntryPrice: thresholds.baseMaxEntryPrice,
    };
  }

  let confidence = 56;
  confidence += Math.min(16, (absMove30 / thresholds.minMove30Pct) * 6);
  confidence += Math.min(10, lagGapCents * 2.2);
  if (persistentMove) confidence += 7;
  if (freshImpulse) confidence += 6;
  if (targetDelta10Cents <= Math.max(0.35, lagGapCents * 0.25)) confidence += 4;
  if (opposingTokenDelta > targetTokenDelta + 1) confidence -= 6;
  if (opposingDelta10Cents > targetDelta10Cents + 0.7) confidence -= 4;
  if (entryPrice > 0.60) confidence -= 5;
  if (entryPrice > 0.66) confidence -= 6;
  confidence = Math.max(55, Math.min(90, Math.round(confidence)));

  const maxEntryPrice = Math.min(
    0.66,
    thresholds.baseMaxEntryPrice +
      Math.min(0.04, lagGapCents * 0.012) +
      (persistentMove ? 0.01 : 0) +
      (freshImpulse ? 0.01 : 0)
  );
  const estimatedEdge = parseFloat(((confidence / 100) - entryPrice).toFixed(4));
  const riskLevel: "LOW" | "MEDIUM" | "HIGH" =
    confidence >= 79 && lagGapCents >= 3 && entryPrice <= 0.58
      ? "LOW"
      : confidence >= 69 && entryPrice <= 0.64
        ? "MEDIUM"
        : "HIGH";

  return {
    decision: estimatedEdge > 0 ? "TRADE" : "NO_TRADE",
    direction,
    confidence,
    estimatedEdge,
    riskLevel,
    reasoning: `${assetSymbol} ${assetMove10Pct >= 0 ? "+" : ""}${assetMove10Pct.toFixed(3)}% /10s, ${assetMove30Pct >= 0 ? "+" : ""}${assetMove30Pct.toFixed(3)}% /30s, ${assetMove60Pct >= 0 ? "+" : ""}${assetMove60Pct.toFixed(3)}% /60s | YES ${yesDelta30Cents >= 0 ? "+" : ""}${yesDelta30Cents.toFixed(2)}c | NO ${noDelta30Cents >= 0 ? "+" : ""}${noDelta30Cents.toFixed(2)}c | lag gap ${lagGapCents.toFixed(2)}c | catch-up10 ${targetDelta10Cents.toFixed(2)}c`,
    assetMove10Pct,
    assetMove30Pct,
    assetMove60Pct,
    targetDelta10Cents,
    opposingDelta10Cents,
    yesDelta30Cents,
    noDelta30Cents,
    lagGapCents,
    expectedCatchupCents,
    maxEntryPrice,
  };
}

async function fetchDynamicAssetPriceFromBinance(symbol: string) {
  const marketSymbol = `${symbol.toUpperCase()}USDT`;
  const binanceHosts = ["https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com"];
  for (const host of binanceHosts) {
    try {
      const response = await axios.get(`${host}/api/v3/ticker/price`, {
        params: { symbol: marketSymbol },
        timeout: 5000,
      });
      return { symbol: marketSymbol, price: String(response.data.price), source: host };
    } catch {
      // try next host
    }
  }
  return null;
}

async function fetchDynamicAssetPriceFromCoinbase(symbol: string) {
  try {
    const product = `${symbol.toUpperCase()}-USD`;
    const response = await axios.get(`https://api.coinbase.com/v2/prices/${product}/spot`, {
      timeout: 5000,
    });
    return {
      symbol: product,
      price: String(response.data?.data?.amount),
      source: "coinbase",
    };
  } catch {
    return null;
  }
}

async function getDynamicAssetPrice(symbol: string, forceRefresh = false): Promise<{ symbol: string; price: string; source?: string } | null> {
  const key = symbol.toUpperCase();
  const cached = dynamicAssetPriceCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;
  const result = (await fetchDynamicAssetPriceFromCoinbase(key)) || (await fetchDynamicAssetPriceFromBinance(key));
  if (result?.price) {
    dynamicAssetPriceCache.set(key, { data: result, expiresAt: Date.now() + BTC_PRICE_CACHE_MS });
    return result;
  }
  return cached?.data ?? null;
}

function normalizeLagMarketRow(market: any, fallbackAsset?: string, fallbackSlug?: string): DynamicLagMarket | null {
  const slug = String(market?.slug || fallbackSlug || "");
  const assetSymbol = (parseCryptoSymbolFromSlug(slug) || fallbackAsset || "").toUpperCase();
  const outcomePrices = parseJsonArray(market?.outcomePrices);
  const tokenIds = parseJsonArray(market?.clobTokenIds);
  if (!assetSymbol || !slug || outcomePrices.length < 2 || tokenIds.length < 2) return null;

  return {
    market: {
      ...market,
      outcomes: parseJsonArray(market?.outcomes),
      outcomePrices,
      clobTokenIds: tokenIds,
    },
    assetSymbol,
    slug,
    yesPrice: outcomePrices[0] != null ? Number(outcomePrices[0]) : null,
    noPrice: outcomePrices[1] != null ? Number(outcomePrices[1]) : null,
    yesTokenId: tokenIds[0] ? String(tokenIds[0]) : null,
    noTokenId: tokenIds[1] ? String(tokenIds[1]) : null,
    liquidity: Number(market?.liquidityNum ?? market?.liquidity ?? 0),
    volume24hr: Number(market?.volume24hrClob ?? market?.volume24hr ?? 0),
  };
}

async function discoverActiveCryptoLagMarkets(currentWindowStart: number): Promise<DynamicLagMarket[]> {
  const directMatches: DynamicLagMarket[] = [];

  await Promise.all(
    ENABLED_ASSETS.map(async (asset) => {
      const slug = `${ASSET_CONFIG[asset].polySlugPrefix}-${currentWindowStart}`;
      try {
        const response = await axios.get(
          `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`,
          { timeout: 8000 }
        );
        const event = response.data;
        const markets = Array.isArray(event?.markets) ? event.markets : [];
        for (const rawMarket of markets) {
          const normalized = normalizeLagMarketRow(
            {
              ...rawMarket,
              slug,
              eventSlug: event?.slug || slug,
              eventId: event?.id,
              eventTitle: event?.title,
              active: rawMarket?.active ?? event?.active,
              closed: rawMarket?.closed ?? event?.closed,
            },
            asset,
            slug
          );
          if (normalized?.yesTokenId && normalized?.noTokenId && normalized.yesPrice != null && normalized.noPrice != null) {
            directMatches.push(normalized);
          }
        }
      } catch {
        // fallback below
      }
    })
  );

  if (directMatches.length > 0) {
    return directMatches.sort((a, b) => (b.liquidity + b.volume24hr) - (a.liquidity + a.volume24hr));
  }

  const wantedSlugs = new Set(ENABLED_ASSETS.map((asset) => `${ASSET_CONFIG[asset].polySlugPrefix}-${currentWindowStart}`));
  const fallbackMatches: DynamicLagMarket[] = [];

  for (let offset = 0; offset <= 300; offset += 100) {
    try {
      const response = await axios.get("https://gamma-api.polymarket.com/events", {
        params: { active: true, closed: false, limit: 100, offset },
        timeout: 12000,
      });
      const events = Array.isArray(response.data) ? response.data : [];
      if (events.length === 0) break;

      for (const event of events) {
        const eventSlug = String(event?.slug || "");
        if (!wantedSlugs.has(eventSlug)) continue;
        const asset = ENABLED_ASSETS.find((row) => eventSlug.startsWith(ASSET_CONFIG[row].polySlugPrefix));
        const markets = Array.isArray(event?.markets) ? event.markets : [];
        for (const rawMarket of markets) {
          const normalized = normalizeLagMarketRow(
            {
              ...rawMarket,
              slug: rawMarket?.slug || eventSlug,
              eventSlug,
              eventId: event?.id,
              eventTitle: event?.title,
              active: rawMarket?.active ?? event?.active,
              closed: rawMarket?.closed ?? event?.closed,
            },
            asset,
            eventSlug
          );
          if (normalized?.yesTokenId && normalized?.noTokenId && normalized.yesPrice != null && normalized.noPrice != null) {
            fallbackMatches.push(normalized);
          }
        }
      }

      if (fallbackMatches.length === wantedSlugs.size) break;
    } catch {
      break;
    }
  }

  return fallbackMatches.sort((a, b) => (b.liquidity + b.volume24hr) - (a.liquidity + a.volume24hr));
}

async function getBtcHistory(forceRefresh = false) {
  if (!forceRefresh && btcHistoryCache && btcHistoryCache.expiresAt > Date.now()) {
    return { history: btcHistoryCache.data, source: "cache" };
  }

  if (!forceRefresh) {
    const persisted = await readPersistentCache<BtcCandle[]>("btc-history-1m", BTC_HISTORY_CACHE_MS);
    if (persisted?.payload?.length) {
      btcHistoryCache = {
        data: persisted.payload,
        expiresAt: Date.now() + (persisted.stale ? 5_000 : BTC_HISTORY_CACHE_MS),
      };
      return { history: persisted.payload, source: persisted.source };
    }
  }

  const providerResult =
    (await fetchBtcHistoryFromBinance()) ||
    (await fetchBtcHistoryFromCoinbase()) ||
    (await fetchBtcHistoryFromCoinGecko());

  if (providerResult?.history?.length) {
    btcHistoryCache = {
      data: providerResult.history,
      expiresAt: Date.now() + BTC_HISTORY_CACHE_MS,
    };
    await persistBtcHistory(providerResult.history, providerResult.source);
    return providerResult;
  }

  if (btcHistoryCache?.data?.length) {
    return { history: btcHistoryCache.data, source: "stale-cache" };
  }

  const persisted = await readPersistentCache<BtcCandle[]>("btc-history-1m", Number.MAX_SAFE_INTEGER);
  if (persisted?.payload?.length) {
    return { history: persisted.payload, source: "mongo-stale-cache" };
  }

  return null;
}

async function getBtcPrice(forceRefresh = false) {
  if (!forceRefresh && btcPriceCache && btcPriceCache.expiresAt > Date.now()) {
    return btcPriceCache.data;
  }

  if (!forceRefresh) {
    const persisted = await readPersistentCache<{ symbol: string; price: string; source?: string }>(
      "btc-price-latest",
      BTC_PRICE_CACHE_MS
    );
    if (persisted?.payload?.price) {
      btcPriceCache = {
        data: { ...persisted.payload, source: persisted.source },
        expiresAt: Date.now() + (persisted.stale ? 5_000 : BTC_PRICE_CACHE_MS),
      };
      return btcPriceCache.data;
    }
  }

  const priceResult =
    (await fetchBtcPriceFromBinance()) ||
    (await fetchBtcPriceFromCoinbase()) ||
    (await fetchBtcPriceFromKraken()) ||
    (await fetchBtcPriceFromCoinGecko());

  if (priceResult?.price) {
    btcPriceCache = { data: priceResult, expiresAt: Date.now() + BTC_PRICE_CACHE_MS };
    await persistBtcPrice(priceResult);
    return priceResult;
  }

  const historyResult = await getBtcHistory(forceRefresh);
  const lastClose = historyResult?.history?.[historyResult.history.length - 1]?.close;
  if (lastClose) {
    const fallback = { symbol: "BTCUSDT", price: String(lastClose), source: historyResult?.source || "history" };
    btcPriceCache = { data: fallback, expiresAt: Date.now() + BTC_PRICE_CACHE_MS };
    await persistBtcPrice(fallback);
    return fallback;
  }

  if (btcPriceCache?.data?.price) {
    return { ...btcPriceCache.data, source: "stale-cache" };
  }

  const persisted = await readPersistentCache<{ symbol: string; price: string; source?: string }>(
    "btc-price-latest",
    Number.MAX_SAFE_INTEGER
  );
  if (persisted?.payload?.price) {
    return { ...persisted.payload, source: "mongo-stale-cache" };
  }

  return null;
}

function computeBtcIndicatorsFromHistory(history: BtcCandle[]) {
  const closes = history.map((k) => Number(k.close));
  const volumes = history.map((k) => Number(k.volume || 0));
  if (closes.length < 15) {
    throw new Error("Not enough BTC candles to compute indicators");
  }

  const calcEma = (data: number[], period: number): number => {
    const k = 2 / (period + 1);
    let result = data[0];
    for (let i = 1; i < data.length; i++) result = data[i] * k + result * (1 - k);
    return result;
  };

  const rsiPeriod = 14;
  let gains = 0;
  let losses = 0;
  const start = Math.max(1, closes.length - rsiPeriod);
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  const count = closes.length - start;
  const avgGain = count > 0 ? gains / count : 0;
  const avgLoss = count > 0 ? losses / count : 0;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const ema9 = calcEma(closes, 9);
  const ema21 = calcEma(closes, 21);

  const last3 = history.slice(-3).map((k) => ({
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    direction: Number(k.close) >= Number(k.open) ? "UP" : "DOWN",
  }));

  const recentVolumes = volumes.slice(-20);
  const avgVol = recentVolumes.length
    ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
    : 0;
  const lastVol = volumes[volumes.length - 1] || 0;
  const volumeSpike = avgVol > 0 ? lastVol / avgVol : 1;

  const trend = last3.every((c) => c.direction === "UP")
    ? "STRONG_UP"
    : last3.every((c) => c.direction === "DOWN")
      ? "STRONG_DOWN"
      : "MIXED";

  // MACD (12, 26, 9) - full rolling calculation for accurate signal line
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  let e12 = closes[0];
  let e26 = closes[0];
  const macdHistory: number[] = [];
  for (const price of closes) {
    e12 = price * k12 + e12 * (1 - k12);
    e26 = price * k26 + e26 * (1 - k26);
    macdHistory.push(e12 - e26);
  }
  const kMacd = 2 / 10;
  let macdSignalVal = macdHistory[0];
  for (const m of macdHistory) {
    macdSignalVal = m * kMacd + macdSignalVal * (1 - kMacd);
  }
  const macdLine = macdHistory[macdHistory.length - 1];
  const macdHistogram = macdLine - macdSignalVal;
  const macdTrend = macdHistogram > 0 ? "BULLISH" : macdHistogram < 0 ? "BEARISH" : "NEUTRAL";

  // Bollinger Bands (20, 2)
  const bbPeriod = Math.min(20, closes.length);
  const bbCloses = closes.slice(-bbPeriod);
  const bbMiddle = bbCloses.reduce((a, b) => a + b, 0) / bbCloses.length;
  const bbVariance = bbCloses.reduce((sum, c) => sum + Math.pow(c - bbMiddle, 2), 0) / bbCloses.length;
  const bbStdDev = Math.sqrt(bbVariance);
  const bbUpper = bbMiddle + 2 * bbStdDev;
  const bbLower = bbMiddle - 2 * bbStdDev;
  const currentClose = closes[closes.length - 1];
  const bbPosition =
    currentClose > bbUpper
      ? "ABOVE_UPPER"
      : currentClose > bbMiddle + bbStdDev
        ? "NEAR_UPPER"
        : currentClose < bbLower
          ? "BELOW_LOWER"
          : currentClose < bbMiddle - bbStdDev
            ? "NEAR_LOWER"
            : "MIDDLE";

  // 5-candle momentum (%)
  const momentum5 =
    closes.length >= 6
      ? parseFloat((((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100).toFixed(3))
      : 0;

  // Pre-computed signal alignment score
  // Positive = bullish signals, Negative = bearish signals
  let signalScore = 0;
  if (ema9 > ema21) signalScore += 1; else signalScore -= 1;
  if (rsi < 35) signalScore += 2;
  else if (rsi > 65) signalScore -= 2;
  if (macdHistogram > 0) signalScore += 1; else if (macdHistogram < 0) signalScore -= 1;
  if (trend === "STRONG_UP") signalScore += 2; else if (trend === "STRONG_DOWN") signalScore -= 2;
  if (momentum5 > 0.15) signalScore += 1; else if (momentum5 < -0.15) signalScore -= 1;
  // BB: near lower = potential bullish reversal, near upper = potential bearish
  if (bbPosition === "NEAR_LOWER" || bbPosition === "BELOW_LOWER") signalScore += 1;
  else if (bbPosition === "NEAR_UPPER" || bbPosition === "ABOVE_UPPER") signalScore -= 1;

  return {
    rsi: parseFloat(rsi.toFixed(2)),
    ema9: parseFloat(ema9.toFixed(2)),
    ema21: parseFloat(ema21.toFixed(2)),
    emaCross: ema9 > ema21 ? "BULLISH" : "BEARISH",
    volumeSpike: parseFloat(volumeSpike.toFixed(2)),
    last3Candles: last3,
    trend,
    currentPrice: closes[closes.length - 1],
    macd: parseFloat(macdLine.toFixed(2)),
    macdSignal: parseFloat(macdSignalVal.toFixed(2)),
    macdHistogram: parseFloat(macdHistogram.toFixed(2)),
    macdTrend: macdTrend as "BULLISH" | "BEARISH" | "NEUTRAL",
    bbUpper: parseFloat(bbUpper.toFixed(2)),
    bbMiddle: parseFloat(bbMiddle.toFixed(2)),
    bbLower: parseFloat(bbLower.toFixed(2)),
    bbPosition: bbPosition as "ABOVE_UPPER" | "NEAR_UPPER" | "MIDDLE" | "NEAR_LOWER" | "BELOW_LOWER",
    momentum5,
    signalScore,
  };
}

// â”€â”€ Fast Loop Momentum (Simmer SDK-inspired CEX momentum signal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface FastLoopMomentum {
  raw: number;            // % price change over 5 candles (first â†’ last)
  volumeWeighted: number; // each candle change weighted by its volume share
  acceleration: number;   // recent-2 candle momentum minus older-2 candle momentum
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
}

function computeFastLoopMomentum(history: BtcCandle[]): FastLoopMomentum | null {
  const last5 = history.slice(-5);
  if (last5.length < 5) return null;

  const closes = last5.map((c) => Number(c.close));
  const volumes = last5.map((c) => Number(c.volume || 0));

  // Raw momentum: % change from first to last close
  const raw = closes[0] > 0 ? ((closes[4] - closes[0]) / closes[0]) * 100 : 0;

  // Volume-weighted momentum: each candle's change weighted by its share of total volume
  const totalVol = volumes.reduce((a, b) => a + b, 0);
  let volumeWeighted = 0;
  if (totalVol > 0) {
    for (let i = 1; i < 5; i++) {
      const change = closes[i - 1] > 0 ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : 0;
      volumeWeighted += change * (volumes[i] / totalVol);
    }
  } else {
    volumeWeighted = raw;
  }

  // Acceleration: momentum of last 2 candles vs first 2 candles
  const recentMom = closes[2] > 0 ? ((closes[4] - closes[2]) / closes[2]) * 100 : 0;
  const olderMom  = closes[0] > 0 ? ((closes[2] - closes[0]) / closes[0]) * 100 : 0;
  const acceleration = recentMom - olderMom;

  const absVW = Math.abs(volumeWeighted);
  const direction: "UP" | "DOWN" | "NEUTRAL" =
    absVW < 0.02 ? "NEUTRAL" : volumeWeighted > 0 ? "UP" : "DOWN";
  const strength: "STRONG" | "MODERATE" | "WEAK" =
    absVW >= 0.15 ? "STRONG" : absVW >= 0.05 ? "MODERATE" : "WEAK";

  return {
    raw: parseFloat(raw.toFixed(4)),
    volumeWeighted: parseFloat(volumeWeighted.toFixed(4)),
    acceleration: parseFloat(acceleration.toFixed(4)),
    direction,
    strength,
  };
}

async function getBtcIndicators(forceRefresh = false) {
  if (!forceRefresh && btcIndicatorsCache && btcIndicatorsCache.expiresAt > Date.now()) {
    return btcIndicatorsCache.data;
  }

  const historyResult = await getBtcHistory(forceRefresh);
  if (!historyResult?.history?.length) {
    if (btcIndicatorsCache?.data) {
      return { ...btcIndicatorsCache.data, source: "stale-cache" };
    }
    return null;
  }

  const indicators = {
    ...computeBtcIndicatorsFromHistory(historyResult.history),
    source: historyResult.source,
  };
  btcIndicatorsCache = { data: indicators, expiresAt: Date.now() + BTC_INDICATORS_CACHE_MS };
  await persistBtcIndicators(indicators, historyResult.source);
  return indicators;
}

async function buildAuthenticatedClobClient(wallet: ethers.Wallet) {
  const rawKey = process.env.POLYMARKET_API_KEY || "";
  const rawSecret = process.env.POLYMARKET_API_SECRET || "";
  const rawPassphrase = process.env.POLYMARKET_API_PASSPHRASE || "";
  const hasEnvCreds = Boolean(rawKey && rawSecret && rawPassphrase);

  if (hasEnvCreds) {
    const envClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      wallet,
      { key: rawKey, secret: rawSecret, passphrase: rawPassphrase },
      POLYMARKET_SIGNATURE_TYPE as 0 | 1 | 2,
      POLYMARKET_FUNDER_ADDRESS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );

    try {
      await envClient.getApiKeys();
      return envClient;
    } catch (error: any) {
      console.warn("Configured Polymarket API credentials are invalid. Falling back to derive/create API key.", error?.message || error);
    }
  }

  const bootstrapClient = new ClobClient(
    "https://clob.polymarket.com",
    137,
    wallet,
    undefined,
    POLYMARKET_SIGNATURE_TYPE as 0 | 1 | 2,
    POLYMARKET_FUNDER_ADDRESS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );
  let derivedCreds;
  try {
    derivedCreds = await bootstrapClient.createApiKey();
  } catch {
    derivedCreds = await bootstrapClient.deriveApiKey();
  }

  return new ClobClient(
    "https://clob.polymarket.com",
    137,
    wallet,
    derivedCreds,
    POLYMARKET_SIGNATURE_TYPE as 0 | 1 | 2,
    POLYMARKET_FUNDER_ADDRESS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );
}


async function getClobClient() {
  if (clobClient) return clobClient;
  if (clobClientInitPromise) return clobClientInitPromise;

  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("POLYGON_PRIVATE_KEY not found in environment. CLOB trading features will be disabled.");
    return null;
  }

  clobClientInitPromise = (async () => {
    const provider = createPolygonProvider();
    clobWallet = new ethers.Wallet(privateKey, provider);
    clobClient = await buildAuthenticatedClobClient(clobWallet);
    return clobClient;
  })()
    .catch((error) => {
      console.error("Failed to initialize CLOB client:", error);
      clobClient = null;
      return null;
    })
    .finally(() => {
      clobClientInitPromise = null;
    });

  return clobClientInitPromise;
}

// â”€â”€ Telegram / Discord push notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendNotification(message: string): Promise<void> {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const discordWebhook = process.env.DISCORD_WEBHOOK_URL;
  const tasks: Promise<void>[] = [];
  if (telegramToken && telegramChatId) {
    tasks.push(
      axios.post(
        `https://api.telegram.org/bot${telegramToken}/sendMessage`,
        { chat_id: telegramChatId, text: message, parse_mode: "HTML" },
        { timeout: 5000 }
      ).then(() => {}).catch(() => {})
    );
  }
  if (discordWebhook) {
    tasks.push(
      axios.post(discordWebhook, { content: message }, { timeout: 5000 })
        .then(() => {}).catch(() => {})
    );
  }
  await Promise.all(tasks);
}

// â”€â”€ Divergence fast-path hook â€” wired up inside startServer() after local fns are defined â”€â”€
// The tracker calls this when STRONG divergence fires; startServer() sets the implementation.
let onStrongDivergence: ((direction: "UP" | "DOWN", snapshot: { yesAsk: number | null; noAsk: number | null; btcDelta: number }) => void) | null = null;

// â”€â”€ Divergence Tracker: BTC price vs YES token price lag detector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Runs every 5s independently. Fills ring buffers and computes divergence score.
function startDivergenceTracker() {
  if (divergenceTrackerInterval) return;

  const tick = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);

      // 1. Asset price sample (uses whichever asset the bot is currently tracking)
      const btcData = await getAssetPrice(currentDivergenceAsset);
      const btcPrice = btcData?.price ? parseFloat(btcData.price as any) : null;
      if (btcPrice && btcPrice > 0) {
        btcRingBuffer.push({ ts: now, price: btcPrice });
        if (btcRingBuffer.length > 120) btcRingBuffer.shift(); // 10-min cap
      }

      // 2. YES / NO token ask price sample (current window)
      let yesAsk: number | null = null;
      let noAsk:  number | null = null;

      if (currentWindowYesTokenId) {
        try {
          const r = await axios.get(
            `https://clob.polymarket.com/book?token_id=${currentWindowYesTokenId}`,
            { timeout: 4000 }
          );
          const asks: any[] = r.data?.asks ?? [];
          const bids: any[] = r.data?.bids ?? [];
          yesAsk = asks.length > 0 ? parseFloat(asks[0].price)
                 : bids.length > 0 ? parseFloat(bids[0].price) : null;
          if (yesAsk && yesAsk > 0) {
            yesRingBuffer.push({ ts: now, price: yesAsk });
            if (yesRingBuffer.length > 120) yesRingBuffer.shift();
          }
        } catch { /* non-fatal */ }
      }

      if (currentWindowNoTokenId) {
        try {
          const r = await axios.get(
            `https://clob.polymarket.com/book?token_id=${currentWindowNoTokenId}`,
            { timeout: 4000 }
          );
          const asks: any[] = r.data?.asks ?? [];
          const bids: any[] = r.data?.bids ?? [];
          noAsk = asks.length > 0 ? parseFloat(asks[0].price)
                : bids.length > 0 ? parseFloat(bids[0].price) : null;
        } catch { /* non-fatal */ }
      }

      // 3. Compute 30s and 60s deltas from ring buffers
      const btcNow = btcRingBuffer.length > 0 ? btcRingBuffer[btcRingBuffer.length - 1].price : null;
      const yesNow = yesRingBuffer.length > 0 ? yesRingBuffer[yesRingBuffer.length - 1].price : null;

      const findNearest = (buf: PricePoint[], targetTs: number) =>
        buf.reduce<PricePoint | null>((best, p) => {
          if (p.ts > targetTs) return best;
          if (!best || Math.abs(p.ts - targetTs) < Math.abs(best.ts - targetTs)) return p;
          return best;
        }, null);

      const btc30ref = findNearest(btcRingBuffer, now - 30);
      const btc60ref = findNearest(btcRingBuffer, now - 60);
      const yes30ref = findNearest(yesRingBuffer, now - 30);

      const btcDelta30s = btcNow && btc30ref ? btcNow - btc30ref.price : 0;
      const btcDelta60s = btcNow && btc60ref ? btcNow - btc60ref.price : 0;
      const yesDelta30s = yesNow && yes30ref ? (yesNow - yes30ref.price) * 100 : 0; // in Â¢

      // 4. Classify divergence using asset-specific thresholds
      const divCfg = ASSET_CONFIG[currentDivergenceAsset];
      const BTC_STRONG = divCfg.divergenceStrong;
      const BTC_MOD    = divCfg.divergenceMod;
      const BTC_WEAK   = divCfg.divergenceWeak;
      const YES_LAG    = 2.0; // Â¢ â€” YES hasn't moved at least 2Â¢ in asset's direction

      let direction: DivergenceState["direction"] = "NEUTRAL";
      let strength:  DivergenceState["strength"]  = "NONE";
      let divergence = 0;

      const absBtc = Math.abs(btcDelta30s);

      if (absBtc >= BTC_WEAK) {
        direction = btcDelta30s > 0 ? "UP" : "DOWN";
        const yesInBtcDir = direction === "UP" ? yesDelta30s : -yesDelta30s;
        const yesLagging  = yesInBtcDir < YES_LAG; // YES hasn't caught up

        divergence = absBtc / BTC_STRONG; // normalized 0â€“1+

        if      (absBtc >= BTC_STRONG && yesLagging) strength = "STRONG";
        else if (absBtc >= BTC_MOD    && yesLagging) strength = "MODERATE";
        else if (absBtc >= BTC_WEAK   && yesLagging) strength = "WEAK";
        else direction = "NEUTRAL"; // BTC moved but YES kept pace â€” no lag
      }

      divergenceStateByAsset.set(currentDivergenceAsset, {
        btcDelta30s, btcDelta60s, yesDelta30s,
        divergence, direction, strength,
        currentBtcPrice: btcNow,
        currentYesAsk: yesAsk,
        currentNoAsk: noAsk,
        updatedAt: now,
      });

      // Fire notification on STRONG divergence (max once per 2 minutes)
      if (strength === "STRONG" && now - lastStrongDivergenceNotifiedAt > 120) {
        lastStrongDivergenceNotifiedAt = now;
        void sendNotification(
          `âš¡ <b>STRONG DIVERGENCE DETECTED</b>\nBTC: ${btcDelta30s >= 0 ? "+" : ""}$${btcDelta30s.toFixed(0)} (30s)\nYES: ${yesDelta30s >= 0 ? "+" : ""}${yesDelta30s.toFixed(2)}Â¢\nDirection: ${direction}\nBot may force-trade ${direction}`
        );
      }

      // â”€â”€ STRONG DIVERGENCE: reset analyzed set so main cycle re-evaluates â”€â”€â”€â”€
      // If STRONG divergence fires mid-window and bot already marked the market
      // as analyzed (e.g. earlier NO_TRADE), clear the set so the next bot cycle
      // re-runs analysis with the new divergence context.
      if (strength === "STRONG" && (direction === "UP" || direction === "DOWN") && botEnabled) {
        const assetSet = botAnalyzedThisWindowByAsset.get(currentDivergenceAsset);
        if (assetSet && assetSet.size > 0) {
          console.log(`[DIV] STRONG divergence mid-window â€” clearing analyzed set for ${currentDivergenceAsset} to force re-evaluation`);
          assetSet.clear();
          currentWindowAiCache = null;
        }
      }

      // â”€â”€ FAST PATH TRIGGER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Fire immediately on STRONG divergence â€” don't wait for next bot cycle.
      // Cooldown: 30s to prevent thrashing on the same divergence event.
      if (
        strength === "STRONG" &&
        (direction === "UP" || direction === "DOWN") &&
        botEnabled &&
        now - lastDivergenceFastTradeAt > 30 &&
        onStrongDivergence
      ) {
        onStrongDivergence(direction, { yesAsk, noAsk, btcDelta: btcDelta30s });
      }

    } catch { /* never crash the tracker */ }
  };

  void tick();
  divergenceTrackerInterval = setInterval(() => void tick(), 5000);
  console.log("[Divergence] Tracker started â€” 5s BTC vs YES token lag detector");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  loadLearning();
  void ensureMongoCollections();
  startBtcBackgroundSync();
  startDivergenceTracker();

  const formatTradeError = (error: any, context?: Record<string, unknown>) => {
    const rawMessage =
      error?.data?.error ||
      error?.errorMsg ||
      error?.response?.data?.error ||
      error?.response?.data?.message ||
      error?.message ||
      "Failed to execute trade";
    const message = String(rawMessage);

    if (/allowance|insufficient allowance|not approved/i.test(message)) {
      return {
        error: "Allowance USDC untuk Polymarket belum siap. Lakukan approval/deposit di akun Polymarket dulu.",
        detail: message,
        context,
      };
    }

    if (/insufficient|balance/i.test(message)) {
      return {
        error: "Saldo atau buying power tidak cukup untuk order ini.",
        detail: message,
        context,
      };
    }

    const minSizeMatch = message.match(/Size \(([^)]+)\) lower than the minimum: ([0-9.]+)/i);
    if (minSizeMatch) {
      const attemptedShares = Number(minSizeMatch[1]);
      const minimumShares = Number(minSizeMatch[2]);
      const limitPrice = Number((context?.price as number) || 0);
      const minimumUsdc = limitPrice > 0 ? (minimumShares * limitPrice).toFixed(2) : null;
      return {
        error: minimumUsdc
          ? `Order terlalu kecil. Minimum sekitar ${minimumUsdc} USDC pada limit price ini.`
          : `Order terlalu kecil. Minimum size market ini ${minimumShares} shares.`,
        detail: message,
        context: { ...context, attemptedShares, minimumShares, minimumUsdc },
      };
    }

    if (/funder|profile/i.test(message)) {
      return {
        error: "Funder/Profile address Polymarket belum dikonfigurasi benar.",
        detail: message,
        context,
      };
    }

    if (/api key|signature|auth|unauthorized|forbidden|invalid credentials/i.test(message)) {
      return {
        error: "Autentikasi Polymarket gagal. API key, signature type, atau private key tidak cocok.",
        detail: message,
        context,
      };
    }

    return { error: message, detail: message, context };
  };

  const executePolymarketTrade = async ({
    tokenID,
    amount,
    side,
    price,
    executionMode = "MANUAL",
    amountMode,
  }: {
    tokenID: string;
    amount: number | string;
    side: Side;
    price?: number | string;
    executionMode?: "MANUAL" | "PASSIVE" | "AGGRESSIVE";
    amountMode?: "SPEND" | "SIZE";
  }) => {
    const client = await getClobClient();
    if (!client) {
      throw new Error("CLOB client not initialized. Check credentials.");
    }

    const parsedAmount = Number(amount);
    const parsedSide = String(side || "BUY").toUpperCase() as Side;
    const normalizedMode = String(executionMode || "MANUAL").toUpperCase() as "MANUAL" | "PASSIVE" | "AGGRESSIVE";
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error("Trade amount must be greater than 0.");
    }

    const orderbook = await client.getOrderBook(tokenID);
    const bestBid = Number(orderbook?.bids?.[0]?.price || "0");
    const bestAsk = Number(orderbook?.asks?.[0]?.price || "0");

    let parsedPrice = Number(price);
    if (normalizedMode === "AGGRESSIVE") {
      parsedPrice = parsedSide === Side.BUY ? bestAsk || parsedPrice : bestBid || parsedPrice;
    } else if (normalizedMode === "PASSIVE") {
      parsedPrice = parsedSide === Side.BUY ? bestBid || parsedPrice : bestAsk || parsedPrice;
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice >= 1) {
      throw new Error("Limit price must be between 0 and 1.");
    }

    const normalizedAmountMode =
      amountMode || (parsedSide === Side.BUY ? "SPEND" : "SIZE");
    const orderSize =
      normalizedAmountMode === "SIZE"
        ? parsedAmount
        : parsedSide === Side.BUY
          ? parsedAmount / parsedPrice
          : parsedAmount;
    if (!Number.isFinite(orderSize) || orderSize <= 0) {
      throw new Error("Computed order size is invalid.");
    }

    const [tickSize, negRisk] = await Promise.all([
      client.getTickSize(tokenID),
      client.getNegRisk(tokenID),
    ]);

    if (parsedSide === Side.BUY && normalizedAmountMode === "SPEND") {
      const allowance = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const allowanceResponse = allowance as any;
      const allowanceValues = [
        allowanceResponse.allowance,
        ...Object.values(allowanceResponse.allowances || {}),
      ].filter(Boolean) as string[];
      const rawAllowance = allowanceValues.reduce((max, current) => {
        if (!max) return current;
        return ethers.BigNumber.from(current).gt(max) ? current : max;
      }, "0");

      const numericBalance = Number(ethers.utils.formatUnits(allowance.balance || "0", 6));
      const numericAllowance = Number(ethers.utils.formatUnits(rawAllowance, 6));
      if (numericBalance < parsedAmount) {
        throw {
          message: `Insufficient Polymarket collateral balance. Available ${numericBalance.toFixed(2)} USDC, requested ${parsedAmount.toFixed(2)} USDC.`,
        };
      }
      if (numericAllowance < parsedAmount) {
        throw {
          message: `Insufficient Polymarket collateral allowance. Approved ${numericAllowance.toFixed(2)} USDC, requested ${parsedAmount.toFixed(2)} USDC.`,
        };
      }
    }

    const order = await client.createAndPostOrder(
      {
        tokenID,
        size: Number(orderSize.toFixed(6)),
        side: parsedSide,
        price: parsedPrice,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );

    if (order?.success === false) {
      const formatted = formatTradeError(order, { tokenID, amount, side, price: parsedPrice, tickSize, negRisk });
      throw { ...formatted, message: formatted.error };
    }

    const distanceToMarket =
      parsedSide === Side.BUY && bestAsk > 0
        ? parsedPrice - bestAsk
        : parsedSide === Side.SELL && bestBid > 0
          ? bestBid - parsedPrice
          : 0;

    return {
      success: true,
      orderID: order?.orderID || order?.id || null,
      status: order?.status || "PENDING",
      tickSize,
      negRisk,
      orderSize: Number(orderSize.toFixed(6)),
      spendingAmount:
        normalizedAmountMode === "SPEND"
          ? parsedAmount
          : Number((parsedAmount * parsedPrice).toFixed(6)),
      executionMode: normalizedMode,
      amountMode: normalizedAmountMode,
      limitPriceUsed: parsedPrice,
      marketSnapshot: {
        bestBid: bestBid || null,
        bestAsk: bestAsk || null,
        spread: bestBid > 0 && bestAsk > 0 ? Number((bestAsk - bestBid).toFixed(4)) : null,
        distanceToMarket: Number(distanceToMarket.toFixed(4)),
      },
      raw: order,
    };
  };

  const savePositionAutomation = async (payload: Partial<PositionAutomationDocument> & { assetId: string }) => {
    const collection = await getPositionAutomationCollection();
    if (!collection) {
      throw new Error("MongoDB not configured for backend TP/SL automation.");
    }

    const existing = await collection.findOne({ assetId: payload.assetId });
    const updateDoc: PositionAutomationDocument = {
      assetId: payload.assetId,
      market: payload.market || existing?.market || "",
      outcome: payload.outcome || existing?.outcome || "",
      averagePrice: payload.averagePrice || existing?.averagePrice || "0",
      size: payload.size || existing?.size || "0",
      takeProfit: payload.takeProfit ?? existing?.takeProfit ?? "",
      stopLoss: payload.stopLoss ?? existing?.stopLoss ?? "",
      trailingStop: payload.trailingStop ?? existing?.trailingStop ?? "",
      armed: payload.armed ?? existing?.armed ?? false,
      highestPrice: payload.highestPrice ?? existing?.highestPrice,
      trailingStopPrice: payload.trailingStopPrice ?? existing?.trailingStopPrice,
      lastPrice: payload.lastPrice ?? existing?.lastPrice,
      status: payload.status ?? existing?.status ?? "Configured",
      lastExitOrderId: payload.lastExitOrderId ?? existing?.lastExitOrderId ?? null,
      updatedAt: new Date(),
      lastTriggeredAt: payload.lastTriggeredAt ?? existing?.lastTriggeredAt ?? null,
    };

    await collection.updateOne({ assetId: payload.assetId }, { $set: updateDoc }, { upsert: true });
    return updateDoc;
  };

  const recommendAutomationLevels = (averagePrice: number) => {
    // TP/SL scaled to absolute price zone â€” binaries have non-linear payoff.
    // TP targets are deliberately tight: 5-min binary markets mean-revert fast,
    // so we take realistic gains rather than holding for a large move that rarely lands.
    let tpTarget: number;
    let slTarget: number;
    let trailingDistance: number;

    if (averagePrice < 0.35) {
      tpTarget = Math.min(0.68, averagePrice + 0.18); // was +0.30 â€” too ambitious
      slTarget = Math.max(0.01, averagePrice - 0.10);
      trailingDistance = 0.07;
    } else if (averagePrice < 0.50) {
      tpTarget = Math.min(0.68, averagePrice + 0.14); // was +0.22
      slTarget = Math.max(0.01, averagePrice - 0.09);
      trailingDistance = 0.06;
    } else if (averagePrice < 0.65) {
      tpTarget = Math.min(0.74, averagePrice + 0.11); // was +0.18
      slTarget = Math.max(0.01, averagePrice - 0.09);
      trailingDistance = 0.05;
    } else {
      // High-price entry: very limited upside
      tpTarget = Math.min(0.84, averagePrice + 0.08); // was +0.10
      slTarget = Math.max(0.01, averagePrice - 0.07);
      trailingDistance = 0.04;
    }

    return {
      takeProfit: tpTarget.toFixed(2),
      stopLoss: slTarget.toFixed(2),
      trailingStop: trailingDistance.toFixed(2),
    };
  };

  const recommendLagScalpLevels = (
    averagePrice: number,
    signal: Pick<PriceLagSignal, "lagGapCents" | "confidence" | "riskLevel">
  ) => {
    const lagDrivenTp = Math.min(0.045, Math.max(0.022, signal.lagGapCents * 0.0075));
    const confidenceBonus = signal.confidence >= 82 ? 0.004 : signal.confidence >= 76 ? 0.002 : 0;
    const tpDelta = Math.min(
      averagePrice >= 0.58 ? 0.04 : 0.05,
      lagDrivenTp + confidenceBonus
    );
    const slDelta = Math.min(
      averagePrice >= 0.58 ? 0.03 : 0.035,
      Math.max(0.018, tpDelta * (signal.riskLevel === "LOW" ? 0.78 : 0.88))
    );
    const trailingDistance = Math.max(0.012, Math.min(0.022, tpDelta * 0.55));

    const tpTarget = Math.min(averagePrice >= 0.58 ? 0.68 : 0.64, averagePrice + tpDelta);
    const slTarget = Math.max(0.01, averagePrice - slDelta);

    return {
      takeProfit: tpTarget.toFixed(2),
      stopLoss: slTarget.toFixed(2),
      trailingStop: trailingDistance.toFixed(2),
    };
  };

  // â”€â”€ Divergence Fast-Path Trade implementation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Wired to onStrongDivergence so the tracker can call it directly without
  // waiting for the next bot cycle (saves the ~2-3s Gemini round-trip).
  onStrongDivergence = (
    direction: "UP" | "DOWN",
    snapshot: { yesAsk: number | null; noAsk: number | null; btcDelta: number }
  ) => {
    // Capture the market for this specific asset atomically before any async work
    const _fastMarket = activeBotMarketByAsset.get(currentDivergenceAsset) ?? null;
    if (divergenceFastTradeRunning || !botEnabled || !_fastMarket) return;
    divergenceFastTradeRunning = true;
    const now = Math.floor(Date.now() / 1000);

    (async () => {
      try {
        const market = _fastMarket;
        const outcomeIndex = direction === "UP" ? 0 : 1;
        const tokenId: string = market.clobTokenIds?.[outcomeIndex];
        if (!tokenId) return;

        // Prevent double-execution with the normal bot cycle (per-asset set)
        const divAssetSet = botAnalyzedThisWindowByAsset.get(currentDivergenceAsset)!;
        if (divAssetSet.has(market.id)) return;

        // Respect price-lag timing gates (same zones as main cycle)
        const cfg = getPriceLagConfig();
        const windowElapsed = now - Math.floor(now / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
        const timing = getPriceLagTiming(windowElapsed);
        if (!timing.allowTrading) return;

        // Divergence trades need enough time for the move to develop.
        // Flash moves (< 15s) that cause divergence often mean-revert quickly.
        // Gate: minimum 120s remaining in the window.
        const divRemainingSeconds = MARKET_SESSION_SECONDS - windowElapsed;
        if (divRemainingSeconds < 120) {
          botPrint("SKIP", `[DIV FAST] Too late: only ${divRemainingSeconds}s remaining â€” divergence entry skipped (min 120s)`);
          return;
        }


        // Fetch fresh order book + implied price for the target token
        const r = await axios.get(
          `https://clob.polymarket.com/book?token_id=${tokenId}`,
          { timeout: 3000 }
        );
        const asks: any[] = r.data?.asks ?? [];
        const clobAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
        // Use outcomePrices from the atomically-captured market (not global alias which may have shifted)
        const divOutcomeIndex = direction === "UP" ? 0 : 1;
        const divImpliedPrice = parseFloat(market.outcomePrices?.[divOutcomeIndex] ?? "0");
        const bestAsk = (clobAsk > 0 && clobAsk < 0.97) ? clobAsk : divImpliedPrice > 0 ? divImpliedPrice : clobAsk;
        if (bestAsk <= 0) return;

        // Entry price gate â€” STRONG divergence gets the 85Â¢ override (same as main cycle)
        const MAX_ENTRY_PRICE = 0.85;
        if (bestAsk > MAX_ENTRY_PRICE) {
          botPrint("SKIP", `[DIV FAST] Price too high: ${(bestAsk * 100).toFixed(1)}Â¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}Â¢ â€” window closed`);
          return;
        }

        const confidence = 78;
        const estimatedEdge = parseFloat((confidence / 100 - bestAsk).toFixed(2));
        if (confidence < cfg.minConfidence || estimatedEdge < cfg.minEdge) return;

        // Kelly sizing â€” use last known balance (updated by bot cycle, fresh within ~30s)
        const balance = lastKnownBalance ?? botSessionStartBalance ?? 0;
        if (balance <= 0) return;

        const p = confidence / 100;
        const b = (1 - bestAsk) / bestAsk;
        const kelly = (p * b - (1 - p)) / b;
        if (kelly <= 0) return;

        const dynFraction = dynamicKellyFraction(confidence);
        const rawBet = balance * kelly * dynFraction;
        const BALANCE_RESERVE = Math.min(1.0, balance * 0.10);
        const spendable = Math.max(0, balance - BALANCE_RESERVE);
        const MIN_BET = Math.min(0.50, balance * 0.20);
        const betAmount = parseFloat(Math.min(rawBet, cfg.maxBetUsdc, spendable).toFixed(2));

        if (betAmount < MIN_BET) {
          botPrint("SKIP", `[DIV FAST] Bet too small: $${betAmount.toFixed(2)} < $${MIN_BET.toFixed(2)} min`);
          return;
        }

        botPrint("TRADE", `âš¡ DIVERGENCE FAST PATH âš¡ STRONG BTC ${snapshot.btcDelta >= 0 ? "+" : ""}$${snapshot.btcDelta.toFixed(0)} (30s) â†’ ${direction} | ask=${(bestAsk * 100).toFixed(0)}Â¢ | $${betAmount.toFixed(2)} USDC | Gemini skipped`);

        // Mark handled before async execute â€” prevents race with bot cycle
        divAssetSet.add(market.id);
        lastDivergenceFastTradeAt = now;

        const nowWindowStart = Math.floor(now / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
        const fastRec = {
          decision: "TRADE",
          direction,
          confidence,
          estimatedEdge,
          riskLevel: "MEDIUM",
          reasoning: `[DIV FAST PATH] STRONG divergence: BTC ${snapshot.btcDelta >= 0 ? "+" : ""}$${snapshot.btcDelta.toFixed(0)} in 30s, YES lagging. Gemini skipped.`,
          candlePatterns: [],
          dataMode: "FULL_DATA" as const,
          reversalProbability: 30,
          oppositePressureProbability: 25,
          reversalReasoning: "Strong structural price lag",
        };
        // Cache so the next bot cycle doesn't call Gemini again for this window
        currentWindowAiCache = { windowStart: nowWindowStart, marketId: market.id, asset: currentDivergenceAsset, rec: fastRec };

        const tradeResult = await executePolymarketTrade({
          tokenID: tokenId,
          amount: betAmount,
          side: Side.BUY,
          price: bestAsk,
          executionMode: "AGGRESSIVE",
          amountMode: "SPEND",
        });

        botSessionTradesCount++;
        botPrint("OK", `âš¡ FAST PATH EXECUTED âœ“ | ID: ${tradeResult.orderID} | Status: ${tradeResult.status}`);
        void sendNotification(
          `âš¡ <b>FAST PATH TRADE</b>\nMarket: ${market.question?.slice(0, 60) ?? "BTC 5m"}\nDirection: ${direction === "UP" ? "â–² UP" : "â–¼ DOWN"}\nAmount: $${betAmount.toFixed(2)} USDC @ ${(bestAsk * 100).toFixed(1)}Â¢\nConf: ${confidence}% | Edge: ${estimatedEdge}Â¢\n(Gemini bypassed â€” STRONG divergence)`
        );

        const levels = recommendAutomationLevels(bestAsk);
        await savePositionAutomation({
          assetId: tokenId,
          market: market.question || market.id,
          outcome: market.outcomes?.[outcomeIndex] || direction,
          averagePrice: bestAsk.toFixed(4),
          size: tradeResult.orderSize.toFixed(6),
          takeProfit: levels.takeProfit,
          stopLoss: levels.stopLoss,
          trailingStop: levels.trailingStop,
          windowEnd: nowWindowStart + MARKET_SESSION_SECONDS,
          armed: true,
        });

        pendingResults.set(tokenId, {
          eventSlug: `${ASSET_CONFIG[currentDivergenceAsset].polySlugPrefix}-${nowWindowStart}`,
          marketId: market.id,
          market: market.question || market.id,
          tokenId,
          direction,
          outcome: market.outcomes?.[outcomeIndex] || direction,
          entryPrice: bestAsk,
          betAmount,
          orderId: tradeResult.orderID,
          windowEnd: nowWindowStart + MARKET_SESSION_SECONDS,
          confidence,
          edge: estimatedEdge,
          reasoning: fastRec.reasoning,
          windowElapsedSeconds: now - nowWindowStart,
          asset: currentDivergenceAsset,
        });
        botPrint("INFO", `Result tracker armed â€” checking after ${new Date((nowWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);

        // â”€â”€ Correlated multi-asset entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // BTC STRONG divergence historically pulls ETH and SOL Polymarket prices
        // in the same direction â€” they often lag BTC by 1-2 cycles. Enter the same
        // direction at reduced Kelly (70%) since the signal is BTC-derived, not
        // the asset's own independent divergence.
        const correlatedAssets = ENABLED_ASSETS.filter(a => a !== currentDivergenceAsset);
        if (correlatedAssets.length > 0) {
          await Promise.allSettled(correlatedAssets.map(async (corrAsset) => {
            try {
              const corrMarket = activeBotMarketByAsset.get(corrAsset);
              if (!corrMarket) return;

              const corrSet = botAnalyzedThisWindowByAsset.get(corrAsset)!;
              if (corrSet.has(corrMarket.id)) {
                botPrint("SKIP", `[CORR-${corrAsset}] Already traded this window â€” skipping correlated entry`);
                return;
              }

              const corrOutcomeIndex = direction === "UP" ? 0 : 1;
              const corrTokenId: string = corrMarket.clobTokenIds?.[corrOutcomeIndex];
              if (!corrTokenId) return;

              // Fetch fresh order book for correlated asset
              const corrR = await axios.get(
                `https://clob.polymarket.com/book?token_id=${corrTokenId}`,
                { timeout: 3000 }
              );
              const corrAsks: any[] = corrR.data?.asks ?? [];
              const corrClobAsk = corrAsks.length > 0 ? parseFloat(corrAsks[0].price) : 0;
              const corrImplied = parseFloat(corrMarket.outcomePrices?.[corrOutcomeIndex] ?? "0");
              const corrBestAsk = (corrClobAsk > 0 && corrClobAsk < 0.97) ? corrClobAsk : corrImplied > 0 ? corrImplied : corrClobAsk;
              if (corrBestAsk <= 0 || corrBestAsk > MAX_ENTRY_PRICE) return;

              // Slightly lower confidence than main asset â€” signal is BTC-derived
              const corrConf = 72;
              const corrEdge = parseFloat((corrConf / 100 - corrBestAsk).toFixed(2));
              if (corrConf < cfg.minConfidence || corrEdge < cfg.minEdge) return;

              const corrP = corrConf / 100;
              const corrB = (1 - corrBestAsk) / corrBestAsk;
              const corrKelly = (corrP * corrB - (1 - corrP)) / corrB;
              if (corrKelly <= 0) return;

              // 70% of normal dynamic Kelly â€” correlated signal, not independent divergence
              const corrFraction = dynamicKellyFraction(corrConf) * 0.70;
              const corrRawBet = balance * corrKelly * corrFraction;
              const corrBetAmount = parseFloat(Math.min(corrRawBet, cfg.maxBetUsdc, spendable).toFixed(2));
              if (corrBetAmount < MIN_BET) {
                botPrint("SKIP", `[CORR-${corrAsset}] Bet too small: $${corrBetAmount.toFixed(2)}`);
                return;
              }

              botPrint("TRADE", `âš¡ CORRELATED [${corrAsset}] BTC-driven ${direction} â†’ ask=${(corrBestAsk * 100).toFixed(0)}Â¢ | $${corrBetAmount.toFixed(2)} USDC | conf=${corrConf}%`);
              corrSet.add(corrMarket.id);

              const corrResult = await executePolymarketTrade({
                tokenID: corrTokenId,
                amount: corrBetAmount,
                side: Side.BUY,
                price: corrBestAsk,
                executionMode: "AGGRESSIVE",
                amountMode: "SPEND",
              });

              botSessionTradesCount++;
              botPrint("OK", `âš¡ CORR [${corrAsset}] EXECUTED âœ“ | ID: ${corrResult.orderID} | Status: ${corrResult.status}`);

              const corrLevels = recommendAutomationLevels(corrBestAsk);
              await savePositionAutomation({
                assetId: corrTokenId,
                market: corrMarket.question || corrMarket.id,
                outcome: corrMarket.outcomes?.[corrOutcomeIndex] || direction,
                averagePrice: corrBestAsk.toFixed(4),
                size: corrResult.orderSize.toFixed(6),
                takeProfit: corrLevels.takeProfit,
                stopLoss: corrLevels.stopLoss,
                trailingStop: corrLevels.trailingStop,
                windowEnd: nowWindowStart + MARKET_SESSION_SECONDS,
                armed: true,
              });

              pendingResults.set(corrTokenId, {
                eventSlug: `${ASSET_CONFIG[corrAsset].polySlugPrefix}-${nowWindowStart}`,
                marketId: corrMarket.id,
                market: corrMarket.question || corrMarket.id,
                tokenId: corrTokenId,
                direction,
                outcome: corrMarket.outcomes?.[corrOutcomeIndex] || direction,
                entryPrice: corrBestAsk,
                betAmount: corrBetAmount,
                orderId: corrResult.orderID,
                windowEnd: nowWindowStart + MARKET_SESSION_SECONDS,
                confidence: corrConf,
                edge: corrEdge,
                reasoning: `[CORRELATED] BTC STRONG divergence +$${snapshot.btcDelta.toFixed(0)} â†’ ${corrAsset} same-direction entry`,
                windowElapsedSeconds: now - nowWindowStart,
                asset: corrAsset,
              });
            } catch (corrErr: any) {
              botPrint("WARN", `[CORR-${corrAsset}] Entry failed: ${corrErr?.message ?? corrErr}`);
            }
          }));
        }

      } catch (err: any) {
        botPrint("ERR", `[DIV FAST] Execution error: ${err?.message ?? err}`);
      } finally {
        divergenceFastTradeRunning = false;
      }
    })();
  };

  const monitorPositionAutomation = async () => {
    if (positionAutomationRunning) return;
    positionAutomationRunning = true;
    try {
      const collection = await getPositionAutomationCollection();
      const client = await getClobClient();
      if (!collection || !client) return;

      const armedAutomations = await collection.find({ armed: true }).toArray();
      if (!armedAutomations.length) return;

      const nowSeconds = Math.floor(Date.now() / 1000);

      for (const automation of armedAutomations) {
        // â”€â”€ Fix 1: time-based expiry instead of position-lookup guard â”€â”€â”€â”€â”€â”€
        // If the market window expired > 6 minutes ago, the position has
        // already resolved on-chain â€” no point monitoring or trying to exit.
        if (automation.windowEnd && nowSeconds > automation.windowEnd + 360) {
          await savePositionAutomation({
            assetId: automation.assetId,
            armed: false,
            status: "Market window expired â€” resolved on-chain",
            lastPrice: automation.lastPrice,
          });
          continue;
        }

        try {
          const book = await client.getOrderBook(automation.assetId);

          // â”€â”€ Fix 2: 3-tier price estimation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          // Tier 1: best bid (real exit price â€” prefer this always)
          // Tier 2: mid-price when both sides exist
          // Tier 3: best ask alone as conservative proxy
          const bestBid  = Number(book?.bids?.[0]?.price || "0");
          const bestAsk  = Number(book?.asks?.[0]?.price || "0");

          let currentPrice: number;
          if (bestBid > 0 && bestAsk > 0) {
            currentPrice = (bestBid + bestAsk) / 2;       // Tier 2: mid
          } else if (bestBid > 0) {
            currentPrice = bestBid;                        // Tier 1: bid only
          } else if (bestAsk > 0) {
            currentPrice = bestAsk;                        // Tier 3: ask proxy
          } else {
            // No liquidity at all â€” keep armed, try next tick
            await savePositionAutomation({
              assetId: automation.assetId,
              status: "No order book liquidity â€” retrying",
              lastPrice: automation.lastPrice ?? "",
            });
            continue;
          }

          const highestPrice = Math.max(Number(automation.highestPrice || "0"), currentPrice);
          const trailingStopDistance = Number(automation.trailingStop || "0");
          const trailingStopPrice =
            trailingStopDistance > 0 ? Math.max(0.01, highestPrice - trailingStopDistance) : 0;
          const takeProfit = Number(automation.takeProfit || "0");
          const stopLoss   = Number(automation.stopLoss   || "0");
          const entryPrice = Number(automation.averagePrice || "0");

          // â”€â”€ Near-expiry forced exit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          // Binary markets collapse fast in the last minute â€” prices drop 20-30Â¢
          // in a single tick as market makers pull bids near resolution.
          // If â‰¤60s remain and the position is profitable, lock in the gain now.
          const secondsToExpiry = automation.windowEnd ? automation.windowEnd - nowSeconds : 9999;
          const isNearExpiry = secondsToExpiry > 0 && secondsToExpiry <= 60;
          const _isCriticalExpiry = secondsToExpiry > 0 && secondsToExpiry <= 30; void _isCriticalExpiry;

          // Determine if a trigger condition is met
          // TP: use bestBid as the real exit price â€” only trigger when there's actual liquidity.
          //     If no bid, fall back to mid. Either way execute immediately â€” never "wait for bid".
          // SL/trailing/expiry: use currentPrice (mid) for detection, then execute at best available.
          const tpCheckPrice = bestBid > 0 ? bestBid : currentPrice;
          let triggerReason: string | null = null;
          if (takeProfit > 0 && tpCheckPrice >= takeProfit) triggerReason = "take profit";
          if (!triggerReason && stopLoss > 0 && currentPrice <= stopLoss) triggerReason = "stop loss";
          if (!triggerReason && trailingStopPrice > 0 && currentPrice <= trailingStopPrice) triggerReason = "trailing stop";

          // â”€â”€ Profit lock: tighten trailing stop when 70%+ of the way to TP â”€â”€â”€â”€â”€â”€
          // Prevents giving back a large gain when price is near-TP then reverses.
          // When unrealized gain >= 70% of (TP - entry), shrink trailing stop to 3Â¢.
          if (!triggerReason && takeProfit > 0 && entryPrice > 0 && trailingStopDistance > 0.03) {
            const tpDistance = takeProfit - entryPrice;
            const unrealizedGain = currentPrice - entryPrice;
            if (tpDistance > 0 && unrealizedGain >= tpDistance * 0.70) {
              // Override trailing stop distance in MongoDB to 3Â¢ for this position
              await savePositionAutomation({
                assetId: automation.assetId,
                trailingStop: "0.03",
                status: `Profit lock: ${(unrealizedGain * 100).toFixed(0)}Â¢ gain â€” trailing tightened to 3Â¢`,
              });
              botPrint("INFO", `[TP LOCK] Position at ${(currentPrice * 100).toFixed(0)}Â¢ â€” trailing tightened to 3Â¢ (${(unrealizedGain * 100).toFixed(0)}Â¢ gain locked)`);
            }
          }

          // â”€â”€ Spike capture: early large move â€” take it before it reverses â”€â”€â”€â”€â”€â”€â”€â”€
          // If within first 90s after entry the price has spiked +8Â¢, exit immediately.
          // These early spikes almost always mean-revert in 5-min binary markets.
          const entryTimestamp = automation.lastTriggeredAt
            ? Math.floor(new Date(automation.lastTriggeredAt).getTime() / 1000)
            : 0;
          const secondsSinceEntry = entryTimestamp > 0 ? nowSeconds - entryTimestamp : 9999;
          if (!triggerReason && entryPrice > 0 && secondsSinceEntry <= 90) {
            const spikeGain = currentPrice - entryPrice;
            if (spikeGain >= 0.08) {
              triggerReason = `spike capture (+${(spikeGain * 100).toFixed(0)}Â¢ in ${secondsSinceEntry}s â€” taking early gain)`;
            }
          }

          // Near-expiry: exit any profitable position (prevents late-window reversal)
          if (!triggerReason && isNearExpiry && entryPrice > 0 && currentPrice > entryPrice * 1.005) {
            triggerReason = `near-expiry exit (${secondsToExpiry}s remaining â€” locking ${(((currentPrice / entryPrice) - 1) * 100).toFixed(1)}% gain)`;
          }

          if (triggerReason) {
            void (triggerReason === "take profit"); // isTakeProfit â€” guard removed; all triggers execute immediately
            // Execution price: best bid preferred. Fallback to ask * 0.97 (3Â¢ slippage) rather
            // than waiting forever â€” a slightly worse price is better than no exit at all.
            const executionPrice = bestBid > 0
              ? bestBid
              : (bestAsk > 0 ? bestAsk * 0.97 : null);

            if (!executionPrice) {
              await savePositionAutomation({
                assetId: automation.assetId,
                status: `${triggerReason} triggered but no exit price available`,
                lastPrice: currentPrice.toFixed(4),
              });
              continue;
            }

            const exit = await executePolymarketTrade({
              tokenID: automation.assetId,
              amount: automation.size,
              side: Side.SELL,
              price: executionPrice.toFixed(4),
              executionMode: "AGGRESSIVE",
            });
            await savePositionAutomation({
              assetId: automation.assetId,
              armed: false,
              highestPrice: highestPrice.toFixed(4),
              trailingStopPrice: trailingStopPrice > 0 ? trailingStopPrice.toFixed(4) : "",
              lastPrice: executionPrice.toFixed(4),
              lastExitOrderId: exit.orderID,
              status: `Exit submitted by ${triggerReason} @ ${(executionPrice * 100).toFixed(0)}Â¢`,
              lastTriggeredAt: new Date(),
            });
            continue;
          }

          // No trigger â€” update tracking state and keep armed
          const expiryLabel = secondsToExpiry < 9999
            ? ` | Expiry: ${secondsToExpiry}s`
            : "";
          await savePositionAutomation({
            assetId: automation.assetId,
            highestPrice: highestPrice.toFixed(4),
            trailingStopPrice: trailingStopPrice > 0 ? trailingStopPrice.toFixed(4) : "",
            lastPrice: currentPrice.toFixed(4),
            status: `Monitoring â€” ${(currentPrice * 100).toFixed(0)}Â¢ | TP: ${(takeProfit * 100).toFixed(0)}Â¢ | SL: ${(stopLoss * 100).toFixed(0)}Â¢${expiryLabel}`,
          });
        } catch (error: any) {
          await savePositionAutomation({
            assetId: automation.assetId,
            status: `Monitor error: ${error?.message || "Unknown error"}`,
          });
        }
      }
    } finally {
      positionAutomationRunning = false;
    }
  };

  const startPositionAutomationMonitor = () => {
    if (!MONGODB_URI || positionAutomationInterval) return;
    void monitorPositionAutomation();
    positionAutomationInterval = setInterval(() => {
      void monitorPositionAutomation();
    }, POSITION_AUTOMATION_SYNC_MS);
  };

  startPositionAutomationMonitor();

  // â”€â”€ Bot logging helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });
  const botPrint = (level: "INFO" | "WARN" | "TRADE" | "OK" | "SKIP" | "ERR", msg: string) => {
    const icons: Record<string, string> = {
      INFO:  "-",
      WARN:  "!",
      TRADE: "$",
      OK:    "+",
      SKIP:  "x",
      ERR:   "X",
    };
    const safeMsg = sanitizeTerminalText(msg);
    const entry: RawLogEntry = { ts: ts(), level, msg: safeMsg };
    console.log(`[${entry.ts}] [BOT:${level.padEnd(5)}] ${icons[level]} ${safeMsg}`);
    rawLog.unshift(entry);
    if (rawLog.length > 500) rawLog.pop();
    pushSSE("log", entry);
  };

  const cexPrint = (level: "INFO" | "WARN" | "OK" | "SKIP" | "ERR", msg: string) => {
    const safeMsg = sanitizeTerminalText(msg);
    const entry: RawLogEntry = { ts: ts(), level, msg: safeMsg };
    console.log(`[${entry.ts}] [CEX:${level.padEnd(5)}] ${safeMsg}`);
    cexLog.unshift(entry);
    if (cexLog.length > 500) cexLog.pop();
    pushSSE("cex", entry);
  };

  // â”€â”€ Win / Loss result checker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const checkPendingResults = async () => {
    if (pendingResults.size === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const parseLocal = (val: any): any[] => {
      if (Array.isArray(val)) return val;
      if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
      return [];
    };

    for (const [tokenId, pending] of pendingResults) {
      if (now < pending.windowEnd + 120) continue; // wait 2 min after close
      const giveUp = now > pending.windowEnd + 1200; // give up after 20 min

      // â”€â”€ Step 1: Check OUR specific token's current price via CLOB â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // tokenId is exactly the token we bought (YES for UP, NO for DOWN)
      // After resolution: worth ~$1.00 if we won, ~$0.00 if we lost
      let ourTokenPrice: number | null = null;
      let resolvedSource = "";

      try {
        const clobClient = await getClobClient();
        if (clobClient) {
          const book = await clobClient.getOrderBook(tokenId);
          const bids: any[] = book?.bids ?? [];
          const asks: any[] = book?.asks ?? [];
          const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
          const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;

          botPrint("INFO", `Result check [CLOB] tokenId=${tokenId.slice(0, 10)}â€¦ bid=${bestBid ?? "none"} ask=${bestAsk ?? "none"}`);

          if (bestBid !== null && bestBid >= 0.90) {
            ourTokenPrice = bestBid;          // token worth ~$1 â†’ WIN
            resolvedSource = `CLOB bid=${bestBid.toFixed(3)}`;
          } else if (bestBid !== null && bestBid <= 0.10) {
            ourTokenPrice = bestBid;          // token worth ~$0 â†’ LOSS
            resolvedSource = `CLOB bid=${bestBid.toFixed(3)}`;
          } else if (bestBid === null && bestAsk === null) {
            // No order book at all â€” market likely settled, check prices-history
            try {
              const hist = await axios.get("https://clob.polymarket.com/prices-history", {
                params: { market: tokenId, interval: "1m", fidelity: 1 },
                timeout: 6000,
              });
              const pts: { t: number; p: number }[] = Array.isArray(hist.data)
                ? hist.data : (hist.data?.history ?? []);
              if (pts.length > 0) {
                const lastPrice = pts[pts.length - 1].p;
                botPrint("INFO", `Result check [prices-history] lastPrice=${lastPrice.toFixed(3)}`);
                if (lastPrice >= 0.90 || lastPrice <= 0.10) {
                  ourTokenPrice = lastPrice;
                  resolvedSource = `prices-history last=${lastPrice.toFixed(3)}`;
                }
              }
            } catch { /* non-fatal */ }
          }
        }
      } catch { /* CLOB unavailable â€” fall through to gamma */ }

      // â”€â”€ Step 2: Fallback â€” Gamma API using correct outcome index â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (ourTokenPrice === null) {
        try {
          const eventRes = await axios.get(
            `https://gamma-api.polymarket.com/events/slug/${pending.eventSlug}`,
            { timeout: 8000 }
          );
          const markets: any[] = eventRes.data?.markets || [];
          const mkt = markets.find((m: any) =>
            m.id === pending.marketId ||
            parseLocal(m.clobTokenIds).includes(tokenId)
          );

          if (mkt) {
            // mkt.winner is the most reliable field
            if (typeof mkt.winner === "string" && mkt.winner.length > 0) {
              const yesWon = mkt.winner.toLowerCase().startsWith("y");
              // Map to our token: UP bought YES (index 0), DOWN bought NO (index 1)
              ourTokenPrice = (pending.direction === "UP" ? yesWon : !yesWon) ? 1.0 : 0.0;
              resolvedSource = `gamma winner="${mkt.winner}"`;
              botPrint("INFO", `Result check [gamma winner] ${mkt.winner} â†’ ourToken=${ourTokenPrice}`);
            } else {
              // Use outcomePrices at OUR outcome index, not always index 0
              const prices = parseLocal(mkt.outcomePrices);
              const ourIndex = pending.direction === "UP" ? 0 : 1;
              const ourPrice = parseFloat(prices[ourIndex] ?? "0.5");
              botPrint("INFO", `Result check [gamma prices] index=${ourIndex} ourPrice=${ourPrice.toFixed(3)} resolved=${mkt.resolved}`);
              if ((ourPrice >= 0.90 || ourPrice <= 0.10) && mkt.resolved !== false) {
                ourTokenPrice = ourPrice;
                resolvedSource = `gamma outcomePrices[${ourIndex}]=${ourPrice.toFixed(3)}`;
              }
            }
          }
        } catch { /* non-fatal */ }
      }

      // â”€â”€ Still can't determine â€” wait or give up â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (ourTokenPrice === null) {
        if (giveUp) {
          botPrint("WARN", `Result UNKNOWN after 20min for "${pending.market.slice(0, 40)}" â€” removing tracker`);
          pendingResults.delete(tokenId);
        } else {
          const waitedMin = ((now - pending.windowEnd) / 60).toFixed(1);
          botPrint("INFO", `Result pending (${waitedMin}min elapsed) â€” retrying next cycle`);
        }
        continue;
      }

      // â”€â”€ Determine WIN / LOSS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // PnL: shares Ã— $1 payout minus cost (WIN), or full bet lost (LOSS)
      // won_final = pnl > 0: even $0.01 profit = WIN; no profit = LOSS
      const shares = pending.entryPrice > 0 ? pending.betAmount / pending.entryPrice : 0;
      const grossPayout = ourTokenPrice >= 0.90 ? shares * 1.0 : shares * ourTokenPrice;
      const pnl = parseFloat((grossPayout - pending.betAmount).toFixed(2));
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const won_final = pnl > 0;

      botPrint("INFO", `Result resolved via [${resolvedSource}] â†’ ${won_final ? "WIN" : "LOSS"} (ourTokenPrice=${ourTokenPrice.toFixed(3)}, pnl=${pnlStr})`);

      if (won_final) {
        // â”€â”€ WIN: relax adaptive threshold (per-asset) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const pendingAsset = pending.asset ?? "BTC";
        const cWins  = (consecutiveWinsByAsset.get(pendingAsset)  ?? 0) + 1;
        const cBoost =  adaptiveConfidenceByAsset.get(pendingAsset) ?? 0;
        consecutiveWinsByAsset.set(pendingAsset, cWins);
        consecutiveLossesByAsset.set(pendingAsset, 0);
        consecutiveWins = cWins; consecutiveLosses = 0; // keep legacy for saveLearning
        if (cWins >= 2 && cBoost > 0) {
          const newBoost = Math.max(cBoost - 3, 0);
          adaptiveConfidenceByAsset.set(pendingAsset, newBoost);
          adaptiveConfidenceBoost = newBoost;
          botPrint("OK", `[${pendingAsset}] Adaptive: streak=${cWins}W â€” threshold relaxed to ${BOT_MIN_CONFIDENCE + newBoost}% (boost=${newBoost > 0 ? `+${newBoost}%` : "none"})`);
        }
        botPrint("OK", `â”â”â” ðŸ† WIN  â”â”â” ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}Â¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
        const winLesson = generateWinLesson(pending);
        winMemory.unshift({
          timestamp: new Date().toISOString(),
          market: pending.market,
          asset: pending.asset,
          direction: pending.direction,
          confidence: pending.confidence,
          edge: pending.edge,
          entryPrice: pending.entryPrice,
          betAmount: pending.betAmount,
          pnl,
          windowElapsedSeconds: pending.windowElapsedSeconds,
          rsi: pending.rsi,
          emaCross: pending.emaCross,
          signalScore: pending.signalScore,
          imbalanceSignal: pending.imbalanceSignal,
          lesson: winLesson,
        });
        if (winMemory.length > 20) winMemory.pop();
        botPrint("INFO", `Win pattern recorded: ${winLesson}`);
        saveLearning();
        saveTradeLog({
          ts: new Date().toISOString(),
          market: pending.market,
          direction: pending.direction as "UP" | "DOWN",
          confidence: pending.confidence,
          edge: pending.edge,
          betAmount: pending.betAmount,
          entryPrice: pending.entryPrice,
          pnl,
          result: "WIN",
          rsi: pending.rsi,
          emaCross: pending.emaCross,
          signalScore: pending.signalScore,
          imbalanceSignal: pending.imbalanceSignal,
          divergenceDirection: divergenceStateByAsset.get(pending.asset ?? "BTC")?.direction,
          divergenceStrength: divergenceStateByAsset.get(pending.asset ?? "BTC")?.strength,
          btcDelta30s: divergenceStateByAsset.get(pending.asset ?? "BTC")?.btcDelta30s,
          yesDelta30s: divergenceStateByAsset.get(pending.asset ?? "BTC")?.yesDelta30s,
          windowElapsedSeconds: pending.windowElapsedSeconds,
          orderId: pending.orderId,
        });
      } else {
        // â”€â”€ LOSS: record memory, tighten adaptive threshold (per-asset) â”€â”€â”€â”€
        const pendingAsset = pending.asset ?? "BTC";
        const cLosses = (consecutiveLossesByAsset.get(pendingAsset) ?? 0) + 1;
        consecutiveLossesByAsset.set(pendingAsset, cLosses);
        consecutiveWinsByAsset.set(pendingAsset, 0);
        consecutiveLosses = cLosses; consecutiveWins = 0; // keep legacy for saveLearning
        const lesson = generateLesson(pending);

        lossMemory.unshift({
          timestamp: new Date().toISOString(),
          market: pending.market,
          asset: pending.asset,
          direction: pending.direction,
          confidence: pending.confidence,
          edge: pending.edge,
          entryPrice: pending.entryPrice,
          betAmount: pending.betAmount,
          pnl,
          windowElapsedSeconds: pending.windowElapsedSeconds,
          rsi: pending.rsi,
          emaCross: pending.emaCross,
          signalScore: pending.signalScore,
          imbalanceSignal: pending.imbalanceSignal,
          reasoning: pending.reasoning,
          lesson,
        });
        if (lossMemory.length > 20) lossMemory.pop();

        if (adaptiveLossPenaltyEnabled && cLosses >= 2) {
          const newBoost = Math.min((adaptiveConfidenceByAsset.get(pendingAsset) ?? 0) + 5, 20);
          adaptiveConfidenceByAsset.set(pendingAsset, newBoost);
          adaptiveConfidenceBoost = newBoost;
          botPrint("WARN", `[${pendingAsset}] Adaptive: streak=${cLosses}L â€” threshold raised to ${BOT_MIN_CONFIDENCE + newBoost}% (+${newBoost}% boost)`);
        } else if (!adaptiveLossPenaltyEnabled && cLosses >= 2) {
          botPrint("INFO", `[${pendingAsset}] Adaptive loss penalty disabled â€” streak=${cLosses}L recorded, threshold unchanged`);
        }
        botPrint("WARN", `â”â”â” âœ— LOSS â”â”â” ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}Â¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
        botPrint("INFO", `Lesson recorded: ${lesson}`);
        saveLearning();
        saveTradeLog({
          ts: new Date().toISOString(),
          market: pending.market,
          direction: pending.direction as "UP" | "DOWN",
          confidence: pending.confidence,
          edge: pending.edge,
          betAmount: pending.betAmount,
          entryPrice: pending.entryPrice,
          pnl,
          result: "LOSS",
          rsi: pending.rsi,
          emaCross: pending.emaCross,
          signalScore: pending.signalScore,
          imbalanceSignal: pending.imbalanceSignal,
          divergenceDirection: divergenceStateByAsset.get(pending.asset ?? "BTC")?.direction,
          divergenceStrength: divergenceStateByAsset.get(pending.asset ?? "BTC")?.strength,
          btcDelta30s: divergenceStateByAsset.get(pending.asset ?? "BTC")?.btcDelta30s,
          yesDelta30s: divergenceStateByAsset.get(pending.asset ?? "BTC")?.yesDelta30s,
          windowElapsedSeconds: pending.windowElapsedSeconds,
          orderId: pending.orderId,
        });
      }

      botLog.unshift({
        timestamp: new Date().toISOString(),
        market: pending.market,
        decision: won_final ? "WIN" : "LOSS",
        direction: pending.direction,
        confidence: 0,
        edge: 0,
        riskLevel: "LOW",
        reasoning: `Market resolved ${won_final ? "IN YOUR FAVOR âœ“" : "AGAINST YOU âœ—"} | Direction: ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}Â¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}${!won_final ? ` | Lesson: ${generateLesson(pending)}` : ""}`,
        tradeExecuted: false,
        tradeAmount: pending.betAmount,
        tradePrice: pending.entryPrice,
        orderId: pending.orderId,
      });
      if (botLog.length > 100) botLog.pop();

      pendingResults.delete(tokenId);
    }
  };

  const runPriceLagScalperCycle = async (params: {
    currentWindowStart: number;
    windowElapsedSeconds: number;
    windowRemaining: number;
    mm: string;
    ss: string;
  }) => {
    const { currentWindowStart, windowElapsedSeconds, windowRemaining, mm, ss } = params;
    const lagMarkets = await discoverActiveCryptoLagMarkets(currentWindowStart);
    if (lagMarkets.length === 0) {
      botPrint("WARN", `[LAG] No active crypto 5m markets found for ${currentWindowStart}`);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const cfg = getPriceLagConfig();
    const timing = getPriceLagTiming(windowElapsedSeconds);
    botPrint("INFO", `[LAG] Strategy=PRICE_LAG_SCALPER | zone=${timing.zone} | scanning ${lagMarkets.length} markets | ${mm}:${ss} left`);

    for (const candidate of lagMarkets) {
      const market = candidate.market;
      const assetKey = candidate.assetSymbol as TradingAsset;

      if (botTradedThisWindowMarketIds.has(market.id)) {
        botPrint("SKIP", `[${candidate.assetSymbol}] Already traded this window: ${market.question?.slice(0, 48)}`);
        continue;
      }

      const assetPriceData = await getDynamicAssetPrice(candidate.assetSymbol);
      const assetNow = Number(assetPriceData?.price || "0");
      if (!(assetNow > 0)) {
        cexPrint("ERR", `[${candidate.assetSymbol}] No external spot price available from Coinbase/Binance`);
        botPrint("WARN", `[${candidate.assetSymbol}] No external spot price available - skipping lag scan`);
        continue;
      }

      const yesNow = Number(candidate.yesPrice || 0);
      const noNow = Number(candidate.noPrice || 0);
      if (!(yesNow > 0 && noNow > 0)) continue;

      pushLagSample(lagAssetPriceBuffers, candidate.assetSymbol, assetNow, now);
      pushLagSample(lagYesPriceBuffers, market.id, yesNow, now);
      pushLagSample(lagNoPriceBuffers, market.id, noNow, now);

      const asset10Ref = findLagReference(lagAssetPriceBuffers.get(candidate.assetSymbol), now - 10);
      const asset30Ref = findLagReference(lagAssetPriceBuffers.get(candidate.assetSymbol), now - 30);
      const asset60Ref = findLagReference(lagAssetPriceBuffers.get(candidate.assetSymbol), now - 60);
      const yes10Ref = findLagReference(lagYesPriceBuffers.get(market.id), now - 10);
      const yes30Ref = findLagReference(lagYesPriceBuffers.get(market.id), now - 30);
      const no10Ref = findLagReference(lagNoPriceBuffers.get(market.id), now - 10);
      const no30Ref = findLagReference(lagNoPriceBuffers.get(market.id), now - 30);

      if (!asset10Ref || !asset30Ref || !asset60Ref || !yes10Ref || !yes30Ref || !no10Ref || !no30Ref) {
        botPrint("SKIP", `[${candidate.assetSymbol}] Building lag buffers for ${market.question?.slice(0, 42)}...`);
        continue;
      }

      const assetBoost = adaptiveConfidenceByAsset.get(assetKey) ?? 0;
      let signal = computePriceLagSignal({
        assetSymbol: candidate.assetSymbol,
        assetNow,
        assetRef10: asset10Ref.price,
        assetRef30: asset30Ref.price,
        assetRef60: asset60Ref.price,
        yesNow,
        yesRef10: yes10Ref.price,
        yesRef30: yes30Ref.price,
        noNow,
        noRef10: no10Ref.price,
        noRef30: no30Ref.price,
      });

      const effectiveMinConf = cfg.minConfidence + assetBoost;
      currentEntrySnapshot = {
        market: market.question || market.id,
        windowStart: currentWindowStart,
        yesPrice: yesNow,
        noPrice: noNow,
        direction: signal.decision === "TRADE" ? signal.direction : null,
        confidence: signal.confidence,
        edge: signal.estimatedEdge,
        riskLevel: signal.riskLevel,
        estimatedBet: botFixedTradeUsdc,
        btcPrice: assetNow,
        asset: assetKey,
        divergence: {
          direction: signal.direction,
          strength: `LAG ${signal.lagGapCents.toFixed(1)}c`,
          btcDelta30s: signal.assetMove30Pct,
          yesDelta30s: signal.direction === "UP" ? signal.yesDelta30Cents : signal.noDelta30Cents,
        },
        fastLoopMomentum: null,
        updatedAt: new Date().toISOString(),
      };

      if (signal.decision !== "TRADE") {
        cexPrint("INFO", `[${candidate.assetSymbol}] ${assetPriceData?.source || "unknown"} spot=${assetNow.toFixed(4)} | poly yes=${(yesNow * 100).toFixed(2)}c no=${(noNow * 100).toFixed(2)}c | ${signal.reasoning}`);
        botPrint("SKIP", `[${candidate.assetSymbol}] ${signal.reasoning}`);
        continue;
      }

      if (signal.confidence < effectiveMinConf || signal.riskLevel === "HIGH") {
        botPrint("SKIP", `[${candidate.assetSymbol}] Lag signal rejected | conf ${signal.confidence}% < ${effectiveMinConf}% or risk=${signal.riskLevel}`);
        continue;
      }

      const targetOutcomeIndex = signal.direction === "UP" ? 0 : 1;
      const targetTokenId = market.clobTokenIds?.[targetOutcomeIndex];
      const yesTokenId = market.clobTokenIds?.[0];
      if (!targetTokenId || !yesTokenId) continue;

      const [yesBook, targetBook] = await Promise.all([
        axios.get(`https://clob.polymarket.com/book?token_id=${yesTokenId}`, { timeout: 4000 }).then((r) => r.data).catch(() => null),
        targetTokenId === yesTokenId
          ? axios.get(`https://clob.polymarket.com/book?token_id=${yesTokenId}`, { timeout: 4000 }).then((r) => r.data).catch(() => null)
          : axios.get(`https://clob.polymarket.com/book?token_id=${targetTokenId}`, { timeout: 4000 }).then((r) => r.data).catch(() => null),
      ]);

      const sumSize = (orders: any[]) => (orders || []).reduce((s: number, o: any) => s + parseFloat(o.size || "0"), 0);
      const yesBidSize = sumSize(yesBook?.bids || []);
      const yesAskSize = sumSize(yesBook?.asks || []);
      const yesTotal = yesBidSize + yesAskSize;
      const yesSignal =
        yesTotal <= 0
          ? "UNKNOWN"
          : yesBidSize / yesTotal > 0.60
            ? "BUY_PRESSURE"
            : yesBidSize / yesTotal < 0.40
              ? "SELL_PRESSURE"
              : "NEUTRAL";

      const pressureOpposes =
        (signal.direction === "UP" && yesSignal === "SELL_PRESSURE") ||
        (signal.direction === "DOWN" && yesSignal === "BUY_PRESSURE") ||
        yesSignal === "UNKNOWN";
      if (pressureOpposes) {
        cexPrint("WARN", `[${candidate.assetSymbol}] Spot ${assetNow.toFixed(4)} | lag=${signal.lagGapCents.toFixed(2)}c rejected by orderbook pressure=${yesSignal}`);
        botPrint("SKIP", `[${candidate.assetSymbol}] Pressure filter blocked lag trade | direction=${signal.direction} yesBook=${yesSignal}`);
        continue;
      }

      const bestBid = Number(targetBook?.bids?.[0]?.price || "0");
      const rawAsk = Number(targetBook?.asks?.[0]?.price || "0");
      const impliedEntryPrice = Number(market.outcomePrices?.[targetOutcomeIndex] || "0");
      const bestAsk = rawAsk > 0 && rawAsk < 0.97 ? rawAsk : impliedEntryPrice > 0 ? impliedEntryPrice : rawAsk;
      if (!(bestAsk > 0)) {
        botPrint("SKIP", `[${candidate.assetSymbol}] No executable entry price`);
        continue;
      }

      const spreadCents = rawAsk > 0 && bestBid > 0 ? (rawAsk - bestBid) * 100 : null;
      if (spreadCents != null && spreadCents > Math.max(4, signal.lagGapCents * 0.85)) {
        botPrint("SKIP", `[${candidate.assetSymbol}] Spread too wide for lag scalp (${spreadCents.toFixed(2)}c)`); 
        continue;
      }

      const chaseCap = Math.min(
        signal.maxEntryPrice,
        impliedEntryPrice > 0
          ? impliedEntryPrice + Math.min(0.03, Math.max(0.015, signal.lagGapCents * 0.0055))
          : signal.maxEntryPrice
      );
      if (bestAsk > chaseCap) {
        cexPrint("SKIP", `[${candidate.assetSymbol}] ${assetPriceData?.source || "unknown"} spot=${assetNow.toFixed(4)} | poly ask=${(bestAsk * 100).toFixed(2)}c too expensive vs lag cap ${(chaseCap * 100).toFixed(2)}c`);
        botPrint("SKIP", `[${candidate.assetSymbol}] Entry too expensive ${(bestAsk * 100).toFixed(1)}c > ${(chaseCap * 100).toFixed(1)}c lag cap`);
        continue;
      }
      if (bestAsk >= ANALYSIS_COIN_FLIP_MIN_PRICE && bestAsk <= ANALYSIS_COIN_FLIP_MAX_PRICE) {
        botPrint("SKIP", `[${candidate.assetSymbol}] Coin-flip zone ${(bestAsk * 100).toFixed(1)}c - lag scalp skipped`);
        continue;
      }

      const logEntry: BotLogEntry = {
        timestamp: new Date().toISOString(),
        market: market.question || market.id,
        decision: "TRADE",
        direction: signal.direction,
        confidence: signal.confidence,
        edge: signal.estimatedEdge,
        riskLevel: signal.riskLevel,
        reasoning: `[PRICE_LAG] ${signal.reasoning}`,
        tradeExecuted: false,
      };

      const client = await getClobClient();
      if (!client) {
        logEntry.error = "CLOB client not ready - trade skipped.";
        botPrint("ERR", "CLOB client not initialized. Check POLYGON_PRIVATE_KEY.");
        botLog.unshift(logEntry);
        if (botLog.length > 100) botLog.pop();
        continue;
      }

      if (botSessionStartBalance === null) {
        try {
          const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          botSessionStartBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
          botPrint("OK", `Session initialized. Starting balance: $${botSessionStartBalance.toFixed(2)} USDC`);
        } catch {
          // non-fatal
        }
      }

      let currentBalance = botSessionStartBalance ?? 0;
      try {
        const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        currentBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
        lastKnownBalance = currentBalance;
      } catch {
        botPrint("WARN", `Balance fetch failed - using last known: $${currentBalance.toFixed(2)} USDC`);
      }

      const reserve = Math.min(1.0, currentBalance * 0.10);
      const spendable = Math.max(0, currentBalance - reserve);
      const betAmount = parseFloat(botFixedTradeUsdc.toFixed(2));
      if (spendable < betAmount) {
        botPrint("SKIP", `[${candidate.assetSymbol}] Insufficient spendable balance for fixed lag trade`);
        continue;
      }

      const refreshedAssetPriceData = await getDynamicAssetPrice(candidate.assetSymbol, true);
      const refreshedAssetNow = Number(refreshedAssetPriceData?.price || "0");
      if (!(refreshedAssetNow > 0)) {
        cexPrint("ERR", `[${candidate.assetSymbol}] Final spot refresh failed before execution`);
        botPrint("SKIP", `[${candidate.assetSymbol}] Spot refresh failed right before execution`);
        continue;
      }

      signal = computePriceLagSignal({
        assetSymbol: candidate.assetSymbol,
        assetNow: refreshedAssetNow,
        assetRef10: asset10Ref.price,
        assetRef30: asset30Ref.price,
        assetRef60: asset60Ref.price,
        yesNow,
        yesRef10: yes10Ref.price,
        yesRef30: yes30Ref.price,
        noNow,
        noRef10: no10Ref.price,
        noRef30: no30Ref.price,
      });

      if (
        signal.decision !== "TRADE" ||
        signal.direction === "NONE" ||
        signal.confidence < effectiveMinConf ||
        signal.riskLevel === "HIGH"
      ) {
        cexPrint("SKIP", `[${candidate.assetSymbol}] Final recheck invalidated setup | source=${refreshedAssetPriceData?.source || assetPriceData?.source || "unknown"} spot=${refreshedAssetNow.toFixed(4)} | ${signal.reasoning}`);
        botPrint("SKIP", `[${candidate.assetSymbol}] Lag died on final recheck | ${signal.reasoning}`);
        continue;
      }

      cexPrint(
        "OK",
        `[${candidate.assetSymbol}] source=${refreshedAssetPriceData?.source || assetPriceData?.source || "unknown"} spot=${refreshedAssetNow.toFixed(4)} | poly yes=${(yesNow * 100).toFixed(2)}c no=${(noNow * 100).toFixed(2)}c | dir=${signal.direction} lag=${signal.lagGapCents.toFixed(2)}c conf=${signal.confidence}% ask=${(bestAsk * 100).toFixed(2)}c`
      );

      botPrint("TRADE", `[PRICE_LAG] ${candidate.assetSymbol} ${signal.direction} | conf=${signal.confidence}% | lag=${signal.lagGapCents.toFixed(2)}c | micro=${signal.assetMove10Pct.toFixed(3)}% | ask=${(bestAsk * 100).toFixed(1)}c | bet=$${betAmount.toFixed(2)}`);

      try {
        const tradeResult = await executePolymarketTrade({
          tokenID: targetTokenId,
          amount: betAmount,
          side: Side.BUY,
          price: bestAsk,
          executionMode: "AGGRESSIVE",
          amountMode: "SPEND",
        });

        const levels = recommendLagScalpLevels(bestAsk, signal);
        await savePositionAutomation({
          assetId: targetTokenId,
          market: market.question || market.id,
          outcome: market.outcomes?.[targetOutcomeIndex] || signal.direction,
          averagePrice: bestAsk.toFixed(4),
          size: tradeResult.orderSize.toFixed(6),
          takeProfit: levels.takeProfit,
          stopLoss: levels.stopLoss,
          trailingStop: levels.trailingStop,
          windowEnd: currentWindowStart + MARKET_SESSION_SECONDS,
          armed: true,
        });

        botTradedThisWindowMarketIds.add(market.id);
        botSessionTradesCount++;
        logEntry.tradeExecuted = true;
        logEntry.tradeAmount = betAmount;
        logEntry.tradePrice = bestAsk;
        logEntry.orderId = tradeResult.orderID;
        botPrint("OK", `[PRICE_LAG] Executed ${candidate.assetSymbol} ${signal.direction} | ID: ${tradeResult.orderID} | TP ${levels.takeProfit} SL ${levels.stopLoss}`);

        pendingResults.set(targetTokenId, {
          eventSlug: candidate.slug,
          marketId: market.id,
          market: market.question || market.id,
          tokenId: targetTokenId,
          direction: signal.direction,
          outcome: market.outcomes?.[targetOutcomeIndex] || signal.direction,
          entryPrice: bestAsk,
          betAmount,
          orderId: tradeResult.orderID,
          windowEnd: currentWindowStart + MARKET_SESSION_SECONDS,
          confidence: signal.confidence,
          edge: signal.estimatedEdge,
          reasoning: `[PRICE_LAG] ${signal.reasoning}`,
          windowElapsedSeconds,
          imbalanceSignal: yesSignal,
          asset: assetKey,
        });
      } catch (tradeErr: any) {
        logEntry.error = tradeErr?.message || String(tradeErr);
        botPrint("ERR", `[PRICE_LAG] Trade execution failed: ${logEntry.error}`);
      }

      botLog.unshift(logEntry);
      if (botLog.length > 100) botLog.pop();
      pushSSE("cycle", { ts: new Date().toISOString() });
    }
  };

  // â”€â”€ Bot cycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const runBotCycle = async () => {
    if (botRunning || !botEnabled) return;

    botRunning = true;
    try {
      await checkPendingResults();
      const nowUtcSeconds = Math.floor(Date.now() / 1000);
      const currentWindowStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
      const windowElapsedSeconds = nowUtcSeconds - currentWindowStart;
      const windowRemaining = MARKET_SESSION_SECONDS - windowElapsedSeconds;
      const mm = String(Math.floor(windowRemaining / 60)).padStart(2, "0");
      const ss = String(windowRemaining % 60).padStart(2, "0");

      // Reset per-window state when a new 5-min window starts
      if (currentWindowStart !== botLastWindowStart) {
        for (const s of botAnalyzedThisWindowByAsset.values()) s.clear();
        currentWindowAiCache = null;
        botLastWindowStart = currentWindowStart;
        botTradedThisWindowMarketIds.clear();
        lagAssetPriceBuffers.clear();
        lagYesPriceBuffers.clear();
        lagNoPriceBuffers.clear();
        // Clear YES ring buffer â€” old window's tokens are no longer valid
        yesRingBuffer.length = 0;
        currentWindowYesTokenId = null;
        currentWindowNoTokenId  = null;
        currentWindowYesTokenIdByAsset.clear();
        currentWindowNoTokenIdByAsset.clear();
        botPrint("INFO", `â”â”â”â” NEW WINDOW â”â”â”â” ${new Date(currentWindowStart * 1000).toLocaleTimeString()} â€” ${new Date((currentWindowStart + 300) * 1000).toLocaleTimeString()}`);
        // Auto-calibrate FastLoop signal quality at start of each new window
        if (autoCalibrateEnabled) void runAutoCalibration();
      }

      const timing = getPriceLagTiming(windowElapsedSeconds);
      if (!timing.allowTrading) {
        if (timing.zone === "EARLY_DEAD_ZONE") {
          botPrint("SKIP", `${timing.reason} | ${mm}:${ss} left`);
        } else {
          botPrint("SKIP", `${timing.reason} | ${mm}:${ss} left`);
        }
        return;
      }

      await runPriceLagScalperCycle({
        currentWindowStart,
        windowElapsedSeconds,
        windowRemaining,
        mm,
        ss,
      });
      return;

      const parseArr = (val: any): any[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
        return [];
      };

      // â”€â”€ Outer loop: iterate over each enabled asset (BTC, ETH, SOL) â”€â”€â”€â”€â”€â”€
      for (const currentAsset of ENABLED_ASSETS) {
        const assetCfg = ASSET_CONFIG[currentAsset];
        const analyzedThisWindow = botAnalyzedThisWindowByAsset.get(currentAsset)!;

        // Fetch current market for this asset
        const slug = `${assetCfg.polySlugPrefix}-${currentWindowStart}`;

        botPrint("INFO", `[${currentAsset}] Scanning window ${mm}:${ss} remaining | elapsed=${windowElapsedSeconds}s | slug=${slug}`);

        let markets: any[] = [];
        {
          try {
            const eventRes = await axios.get(`https://gamma-api.polymarket.com/events/slug/${slug}`, { timeout: 8000 });
            const event = eventRes.data;
            markets = (event?.markets || []).map((m: any) => ({
              ...m,
              outcomes: parseArr(m.outcomes),
              outcomePrices: parseArr(m.outcomePrices),
              clobTokenIds: parseArr(m.clobTokenIds),
              eventSlug: event.slug,
              eventTitle: event.title,
              eventId: event.id,
              startDate: event.startDate,
              endDate: event.endDate,
            }));
            if (markets.length === 0) {
              botPrint("WARN", `[${currentAsset}] No markets found for slug: ${slug}`);
              continue;
            }
            botPrint("INFO", `[${currentAsset}] Found ${markets.length} market(s) for window`);
          } catch {
            botPrint("ERR", `[${currentAsset}] Failed to fetch market for slug: ${slug}`);
            continue;
          }
        }

      for (const market of markets) {
        // Expose to divergence fast path so it can execute without waiting for this cycle
        activeBotMarketByAsset.set(currentAsset, market);
        activeBotMarket = market; // sync alias for divergence tracker
        currentDivergenceAsset = currentAsset; // tracker uses this asset's thresholds + token IDs
        // Sync YES/NO token IDs to divergence tracker for this asset
        currentWindowYesTokenId = currentWindowYesTokenIdByAsset.get(currentAsset) ?? null;
        currentWindowNoTokenId  = currentWindowNoTokenIdByAsset.get(currentAsset) ?? null;

        if (analyzedThisWindow.has(market.id)) {
          botPrint("SKIP", `[${currentAsset}] Already analyzed this window: ${market.question?.slice(0, 50)}`);
          continue;
        }
        analyzedThisWindow.add(market.id);
        // NOTE: if only the price gate fails (not signal quality), we remove from
        // the set below so the bot re-checks price on the next cycle.

        botPrint("INFO", `Analyzing: ${market.question?.slice(0, 60)}`);

        try {
          let btcPriceData: any;
          let btcHistoryResult: any;
          let btcIndicatorsData: any;
          let sentimentData: any;
          let orderBooks: Record<string, any>;
          let marketHistory: { t: number; yes: number; no: number }[];

          {
            // Fetch all data fresh (no prefetch)
            botPrint("INFO", `[${currentAsset}] Fetching price, history, indicators, sentiment...`);
            [btcPriceData, btcHistoryResult, btcIndicatorsData, sentimentData] = await Promise.all([
              getAssetPrice(currentAsset),
              getAssetHistory(currentAsset),
              getAssetIndicators(currentAsset),
              axios.get("https://api.alternative.me/fng/", { timeout: 5000 })
                .then((r) => r.data.data[0]).catch(() => null),
            ]);
            botPrint("OK", `[${currentAsset}] $${btcPriceData?.price ?? "?"} | Candles: ${btcHistoryResult?.history?.length ?? 0} | RSI: ${btcIndicatorsData?.rsi?.toFixed(1) ?? "?"} | EMA: ${btcIndicatorsData?.emaCross ?? "?"} | Sentiment: ${sentimentData?.value_classification ?? "?"}`);

            // Fetch order books with computed imbalance + liquidity
            botPrint("INFO", "Fetching order books...");
            const tokenIds: string[] = market.clobTokenIds || [];
            // Register token IDs per-asset for divergence tracker
            if (tokenIds[0]) currentWindowYesTokenIdByAsset.set(currentAsset, tokenIds[0]);
            if (tokenIds[1]) currentWindowNoTokenIdByAsset.set(currentAsset, tokenIds[1]);
            // Sync tracker vars to current asset so divergence tracker reads correct tokens
            currentWindowYesTokenId = currentWindowYesTokenIdByAsset.get(currentAsset) ?? null;
            currentWindowNoTokenId  = currentWindowNoTokenIdByAsset.get(currentAsset) ?? null;
            orderBooks = {};
            await Promise.all(tokenIds.map(async (tid, idx) => {
              try {
                const client = await getClobClient();
                const raw: any = client
                  ? await client.getOrderBook(tid)
                  : (await axios.get(`https://clob.polymarket.com/book?token_id=${tid}`, { timeout: 6000 })).data;
                const sumSize = (orders: any[]) => (orders || []).reduce((s: number, o: any) => s + parseFloat(o.size || "0"), 0);
                const sumNotional = (orders: any[]) => (orders || []).reduce((s: number, o: any) => s + parseFloat(o.size || "0") * parseFloat(o.price || "0"), 0);
                const bidSize = sumSize(raw.bids);
                const askSize = sumSize(raw.asks);
                const total = bidSize + askSize;
                const imbalance = total > 0 ? parseFloat((bidSize / total).toFixed(4)) : 0.5;
                const imbalanceSignal = imbalance > 0.60 ? "BUY_PRESSURE" : imbalance < 0.40 ? "SELL_PRESSURE" : "NEUTRAL";
                const totalLiquidityUsdc = parseFloat((sumNotional(raw.bids) + sumNotional(raw.asks)).toFixed(2));
                orderBooks[tid] = { ...raw, imbalance, imbalanceSignal, totalLiquidityUsdc };
                const outcome = market.outcomes?.[idx] ?? `Token${idx}`;
                botPrint("OK", `OrderBook [${outcome}]: bid=${raw.bids?.[0]?.price ?? "?"} ask=${raw.asks?.[0]?.price ?? "?"} imbalance=${(imbalance * 100).toFixed(0)}% (${imbalanceSignal}) liquidity=$${totalLiquidityUsdc}`);
              } catch {
                botPrint("WARN", `Failed to fetch order book for token ${tid.slice(0, 12)}...`);
              }
            }));

            // Fetch Polymarket price history for velocity signal
            marketHistory = [];
            const yesId = tokenIds[0];
            if (yesId) {
              try {
                const [yRes, nRes] = await Promise.all([
                  axios.get("https://clob.polymarket.com/prices-history", { params: { market: yesId, interval: "1m", fidelity: 10 }, timeout: 5000 }),
                  tokenIds[1] ? axios.get("https://clob.polymarket.com/prices-history", { params: { market: tokenIds[1], interval: "1m", fidelity: 10 }, timeout: 5000 }) : Promise.resolve({ data: [] }),
                ]);
                const yesData: { t: number; p: number }[] = Array.isArray(yRes.data) ? yRes.data : (yRes.data?.history ?? []);
                const noData: { t: number; p: number }[] = Array.isArray(nRes.data) ? nRes.data : (nRes.data?.history ?? []);
                const noMap = new Map(noData.map((d) => [d.t, d.p]));
                marketHistory = yesData.map((d) => ({ t: d.t, yes: d.p, no: noMap.get(d.t) ?? 1 - d.p }));
                const latestYes = marketHistory[marketHistory.length - 1]?.yes;
                botPrint("OK", `Market history: ${marketHistory.length} points | Latest YES: ${latestYes !== undefined ? (latestYes * 100).toFixed(1) + "Â¢" : "?"}`);
              } catch {
                botPrint("WARN", "Market price history unavailable â€” velocity signal disabled");
              }
            }
          }

          const cfg = getPriceLagConfig();
          // Merge adaptive boost + calibration delta into effective threshold
          const calDelta = (autoCalibrateEnabled && calibrationState) ? calibrationState.confidenceDelta : 0;
          const assetBoost = adaptiveConfidenceByAsset.get(currentAsset) ?? 0;
          const effectiveMinConf = cfg.minConfidence + assetBoost + calDelta;
          if (assetBoost > 0 || calDelta !== 0) {
            botPrint("INFO", `Threshold: ${effectiveMinConf}%${assetBoost > 0 ? ` (+${assetBoost}% [${currentAsset}] loss streak)` : ""}${calDelta !== 0 ? ` (${calDelta > 0 ? "+" : ""}${calDelta}% calibrator)` : ""}`);
          }

          // â”€â”€ Fast Loop Momentum (Simmer-style CEX signal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          const fastMom = btcHistoryResult?.history?.length
            ? computeFastLoopMomentum(btcHistoryResult.history)
            : null;
          if (fastMom) {
            const sign = (n: number) => (n >= 0 ? "+" : "");
            botPrint("INFO", `FastLoop: ${fastMom.direction} | raw=${sign(fastMom.raw)}${fastMom.raw.toFixed(3)}% | vw=${sign(fastMom.volumeWeighted)}${fastMom.volumeWeighted.toFixed(3)}% | accel=${sign(fastMom.acceleration)}${fastMom.acceleration.toFixed(3)}% | ${fastMom.strength}`);
          }
          if (fastMom) {
            momentumHistory.push({ ts: Math.floor(Date.now() / 1000), direction: fastMom.direction, strength: fastMom.strength, vw: fastMom.volumeWeighted, raw: fastMom.raw, accel: fastMom.acceleration });
            if (momentumHistory.length > MOMENTUM_HISTORY_MAX) momentumHistory.shift();
          }

          // â”€â”€ Read divergence state for this asset (fresh within 30s) â”€â”€â”€â”€â”€â”€
          const divNow = Math.floor(Date.now() / 1000);
          const assetDivState = divergenceStateByAsset.get(currentAsset) ?? null;
          const div = (assetDivState && divNow - assetDivState.updatedAt < 30)
            ? assetDivState : null;

          if (div && div.strength !== "NONE") {
            botPrint("INFO",
              `Divergence: BTC ${div.btcDelta30s >= 0 ? "+" : ""}$${div.btcDelta30s.toFixed(0)} (30s) | YES ${div.yesDelta30s >= 0 ? "+" : ""}${div.yesDelta30s.toFixed(2)}Â¢ | direction=${div.direction} strength=${div.strength} score=${div.divergence.toFixed(2)}`
            );
          }

          // â”€â”€ Early window coin-flip guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          // Block trade in first 60s if there's no divergence and BTC is flat.
          // At this point FastLoop hasn't built 5 fresh candles and any cached AI
          // rec is from the previous window â€” no real edge exists.
          if (windowElapsedSeconds < 60) {
            const btcFlat = !div || (div.strength === "NONE" && Math.abs(div.btcDelta30s) < 5);
            const noDivergence = !div || div.strength === "NONE";
            if (noDivergence && btcFlat) {
              botPrint("SKIP", `Early window coin-flip guard: elapsed=${windowElapsedSeconds}s, no divergence, BTC flat â€” waiting for signal`);
              analyzedThisWindow.delete(market.id); // allow re-check once past 60s or when signal appears
              continue;
            }
          }

          // â”€â”€ FastLoop pre-filter: skip AI when no momentum and no divergence â”€â”€
          const calMinStrength = (autoCalibrateEnabled && calibrationState) ? calibrationState.fastLoopMinStrength : "MODERATE";
          const fastMomWeak = !fastMom || fastMom.direction === "NEUTRAL" || fastMom.strength === "WEAK"
            || (calMinStrength === "STRONG" && fastMom.strength !== "STRONG");
          if (fastMomWeak && (!div || div.strength === "NONE")) {
            botPrint("SKIP", `FastLoop pre-filter: ${fastMom ? `${fastMom.direction} ${fastMom.strength}` : "no data"} (min=${calMinStrength}${autoCalibrateEnabled ? " calibrated" : ""}) + no divergence â€” skipping AI`);
            continue;
          }

          // â”€â”€ FAST PATH: bypass Gemini when signals are overwhelmingly clear â”€â”€â”€â”€
          // Conditions (ALL must be true):
          //   1. FastLoop STRONG and directional
          //   2. Multi-TF alignment 4/5 or 5/5 in same direction
          //   3. Divergence STRONG or MODERATE in same direction (or no conflict)
          //   4. No recent loss pattern match (avoid repeating bad setups)
          // When triggered: synthesize rec directly, skip ~3s Gemini latency.

          // Compute local alignment score (mirrors computeMultiTimeframeAlignment in gemini.ts)
          // Signals: 60m bias, 5m confirmation, 1m trigger, technical score, FastLoop
          const _hist = btcHistoryResult?.history ?? [];
          const _ind = btcIndicatorsData;
          let _localBullish = 0, _localBearish = 0;
          if (_hist.length >= 20) {
            const first = _hist[0].close, last60 = _hist[_hist.length - 1].close;
            const move60 = first > 0 ? ((last60 - first) / first) * 100 : 0;
            const bias60 = (_ind?.emaCross === "BULLISH" && move60 > 0.15) ? "UP"
              : (_ind?.emaCross === "BEARISH" && move60 < -0.15) ? "DOWN"
              : Math.abs(move60) < 0.1 ? "MIXED"
              : move60 > 0 ? "UP" : "DOWN";
            if (bias60 === "UP") _localBullish++; else if (bias60 === "DOWN") _localBearish++;
          }
          if (_hist.length >= 5) {
            const recent5 = _hist.slice(-5);
            const up5 = recent5.filter(c => c.close > c.open).length;
            const dn5 = recent5.filter(c => c.close < c.open).length;
            if (up5 >= 3) _localBullish++; else if (dn5 >= 3) _localBearish++;
          }
          if (_hist.length >= 2) {
            const last1 = _hist[_hist.length - 1];
            if (last1.close > last1.open) _localBullish++; else if (last1.close < last1.open) _localBearish++;
          }
          if (_ind) {
            if (_ind.signalScore >= 2) _localBullish++; else if (_ind.signalScore <= -2) _localBearish++;
          }
          if (fastMom && fastMom.strength !== "WEAK") {
            if (fastMom.direction === "UP") _localBullish++; else if (fastMom.direction === "DOWN") _localBearish++;
          }
          const localAlignment = { bullish: _localBullish, bearish: _localBearish };

          let rec: any;
          const fastPathDir = fastMom?.strength === "STRONG" && fastMom.direction !== "NEUTRAL"
            ? fastMom.direction : null;
          const alignmentScore = fastPathDir === "UP" ? localAlignment.bullish : fastPathDir === "DOWN" ? localAlignment.bearish : 0;
          const divAgrees = !div || div.strength === "NONE" || div.direction === "NEUTRAL" || div.direction === fastPathDir;
          const assetLossMemory = lossMemory.filter(l => !l.asset || l.asset === currentAsset);
          const assetWinMemory  = winMemory.filter(w => !w.asset || w.asset === currentAsset);
          const noLossConflict = assetLossMemory.slice(0, 3).every(
            (l) => !(l.direction === fastPathDir && Math.abs((l.signalScore ?? 0)) >= 2)
          );
          const fastPathEligible = (
            fastPathDir !== null &&
            alignmentScore >= 4 &&
            divAgrees &&
            noLossConflict &&
            !(currentWindowAiCache?.windowStart === currentWindowStart && currentWindowAiCache?.asset === currentAsset)
          );

          if (fastPathEligible && fastPathDir) {
            const divBoost = div && (div.strength === "STRONG" || div.strength === "MODERATE") ? 8 : 0;
            const baseConf = alignmentScore === 5 ? 80 : 75;
            const fastConf = Math.min(92, baseConf + divBoost);
            const fastEdge = parseFloat(((fastConf / 100) - 0.5).toFixed(2));
            rec = {
              decision: "TRADE",
              direction: fastPathDir,
              confidence: fastConf,
              estimatedEdge: fastEdge,
              candlePatterns: [],
              reasoning: `[FAST PATH] ${alignmentScore}/5 signals aligned ${fastPathDir} | FastLoop STRONG vw=${fastMom!.volumeWeighted.toFixed(3)}% accel=${fastMom!.acceleration.toFixed(3)}%${div && div.strength !== "NONE" ? ` | Divergence ${div.strength} ${div.direction}` : ""} | Gemini skipped`,
              riskLevel: alignmentScore === 5 ? "LOW" : "MEDIUM",
              dataMode: "FULL_DATA" as const,
              reversalProbability: alignmentScore === 5 ? 20 : 30,
              oppositePressureProbability: 25,
              reversalReasoning: "Fast path â€” strong multi-signal consensus",
            };
            botPrint("TRADE", `âš¡ FAST PATH âš¡ ${alignmentScore}/5 aligned ${fastPathDir} | FastLoop STRONG | conf=${fastConf}% | edge=${fastEdge}Â¢ | Gemini skipped`);
            currentWindowAiCache = { windowStart: currentWindowStart, marketId: market.id, asset: currentAsset, rec };

          // â”€â”€ NORMAL PATH: use cached or fresh Gemini â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          } else if (currentWindowAiCache?.windowStart === currentWindowStart && currentWindowAiCache?.marketId === market.id && currentWindowAiCache?.asset === currentAsset) {
            rec = currentWindowAiCache.rec;
            botPrint("OK", `Reusing AI (price re-check): ${rec.decision === "TRADE" ? (rec.direction === "UP" ? "â–²" : "â–¼") : "â€”"} ${rec.decision} ${rec.direction !== "NONE" ? rec.direction : ""} | conf=${rec.confidence}% â€” only checking price now`);
          } else {
            botPrint("INFO", "Calling Gemini AI for analysis...");
            rec = await analyzeMarket(
              market,
              btcPriceData?.price ?? null,
              btcHistoryResult?.history ?? [],
              sentimentData,
              btcIndicatorsData,
              orderBooks,
              marketHistory,
              windowElapsedSeconds,
              assetLossMemory.slice(0, 5),
              div,
              assetWinMemory.slice(0, 3),
              fastMom,
              currentAsset
            );
            // Cache AI result for this window so price-gate retries don't re-call Gemini
            currentWindowAiCache = { windowStart: currentWindowStart, marketId: market.id, asset: currentAsset, rec };
          }

          // â”€â”€ Apply divergence overrides AFTER AI decision â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          if (div && div.strength !== "NONE" && div.direction !== "NEUTRAL") {
            if (div.strength === "STRONG" && rec.decision !== "TRADE") {
              // Force trade only if enough time remains â€” flash moves revert quickly
              if (windowRemaining < 120) {
                botPrint("SKIP",
                  `DIVERGENCE OVERRIDE skipped â€” only ${windowRemaining}s remaining (min 120s). Flash move likely to revert.`
                );
              } else {
              // Force trade in divergence direction â€” market is clearly lagging BTC
              botPrint("TRADE",
                `DIVERGENCE OVERRIDE âœ¦ BTC +$${Math.abs(div.btcDelta30s).toFixed(0)} in 30s, YES only ${div.yesDelta30s.toFixed(2)}Â¢ â€” forcing ${div.direction} trade`
              );
              rec = { ...rec, decision: "TRADE", direction: div.direction, confidence: Math.max(rec.confidence, 72), riskLevel: "MEDIUM" };
              }
            } else if (div.strength === "MODERATE" && rec.decision === "TRADE" && rec.direction === div.direction) {
              // Same direction â€” boost confidence
              const boosted = Math.min(rec.confidence + 10, 95);
              botPrint("OK", `Divergence CONFIRMS AI direction (${div.direction}) â€” confidence boosted ${rec.confidence}% â†’ ${boosted}%`);
              rec = { ...rec, confidence: boosted };
            } else if (div.strength === "STRONG" && rec.decision === "TRADE" && rec.direction !== div.direction) {
              // STRONG conflict â€” structural divergence wins, block the AI trade
              botPrint("WARN",
                `DIVERGENCE CONFLICT âœ¦ AI says ${rec.direction} but BTC divergence says ${div.direction} (STRONG) â€” trade blocked`
              );
              rec = { ...rec, decision: "NO_TRADE", reasoning: rec.reasoning + ` | BLOCKED: strong divergence conflict (BTC ${div.direction} vs AI ${rec.direction})` };
            } else if (div.strength === "MODERATE" && rec.decision === "TRADE" && rec.direction !== div.direction) {
              // MODERATE conflict â€” penalise confidence but don't block; data windows differ
              const penalised = Math.max(rec.confidence - 15, 50);
              botPrint("WARN",
                `DIVERGENCE FRICTION âœ¦ AI says ${rec.direction} but divergence says ${div.direction} (MODERATE) â€” confidence penalised ${rec.confidence}% â†’ ${penalised}%`
              );
              rec = { ...rec, confidence: penalised, reasoning: rec.reasoning + ` | Confidence penalised: moderate divergence friction (BTC ${div.direction})` };
            }
          }

          // Log AI result
          const decisionIcon = rec.decision === "TRADE" ? (rec.direction === "UP" ? "â–²" : "â–¼") : "â€”";
          botPrint(
            rec.decision === "TRADE" ? "INFO" : "SKIP",
            `AI Result: ${decisionIcon} ${rec.decision} ${rec.direction} | conf=${rec.confidence}% | edge=${rec.estimatedEdge}Â¢ | risk=${rec.riskLevel}`
          );
          botPrint("INFO", `Reasoning: ${rec.reasoning.slice(0, 120)}`);

          // â”€â”€ Update entry snapshot for dashboard widget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          {
            const outcomeIdx = rec.direction === "DOWN" ? 1 : 0;
            const oppIdx     = outcomeIdx === 0 ? 1 : 0;
            const tokenIds: string[] = market.clobTokenIds || [];
            const yesAsk = orderBooks[tokenIds[0]]?.asks?.[0]?.price ?? market.outcomePrices?.[0] ?? null;
            const noAsk  = orderBooks[tokenIds[1]]?.asks?.[0]?.price ?? market.outcomePrices?.[1] ?? null;
            const entryAsk = orderBooks[tokenIds[outcomeIdx]]?.asks?.[0]?.price ?? market.outcomePrices?.[outcomeIdx] ?? null;
            const impliedPrice = parseFloat(market.outcomePrices?.[outcomeIdx] ?? "0.5");
            const p = rec.confidence / 100;
            const b = (1 - impliedPrice) / impliedPrice;
            const kelly = (p * b - (1 - p)) / b;
            const rawBet = kelly > 0 && botSessionStartBalance != null
              ? (botSessionStartBalance * kelly * cfg.kellyFraction)
              : null;
            currentEntrySnapshot = {
              market: market.question || market.id,
              windowStart: currentWindowStart,
              yesPrice: yesAsk !== null ? parseFloat(yesAsk) : null,
              noPrice:  noAsk  !== null ? parseFloat(noAsk)  : null,
              direction: rec.decision === "TRADE" ? rec.direction : null,
              confidence: rec.confidence,
              edge: rec.estimatedEdge,
              riskLevel: rec.riskLevel,
              estimatedBet: rawBet !== null ? parseFloat(Math.min(rawBet, cfg.maxBetUsdc).toFixed(2)) : null,
              btcPrice: btcPriceData?.price ?? null,
              asset: currentAsset,
              divergence: div && div.strength !== "NONE"
                ? { direction: div.direction, strength: div.strength, btcDelta30s: div.btcDelta30s, yesDelta30s: div.yesDelta30s }
                : null,
              fastLoopMomentum: fastMom ? { direction: fastMom.direction, strength: fastMom.strength, vw: fastMom.volumeWeighted } : null,
              updatedAt: new Date().toISOString(),
            };
            void oppIdx; void entryAsk; // suppress unused warnings
          }

          const qualifies =
            rec.decision === "TRADE" &&
            rec.confidence >= effectiveMinConf &&
            rec.estimatedEdge >= cfg.minEdge &&
            rec.riskLevel !== "HIGH";

          if (rec.decision === "TRADE" && !qualifies) {
            const reasons: string[] = [];
            if (rec.confidence < effectiveMinConf) reasons.push(`conf ${rec.confidence}% < ${effectiveMinConf}% (adaptive)`);
            if (rec.estimatedEdge < cfg.minEdge) reasons.push(`edge ${rec.estimatedEdge}Â¢ < ${cfg.minEdge}Â¢`);
            if (rec.riskLevel === "HIGH") reasons.push(`risk=${rec.riskLevel} (need LOW or MEDIUM)`);
            botPrint("SKIP", `Trade rejected by bot filters: ${reasons.join(" | ")}`);
          }

          if (qualifies && btcIndicatorsData?.signalScore === 0) {
            botPrint("SKIP", "Signal score filter: score=0 â€” no technical edge. Waiting for stronger setup.");
            analyzedThisWindow.delete(market.id);
            pushSSE("cycle", { ts: new Date().toISOString() });
            continue;
          }

          if (
            qualifies &&
            (windowElapsedSeconds < ANALYSIS_MIN_ENTRY_WINDOW_SECONDS ||
              windowElapsedSeconds > ANALYSIS_MAX_ENTRY_WINDOW_SECONDS)
          ) {
            botPrint(
              "SKIP",
              `Timing filter: elapsed=${windowElapsedSeconds}s â€” only trading in ${ANALYSIS_MIN_ENTRY_WINDOW_SECONDS}-${ANALYSIS_MAX_ENTRY_WINDOW_SECONDS}s window`
            );
            analyzedThisWindow.delete(market.id);
            pushSSE("cycle", { ts: new Date().toISOString() });
            continue;
          }

          // â”€â”€ Order book pressure alignment filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          // Data from 23 live trades shows:
          //   BUY_PRESSURE  â†’ 67% WR (+$8.84)   â† trade with
          //   NEUTRAL       â†’ 40% WR (-$1.55)   â† trade with (marginal edge)
          //   SELL_PRESSURE â†’ 20% WR (-$7.64)   â† BLOCK
          // Rule: YES order book pressure must not oppose the trade direction.
          //   UP   trade â†’ block if YES book shows SELL_PRESSURE (crowd selling YES)
          //   DOWN trade â†’ block if YES book shows BUY_PRESSURE  (crowd buying YES)
          if (qualifies) {
            const tokenIds: string[] = market.clobTokenIds || [];
            const yesSignal = orderBooks[tokenIds[0]]?.imbalanceSignal ?? "UNKNOWN";
            const pressureOpposesDirection =
              (rec.direction === "UP"   && yesSignal === "SELL_PRESSURE") ||
              (rec.direction === "DOWN" && yesSignal === "BUY_PRESSURE") ||
              yesSignal === "UNKNOWN"; // no order book data = blind entry (hist WR 17%)

            if (pressureOpposesDirection) {
              botPrint("SKIP", `Pressure filter: direction=${rec.direction} | YES book=${yesSignal} â€” blocked (SELL_PRESSURE/BUY_PRESSURE/UNKNOWN) | re-check next cycle`);
              analyzedThisWindow.delete(market.id); // re-check each cycle in case pressure shifts
              pushSSE("cycle", { ts: new Date().toISOString() });
              continue;
            }
            botPrint("INFO", `Pressure check: direction=${rec.direction} | YES book=${yesSignal} âœ“`);
          }

          const logEntry: BotLogEntry = {
            timestamp: new Date().toISOString(),
            market: market.question || market.id,
            decision: rec.decision,
            direction: rec.direction,
            confidence: rec.confidence,
            edge: rec.estimatedEdge,
            riskLevel: rec.riskLevel,
            reasoning: rec.reasoning,
            tradeExecuted: false,
          };

          if (qualifies) {
            botPrint("TRADE", `SIGNAL QUALIFIED âœ“ â€” preparing to execute ${rec.direction} trade`);
            const client = await getClobClient();
            if (!client) {
              logEntry.error = "CLOB client not ready â€” trade skipped.";
              botPrint("ERR", "CLOB client not initialized. Check POLYGON_PRIVATE_KEY.");
            } else {
              // Initialise session balance on first qualifying trade
              if (botSessionStartBalance === null) {
                try {
                  const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                  botSessionStartBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
                  botPrint("OK", `Session initialized. Starting balance: $${botSessionStartBalance.toFixed(2)} USDC`);
                } catch { /* non-fatal */ }
              }

              // â”€â”€ Live balance check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
              let currentBalance = botSessionStartBalance ?? 0;
              let balanceFresh = false;
              try {
                const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                currentBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
                lastKnownBalance = currentBalance; // keep fast path in sync
                balanceFresh = true;
              } catch {
                botPrint("WARN", `Balance fetch failed â€” using last known: $${currentBalance.toFixed(2)} USDC`);
              }

              botPrint("INFO", `Balance: $${currentBalance.toFixed(2)} USDC${balanceFresh ? " (live)" : " (cached)"} | Session start: $${botSessionStartBalance?.toFixed(2) ?? "?"}`);

              // Hard stop if wallet is empty
              if (currentBalance < 1) {
                botPrint("WARN", `Insufficient balance ($${currentBalance.toFixed(2)} USDC < $1 minimum). Skipping all trades this cycle.`);
                logEntry.reasoning += ` | Skipped: Insufficient balance ($${currentBalance.toFixed(2)}).`;
                botLog.unshift(logEntry);
                if (botLog.length > 100) botLog.pop();
                break;
              }

              // â”€â”€ Kelly sizing with balance-aware adjustment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
              const outcomeIndex = rec.direction === "UP" ? 0 : 1;
              const tokenId: string = market.clobTokenIds?.[outcomeIndex];
              if (tokenId) {
                const ob = orderBooks[tokenId];
                const clobAsk = Number(ob?.asks?.[0]?.price || "0");
                const bestBid = Number(ob?.bids?.[0]?.price || "0");

                // â”€â”€ Use outcomePrices (AMM implied price) as primary fill reference â”€â”€
                // CLOB asks are almost always 99Â¢ in these 5m markets because nobody
                // places limit orders at fair value â€” execution happens via the AMM.
                // outcomePrices[outcomeIndex] reflects the real fill cost.
                const impliedPrice = parseFloat(market.outcomePrices?.[outcomeIndex] ?? "0");
                // Use CLOB ask only if it's realistic (between 1Â¢ and 97Â¢); else use AMM
                const CLOB_SPREAD_THRESHOLD = 0.97;
                const bestAsk = (clobAsk > 0 && clobAsk < CLOB_SPREAD_THRESHOLD)
                  ? clobAsk
                  : impliedPrice > 0 ? impliedPrice : clobAsk;

                // â”€â”€ Dynamic entry price gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // Break-even win rate = entry price for binary $1 payouts.
                // So at 70% confidence, paying 70Â¢ is break-even â€” we need
                // a buffer to actually profit. Formula: max = (confidence - 10) / 100
                //   70% conf â†’ max 60Â¢  (EV = +10Â¢/share)
                //   75% conf â†’ max 65Â¢  (EV = +10Â¢/share)
                //   80% conf â†’ max 70Â¢  (EV = +10Â¢/share)
                //   85%+ conf â†’ max 75Â¢ (capped; divergence gets 85Â¢ exception)
                // STRONG divergence is a structural edge (real price lag) â†’ allow 85Â¢.
                if (bestAsk <= 0) {
                  botPrint("SKIP", `No price data available â€” skipping`);
                  analyzedThisWindow.delete(market.id);
                  continue;
                }

                const isDivergenceStrong = div?.strength === "STRONG";
                const MAX_ENTRY_PRICE = isDivergenceStrong
                  ? 0.85
                  : Math.min(0.75, (rec.confidence - 10) / 100);
                if (bestAsk > MAX_ENTRY_PRICE) {
                  const priceSource = (clobAsk > 0 && clobAsk < CLOB_SPREAD_THRESHOLD) ? "CLOB" : "AMM";
                  botPrint("SKIP", `Entry price too high: ${priceSource}=${( bestAsk * 100).toFixed(1)}Â¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}Â¢ max (conf=${rec.confidence}%${isDivergenceStrong ? ", divergence override" : ""}). Monitoring for better priceâ€¦`);
                  logEntry.reasoning += ` | Skipped: bestAsk ${(bestAsk * 100).toFixed(0)}Â¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}Â¢ dynamic max (conf=${rec.confidence}%).`;
                  botLog.unshift(logEntry);
                  if (botLog.length > 100) botLog.pop();
                  // Remove from analyzed set so next cycle re-checks the price
                  // (signal is still valid, only price was too high this moment)
                  analyzedThisWindow.delete(market.id);
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }

                if (bestAsk >= ANALYSIS_COIN_FLIP_MIN_PRICE && bestAsk <= ANALYSIS_COIN_FLIP_MAX_PRICE) {
                  botPrint(
                    "SKIP",
                    `Coin-flip price filter: ${(bestAsk * 100).toFixed(1)}Â¢ is inside ${(ANALYSIS_COIN_FLIP_MIN_PRICE * 100).toFixed(0)}-${(ANALYSIS_COIN_FLIP_MAX_PRICE * 100).toFixed(0)}Â¢ danger zone`
                  );
                  logEntry.reasoning += ` | Skipped: bestAsk ${(bestAsk * 100).toFixed(1)}Â¢ in coin-flip zone.`;
                  botLog.unshift(logEntry);
                  if (botLog.length > 100) botLog.pop();
                  analyzedThisWindow.delete(market.id);
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }

                // Use bestAsk as fill price for Kelly (already AMM-corrected above).
                const kellyFillPrice = bestAsk > 0 ? bestAsk : parseFloat(market.outcomePrices[outcomeIndex] || "0.5");

                const p = rec.confidence / 100;
                const b = (1 - kellyFillPrice) / kellyFillPrice;
                const kelly = (p * b - (1 - p)) / b;

                // â”€â”€ Volatility-adjusted Kelly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                // Scale bet down when BTC is choppy (high ATR = noisy market).
                // ATR = avg true range of last 10 1-min candles.
                // Baseline: 0.15% of BTC price (e.g. $120 on $80K BTC).
                // Above baseline â†’ reduce Kelly. Below â†’ capped at 1.0 (no reward for calm).
                let volMultiplier = 1.0;
                const btcCandles = btcHistoryResult?.history ?? [];
                if (btcCandles.length >= 5 && btcPriceData?.price) {
                  const last10 = btcCandles.slice(-10);
                  const atr = last10.reduce((sum: number, c: { high: number; low: number }) => sum + (c.high - c.low), 0) / last10.length;
                  const btcPriceNum = Number(btcPriceData.price);
                  if (btcPriceNum > 0) {
                    const normalizedAtr = atr / btcPriceNum; // as fraction of price
                    const BASELINE_ATR = 0.0015;            // 0.15% = calm/normal BTC
                    volMultiplier = Math.max(0.50, Math.min(1.0, BASELINE_ATR / normalizedAtr));
                    if (volMultiplier < 1.0) {
                      botPrint("INFO", `Volatility gate: ATR=${atr.toFixed(0)} (${(normalizedAtr * 100).toFixed(2)}% of price) â†’ Kelly scaled to ${(volMultiplier * 100).toFixed(0)}%`);
                    }
                  }
                }

                const dynFraction = dynamicKellyFraction(rec.confidence);
                const rawBet = kelly > 0 ? currentBalance * kelly * dynFraction * volMultiplier : 0;

                // Reserve buffer â€” scale with balance, min $0.20
                const BALANCE_RESERVE = Math.min(1.0, currentBalance * 0.10);
                const spendable = Math.max(0, currentBalance - BALANCE_RESERVE);

                // Fixed execution size: runtime-configurable from the dashboard.
                const betAmount = parseFloat(botFixedTradeUsdc.toFixed(2));

                botPrint("INFO", `Sizing override: fixed $${botFixedTradeUsdc.toFixed(2)} per trade | Kelly raw=$${rawBet.toFixed(2)} ignored [PRICE_LAG]`);
                botPrint("INFO", `Balance check: $${currentBalance.toFixed(2)} available | $${betAmount.toFixed(2)} to spend | $${(currentBalance - betAmount).toFixed(2)} remaining after trade`);

                if (spendable < betAmount) {
                  botPrint("SKIP", `Insufficient spendable balance for fixed trade size ($${spendable.toFixed(2)} available after reserve < $${betAmount.toFixed(2)} required). Skipping.`);
                  logEntry.reasoning += ` | Skipped: spendable balance $${spendable.toFixed(2)} < fixed $${betAmount.toFixed(2)} trade size.`;
                } else {
                  // ob, bestAsk, bestBid already fetched above for the hard gate
                  botPrint("TRADE", `â”â”â” EXECUTING ORDER â”â”â”`);
                  botPrint("TRADE", `Direction : ${rec.direction === "UP" ? "â–² UP (YES)" : "â–¼ DOWN (NO)"}`);
                  botPrint("TRADE", `Amount    : $${betAmount.toFixed(2)} USDC`);
                  botPrint("TRADE", `Price     : ${(bestAsk * 100).toFixed(1)}Â¢ (ask) | ${(bestBid * 100).toFixed(1)}Â¢ (bid)`);
                  botPrint("TRADE", `Confidence: ${rec.confidence}% | Edge: ${rec.estimatedEdge}Â¢ | Risk: ${rec.riskLevel}`);
                  try {
                    const tradeResult = await executePolymarketTrade({
                      tokenID: tokenId,
                      amount: betAmount,
                      side: Side.BUY,
                      price: bestAsk,
                      executionMode: "AGGRESSIVE",
                      amountMode: "SPEND",
                    });

                    // Auto-arm TP/SL based on entry price zone
                    const levels = recommendAutomationLevels(bestAsk);
                    await savePositionAutomation({
                      assetId: tokenId,
                      market: market.question || market.id,
                      outcome: market.outcomes?.[outcomeIndex] || rec.direction,
                      averagePrice: bestAsk.toFixed(4),
                      size: tradeResult.orderSize.toFixed(6),
                      takeProfit: levels.takeProfit,
                      stopLoss: levels.stopLoss,
                      trailingStop: levels.trailingStop,
                      windowEnd: currentWindowStart + MARKET_SESSION_SECONDS,
                      armed: true,
                    });

                    botSessionTradesCount++;
                    logEntry.tradeExecuted = true;
                    logEntry.tradeAmount = betAmount;
                    logEntry.tradePrice = bestAsk;
                    logEntry.orderId = tradeResult.orderID;
                    botPrint("OK", `Order submitted! ID: ${tradeResult.orderID} | Status: ${tradeResult.status}`);
                    void sendNotification(
                      `âœ… <b>TRADE EXECUTED</b>\nMarket: ${market.question?.slice(0, 60) ?? "BTC 5m"}\nDirection: ${rec.direction === "UP" ? "â–² UP" : "â–¼ DOWN"}\nAmount: $${betAmount.toFixed(2)} USDC @ ${(bestAsk * 100).toFixed(1)}Â¢\nConf: ${rec.confidence}% | Edge: ${rec.estimatedEdge}Â¢ | Risk: ${rec.riskLevel}`
                    );
                    botPrint("OK", `TP: ${(parseFloat(levels.takeProfit) * 100).toFixed(0)}Â¢ | SL: ${(parseFloat(levels.stopLoss) * 100).toFixed(0)}Â¢ | TS: ${(parseFloat(levels.trailingStop) * 100).toFixed(0)}Â¢ distance â€” automation ARMED`);
                    botPrint("OK", `Session trades: ${botSessionTradesCount} | Balance: ~$${currentBalance.toFixed(2)}`);

                    // Track this trade for win/loss resolution after window closes
                    pendingResults.set(tokenId, {
                      eventSlug: slug,
                      marketId: market.id,
                      market: market.question || market.id,
                      tokenId,
                      direction: rec.direction,
                      outcome: market.outcomes?.[outcomeIndex] || rec.direction,
                      entryPrice: bestAsk,
                      betAmount,
                      orderId: tradeResult.orderID,
                      windowEnd: currentWindowStart + MARKET_SESSION_SECONDS,
                      // Context for adaptive learning
                      confidence: rec.confidence,
                      edge: rec.estimatedEdge,
                      reasoning: rec.reasoning,
                      windowElapsedSeconds,
                      rsi: btcIndicatorsData?.rsi,
                      emaCross: btcIndicatorsData?.emaCross,
                      signalScore: btcIndicatorsData?.signalScore,
                      imbalanceSignal: orderBooks[tokenId]?.imbalanceSignal,
                      asset: currentAsset,
                    });
                    botPrint("INFO", `Result tracker armed â€” checking after ${new Date((currentWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);
                  } catch (tradeErr: any) {
                    logEntry.error = tradeErr?.message || String(tradeErr);
                    botPrint("ERR", `Trade execution failed: ${logEntry.error}`);
                  }
                }
              }
            }
          } else if (rec.decision === "NO_TRADE") {
            botPrint("SKIP", `No trade â€” conditions not met, will re-check next cycle`);
            // Remove from analyzed set so next cycle re-evaluates if conditions change.
            // Keep AI cache so Gemini is not re-called â€” only re-check divergence/price/filters.
            analyzedThisWindow.delete(market.id);
          }

          botLog.unshift(logEntry);
          if (botLog.length > 100) botLog.pop();
          pushSSE("cycle", { ts: new Date().toISOString() });
        } catch (err: any) {
          botPrint("ERR", `Analysis error: ${err?.message || String(err)}`);
        }
      } // end for (market of markets)
      } // end for (currentAsset of ENABLED_ASSETS)
    } finally {
      botRunning = false;
    }
  };

  // â”€â”€ Polymarket heartbeat â€” must fire every <10s or all open orders are cancelled â”€â”€
  // Chain: first call uses "" â†’ server returns heartbeat_id â†’ each subsequent call passes that ID.
  // On 400: server returns the correct heartbeat_id in the response body â€” extract and use it.
  // On other errors: reset to "" to start a fresh chain next tick.
  const startHeartbeat = () => {
    if (heartbeatInterval) return;
    const sendHeartbeat = async () => {
      const cl = await getClobClient();
      if (!cl) return;
      try {
        const resp = await cl.postHeartbeat(lastHeartbeatId || null);
        lastHeartbeatId = resp?.heartbeat_id ?? "";
      } catch (err: any) {
        // Polymarket returns 400 with the correct heartbeat_id when we send a stale/wrong ID.
        // The SDK throws on 400 but may attach the response body â€” try to extract it.
        const body = err?.response?.data ?? err?.data ?? null;
        const recoveredId = body?.heartbeat_id ?? body?.id ?? null;
        if (recoveredId) {
          console.warn(`[Heartbeat] 400 â€” recovered correct ID from response, re-chaining`);
          lastHeartbeatId = recoveredId;
        } else {
          console.warn("[Heartbeat] Failed:", err?.message ?? String(err), "â€” resetting chain");
          lastHeartbeatId = "";
        }
      }
    };
    void sendHeartbeat();
    heartbeatInterval = setInterval(() => void sendHeartbeat(), 5_000);
    console.log("[Heartbeat] Started â€” sending every 5s to keep open orders alive");
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    lastHeartbeatId = "";
    console.log("[Heartbeat] Stopped");
  };

  const startBot = () => {
    if (botInterval) return;
    console.log("");
    console.log("====================================================");
    console.log("          PolyBTC AI Trading Bot - STARTED          ");
    console.log("====================================================");
    const startCfg = getPriceLagConfig();
    botPrint("INFO", "Strategy       : PRICE_LAG_MISPRICING");
    botPrint("INFO", `Min confidence : ${startCfg.minConfidence}%`);
    botPrint("INFO", `Min edge       : ${startCfg.minEdge}Â¢`);
    botPrint("INFO", `Max bet        : $${startCfg.maxBetUsdc} USDC`);
    botPrint("INFO", `Fixed trade    : $${botFixedTradeUsdc.toFixed(2)} USDC`);
    botPrint("INFO", `Kelly fraction : ${startCfg.kellyFraction * 100}%`);
    botPrint("INFO", `Timing zones   : dead 0-${startCfg.earlyDeadZoneEnd}s | best ${startCfg.bestLagZoneStart}-${startCfg.bestLagZoneEnd}s | late ${startCfg.lateNoTradeStart}-300s`);
    botPrint("INFO", `Scan interval  : every ${BOT_SCAN_INTERVAL_MS / 1000}s`);
    console.log("");
    startHeartbeat();
    void runBotCycle();
    botInterval = setInterval(() => void runBotCycle(), BOT_SCAN_INTERVAL_MS);
  };

  const stopBot = () => {
    if (botInterval) { clearInterval(botInterval); botInterval = null; }
    stopHeartbeat();
    botEnabled = false;
    console.log("");
    botPrint("WARN", "Bot stopped by user.");
    console.log("");
  };

  if (botEnabled) startBot();

  app.use(express.json());

  // â”€â”€ Bot control API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/bot/status", (_req, res) => {
    const nowUtcSeconds = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
    const windowElapsedSeconds = nowUtcSeconds - currentWindowStart;
    const timing = getPriceLagTiming(windowElapsedSeconds);
    res.json({
      enabled: botEnabled,
      running: botRunning,
      sessionStartBalance: botSessionStartBalance,
      sessionTradesCount: botSessionTradesCount,
      windowElapsedSeconds,
      timing,
      analyzedThisWindow: botAnalyzedThisWindow.size,
      entrySnapshot: currentEntrySnapshot,
      config: {
        strategy: "PRICE_LAG_MISPRICING",
        minConfidence: getPriceLagConfig().minConfidence,
        minEdge: getPriceLagConfig().minEdge,
        kellyFraction: getPriceLagConfig().kellyFraction,
        maxBetUsdc: getPriceLagConfig().maxBetUsdc,
        earlyDeadZoneEnd: getPriceLagConfig().earlyDeadZoneEnd,
        bestLagZoneStart: getPriceLagConfig().bestLagZoneStart,
        bestLagZoneEnd: getPriceLagConfig().bestLagZoneEnd,
        lateNoTradeStart: getPriceLagConfig().lateNoTradeStart,
        fixedTradeUsdc: botFixedTradeUsdc,
        scanIntervalMs: BOT_SCAN_INTERVAL_MS,
      },
    });
  });

  app.get("/api/bot/ping", async (_req, res) => {
    const testedAt = new Date().toISOString();
    const results = await Promise.all(
      PRICE_LAG_PING_TARGETS.map((target) => probeHttpLatency(target.key, target.label, target.target))
    );
    const successful = results.filter((entry) => entry.latencyMs != null);
    const fastestMs = successful.length > 0 ? Math.min(...successful.map((entry) => entry.latencyMs as number)) : null;
    const slowestMs = successful.length > 0 ? Math.max(...successful.map((entry) => entry.latencyMs as number)) : null;
    const averageMs = successful.length > 0
      ? Math.round(successful.reduce((sum, entry) => sum + (entry.latencyMs as number), 0) / successful.length)
      : null;
    const polymarketCritical = results.filter((entry) => entry.key === "clob" || entry.key === "gamma" || entry.key === "data");
    const criticalReady = polymarketCritical.every((entry) => entry.latencyMs != null && entry.latencyMs <= 250);

    res.json({
      testedAt,
      note: "Latency is measured from this bot server to upstream services. This is the number that matters for price-lag execution.",
      summary: {
        fastestMs,
        slowestMs,
        averageMs,
        grade: gradeLatency(averageMs),
        criticalReady,
      },
      upstreams: results,
    });
  });

  app.post("/api/bot/control", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required." });
    }
    if (enabled) {
      botEnabled = true;
      botSessionStartBalance = null; // reset session on re-enable
      botSessionTradesCount = 0;
      startBot();
      res.json({ enabled: true, message: "Bot started." });
    } else {
      stopBot();
      res.json({ enabled: false, message: "Bot stopped." });
    }
  });

  app.get("/api/bot/log", (_req, res) => {
    res.json({ log: botLog });
  });

  app.get("/api/bot/rawlog", (_req, res) => {
    res.json({ log: rawLog });
  });

  app.get("/api/bot/cex-log", (_req, res) => {
    res.json({ log: cexLog });
  });

  // â”€â”€ SSE endpoint â€” real-time bot events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/bot/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current log snapshot so the client is immediately up-to-date
    res.write(`event: snapshot\ndata: ${JSON.stringify({ log: rawLog.slice(0, 200), cexLog: cexLog.slice(0, 200) })}\n\n`);

    sseClients.add(res as unknown as ServerResponse);
    req.on("close", () => sseClients.delete(res as unknown as ServerResponse));
  });

  app.get("/api/bot/learning", (_req, res) => {
    res.json({
      consecutiveLosses,
      consecutiveWins,
      adaptiveConfidenceBoost,
      adaptiveLossPenaltyEnabled,
      effectiveMinConfidence: BOT_MIN_CONFIDENCE + adaptiveConfidenceBoost,
      baseMinConfidence: BOT_MIN_CONFIDENCE,
      lossMemoryCount: lossMemory.length,
      winMemoryCount: winMemory.length,
      recentLosses: lossMemory.slice(0, 10),
      recentWins: winMemory.slice(0, 10),
    });
  });

  app.post("/api/bot/learning/loss-penalty", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required." });
    }
    adaptiveLossPenaltyEnabled = enabled;
    saveLearning();
    botPrint("INFO", `Adaptive loss penalty ${adaptiveLossPenaltyEnabled ? "ENABLED" : "DISABLED"}`);
    res.json({ ok: true, adaptiveLossPenaltyEnabled });
  });

  app.get("/api/bot/momentum-history", (_req, res) => {
    res.json({ history: momentumHistory });
  });

  // â”€â”€ Auto-calibrator toggle & status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/bot/calibration", (_req, res) => {
    res.json({ enabled: autoCalibrateEnabled, state: calibrationState });
  });

  app.post("/api/bot/calibration/toggle", (_req, res) => {
    autoCalibrateEnabled = !autoCalibrateEnabled;
    botPrint("INFO", `Auto-calibrator ${autoCalibrateEnabled ? "ENABLED" : "DISABLED"}`);
    // Run immediately on enable so the current window benefits
    if (autoCalibrateEnabled) void runAutoCalibration();
    res.json({ enabled: autoCalibrateEnabled });
  });

  app.get("/api/notifications/status", (_req, res) => {
    res.json({
      telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      discord: !!process.env.DISCORD_WEBHOOK_URL,
    });
  });

  app.post("/api/backtest", async (_req, res) => {
    try {
      const historyResult = await getBtcHistory();
      if (!historyResult?.history?.length) return res.json({ error: "No BTC history available" });
      const history = historyResult.history;
      const minStart = 20;
      const maxWindows = Math.floor((history.length - minStart - 5) / 3);
      const actualWindows = Math.min(40, maxWindows);
      const results: any[] = [];
      for (let w = 0; w < actualWindows; w++) {
        const endIdx = minStart + w * 3;
        if (endIdx + 5 >= history.length) break;
        const slice = history.slice(0, endIdx + 1);
        const future = history.slice(endIdx + 1, endIdx + 6);
        let fastMom: FastLoopMomentum | null = null;
        let indicators: any = null;
        try { fastMom = computeFastLoopMomentum(slice); } catch {}
        try { if (slice.length >= 15) indicators = computeBtcIndicatorsFromHistory(slice); } catch {}
        const entryClose = history[endIdx].close;
        const exitClose = future.length > 0 ? future[future.length - 1].close : null;
        const actualDir = exitClose != null ? (exitClose > entryClose ? "UP" : exitClose < entryClose ? "DOWN" : "NEUTRAL") : null;
        const signaled = !!(fastMom && fastMom.strength !== "WEAK" && fastMom.direction !== "NEUTRAL");
        const correct = signaled && actualDir !== null ? fastMom!.direction === actualDir : null;
        results.push({
          ts: history[endIdx].time,
          fastMom: fastMom ? { direction: fastMom.direction, strength: fastMom.strength, vw: fastMom.volumeWeighted } : null,
          rsi: indicators?.rsi ?? null,
          emaCross: indicators?.emaCross ?? null,
          signalScore: indicators?.signalScore ?? null,
          signaled,
          signalDirection: fastMom?.direction ?? null,
          actualDir,
          correct,
          entryClose: parseFloat(entryClose.toFixed(0)),
          exitClose: exitClose != null ? parseFloat(exitClose.toFixed(0)) : null,
        });
      }
      const signaled = results.filter((r) => r.signaled);
      const correct = signaled.filter((r) => r.correct === true);
      res.json({
        totalWindows: results.length,
        signaledCount: signaled.length,
        correctCount: correct.length,
        winRate: signaled.length > 0 ? parseFloat(((correct.length / signaled.length) * 100).toFixed(1)) : null,
        results,
      });
    } catch (err: any) {
      res.json({ error: err?.message || "Backtest failed" });
    }
  });

  app.get("/api/analytics", (_req, res) => {
    try {
      const trades = loadTradeLog();
      if (trades.length === 0) return res.json({ total: 0, byHour: [], byDivergence: [], byDirection: [] });
      const byHourMap: Record<number, { wins: number; losses: number; pnl: number }> = {};
      const divMap: Record<string, { wins: number; losses: number; pnl: number }> = {
        STRONG: { wins: 0, losses: 0, pnl: 0 }, MODERATE: { wins: 0, losses: 0, pnl: 0 }, "WEAK/NONE": { wins: 0, losses: 0, pnl: 0 },
      };
      const dirMap: Record<string, { wins: number; losses: number; pnl: number }> = {
        UP: { wins: 0, losses: 0, pnl: 0 }, DOWN: { wins: 0, losses: 0, pnl: 0 },
      };
      for (const t of trades) {
        const hour = new Date(t.ts).getHours();
        if (!byHourMap[hour]) byHourMap[hour] = { wins: 0, losses: 0, pnl: 0 };
        if (t.result === "WIN") { byHourMap[hour].wins++; } else { byHourMap[hour].losses++; }
        byHourMap[hour].pnl += t.pnl;
        const dk = t.divergenceStrength === "STRONG" ? "STRONG" : t.divergenceStrength === "MODERATE" ? "MODERATE" : "WEAK/NONE";
        if (t.result === "WIN") divMap[dk].wins++; else divMap[dk].losses++;
        divMap[dk].pnl += t.pnl;
        if (dirMap[t.direction]) {
          if (t.result === "WIN") dirMap[t.direction].wins++; else dirMap[t.direction].losses++;
          dirMap[t.direction].pnl += t.pnl;
        }
      }
      const mkStats = (label: string, d: { wins: number; losses: number; pnl: number }) => ({
        label, wins: d.wins, losses: d.losses, total: d.wins + d.losses,
        winRate: d.wins + d.losses > 0 ? parseFloat(((d.wins / (d.wins + d.losses)) * 100).toFixed(1)) : null,
        pnl: parseFloat(d.pnl.toFixed(2)),
      });
      res.json({
        total: trades.length,
        byHour: Object.entries(byHourMap).map(([h, d]) => ({ ...mkStats(`${String(h).padStart(2,"0")}:00`, d), hour: Number(h) })).sort((a, b) => a.hour - b.hour),
        byDivergence: Object.entries(divMap).map(([l, d]) => mkStats(l, d)),
        byDirection: Object.entries(dirMap).map(([l, d]) => mkStats(l, d)),
      });
    } catch (err: any) {
      res.json({ error: err?.message || "Analytics failed" });
    }
  });

  app.post("/api/bot/config", (req, res) => {
    const { minConfidence, minEdge, fixedTradeUsdc } = req.body || {};
    if (minConfidence !== undefined) {
      const val = Number(minConfidence);
      if (isNaN(val) || val < 50 || val > 99) return res.status(400).json({ error: "minConfidence must be 50-99" });
      priceLagMinConfidence = val;
    }
    if (minEdge !== undefined) {
      const val = Number(minEdge);
      if (isNaN(val) || val < 0.01 || val > 0.50) return res.status(400).json({ error: "minEdge must be 0.01-0.50" });
      priceLagMinEdge = val;
    }
    if (fixedTradeUsdc !== undefined) {
      const val = Number(fixedTradeUsdc);
      if (!Number.isFinite(val) || val < 1 || val > 5 || !Number.isInteger(val)) {
        return res.status(400).json({ error: "fixedTradeUsdc must be an integer 1-5" });
      }
      botFixedTradeUsdc = val;
    }
    const cfg = getPriceLagConfig();
    botPrint("INFO", `Config updated (PRICE_LAG): conf>=${priceLagMinConfidence}% edge>=${priceLagMinEdge}c fixed=$${botFixedTradeUsdc.toFixed(2)}`);
    res.json({
      ok: true,
      priceLagMinConfidence,
      priceLagMinEdge,
      fixedTradeUsdc: botFixedTradeUsdc,
      config: { ...cfg, strategy: "PRICE_LAG_MISPRICING", fixedTradeUsdc: botFixedTradeUsdc },
    });
  });

  app.post("/api/bot/reset-confidence", (_req, res) => {
    adaptiveConfidenceBoost = 0;
    consecutiveLosses = 0;
    consecutiveWins = 0;
    saveLearning();
    botPrint("INFO", `Adaptive confidence reset to baseline ${BOT_MIN_CONFIDENCE}% (manual override)`);
    res.json({ ok: true, baseMinConfidence: BOT_MIN_CONFIDENCE, adaptiveConfidenceBoost: 0 });
  });

  app.get("/api/bot/trade-log", (req, res) => {
    const all = loadTradeLog();
    const limit = Math.min(parseInt(String(req.query.limit || "200"), 10), 1000);
    const offset = parseInt(String(req.query.offset || "0"), 10);
    const entries = all.slice().reverse().slice(offset, offset + limit);
    const wins   = all.filter((e) => e.result === "WIN").length;
    const losses = all.filter((e) => e.result === "LOSS").length;
    const totalPnl = parseFloat(all.reduce((s, e) => s + e.pnl, 0).toFixed(2));
    const winRate  = all.length > 0 ? parseFloat(((wins / all.length) * 100).toFixed(1)) : 0;
    const divTrades = all.filter((e) => e.divergenceStrength === "STRONG" || e.divergenceStrength === "MODERATE");
    const divWins   = divTrades.filter((e) => e.result === "WIN").length;
    const divWinRate = divTrades.length > 0 ? parseFloat(((divWins / divTrades.length) * 100).toFixed(1)) : null;
    res.json({
      total: all.length, wins, losses, winRate, totalPnl,
      divergence: { trades: divTrades.length, wins: divWins, winRate: divWinRate },
      entries,
    });
  });

  // API Proxy for Polymarket â€” BTC/ETH/SOL Up/Down 5-Minute Events
  app.get("/api/polymarket/markets", async (req, res) => {
    try {
      const nowUtcSeconds = Math.floor(Date.now() / 1000);
      const currentStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;

      // Generate slugs for current + next window across all enabled assets
      const slugs: string[] = [];
      for (const asset of ENABLED_ASSETS) {
        for (let i = 0; i < 2; i++) {
          const ts = currentStart + i * MARKET_SESSION_SECONDS;
          slugs.push(`${ASSET_CONFIG[asset].polySlugPrefix}-${ts}`);
        }
      }

      console.log("Fetching slugs:", slugs);

      // Fetch each slug via /events/slug/{slug} in parallel
      const results = await Promise.allSettled(
        slugs.map((slug) =>
          axios.get(`https://gamma-api.polymarket.com/events/slug/${slug}`, { timeout: 8000 })
        )
      );

      // Collect all found events (skip 404s / failures)
      const events = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<any>).value.data)
        .filter(Boolean);

      // Gamma API returns outcomes/outcomePrices/clobTokenIds as JSON strings â€” parse them
      const parseArr = (val: any): any[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
        return [];
      };

      // Flatten each event's markets and attach event metadata + asset tag
      const markets = events.flatMap((event: any) => {
        // Detect asset from slug prefix
        const asset = ENABLED_ASSETS.find(a => event.slug?.startsWith(ASSET_CONFIG[a].polySlugPrefix)) ?? "BTC";
        return (event.markets || []).map((m: any) => ({
          ...m,
          outcomes: parseArr(m.outcomes),
          outcomePrices: parseArr(m.outcomePrices),
          clobTokenIds: parseArr(m.clobTokenIds),
          eventSlug: event.slug,
          eventTitle: event.title,
          eventId: event.id,
          startDate: event.startDate,
          endDate: event.endDate,
          asset, // "BTC" | "ETH" | "SOL"
        }));
      });

      console.log(`Fetched ${events.length}/${slugs.length} events â†’ ${markets.length} markets`);
      res.json(markets);
    } catch (error: any) {
      console.error("Polymarket Events API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch BTC 5-min markets" });
    }
  });

  // API for Polymarket CLOB Order Book (with imbalance signal)
  app.get("/api/polymarket/orderbook/:tokenID", async (req, res) => {
    try {
      const { tokenID } = req.params;
      const client = await getClobClient();

      let raw: any;
      if (!client) {
        const response = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenID}`, { timeout: 6000 });
        raw = response.data;
      } else {
        raw = await client.getOrderBook(tokenID);
      }

      // Compute order book imbalance: totalBidSize / (totalBidSize + totalAskSize)
      const sumSize = (orders: any[]) =>
        (orders || []).reduce((acc: number, o: any) => acc + parseFloat(o.size || "0"), 0);
      const sumNotional = (orders: any[]) =>
        (orders || []).reduce((acc: number, o: any) => acc + parseFloat(o.size || "0") * parseFloat(o.price || "0"), 0);
      const bidSize = sumSize(raw.bids);
      const askSize = sumSize(raw.asks);
      const total = bidSize + askSize;
      const imbalance = total > 0 ? parseFloat((bidSize / total).toFixed(4)) : 0.5;
      const imbalanceSignal = imbalance > 0.60 ? "BUY_PRESSURE"
                            : imbalance < 0.40 ? "SELL_PRESSURE"
                            : "NEUTRAL";
      // Total USDC liquidity (notional value of all resting orders)
      const totalLiquidityUsdc = parseFloat((sumNotional(raw.bids) + sumNotional(raw.asks)).toFixed(2));

      res.json({ ...raw, imbalance, imbalanceSignal, totalLiquidityUsdc });
    } catch (error: any) {
      console.error("Polymarket CLOB API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch order book" });
    }
  });

  // API for Placing Trades
  app.post("/api/polymarket/trade", async (req, res) => {
    try {
      const { tokenID, amount, side, price, executionMode, amountMode } = req.body;
      if (!price && String(executionMode || "MANUAL").toUpperCase() === "MANUAL") {
        return res.status(400).json({ error: "Limit price is required." });
      }
      const result = await executePolymarketTrade({
        tokenID,
        amount,
        side: String(side || "BUY").toUpperCase() as Side,
        price,
        executionMode: String(executionMode || "MANUAL").toUpperCase() as "MANUAL" | "PASSIVE" | "AGGRESSIVE",
        amountMode,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Trade Execution Error:", error);
      const formatted = formatTradeError(error, req.body);
      res.status(500).json(formatted);
    }
  });

  app.post("/api/polymarket/order/reprice", async (req, res) => {
    try {
      const { orderID, executionMode = "AGGRESSIVE" } = req.body || {};
      if (!orderID) {
        return res.status(400).json({ error: "orderID is required." });
      }

      const client = await getClobClient();
      if (!client) {
        return res.status(400).json({ error: "CLOB client not initialized. Check credentials." });
      }

      const order = await client.getOrder(orderID);
      const originalSize = Number(order.original_size || "0");
      const matchedSize = Number(order.size_matched || "0");
      const remainingSize = Math.max(0, originalSize - matchedSize);
      if (!(remainingSize > 0)) {
        return res.status(400).json({ error: "No remaining size left to reprice." });
      }

      const status = String(order.status || "").toUpperCase();
      if (status === "LIVE" || status === "OPEN") {
        await client.cancelOrder({ orderID });
      }

      const repriced = await executePolymarketTrade({
        tokenID: order.asset_id,
        amount: remainingSize,
        side: String(order.side || "BUY").toUpperCase() as Side,
        price: Number(order.price || "0"),
        executionMode: String(executionMode || "AGGRESSIVE").toUpperCase() as "MANUAL" | "PASSIVE" | "AGGRESSIVE",
        amountMode: "SIZE",
      });

      res.json({
        success: true,
        cancelledOrderID: orderID,
        replacement: repriced,
        remainingSize: remainingSize.toFixed(6),
      });
    } catch (error: any) {
      console.error("Order Reprice Error:", error);
      res.status(500).json(formatTradeError(error, req.body));
    }
  });

  app.get("/api/polymarket/order/:orderID", async (req, res) => {
    try {
      const { orderID } = req.params;
      const client = await getClobClient();
      if (!client) {
        return res.status(400).json({ error: "CLOB client not initialized. Check credentials." });
      }

      const order = await client.getOrder(orderID);
      const originalSize = Number(order.original_size || "0");
      const matchedSize = Number(order.size_matched || "0");
      const remainingSize = Math.max(0, originalSize - matchedSize);
      const fillPercent = originalSize > 0 ? (matchedSize / originalSize) * 100 : 0;
      const normalizedStatus = String(order.status || "UNKNOWN").toUpperCase();
      const positionState =
        normalizedStatus === "MATCHED" || fillPercent >= 100
          ? "FILLED"
          : matchedSize > 0
            ? "PARTIALLY_FILLED"
            : normalizedStatus === "LIVE"
              ? "OPEN"
              : normalizedStatus;

      res.json({
        orderID,
        status: normalizedStatus,
        positionState,
        outcome: order.outcome,
        side: order.side,
        market: order.market,
        assetId: order.asset_id,
        price: order.price,
        originalSize: order.original_size,
        matchedSize: order.size_matched,
        remainingSize: remainingSize.toFixed(4),
        fillPercent: fillPercent.toFixed(2),
        createdAt: order.created_at,
        expiration: order.expiration,
        raw: order,
      });
    } catch (error: any) {
      console.error("Order Lookup Error:", error);
      res.status(500).json(formatTradeError(error, { orderID: req.params.orderID }));
    }
  });

  app.get("/api/polymarket/automation", async (_req, res) => {
    try {
      const collection = await getPositionAutomationCollection();
      if (!collection) {
        return res.json({ automations: [] });
      }
      const automations = await collection.find({}).sort({ updatedAt: -1 }).toArray();
      res.json({ automations });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch position automation", detail: error?.message || String(error) });
    }
  });

  app.post("/api/polymarket/automation", async (req, res) => {
    try {
      const {
        assetId,
        market,
        outcome,
        averagePrice,
        size,
        takeProfit,
        stopLoss,
        trailingStop,
        armed,
      } = req.body || {};

      if (!assetId) {
        return res.status(400).json({ error: "assetId is required." });
      }

      const saved = await savePositionAutomation({
        assetId,
        market,
        outcome,
        averagePrice,
        size,
        takeProfit: takeProfit ?? "",
        stopLoss: stopLoss ?? "",
        trailingStop: trailingStop ?? "",
        armed: Boolean(armed),
        status: armed ? "Armed on backend" : "Disarmed",
      });

      res.json({ success: true, automation: saved });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to save position automation", detail: error?.message || String(error) });
    }
  });

  app.post("/api/polymarket/automation/recommend", async (req, res) => {
    try {
      const averagePrice = Number(req.body?.averagePrice || "0");
      if (!(averagePrice > 0 && averagePrice < 1)) {
        return res.status(400).json({ error: "averagePrice must be between 0 and 1." });
      }
      res.json(recommendAutomationLevels(averagePrice));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to recommend automation levels", detail: error?.message || String(error) });
    }
  });

  // â”€â”€ Helper: resolve trading address (proxy wallet or EOA) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/polymarket/copy-trading/trader/:address", async (req, res) => {
    try {
      const address = String(req.params.address || "").trim();
      if (!ethers.utils.isAddress(address)) {
        return res.status(400).json({ error: "Valid Polygon wallet/profile address is required." });
      }

      const positionsRaw = await fetchOpenPositionsForUser(address);
      const positions = positionsRaw
        .filter((p) => Number(p.size ?? 0) > 0)
        .sort((a, b) => Number(b.currentValue ?? b.initialValue ?? 0) - Number(a.currentValue ?? a.initialValue ?? 0))
        .map(mapCopyTraderPosition);

      const totalExposure = positions.reduce((sum, p) => sum + Number(p.currentValue || p.initialValue || 0), 0);
      const totalCost = positions.reduce((sum, p) => sum + Number(p.initialValue || 0), 0);
      const totalCashPnl = positions.reduce((sum, p) => sum + Number(p.cashPnl || 0), 0);

      res.json({
        trader: address,
        positions,
        summary: {
          openPositions: positions.length,
          totalExposure: totalExposure.toFixed(4),
          totalCost: totalCost.toFixed(4),
          totalCashPnl: totalCashPnl.toFixed(4),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch trader positions", detail: error?.message || String(error) });
    }
  });

  app.post("/api/polymarket/copy-trading/execute", async (req, res) => {
    try {
      const {
        leaderAddress,
        assetId,
        amount,
        executionMode = "AGGRESSIVE",
      } = req.body || {};

      const normalizedLeaderAddress = String(leaderAddress || "").trim();
      const normalizedAssetId = String(assetId || "").trim();
      const spendAmount = Number(amount);
      const normalizedExecutionMode = String(executionMode || "AGGRESSIVE").toUpperCase() as "PASSIVE" | "AGGRESSIVE";

      if (!ethers.utils.isAddress(normalizedLeaderAddress)) {
        return res.status(400).json({ error: "Valid leaderAddress is required." });
      }
      if (!normalizedAssetId) {
        return res.status(400).json({ error: "assetId is required." });
      }
      if (!Number.isFinite(spendAmount) || spendAmount <= 0) {
        return res.status(400).json({ error: "amount must be greater than 0." });
      }
      if (normalizedExecutionMode !== "PASSIVE" && normalizedExecutionMode !== "AGGRESSIVE") {
        return res.status(400).json({ error: "executionMode must be PASSIVE or AGGRESSIVE." });
      }

      const myTradingAddress = await getTradingAddress();
      if (myTradingAddress && myTradingAddress.toLowerCase() === normalizedLeaderAddress.toLowerCase()) {
        return res.status(400).json({ error: "Leader address matches your configured trading address." });
      }

      const leaderPositions = await fetchOpenPositionsForUser(normalizedLeaderAddress);
      const leaderPosition = leaderPositions.find((position) => String(position.asset || "") === normalizedAssetId);
      if (!leaderPosition) {
        return res.status(404).json({ error: "Selected leader position is no longer open." });
      }

      const result = await executePolymarketTrade({
        tokenID: normalizedAssetId,
        amount: spendAmount,
        side: Side.BUY,
        executionMode: normalizedExecutionMode,
        amountMode: "SPEND",
      });

      res.json({
        success: true,
        trader: normalizedLeaderAddress,
        copiedPosition: mapCopyTraderPosition(leaderPosition),
        executionMode: normalizedExecutionMode,
        result,
      });
    } catch (error: any) {
      res.status(500).json(formatTradeError(error, req.body));
    }
  });

  const getTradingAddress = async (): Promise<string | null> => {
    if (POLYMARKET_FUNDER_ADDRESS) return POLYMARKET_FUNDER_ADDRESS;
    await getClobClient();
    return clobWallet?.address ?? null;
  };

  const fetchOpenPositionsForUser = async (userAddress: string): Promise<any[]> => {
    const response = await axios.get("https://data-api.polymarket.com/positions", {
      params: { user: userAddress, limit: 500, sizeThreshold: 0 },
      timeout: 10000,
    });
    return Array.isArray(response.data) ? response.data : [];
  };

  const mapCopyTraderPosition = (position: any): CopyTraderPosition => ({
    assetId: String(position.asset || ""),
    market: String(position.title || position.market || ""),
    outcome: String(position.outcome || ""),
    size: Number(position.size ?? 0).toFixed(4),
    averagePrice: Number(position.avgPrice ?? 0).toFixed(4),
    currentPrice: Number(position.curPrice ?? 0).toFixed(4),
    initialValue: Number(position.initialValue ?? 0).toFixed(4),
    currentValue: Number(position.currentValue ?? 0).toFixed(4),
    cashPnl: Number(position.cashPnl ?? 0).toFixed(4),
    percentPnl: Number(position.percentPnl ?? 0).toFixed(2),
    endDate: position.endDate || null,
    eventSlug: position.eventSlug || null,
  });

  // â”€â”€ Current positions (open) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/polymarket/positions", async (_req, res) => {
    try {
      const userAddress = await getTradingAddress();
      if (!userAddress) return res.status(400).json({ error: "Wallet not initialized. Set POLYGON_PRIVATE_KEY in .env" });

      const response = await axios.get("https://data-api.polymarket.com/positions", {
        params: { user: userAddress, limit: 500, sizeThreshold: 0 },
        timeout: 10000,
      });
      res.json({ positions: response.data ?? [], user: userAddress });
    } catch (error: any) {
      console.error("Positions fetch error:", error.message);
      res.status(500).json({ error: "Failed to fetch current positions", detail: error.message });
    }
  });

  // â”€â”€ Closed positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/polymarket/closed-positions", async (_req, res) => {
    try {
      const userAddress = await getTradingAddress();
      if (!userAddress) return res.status(400).json({ error: "Wallet not initialized. Set POLYGON_PRIVATE_KEY in .env" });

      const response = await axios.get("https://data-api.polymarket.com/closed-positions", {
        params: { user: userAddress, limit: 50, sortBy: "TIMESTAMP", sortDirection: "DESC" },
        timeout: 10000,
      });
      res.json({ positions: response.data ?? [], user: userAddress });
    } catch (error: any) {
      console.error("Closed positions fetch error:", error.message);
      res.status(500).json({ error: "Failed to fetch closed positions", detail: error.message });
    }
  });

  // â”€â”€ Performance summary (aggregated from both APIs) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/polymarket/performance", async (_req, res) => {
    try {
      const userAddress = await getTradingAddress();
      if (!userAddress) return res.status(400).json({ error: "Wallet not initialized. Set POLYGON_PRIVATE_KEY in .env" });

      const [openRes, closedRes] = await Promise.allSettled([
        axios.get("https://data-api.polymarket.com/positions", {
          params: { user: userAddress, limit: 500, sizeThreshold: 0 },
          timeout: 10000,
        }),
        axios.get("https://data-api.polymarket.com/closed-positions", {
          params: { user: userAddress, limit: 50, sortBy: "TIMESTAMP", sortDirection: "DESC" },
          timeout: 10000,
        }),
      ]);

      const openPositionsRaw: any[] = openRes.status === "fulfilled" ? (openRes.value.data ?? []) : [];
      const closedPositionsRaw: any[] = closedRes.status === "fulfilled" ? (closedRes.value.data ?? []) : [];

      // Aggregate stats from closed positions
      const winCount  = closedPositionsRaw.filter((p) => p.realizedPnl > 0).length;
      const lossCount = closedPositionsRaw.filter((p) => p.realizedPnl < 0).length;
      const closedTrades = closedPositionsRaw.length;
      const winRate = closedTrades > 0 ? (winCount / closedTrades) * 100 : 0;
      const realizedPnl = closedPositionsRaw.reduce((sum, p) => sum + (p.realizedPnl ?? 0), 0);

      // Open exposure = sum of current market value of open positions
      const openExposure = openPositionsRaw.reduce((sum, p) => sum + (p.currentValue ?? p.initialValue ?? 0), 0);

      // Map open positions to the shape the frontend expects
      const openPositions = openPositionsRaw.map((p) => ({
        assetId:      p.asset,
        market:       p.title,
        outcome:      p.outcome,
        size:         Number(p.size ?? 0).toFixed(4),
        costBasis:    Number(p.initialValue ?? 0).toFixed(4),
        averagePrice: Number(p.avgPrice ?? 0).toFixed(4),
        currentValue: Number(p.currentValue ?? 0).toFixed(4),
        cashPnl:      Number(p.cashPnl ?? 0).toFixed(4),
        percentPnl:   Number(p.percentPnl ?? 0).toFixed(2),
        curPrice:     Number(p.curPrice ?? 0).toFixed(4),
        redeemable:   p.redeemable ?? false,
      }));

      res.json({
        summary: {
          totalMatchedTrades: closedTrades,
          closedTrades,
          winCount,
          lossCount,
          winRate: winRate.toFixed(2),
          realizedPnl: realizedPnl.toFixed(4),
          openExposure: openExposure.toFixed(4),
        },
        openPositions,
        closedPositions: closedPositionsRaw.map((p) => ({
          assetId:     p.asset,
          market:      p.title,
          outcome:     p.outcome,
          avgPrice:    Number(p.avgPrice ?? 0).toFixed(4),
          totalBought: Number(p.totalBought ?? 0).toFixed(4),
          realizedPnl: Number(p.realizedPnl ?? 0).toFixed(4),
          curPrice:    Number(p.curPrice ?? 0).toFixed(4),
          timestamp:   p.timestamp,
          endDate:     p.endDate,
          eventSlug:   p.eventSlug,
        })),
        history: [], // legacy field kept for App.tsx compatibility
        user: userAddress,
      });
    } catch (error: any) {
      console.error("Performance fetch error:", error.message);
      res.status(500).json({ error: "Failed to fetch performance", detail: error.message });
    }
  });

  // API for Fetching Balance
  app.get("/api/polymarket/balance", async (req, res) => {
    try {
      const client = await getClobClient(); // Ensure wallet is initialized
      if (!clobWallet) return res.status(400).json({ error: "Wallet not initialized. Set POLYGON_PRIVATE_KEY in .env" });

      const walletAddress = clobWallet.address;
      const funderAddress = POLYMARKET_FUNDER_ADDRESS || null;
      const tradingAddress = funderAddress || walletAddress;

      // Try both Polygon USDC contracts because wallets can still hold bridged USDC.e.
      const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)"];

      let onChainBalance = "0.00";
      let tokenAddressUsed = POLYGON_USDC_TOKENS[0].address;
      let tokenSymbolUsed = POLYGON_USDC_TOKENS[0].symbol;
      for (const token of POLYGON_USDC_TOKENS) {
        try {
          const usdc = new ethers.Contract(token.address, ERC20_ABI, clobWallet.provider);
          const raw: ethers.BigNumber = await usdc.balanceOf(walletAddress);
          const formatted = Number(ethers.utils.formatUnits(raw, 6));
          if (formatted > 0 || onChainBalance === "0.00") {
            onChainBalance = formatted.toFixed(2);
            tokenAddressUsed = token.address;
            tokenSymbolUsed = token.symbol;
          }
        } catch (err: any) {
          console.warn(`Could not fetch ${token.symbol} balance from ${token.address}:`, err.message);
        }
      }

      let polymarketBalance = onChainBalance;
      let polymarketRawBalance = null;
      try {
        if (client) {
          const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          polymarketRawBalance = collateral.balance || "0";
          polymarketBalance = Number(ethers.utils.formatUnits(collateral.balance || "0", 6)).toFixed(2);
        }
      } catch (err: any) {
        console.warn("Could not fetch Polymarket collateral balance:", err.message);
      }

      res.json({
        address: tradingAddress,
        walletAddress,
        funderAddress,
        tradingAddress,
        balance: polymarketBalance,
        polymarketBalance,
        polymarketRawBalance,
        onChainBalance,
        tokenAddressUsed,
        tokenSymbolUsed,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch balance" });
    }
  });

  // API for Polymarket Market Price History (CLOB endpoint)
  app.get("/api/polymarket/history/:marketID", async (req, res) => {
    const { marketID } = req.params;
    console.log(`[history] Fetching price history for token: ${marketID}`);
    try {
      const response = await axios.get(`https://clob.polymarket.com/prices-history`, {
        params: { market: marketID, interval: "1m", fidelity: 10 },
        timeout: 8000,
      });
      const history = Array.isArray(response.data)
        ? response.data
        : response.data?.history ?? [];
      console.log(`[history] Got ${history.length} data points for ${marketID}`);
      res.json(history);
    } catch (error: any) {
      const status = error.response?.status;
      const body = error.response?.data;
      console.log(`[history] CLOB returned ${status} for token ${marketID}:`, JSON.stringify(body));
      // Any CLOB error (400, 404, 422, 500â€¦) â€” return empty array so UI doesn't break
      return res.json([]);
    }
  });

  // Proxy for BTC Price (Binance with CoinGecko fallback)
  app.get("/api/debug/btc-cache", async (_req, res) => {
    try {
      const debug = await getMongoCacheDebug();
      res.json(debug);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to inspect BTC cache", detail: error?.message || String(error) });
    }
  });

  app.get("/api/btc-price", async (req, res) => {
    try {
      const price = await getBtcPrice();
      if (!price) {
        return res.status(500).json({ error: "Failed to fetch BTC price" });
      }
      return res.json({
        ...price,
        freshness: getCacheMeta(btcPriceCache?.expiresAt),
      });
    } catch (error: any) {
      console.error("BTC price fetch failed (all sources):", error.message);
      res.status(500).json({ error: "Failed to fetch BTC price" });
    }
  });

  // Proxy for BTC Historical Data â€” 1m candles, last 60 (for chart + indicators)
  app.get("/api/btc-history", async (req, res) => {
    try {
      const historyResult = await getBtcHistory();
      if (!historyResult?.history?.length) {
        return res.status(500).json({ error: "Failed to fetch BTC history" });
      }
      res.setHeader("X-BTC-Source", historyResult.source);
      res.setHeader("X-BTC-Cache-Stale", String(Boolean(getCacheMeta(btcHistoryCache?.expiresAt).stale)));
      return res.json(historyResult.history);
    } catch (err: any) {
      console.error("[btc-history] all sources failed:", err.message);
    }
    res.status(500).json({ error: "Failed to fetch BTC history" });
  });

  // BTC Technical Indicators â€” RSI(14), EMA(9), EMA(21), volume spike
  app.get("/api/btc-indicators", async (_req, res) => {
    try {
      const indicators = await getBtcIndicators();
      if (!indicators) {
        return res.status(500).json({ error: "Failed to fetch klines for indicators" });
      }
      res.json({
        ...indicators,
        freshness: getCacheMeta(btcIndicatorsCache?.expiresAt),
      });
    } catch (err: any) {
      console.error("[indicators] Computation error:", err.message);
      res.status(500).json({ error: "Failed to compute indicators", detail: err.message });
    }
  });

  // Proxy for Crypto Sentiment (Fear & Greed Index)
  app.get("/api/sentiment", async (req, res) => {
    try {
      const response = await axios.get("https://api.alternative.me/fng/");
      res.json(response.data.data[0]);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch sentiment data" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

