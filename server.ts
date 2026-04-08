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
import { buildAlphaResearchReport } from "./src/server/alpha/analytics.js";
import { scoreBtcAlpha } from "./src/server/alpha/model.js";
import {
  appendDecisionLog,
  createDecisionLogEntry,
  filterDecisionLogByDays,
  loadDecisionLog as loadPersistedDecisionLog,
} from "./src/server/alpha/persistence.js";
import type {
  AlphaModelSnapshot,
  DecisionAction,
  DecisionLogEntry as AlphaDecisionLogEntry,
  ExecutedTradeSample,
} from "./src/server/alpha/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Persistence: data/ directory ──────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, "data");
const LOSS_MEMORY_FILE = path.join(DATA_DIR, "loss_memory.json");
const TRADE_LOG_FILE   = path.join(DATA_DIR, "trade_log.jsonl");
const DECISION_LOG_FILE = path.join(DATA_DIR, "decision_log.jsonl");

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


function saveTradeLog(entry: TradeLogEntry): void {
  // 1. Local file (fast, always)
  try {
    fs.appendFileSync(TRADE_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (e: any) {
    console.error("[Persist] Failed to write trade_log.jsonl:", e.message);
  }
  // 2. MongoDB (SSOT — async, non-blocking)
  getTradesCollection().then((col) => {
    if (!col) return;
    col.insertOne({ ...entry }).catch((e: any) =>
      console.error("[Persist] Failed to save trade to MongoDB:", e.message)
    );
  });
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

function filterTradeLogByDays(entries: TradeLogEntry[], days?: number): TradeLogEntry[] {
  if (!Number.isFinite(days) || !days || days <= 0) return entries;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    const ts = new Date(entry.ts).getTime();
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
}

function saveDecisionSnapshot(entry: AlphaDecisionLogEntry): void {
  try {
    appendDecisionLog(DECISION_LOG_FILE, entry);
  } catch (e: any) {
    console.error("[Persist] Failed to write decision_log.jsonl:", e.message);
  }
  getDecisionLogCollection().then((col) => {
    if (!col) return;
    col.insertOne({ ...entry }).catch((e: any) =>
      console.error("[Persist] Failed to save decision to MongoDB:", e.message)
    );
  });
}

function loadDecisionSnapshots(): AlphaDecisionLogEntry[] {
  try {
    return loadPersistedDecisionLog(DECISION_LOG_FILE);
  } catch (e: any) {
    console.error("[Persist] Failed to read decision_log.jsonl:", e.message);
    return [];
  }
}

// Load last 100 resolved trades from MongoDB into botLog on startup.
// This makes PnL chart persist across restarts (SSOT = MongoDB).
async function loadBotLogFromDb(): Promise<void> {
  try {
    const col = await getTradesCollection();
    if (!col) return;
    const docs = await col.find({}).sort({ ts: -1 }).limit(100).toArray();
    if (docs.length === 0) return;
    // Map TradeLogEntry → BotLogEntry and prepend to botLog (oldest first)
    const historical: BotLogEntry[] = docs.reverse().map((d) => ({
      timestamp: d.ts,
      market: d.market,
      decision: d.result,          // "WIN" | "LOSS"
      direction: d.direction,
      confidence: d.confidence,
      edge: d.edge,
      riskLevel: "MEDIUM",
      reasoning: `Loaded from DB — ${d.result} | PnL: ${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(2)}`,
      tradeExecuted: true,
      tradeAmount: d.betAmount,
      tradePrice: d.entryPrice,
      orderId: d.orderId ?? null,
    }));
    // Only add entries not already in botLog (avoid dupes on hot reload)
    const existingTs = new Set(botLog.map((e) => e.timestamp));
    const fresh = historical.filter((e) => !existingTs.has(e.timestamp));
    botLog.push(...fresh);
    // Keep newest at index 0 (botLog is newest-first)
    botLog.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    if (botLog.length > 100) botLog.length = 100;
    console.log(`[Persist] Loaded ${fresh.length} historical trades from MongoDB into botLog`);
  } catch (e: any) {
    console.error("[Persist] Failed to load botLog from MongoDB:", e.message);
  }
}

interface PersistedLearning {
  lossMemory: LossMemory[];
  winMemory: WinMemory[];
  // Per-asset streak/boost (canonical). Legacy scalar fields kept for reading old files.
  consecutiveLossesByAsset?: Record<string, number>;
  consecutiveWinsByAsset?: Record<string, number>;
  adaptiveConfidenceByAsset?: Record<string, number>;
  // Old scalar fields — read-only for migration from pre-per-asset saves
  consecutiveLosses?: number;
  consecutiveWins?: number;
  adaptiveConfidenceBoost?: number;
  adaptiveLossPenaltyEnabled?: boolean;
  savedAt: string;
}

function saveLearning(): void {
  try {
    const payload: PersistedLearning = {
      lossMemory,
      winMemory,
      consecutiveLossesByAsset: Object.fromEntries(consecutiveLossesByAsset),
      consecutiveWinsByAsset:   Object.fromEntries(consecutiveWinsByAsset),
      adaptiveConfidenceByAsset: Object.fromEntries(adaptiveConfidenceByAsset),
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
    adaptiveLossPenaltyEnabled = data.adaptiveLossPenaltyEnabled ?? true;
    // Load per-asset state — fall back to old scalar if per-asset not present (migration)
    const assets: TradingAsset[] = ["BTC", "ETH", "SOL"];
    if (data.consecutiveLossesByAsset) {
      for (const a of assets) consecutiveLossesByAsset.set(a, data.consecutiveLossesByAsset[a] ?? 0);
    } else {
      // Old single-asset save: assign legacy value to BTC only
      consecutiveLossesByAsset.set("BTC", data.consecutiveLosses ?? 0);
    }
    if (data.consecutiveWinsByAsset) {
      for (const a of assets) consecutiveWinsByAsset.set(a, data.consecutiveWinsByAsset[a] ?? 0);
    } else {
      consecutiveWinsByAsset.set("BTC", data.consecutiveWins ?? 0);
    }
    if (data.adaptiveConfidenceByAsset) {
      for (const a of assets) adaptiveConfidenceByAsset.set(a, data.adaptiveConfidenceByAsset[a] ?? 0);
    } else {
      adaptiveConfidenceByAsset.set("BTC", data.adaptiveConfidenceBoost ?? 0);
    }
    const totalL = [...consecutiveLossesByAsset.values()].reduce((s, v) => s + v, 0);
    const totalW = [...consecutiveWinsByAsset.values()].reduce((s, v) => s + v, 0);
    const maxBoost = Math.max(...adaptiveConfidenceByAsset.values());
    console.log(`[Persist] Loaded learning state: ${lossMemory.length} loss / ${winMemory.length} win | streak=${totalL}L/${totalW}W | max boost=+${maxBoost}%`);
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

// ── BTC-only market scope ────────────────────────────────────────────────────
type TradingAsset = "BTC" | "ETH" | "SOL";
const ALL_ASSETS: TradingAsset[] = ["BTC"];
let ENABLED_ASSETS: TradingAsset[] = ["BTC"];
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
  BTC: { binanceSymbol: "BTCUSDT", coinbaseProduct: "BTC-USD", coinGeckoId: "bitcoin",  krakenPair: "XBTUSD",  polySlugPrefix: "btc-updown-5m", divergenceStrong: 200, divergenceMod: 120, divergenceWeak: 60,  label: "Bitcoin" },
  ETH: { binanceSymbol: "ETHUSDT", coinbaseProduct: "ETH-USD", coinGeckoId: "ethereum", krakenPair: "ETHUSD",  polySlugPrefix: "eth-updown-5m", divergenceStrong: 12,  divergenceMod: 7,   divergenceWeak: 3,   label: "Ethereum" },
  SOL: { binanceSymbol: "SOLUSDT", coinbaseProduct: "SOL-USD", coinGeckoId: "solana",   krakenPair: "SOLUSD",  polySlugPrefix: "sol-updown-5m", divergenceStrong: 4,   divergenceMod: 2,   divergenceWeak: 0.8, label: "Solana" },
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
const MONGODB_TRADES_COLLECTION = process.env.MONGODB_TRADES_COLLECTION || "trades";
const MONGODB_DECISION_LOG_COLLECTION = process.env.MONGODB_DECISION_LOG_COLLECTION || "decision_log";
const BTC_PRICE_CACHE_MS = 2_000;
const BTC_HISTORY_CACHE_MS = 8_000;
const BTC_INDICATORS_CACHE_MS = 15_000;
const BTC_PRICE_SNAPSHOT_TTL_SECONDS = Number(process.env.BTC_PRICE_SNAPSHOT_TTL_SECONDS || 60 * 60 * 24 * 14);
const BTC_CANDLE_TTL_SECONDS = Number(process.env.BTC_CANDLE_TTL_SECONDS || 60 * 60 * 24 * 30);
const BTC_BACKGROUND_SYNC_MS = Number(process.env.BTC_BACKGROUND_SYNC_MS || 5_000);
const POSITION_AUTOMATION_SYNC_MS = Number(process.env.POSITION_AUTOMATION_SYNC_MS || 3_000);
const MARKET_DISCOVERY_CACHE_MS = Number(process.env.MARKET_DISCOVERY_CACHE_MS || 10_000);
const POLYMARKET_STREAM_STALE_MS = Number(process.env.POLYMARKET_STREAM_STALE_MS || 7_000);
const POLYMARKET_PREWARM_TTL_MS = Number(process.env.POLYMARKET_PREWARM_TTL_MS || 5 * 60 * 1000);
const POLYMARKET_STREAM_TRADE_BUFFER = Number(process.env.POLYMARKET_STREAM_TRADE_BUFFER || 12);

// ── Bot configuration ────────────────────────────────────────────────────────
const BOT_SCAN_INTERVAL_MS = Number(process.env.BOT_SCAN_INTERVAL_MS || 5_000);
const BOT_MIN_CONFIDENCE = Number(process.env.BOT_MIN_CONFIDENCE || 75);
const BOT_MIN_EDGE = Number(process.env.BOT_MIN_EDGE || 0.15);
const BOT_KELLY_FRACTION = Number(process.env.BOT_KELLY_FRACTION || 0.40);
const BOT_MAX_BET_USDC = Number(process.env.BOT_MAX_BET_USDC || 250);
const BOT_FIXED_TRADE_USDC = Number(process.env.BOT_FIXED_TRADE_USDC || 1);

// Runtime-overrideable thresholds (UI-adjustable via /api/bot/config)
let aggressiveMinConfidence = BOT_MIN_CONFIDENCE;
let aggressiveMinEdge       = BOT_MIN_EDGE;
let aggressiveFixedTradeUsdc = BOT_FIXED_TRADE_USDC;

function getActiveConfig() {
  return {
    minConfidence:    aggressiveMinConfidence,
    minEdge:          aggressiveMinEdge,
    kellyFraction:    BOT_KELLY_FRACTION,
    maxBetUsdc:       BOT_MAX_BET_USDC,
    fixedTradeUsdc:   aggressiveFixedTradeUsdc,
    balanceCap:       0.25,
    entryWindowStart: 10,
    entryWindowEnd:   220,
  };
}

function getFixedEntryBetAmount(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const reserve = Math.min(1.0, balance * 0.10);
  const spendable = Math.max(0, balance - reserve);
  return parseFloat(Math.min(getActiveConfig().fixedTradeUsdc, spendable).toFixed(2));
}

// ── Dynamic Kelly fraction based on confidence ────────────────────────────────
// CONSERVATIVE mode always uses its flat fraction (already risk-managed).
// AGGRESSIVE mode scales the fraction with conviction level:
//   65–74% → 0.25  (borderline signal, bet small)
//   75–84% → 0.40  (normal, use base fraction)
//   85–89% → 0.55  (strong signal, size up)
//   90%+   → 0.65  (very high conviction, max size)
function dynamicKellyFraction(confidence: number): number {
  if (confidence >= 90) return 0.65;
  if (confidence >= 85) return 0.55;
  if (confidence >= 75) return 0.50;
  return 0.25;
}

function getBtcPremiumEntryBlockReason(
  asset: TradingAsset,
  bestAsk: number,
  confidence: number,
  estimatedEdge: number
): string | null {
  if (asset !== "BTC") return null;
  if (bestAsk > 0.50 && confidence < 82) {
    return `BTC premium price gate: ask ${(bestAsk * 100).toFixed(1)}¢ > 50.0¢ requires confidence >= 82%`;
  }
  if (bestAsk >= 0.495 && estimatedEdge < 0.21) {
    return `BTC premium price gate: ask ${(bestAsk * 100).toFixed(1)}¢ >= 49.5¢ requires edge >= 21.0¢`;
  }
  if (confidence >= 75 && confidence <= 79 && bestAsk >= 0.49 && estimatedEdge < 0.28) {
    return `BTC selective confidence gate: 75–79% confidence at ask >= 49.0¢ requires edge >= 28.0¢`;
  }
  return null;
}

function getRequiredMinConfidence(params: {
  baseMinConfidence: number;
  minEdge: number;
  direction?: string | null;
  divergenceDirection?: string | null;
  divergenceStrength?: string | null;
  entryPrice?: number | null;
  estimatedEdge?: number | null;
}): number {
  const divergenceStrength = String(params.divergenceStrength || "").toUpperCase();
  const direction = String(params.direction || "").toUpperCase();
  const divergenceDirection = String(params.divergenceDirection || "").toUpperCase();
  const entryPrice = Number(params.entryPrice);
  const estimatedEdge = Number(params.estimatedEdge);

  const isAlignedStrongDivergence =
    divergenceStrength === "STRONG" &&
    direction !== "" &&
    direction === divergenceDirection;
  const hasReasonablePrice =
    Number.isFinite(entryPrice) &&
    entryPrice > 0 &&
    entryPrice <= 0.80;
  const hasHealthyEdge =
    Number.isFinite(estimatedEdge) &&
    estimatedEdge >= Math.max(params.minEdge, 0.20);

  if (isAlignedStrongDivergence && hasReasonablePrice && hasHealthyEdge) {
    return Math.min(params.baseMinConfidence, 72);
  }

  return params.baseMinConfidence;
}

type QuoteSide = "BUY" | "SELL";
type QuoteAmountMode = "SPEND" | "SIZE";

interface NormalizedOrderLevel {
  price: number;
  size: number;
}

interface NormalizedOrderBookSnapshot {
  tokenId: string;
  bids: NormalizedOrderLevel[];
  asks: NormalizedOrderLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  mid: number | null;
  imbalance: number;
  imbalanceSignal: "BUY_PRESSURE" | "SELL_PRESSURE" | "NEUTRAL";
  totalLiquidityUsdc: number;
  source: "rest" | "ws";
  updatedAt: number;
}

interface ExecutionQuote {
  tokenId: string;
  side: QuoteSide;
  amount: number;
  amountMode: QuoteAmountMode;
  referencePrice: number | null;
  averagePrice: number | null;
  limitPrice: number | null;
  worstPrice: number | null;
  estimatedCost: number;
  filledSize: number;
  fullyFilled: boolean;
  levelsConsumed: number;
  slippageAbs: number | null;
  slippageBps: number | null;
  source: "depth" | "fallback" | "unavailable";
  updatedAt: string;
}

interface NormalizedPolymarketOutcome {
  label: string;
  index: number;
  tokenId: string | null;
  marketPrice: number | null;
  side: "YES" | "NO";
}

interface NormalizedPolymarketMarket {
  id: string;
  conditionId: string;
  question: string;
  description: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
  image: string;
  icon: string;
  category: string;
  volume: string;
  liquidity: string;
  eventSlug: string;
  eventTitle: string;
  eventId: string;
  startDate: string;
  endDate: string;
  asset: TradingAsset;
  normalizedOutcomes: NormalizedPolymarketOutcome[];
}

interface MarketDiscoverySnapshot {
  asset: TradingAsset;
  windowStart: number;
  currentSlug: string;
  nextSlug: string;
  currentMarkets: NormalizedPolymarketMarket[];
  nextMarkets: NormalizedPolymarketMarket[];
  fetchedAt: number;
  source: string;
  activeMarketId: string | null;
  trackedTokenIds: string[];
  prewarmedTokenIds: string[];
}

interface StreamTradeSnapshot {
  tokenId: string;
  price: number;
  size: number;
  side: "BUY" | "SELL" | "UNKNOWN";
  timestamp: number;
}

interface MarketInfraStatus {
  marketDiscovery: Record<string, {
    asset: TradingAsset;
    currentSlug: string;
    nextSlug: string;
    currentMarketCount: number;
    nextMarketCount: number;
    activeMarketId: string | null;
    fetchedAt: string | null;
    ageMs: number | null;
    trackedTokenIds: string[];
    prewarmedTokenIds: string[];
  }>;
  stream: {
    mode: "websocket" | "disabled";
    packageAvailable: boolean;
    connected: boolean;
    watchedTokenIds: string[];
    lastBookAt: string | null;
    lastTradeAt: string | null;
    reconnectCount: number;
    lastError: string | null;
    books: Record<string, {
      tokenId: string;
      bestBid: number | null;
      bestAsk: number | null;
      spread: number | null;
      imbalanceSignal: string;
      updatedAt: string;
      source: "rest" | "ws";
    }>;
    recentTrades: Record<string, StreamTradeSnapshot[]>;
  };
  prewarm: {
    readyTokenIds: string[];
    totalReady: number;
    totalTracked: number;
    lastError: string | null;
  };
  executionQuote: ExecutionQuote | null;
}

const marketDiscoveryByAsset = new Map<TradingAsset, MarketDiscoverySnapshot>();
const prewarmedTokenState = new Map<string, { warmedAt: number; ok: boolean; error: string | null }>();
const cachedExecutionQuotes = new Map<string, ExecutionQuote>();
const streamBooksByToken = new Map<string, NormalizedOrderBookSnapshot>();
const streamRecentTradesByToken = new Map<string, StreamTradeSnapshot[]>();
let currentExecutionQuote: ExecutionQuote | null = null;
let polymarketWsManager: any = null;
let polymarketWsInitPromise: Promise<any> | null = null;
let polymarketWsPackageAvailable: boolean | null = null;
let polymarketWsConnected = false;
let polymarketWsLastError: string | null = null;
let polymarketWsReconnectCount = 0;
let polymarketWsLastBookAt: number | null = null;
let polymarketWsLastTradeAt: number | null = null;
const polymarketWatchedTokenIds = new Set<string>();
let marketInfraPushTimeout: NodeJS.Timeout | null = null;

function parsePolyArray(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toFiniteNumber(value: any): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOrderBookSide(levels: any[], side: QuoteSide): NormalizedOrderLevel[] {
  return (levels || [])
    .map((level) => ({
      price: Number(level?.price || 0),
      size: Number(level?.size || 0),
    }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => (side === "BUY" ? a.price - b.price : b.price - a.price));
}

function normalizeOrderBookSnapshot(
  tokenId: string,
  raw: any,
  source: "rest" | "ws"
): NormalizedOrderBookSnapshot {
  const bids = normalizeOrderBookSide(raw?.bids ?? [], "SELL");
  const asks = normalizeOrderBookSide(raw?.asks ?? [], "BUY");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const bidSize = bids.reduce((sum, level) => sum + level.size, 0);
  const askSize = asks.reduce((sum, level) => sum + level.size, 0);
  const totalSize = bidSize + askSize;
  const imbalance = totalSize > 0 ? Number((bidSize / totalSize).toFixed(4)) : 0.5;
  const imbalanceSignal =
    imbalance > 0.6 ? "BUY_PRESSURE" :
    imbalance < 0.4 ? "SELL_PRESSURE" :
    "NEUTRAL";
  const totalLiquidityUsdc = Number(
    (
      bids.reduce((sum, level) => sum + level.price * level.size, 0) +
      asks.reduce((sum, level) => sum + level.price * level.size, 0)
    ).toFixed(2)
  );

  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? Number((bestAsk - bestBid).toFixed(4)) : null,
    mid: bestBid !== null && bestAsk !== null ? Number(((bestBid + bestAsk) / 2).toFixed(4)) : null,
    imbalance,
    imbalanceSignal,
    totalLiquidityUsdc,
    source,
    updatedAt: Date.now(),
  };
}

function getExecutionQuoteDetailed(
  orderBook: Pick<NormalizedOrderBookSnapshot, "tokenId" | "bids" | "asks" | "bestBid" | "bestAsk">,
  side: QuoteSide,
  amount: number,
  amountMode: QuoteAmountMode,
  fallbackPrice?: number | null
): ExecutionQuote {
  const normalizedFallback = Number.isFinite(Number(fallbackPrice)) && Number(fallbackPrice) > 0
    ? Number(fallbackPrice)
    : null;
  const referencePrice = side === "BUY" ? (orderBook.bestAsk ?? normalizedFallback) : (orderBook.bestBid ?? normalizedFallback);

  if (!(amount > 0)) {
    return {
      tokenId: orderBook.tokenId,
      side,
      amount,
      amountMode,
      referencePrice,
      averagePrice: null,
      limitPrice: normalizedFallback,
      worstPrice: normalizedFallback,
      estimatedCost: 0,
      filledSize: 0,
      fullyFilled: false,
      levelsConsumed: 0,
      slippageAbs: null,
      slippageBps: null,
      source: "unavailable",
      updatedAt: new Date().toISOString(),
    };
  }

  const levels = (side === "BUY" ? orderBook.asks : orderBook.bids).filter((level) => level.size > 0);
  const EPSILON = 1e-8;

  if (levels.length === 0) {
    if (!normalizedFallback) {
      return {
        tokenId: orderBook.tokenId,
        side,
        amount,
        amountMode,
        referencePrice,
        averagePrice: null,
        limitPrice: null,
        worstPrice: null,
        estimatedCost: 0,
        filledSize: 0,
        fullyFilled: false,
        levelsConsumed: 0,
        slippageAbs: null,
        slippageBps: null,
        source: "unavailable",
        updatedAt: new Date().toISOString(),
      };
    }

    const filledSize = amountMode === "SPEND" ? amount / normalizedFallback : amount;
    return {
      tokenId: orderBook.tokenId,
      side,
      amount,
      amountMode,
      referencePrice,
      averagePrice: normalizedFallback,
      limitPrice: normalizedFallback,
      worstPrice: normalizedFallback,
      estimatedCost: amountMode === "SPEND" ? amount : Number((filledSize * normalizedFallback).toFixed(6)),
      filledSize: Number(filledSize.toFixed(6)),
      fullyFilled: true,
      levelsConsumed: 1,
      slippageAbs: 0,
      slippageBps: 0,
      source: "fallback",
      updatedAt: new Date().toISOString(),
    };
  }

  let remaining = amount;
  let totalNotional = 0;
  let filledSize = 0;
  let levelsConsumed = 0;
  let worstPrice: number | null = null;

  for (const level of levels) {
    if (remaining <= EPSILON) break;

    let fillSize = 0;
    if (amountMode === "SPEND") {
      const maxNotionalAtLevel = level.price * level.size;
      const usedNotional = Math.min(remaining, maxNotionalAtLevel);
      fillSize = usedNotional / level.price;
      totalNotional += usedNotional;
      remaining -= usedNotional;
    } else {
      fillSize = Math.min(remaining, level.size);
      totalNotional += fillSize * level.price;
      remaining -= fillSize;
    }

    if (fillSize > EPSILON) {
      filledSize += fillSize;
      levelsConsumed += 1;
      worstPrice = level.price;
    }
  }

  const fullyFilled = remaining <= EPSILON;
  const averagePrice = filledSize > EPSILON ? Number((totalNotional / filledSize).toFixed(4)) : null;
  const slippageAbs = averagePrice !== null && referencePrice !== null
    ? Number((side === "BUY" ? averagePrice - referencePrice : referencePrice - averagePrice).toFixed(4))
    : null;
  const slippageBps = slippageAbs !== null && referencePrice !== null && referencePrice > 0
    ? Number(((slippageAbs / referencePrice) * 10_000).toFixed(1))
    : null;

  return {
    tokenId: orderBook.tokenId,
    side,
    amount,
    amountMode,
    referencePrice,
    averagePrice,
    limitPrice: worstPrice ?? averagePrice ?? normalizedFallback,
    worstPrice,
    estimatedCost: Number(totalNotional.toFixed(6)),
    filledSize: Number(filledSize.toFixed(6)),
    fullyFilled,
    levelsConsumed,
    slippageAbs,
    slippageBps,
    source: "depth",
    updatedAt: new Date().toISOString(),
  };
}

function normalizePolymarketMarket(event: any, market: any, asset: TradingAsset): NormalizedPolymarketMarket {
  const outcomes = parsePolyArray(market?.outcomes).map(String);
  const outcomePrices = parsePolyArray(market?.outcomePrices).map((value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(4) : String(value ?? "");
  });
  const clobTokenIds = parsePolyArray(market?.clobTokenIds).map(String);

  return {
    ...market,
    id: String(market?.id || ""),
    conditionId: String(market?.conditionId || ""),
    question: String(market?.question || event?.title || ""),
    description: String(market?.description || ""),
    outcomes,
    outcomePrices,
    clobTokenIds,
    active: Boolean(market?.active ?? event?.active ?? false),
    closed: Boolean(market?.closed ?? event?.closed ?? false),
    image: String(market?.image || event?.image || ""),
    icon: String(market?.icon || ""),
    category: String(market?.category || event?.category || ""),
    volume: String(market?.volume ?? market?.volume24hr ?? market?.volume_24h ?? ""),
    liquidity: String(market?.liquidity ?? ""),
    eventSlug: String(event?.slug || ""),
    eventTitle: String(event?.title || ""),
    eventId: String(event?.id || ""),
    startDate: String(event?.startDate || market?.startDate || ""),
    endDate: String(event?.endDate || market?.endDate || ""),
    asset,
    normalizedOutcomes: outcomes.map((label, index) => ({
      label,
      index,
      tokenId: clobTokenIds[index] || null,
      marketPrice: toFiniteNumber(outcomePrices[index]),
      side: index === 0 ? "YES" : "NO",
    })),
  };
}

function scheduleMarketInfraPush() {
  if (marketInfraPushTimeout) return;
  marketInfraPushTimeout = setTimeout(() => {
    marketInfraPushTimeout = null;
    pushSSE("infra", getMarketInfraStatus());
  }, 150);
}

function getMarketInfraStatus(): MarketInfraStatus {
  const now = Date.now();
  const marketDiscovery = Object.fromEntries(
    Array.from(marketDiscoveryByAsset.entries()).map(([asset, snapshot]) => [
      asset,
      {
        asset,
        currentSlug: snapshot.currentSlug,
        nextSlug: snapshot.nextSlug,
        currentMarketCount: snapshot.currentMarkets.length,
        nextMarketCount: snapshot.nextMarkets.length,
        activeMarketId: snapshot.activeMarketId,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        ageMs: now - snapshot.fetchedAt,
        trackedTokenIds: snapshot.trackedTokenIds,
        prewarmedTokenIds: snapshot.prewarmedTokenIds,
      },
    ])
  );

  const readyTokenIds = Array.from(prewarmedTokenState.entries())
    .filter(([, state]) => state.ok && now - state.warmedAt <= POLYMARKET_PREWARM_TTL_MS)
    .map(([tokenId]) => tokenId);
  const prewarmErrors = Array.from(prewarmedTokenState.values()).map((state) => state.error).filter(Boolean);

  return {
    marketDiscovery,
    stream: {
      mode: polymarketWsPackageAvailable === false ? "disabled" : "websocket",
      packageAvailable: polymarketWsPackageAvailable !== false,
      connected: polymarketWsConnected,
      watchedTokenIds: Array.from(polymarketWatchedTokenIds),
      lastBookAt: polymarketWsLastBookAt ? new Date(polymarketWsLastBookAt).toISOString() : null,
      lastTradeAt: polymarketWsLastTradeAt ? new Date(polymarketWsLastTradeAt).toISOString() : null,
      reconnectCount: polymarketWsReconnectCount,
      lastError: polymarketWsLastError,
      books: Object.fromEntries(
        Array.from(streamBooksByToken.entries()).map(([tokenId, book]) => [
          tokenId,
          {
            tokenId,
            bestBid: book.bestBid,
            bestAsk: book.bestAsk,
            spread: book.spread,
            imbalanceSignal: book.imbalanceSignal,
            updatedAt: new Date(book.updatedAt).toISOString(),
            source: book.source,
          },
        ])
      ),
      recentTrades: Object.fromEntries(streamRecentTradesByToken.entries()),
    },
    prewarm: {
      readyTokenIds,
      totalReady: readyTokenIds.length,
      totalTracked: prewarmedTokenState.size,
      lastError: prewarmErrors.length > 0 ? String(prewarmErrors[prewarmErrors.length - 1]) : null,
    },
    executionQuote: currentExecutionQuote,
  };
}

function rememberExecutionQuote(quote: ExecutionQuote | null) {
  currentExecutionQuote = quote;
  if (quote) cachedExecutionQuotes.set(quote.tokenId, quote);
  scheduleMarketInfraPush();
}

function rememberStreamTrade(trade: StreamTradeSnapshot) {
  const existing = streamRecentTradesByToken.get(trade.tokenId) ?? [];
  existing.unshift(trade);
  if (existing.length > POLYMARKET_STREAM_TRADE_BUFFER) existing.length = POLYMARKET_STREAM_TRADE_BUFFER;
  streamRecentTradesByToken.set(trade.tokenId, existing);
}

function handlePolymarketBookSnapshot(event: any) {
  const tokenId = String(event?.asset_id || "");
  if (!tokenId) return;
  const book = normalizeOrderBookSnapshot(tokenId, { bids: event?.bids ?? [], asks: event?.asks ?? [] }, "ws");
  streamBooksByToken.set(tokenId, book);
  polymarketWsConnected = true;
  polymarketWsLastBookAt = Date.now();
  scheduleMarketInfraPush();
}

function handlePolymarketBookDelta(event: any) {
  const changes: any[] = Array.isArray(event?.price_changes) ? event.price_changes : [];
  for (const change of changes) {
    const tokenId = String(change?.asset_id || "");
    const existing = streamBooksByToken.get(tokenId);
    if (!existing) continue;

    const price = Number(change?.price || 0);
    const size = Number(change?.size || 0);
    const side = String(change?.side || "").toUpperCase();
    if (!(price > 0) || !Number.isFinite(size) || !["BUY", "SELL"].includes(side)) continue;

    const levels = side === "BUY" ? existing.bids : existing.asks;
    const index = levels.findIndex((level) => level.price === price);

    if (size <= 0) {
      if (index !== -1) levels.splice(index, 1);
    } else if (index !== -1) {
      levels[index].size = size;
    } else {
      levels.push({ price, size });
    }

    if (side === "BUY") {
      levels.sort((a, b) => b.price - a.price);
    } else {
      levels.sort((a, b) => a.price - b.price);
    }

    const refreshed = normalizeOrderBookSnapshot(tokenId, existing, "ws");
    streamBooksByToken.set(tokenId, refreshed);
    polymarketWsConnected = true;
    polymarketWsLastBookAt = Date.now();
  }
  scheduleMarketInfraPush();
}

function handlePolymarketTrade(event: any) {
  const tokenId = String(event?.asset_id || "");
  const price = Number(event?.price || 0);
  const size = Number(event?.size || 0);
  if (!tokenId || !(price > 0) || !(size > 0)) return;

  rememberStreamTrade({
    tokenId,
    price,
    size,
    side: String(event?.side || "").toUpperCase() === "BUY"
      ? "BUY"
      : String(event?.side || "").toUpperCase() === "SELL"
        ? "SELL"
        : "UNKNOWN",
    timestamp: event?.timestamp
      ? (Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : new Date(event.timestamp).getTime())
      : Date.now(),
  });
  polymarketWsConnected = true;
  polymarketWsLastTradeAt = Date.now();
  scheduleMarketInfraPush();
}

async function ensurePolymarketWsManager() {
  if (polymarketWsManager) return polymarketWsManager;
  if (polymarketWsInitPromise) return polymarketWsInitPromise;

  polymarketWsInitPromise = (async () => {
    try {
      const poly: any = await import("@nevuamarkets/poly-websockets");
      polymarketWsPackageAvailable = true;
      polymarketWsReconnectCount += 1;
      polymarketWsManager = new poly.WSSubscriptionManager(
        {
          onBook: async (events: any[]) => {
            for (const event of events) handlePolymarketBookSnapshot(event);
          },
          onPriceChange: async (events: any[]) => {
            for (const event of events) handlePolymarketBookDelta(event);
          },
          onLastTradePrice: async (events: any[]) => {
            for (const event of events) handlePolymarketTrade(event);
          },
          onError: async (error: Error) => {
            polymarketWsConnected = false;
            polymarketWsLastError = error?.message || "WebSocket error";
            scheduleMarketInfraPush();
          },
        },
        {
          reconnectAndCleanupIntervalMs: 5_000,
          pendingFlushIntervalMs: 100,
        }
      );
      polymarketWsConnected = true;
      polymarketWsLastError = null;
      return polymarketWsManager;
    } catch (error: any) {
      polymarketWsPackageAvailable = false;
      polymarketWsConnected = false;
      polymarketWsLastError = error?.message || String(error);
      polymarketWsManager = null;
      return null;
    } finally {
      polymarketWsInitPromise = null;
      scheduleMarketInfraPush();
    }
  })();

  return polymarketWsInitPromise;
}

async function ensurePolymarketStreamSubscriptions(tokenIds: string[]) {
  const uniqueTokenIds = Array.from(new Set(tokenIds.filter(Boolean)));
  if (uniqueTokenIds.length === 0) return;

  const manager = await ensurePolymarketWsManager();
  if (!manager) return;

  const currentlyWatched = typeof manager.getAssetIds === "function"
    ? (manager.getAssetIds() as string[])
    : Array.from(polymarketWatchedTokenIds);
  const missing = uniqueTokenIds.filter((tokenId) => !currentlyWatched.includes(tokenId));
  if (missing.length === 0) return;

  await manager.addSubscriptions(missing);
  for (const tokenId of missing) polymarketWatchedTokenIds.add(tokenId);
  polymarketWsConnected = true;
  scheduleMarketInfraPush();
}

async function resetPolymarketStream() {
  try {
    if (polymarketWsManager?.clearState) {
      await polymarketWsManager.clearState();
    }
  } catch (error: any) {
    polymarketWsLastError = error?.message || String(error);
  } finally {
    polymarketWsManager = null;
    polymarketWatchedTokenIds.clear();
    streamBooksByToken.clear();
    streamRecentTradesByToken.clear();
    polymarketWsConnected = false;
    polymarketWsLastBookAt = null;
    polymarketWsLastTradeAt = null;
    scheduleMarketInfraPush();
  }
}

function isTokenPrewarmed(tokenId: string): boolean {
  const state = prewarmedTokenState.get(tokenId);
  return Boolean(state?.ok && Date.now() - state.warmedAt <= POLYMARKET_PREWARM_TTL_MS);
}

async function preWarmMarketToken(tokenId: string) {
  if (!tokenId || isTokenPrewarmed(tokenId)) return;
  const client = await getClobClient();
  if (!client) return;

  try {
    await Promise.all([
      client.getTickSize(tokenId),
      typeof (client as any).getFeeRateBps === "function"
        ? (client as any).getFeeRateBps(tokenId)
        : Promise.resolve(null),
      client.getNegRisk(tokenId),
    ]);
    prewarmedTokenState.set(tokenId, { warmedAt: Date.now(), ok: true, error: null });
  } catch (error: any) {
    prewarmedTokenState.set(tokenId, {
      warmedAt: Date.now(),
      ok: false,
      error: error?.message || String(error),
    });
  }
  scheduleMarketInfraPush();
}

async function getNormalizedOrderBookSnapshot(
  tokenId: string,
  options?: { preferStream?: boolean }
): Promise<NormalizedOrderBookSnapshot> {
  const preferStream = options?.preferStream !== false;
  const streamed = streamBooksByToken.get(tokenId);
  if (preferStream && streamed && Date.now() - streamed.updatedAt <= POLYMARKET_STREAM_STALE_MS) {
    return streamed;
  }

  const client = await getClobClient();
  const raw = client
    ? await client.getOrderBook(tokenId)
    : (await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, { timeout: 6_000 })).data;
  const snapshot = normalizeOrderBookSnapshot(tokenId, raw, "rest");
  streamBooksByToken.set(tokenId, snapshot);
  return snapshot;
}

async function fetchMarketDiscoverySnapshot(
  asset: TradingAsset,
  windowStart: number,
  forceRefresh = false
): Promise<MarketDiscoverySnapshot> {
  const cached = marketDiscoveryByAsset.get(asset);
  if (
    cached &&
    !forceRefresh &&
    cached.windowStart === windowStart &&
    Date.now() - cached.fetchedAt <= MARKET_DISCOVERY_CACHE_MS
  ) {
    return cached;
  }

  const currentSlug = `${ASSET_CONFIG[asset].polySlugPrefix}-${windowStart}`;
  const nextSlug = `${ASSET_CONFIG[asset].polySlugPrefix}-${windowStart + MARKET_SESSION_SECONDS}`;
  const [currentRes, nextRes] = await Promise.allSettled([
    axios.get(`https://gamma-api.polymarket.com/events/slug/${currentSlug}`, { timeout: 8_000 }),
    axios.get(`https://gamma-api.polymarket.com/events/slug/${nextSlug}`, { timeout: 8_000 }),
  ]);

  const currentEvent = currentRes.status === "fulfilled" ? currentRes.value.data : null;
  const nextEvent = nextRes.status === "fulfilled" ? nextRes.value.data : null;
  const currentMarkets = (currentEvent?.markets || []).map((market: any) => normalizePolymarketMarket(currentEvent, market, asset));
  const nextMarkets = (nextEvent?.markets || []).map((market: any) => normalizePolymarketMarket(nextEvent, market, asset));
  const trackedTokenIds = Array.from(
    new Set(
      [...currentMarkets, ...nextMarkets].flatMap((market) => market.clobTokenIds).filter(Boolean)
    )
  );

  const snapshot: MarketDiscoverySnapshot = {
    asset,
    windowStart,
    currentSlug,
    nextSlug,
    currentMarkets,
    nextMarkets,
    fetchedAt: Date.now(),
    source: "gamma",
    activeMarketId: currentMarkets[0]?.id ?? null,
    trackedTokenIds,
    prewarmedTokenIds: trackedTokenIds.filter((tokenId) => isTokenPrewarmed(tokenId)),
  };

  marketDiscoveryByAsset.set(asset, snapshot);
  void ensurePolymarketStreamSubscriptions(trackedTokenIds);
  void Promise.allSettled(trackedTokenIds.map((tokenId) => preWarmMarketToken(tokenId))).then(() => {
    const latest = marketDiscoveryByAsset.get(asset);
    if (!latest) return;
    latest.prewarmedTokenIds = latest.trackedTokenIds.filter((tokenId) => isTokenPrewarmed(tokenId));
    scheduleMarketInfraPush();
  });
  scheduleMarketInfraPush();
  return snapshot;
}

type BucketStat = {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
};

type ReplaySummary = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
};

function normalizeLoggedEdge(edge: number): number {
  const numeric = Number(edge);
  if (!Number.isFinite(numeric)) return 0;
  return numeric >= 1 ? Number((numeric / 100).toFixed(4)) : numeric;
}

function detectTradeAsset(market: string): TradingAsset | null {
  const normalized = String(market || "").toLowerCase();
  if (normalized.includes("bitcoin") || normalized.includes("btc")) return "BTC";
  if (normalized.includes("ethereum") || normalized.includes("eth")) return "ETH";
  if (normalized.includes("solana") || normalized.includes("sol")) return "SOL";
  return null;
}

function summarizeReplayEntries(entries: Array<{ result: "WIN" | "LOSS"; pnl: number }>): ReplaySummary {
  const wins = entries.filter((entry) => entry.result === "WIN").length;
  const losses = entries.length - wins;
  const totalPnl = Number(entries.reduce((sum, entry) => sum + Number(entry.pnl || 0), 0).toFixed(2));
  return {
    trades: entries.length,
    wins,
    losses,
    winRate: entries.length > 0 ? Number(((wins / entries.length) * 100).toFixed(1)) : null,
    totalPnl,
  };
}

function getReplayBlockReasons(
  entry: TradeLogEntry,
  config: ReturnType<typeof getActiveConfig>
): string[] {
  const reasons: string[] = [];
  const asset = detectTradeAsset(entry.market);
  const edge = normalizeLoggedEdge(entry.edge);
  const confidence = Number(entry.confidence || 0);
  const entryPrice = Number(entry.entryPrice || 0);

  if (asset !== "BTC") {
    reasons.push("BTC-only market scope");
    return reasons;
  }
  const requiredMinConfidence = getRequiredMinConfidence({
    baseMinConfidence: config.minConfidence,
    minEdge: config.minEdge,
    direction: entry.direction,
    divergenceDirection: entry.divergenceDirection,
    divergenceStrength: entry.divergenceStrength,
    entryPrice,
    estimatedEdge: edge,
  });
  if (confidence < requiredMinConfidence) {
    reasons.push(`Confidence ${confidence}% < ${requiredMinConfidence}%`);
  }
  if (edge < config.minEdge) {
    reasons.push(`Edge ${(edge * 100).toFixed(1)}c < ${(config.minEdge * 100).toFixed(1)}c`);
  }

  const divergenceStrength = String(entry.divergenceStrength || "").toUpperCase();
  const isDivergenceStrong = divergenceStrength === "STRONG";
  const dynamicMaxEntry = isDivergenceStrong
    ? 0.80
    : Math.min(0.75, (confidence - 15) / 100);
  if (entryPrice > dynamicMaxEntry) {
    reasons.push(`Entry ${(entryPrice * 100).toFixed(1)}c > dynamic max ${(dynamicMaxEntry * 100).toFixed(1)}c`);
  }

  const premiumGate = getBtcPremiumEntryBlockReason("BTC", entryPrice, confidence, edge);
  if (premiumGate) {
    reasons.push(premiumGate);
  }

  const imbalanceSignal = String(entry.imbalanceSignal || "").toUpperCase();
  if (imbalanceSignal) {
    const pressureOpposesDirection =
      (entry.direction === "UP" && imbalanceSignal === "SELL_PRESSURE") ||
      (entry.direction === "DOWN" && imbalanceSignal === "BUY_PRESSURE");
    if (pressureOpposesDirection) {
      reasons.push(`Order book pressure opposed ${entry.direction}`);
    }
  }

  return reasons;
}

function buildTradeLogReplayReport(entries: TradeLogEntry[], config: ReturnType<typeof getActiveConfig>) {
  const btcEntries = entries
    .map((entry) => ({
      ...entry,
      asset: detectTradeAsset(entry.market),
      normalizedEdge: normalizeLoggedEdge(entry.edge),
    }))
    .filter((entry) => entry.asset === "BTC");

  const replayEntries = btcEntries.map((entry) => {
    const replayReasons = getReplayBlockReasons(
      { ...entry, edge: entry.normalizedEdge },
      config
    );
    return {
      ...entry,
      replayReasons,
      replayAllowed: replayReasons.length === 0,
    };
  });

  const allowed = replayEntries.filter((entry) => entry.replayAllowed);
  const blocked = replayEntries.filter((entry) => !entry.replayAllowed);
  const reasonMap = new Map<string, { trades: number; wins: number; losses: number; totalPnl: number }>();

  for (const entry of blocked) {
    for (const reason of entry.replayReasons) {
      const bucket = reasonMap.get(reason) || { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
      bucket.trades += 1;
      if (entry.result === "WIN") bucket.wins += 1;
      else bucket.losses += 1;
      bucket.totalPnl += Number(entry.pnl || 0);
      reasonMap.set(reason, bucket);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      asset: "BTC" as const,
      totalTrades: replayEntries.length,
      assumptions: [
        "Replay uses fields present in trade_log.jsonl only",
        "Replays BTC-only scope, min confidence/edge, dynamic max entry, premium confidence gate, and pressure filter when imbalance exists",
        "Risk-level and full AI context are not replayed because they are not persisted in trade_log.jsonl",
      ],
    },
    config: {
      minConfidence: config.minConfidence,
      minEdge: config.minEdge,
    },
    baseline: summarizeReplayEntries(replayEntries),
    replay: {
      ...summarizeReplayEntries(allowed),
      blockedTrades: blocked.length,
      blockedPnl: Number(blocked.reduce((sum, entry) => sum + Number(entry.pnl || 0), 0).toFixed(2)),
      pnlDelta: Number(
        (
          allowed.reduce((sum, entry) => sum + Number(entry.pnl || 0), 0) -
          replayEntries.reduce((sum, entry) => sum + Number(entry.pnl || 0), 0)
        ).toFixed(2)
      ),
    },
    blockedByReason: Array.from(reasonMap.entries())
      .map(([reason, stats]) => ({
        reason,
        trades: stats.trades,
        wins: stats.wins,
        losses: stats.losses,
        totalPnl: Number(stats.totalPnl.toFixed(2)),
      }))
      .sort((a, b) => a.totalPnl - b.totalPnl),
    entries: replayEntries
      .slice()
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, 40)
      .map((entry) => ({
        ts: entry.ts,
        market: entry.market,
        direction: entry.direction,
        confidence: entry.confidence,
        edge: Number((entry.normalizedEdge * 100).toFixed(1)),
        entryPrice: Number((Number(entry.entryPrice || 0) * 100).toFixed(1)),
        pnl: Number(Number(entry.pnl || 0).toFixed(2)),
        result: entry.result,
        replayAllowed: entry.replayAllowed,
        replayReasons: entry.replayReasons,
      })),
  };
}

function buildBucketStat(label: string, rows: TradeLogEntry[]): BucketStat {
  const wins = rows.filter((entry) => entry.result === "WIN").length;
  const losses = rows.length - wins;
  return {
    label,
    trades: rows.length,
    wins,
    losses,
    winRate: rows.length > 0 ? Number(((wins / rows.length) * 100).toFixed(1)) : null,
    pnl: Number(rows.reduce((sum, entry) => sum + Number(entry.pnl || 0), 0).toFixed(2)),
  };
}

function buildBtcCutoffReport(entries: TradeLogEntry[]) {
  const btcEntries = entries
    .map((entry) => ({
      ...entry,
      asset: detectTradeAsset(entry.market),
      normalizedEdge: normalizeLoggedEdge(entry.edge),
    }))
    .filter((entry) => entry.asset === "BTC");

  const byDirection = ["UP", "DOWN"].map((direction) =>
    buildBucketStat(direction, btcEntries.filter((entry) => entry.direction === direction))
  );

  const confidenceBuckets = [
    { label: "70-74", fn: (entry: typeof btcEntries[number]) => entry.confidence >= 70 && entry.confidence <= 74 },
    { label: "75-79", fn: (entry: typeof btcEntries[number]) => entry.confidence >= 75 && entry.confidence <= 79 },
    { label: "80-84", fn: (entry: typeof btcEntries[number]) => entry.confidence >= 80 && entry.confidence <= 84 },
    { label: "85+", fn: (entry: typeof btcEntries[number]) => entry.confidence >= 85 },
  ];
  const entryPriceBuckets = [
    { label: "<49.0c", fn: (entry: typeof btcEntries[number]) => entry.entryPrice < 0.49 },
    { label: "49.0-49.9c", fn: (entry: typeof btcEntries[number]) => entry.entryPrice >= 0.49 && entry.entryPrice < 0.5 },
    { label: ">=50.0c", fn: (entry: typeof btcEntries[number]) => entry.entryPrice >= 0.5 },
  ];
  const edgeBuckets = [
    { label: "<22.0c", fn: (entry: typeof btcEntries[number]) => entry.normalizedEdge < 0.22 },
    { label: "22.0-27.9c", fn: (entry: typeof btcEntries[number]) => entry.normalizedEdge >= 0.22 && entry.normalizedEdge < 0.28 },
    { label: ">=28.0c", fn: (entry: typeof btcEntries[number]) => entry.normalizedEdge >= 0.28 },
  ];

  const byConfidence = confidenceBuckets.map((bucket) =>
    buildBucketStat(bucket.label, btcEntries.filter(bucket.fn))
  ).filter((bucket) => bucket.trades > 0);

  const byEntryPrice = entryPriceBuckets.map((bucket) =>
    buildBucketStat(bucket.label, btcEntries.filter(bucket.fn))
  ).filter((bucket) => bucket.trades > 0);

  const matrix = byDirection.flatMap((directionStat) =>
    confidenceBuckets.flatMap((confidenceBucket) =>
      entryPriceBuckets.flatMap((priceBucket) =>
        edgeBuckets.map((edgeBucket) => {
          const rows = btcEntries.filter((entry) =>
            entry.direction === directionStat.label &&
            confidenceBucket.fn(entry) &&
            priceBucket.fn(entry) &&
            edgeBucket.fn(entry)
          );
          return {
            direction: directionStat.label,
            confidenceBucket: confidenceBucket.label,
            entryPriceBucket: priceBucket.label,
            edgeBucket: edgeBucket.label,
            ...buildBucketStat(
              `${directionStat.label} | ${confidenceBucket.label} | ${priceBucket.label} | ${edgeBucket.label}`,
              rows
            ),
          };
        })
      )
    )
  ).filter((row) => row.trades > 0);

  return {
    generatedAt: new Date().toISOString(),
    total: summarizeReplayEntries(btcEntries),
    byDirection,
    byConfidence,
    byEntryPrice,
    matrix,
    bestBuckets: matrix.slice().sort((a, b) => b.pnl - a.pnl).slice(0, 8),
    worstBuckets: matrix.slice().sort((a, b) => a.pnl - b.pnl).slice(0, 8),
  };
}

// ── Bot runtime state ────────────────────────────────────────────────────────
let botEnabled = process.env.BOT_AUTO_START === "true";
let botRunning = false;
let botInterval: NodeJS.Timeout | null = null;
let botSessionStartBalance: number | null = null;
let botSessionTradesCount = 0;
let botLastWindowStart = 0;
// Per-asset analyzed-this-window tracking (keyed by asset → Set of market IDs)
const botAnalyzedThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC", "ETH", "SOL"] as TradingAsset[]).map(a => [a, new Set<string>()])
);
// Per-asset trade execution locks for the current window.
// `executing` prevents duplicate submits during async races.
// `executed` blocks any re-analysis/re-entry after a real Polymarket fill attempt succeeded.
const botExecutingTradesThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC", "ETH", "SOL"] as TradingAsset[]).map(a => [a, new Set<string>()])
);
const botExecutedTradesThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC", "ETH", "SOL"] as TradingAsset[]).map(a => [a, new Set<string>()])
);
// Backward-compat alias (used by BTC path until loop refactor is complete)
const botAnalyzedThisWindow = botAnalyzedThisWindowByAsset.get("BTC")!;

function getTradeWindowStatus(asset: TradingAsset, marketId: string): "EXECUTING" | "EXECUTED" | null {
  if (botExecutedTradesThisWindowByAsset.get(asset)?.has(marketId)) return "EXECUTED";
  if (botExecutingTradesThisWindowByAsset.get(asset)?.has(marketId)) return "EXECUTING";
  return null;
}

function markTradeExecutionStarted(asset: TradingAsset, marketId: string): void {
  botExecutingTradesThisWindowByAsset.get(asset)?.add(marketId);
}

function markTradeExecutionFinished(asset: TradingAsset, marketId: string, executed: boolean): void {
  botExecutingTradesThisWindowByAsset.get(asset)?.delete(marketId);
  if (executed) botExecutedTradesThisWindowByAsset.get(asset)?.add(marketId);
}


// ── Fast loop momentum history ring buffer ────────────────────────────────────
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

// ── Last known STRONG divergence timestamp (for notification dedup) ───────────
let lastStrongDivergenceNotifiedAt = 0;

// ── Divergence fast-path state ────────────────────────────────────────────────
const activeBotMarketByAsset = new Map<TradingAsset, any>(); // per-asset active market
let activeBotMarket: any = null;          // kept for backward-compat with divergence tracker sync (line below)
let lastKnownBalance: number | null = null; // most recent balance fetch, used by fast path
let lastDivergenceFastTradeAt = 0;        // unix-seconds cooldown tracker
let divergenceFastTradeRunning = false;   // mutex — prevents concurrent fast-path execution


// ── Per-window AI result cache (reuse rec across cycles, only re-check price) ──
// Keyed by asset so BTC/ETH/SOL caches don't overwrite each other.
const currentWindowAiCache = new Map<TradingAsset, { windowStart: number; marketId: string; rec: any }>();

// ── Divergence tracker (asset price vs YES token lag detector) ───────────────
interface PricePoint { ts: number; price: number; }
const priceRingBufferByAsset = new Map<TradingAsset, PricePoint[]>([["BTC",[]], ["ETH",[]], ["SOL",[]]]);
const yesRingBufferByAsset   = new Map<TradingAsset, PricePoint[]>([["BTC",[]], ["ETH",[]], ["SOL",[]]]);
const currentWindowYesTokenIdByAsset = new Map<TradingAsset, string | null>();
const currentWindowNoTokenIdByAsset  = new Map<TradingAsset, string | null>();
// Convenience accessors used by divergence tracker (always reflects currentDivergenceAsset)
let currentWindowYesTokenId: string | null = null;
let currentWindowNoTokenId:  string | null = null;
let currentDivergenceAsset: TradingAsset = "BTC"; // tracks which asset divergence monitors

interface DivergenceState {
  btcDelta30s: number;       // raw $ BTC change in last 30s
  btcDelta60s: number;       // raw $ BTC change in last 60s
  yesDelta30s: number;       // YES token ¢ change in last 30s
  divergence: number;        // 0.0–1.0+ normalized score
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK" | "NONE";
  currentBtcPrice: number | null;
  currentYesAsk:   number | null;
  currentNoAsk:    number | null;
  updatedAt: number;         // unix seconds
}
const divergenceStateByAsset = new Map<TradingAsset, DivergenceState>();
let divergenceTrackerInterval: NodeJS.Timeout | null = null;

interface PriceToBeatState {
  asset: TradingAsset;
  windowStart: number;
  openingPrice: number;
  openingSource: string;
  openingCapturedAt: string;
  currentPrice: number;
  currentSource: string;
  currentUpdatedAt: string;
  mode: "proxy" | "chainlink";
}

interface PriceToBeatSnapshot {
  windowStart: number;
  openingPrice: number;
  currentPrice: number;
  distanceUsd: number;
  distancePct: number;
  direction: "UP" | "DOWN" | "FLAT";
  favoredOutcome: "UP" | "DOWN";
  tieGoesToUp: true;
  source: string;
  mode: "proxy" | "chainlink";
  updatedAt: string;
}

const priceToBeatStateByAsset = new Map<TradingAsset, PriceToBeatState>();

function buildPriceToBeatSnapshot(state: PriceToBeatState): PriceToBeatSnapshot {
  const distanceUsd = Number((state.currentPrice - state.openingPrice).toFixed(2));
  const distancePct = state.openingPrice > 0
    ? Number((((state.currentPrice - state.openingPrice) / state.openingPrice) * 100).toFixed(4))
    : 0;
  const direction =
    distanceUsd > 0 ? "UP" :
    distanceUsd < 0 ? "DOWN" :
    "FLAT";
  const favoredOutcome = distanceUsd >= 0 ? "UP" : "DOWN";

  return {
    windowStart: state.windowStart,
    openingPrice: state.openingPrice,
    currentPrice: state.currentPrice,
    distanceUsd,
    distancePct,
    direction,
    favoredOutcome,
    tieGoesToUp: true,
    source: state.currentSource,
    mode: state.mode,
    updatedAt: state.currentUpdatedAt,
  };
}

function updatePriceToBeatState(
  asset: TradingAsset,
  windowStart: number,
  currentPrice: number | null | undefined,
  source?: string | null,
  mode: "proxy" | "chainlink" = "proxy"
): PriceToBeatSnapshot | null {
  if (!Number.isFinite(currentPrice) || !currentPrice || currentPrice <= 0) {
    return getPriceToBeatSnapshot(asset, windowStart);
  }

  const normalizedSource = String(source || "unknown");
  const nowIso = new Date().toISOString();
  const existing = priceToBeatStateByAsset.get(asset);

  if (!existing || existing.windowStart !== windowStart) {
    const freshState: PriceToBeatState = {
      asset,
      windowStart,
      openingPrice: Number(currentPrice),
      openingSource: normalizedSource,
      openingCapturedAt: nowIso,
      currentPrice: Number(currentPrice),
      currentSource: normalizedSource,
      currentUpdatedAt: nowIso,
      mode,
    };
    priceToBeatStateByAsset.set(asset, freshState);
    return buildPriceToBeatSnapshot(freshState);
  }

  existing.currentPrice = Number(currentPrice);
  existing.currentSource = normalizedSource;
  existing.currentUpdatedAt = nowIso;
  return buildPriceToBeatSnapshot(existing);
}

function getPriceToBeatSnapshot(asset: TradingAsset, windowStart: number): PriceToBeatSnapshot | null {
  const state = priceToBeatStateByAsset.get(asset);
  if (!state || state.windowStart !== windowStart) return null;
  return buildPriceToBeatSnapshot(state);
}

// ── Current entry snapshot (shown in dashboard widget) ────────────────────────
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
  priceToBeat: PriceToBeatSnapshot | null;
  asset?: TradingAsset;
  divergence: { direction: string; strength: string; btcDelta30s: number; yesDelta30s: number; } | null;
  fastLoopMomentum: { direction: string; strength: string; vw: number; } | null;
  alphaModel: AlphaModelSnapshot | null;
  updatedAt: string;
}
let currentEntrySnapshot: EntrySnapshot | null = null;

function extractStrikePrice(question: string): number | null {
  const match = String(question || "").match(/\$([0-9,]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildAlphaModelSnapshot(input: {
  asset: TradingAsset;
  direction: "UP" | "DOWN" | "NONE";
  confidence: number;
  edge: number;
  entryPrice: number | null;
  riskLevel: string;
  imbalanceSignal?: string | null;
  signalScore?: number | null;
  rsi?: number | null;
  emaCross?: string | null;
  divergenceDirection?: string | null;
  divergenceStrength?: string | null;
  fastLoopDirection?: string | null;
  fastLoopStrength?: string | null;
  fastLoopVw?: number | null;
  windowElapsedSeconds?: number | null;
}): AlphaModelSnapshot | null {
  const model = scoreBtcAlpha({
    asset: input.asset,
    direction: input.direction,
    confidence: input.confidence,
    edge: input.edge,
    entryPrice: input.entryPrice,
    riskLevel: input.riskLevel,
    imbalanceSignal: input.imbalanceSignal,
    signalScore: input.signalScore,
    rsi: input.rsi,
    emaCross: input.emaCross,
    divergenceDirection: input.divergenceDirection,
    divergenceStrength: input.divergenceStrength,
    fastLoopDirection: input.fastLoopDirection,
    fastLoopStrength: input.fastLoopStrength,
    fastLoopVw: input.fastLoopVw,
    windowElapsedSeconds: input.windowElapsedSeconds,
  });
  return model.probability == null ? null : model;
}

function persistDecisionSnapshotFromSignal(params: {
  asset: TradingAsset;
  market: NormalizedPolymarketMarket;
  windowStart: number;
  windowElapsedSeconds: number;
  decision: "TRADE" | "NO_TRADE";
  action: DecisionAction;
  direction: "UP" | "DOWN" | "NONE";
  confidence: number;
  edge: number;
  riskLevel: string;
  reasoning: string;
  filterReasons?: string[];
  yesPrice: number | null;
  noPrice: number | null;
  estimatedBet?: number | null;
  btcPrice?: number | null;
  priceToBeat?: PriceToBeatSnapshot | null;
  rsi?: number | null;
  emaCross?: string | null;
  signalScore?: number | null;
  imbalanceSignal?: string | null;
  divergenceDirection?: string | null;
  divergenceStrength?: string | null;
  btcDelta30s?: number | null;
  yesDelta30s?: number | null;
  fastLoopDirection?: string | null;
  fastLoopStrength?: string | null;
  fastLoopVw?: number | null;
  tradeExecuted?: boolean;
  tradeAmount?: number | null;
  tradePrice?: number | null;
  orderId?: string | null;
}): AlphaDecisionLogEntry {
  const entryPrice =
    params.direction === "UP" ? params.yesPrice :
    params.direction === "DOWN" ? params.noPrice :
    null;
  const model = buildAlphaModelSnapshot({
    asset: params.asset,
    direction: params.direction,
    confidence: params.confidence,
    edge: params.edge,
    entryPrice,
    riskLevel: params.riskLevel,
    imbalanceSignal: params.imbalanceSignal,
    signalScore: params.signalScore,
    rsi: params.rsi,
    emaCross: params.emaCross,
    divergenceDirection: params.divergenceDirection,
    divergenceStrength: params.divergenceStrength,
    fastLoopDirection: params.fastLoopDirection,
    fastLoopStrength: params.fastLoopStrength,
    fastLoopVw: params.fastLoopVw,
    windowElapsedSeconds: params.windowElapsedSeconds,
  });

  const entry = createDecisionLogEntry({
    windowStart: params.windowStart,
    windowEnd: params.windowStart + MARKET_SESSION_SECONDS,
    asset: params.asset,
    market: params.market.question || params.market.id,
    marketId: params.market.id,
    eventSlug: params.market.eventSlug || "",
    decision: params.decision,
    action: params.action,
    direction: params.direction,
    confidence: params.confidence,
    edge: params.edge,
    riskLevel: params.riskLevel,
    reasoning: params.reasoning,
    filterReasons: params.filterReasons || [],
    entryPrice,
    yesPrice: params.yesPrice,
    noPrice: params.noPrice,
    estimatedBet: params.estimatedBet ?? null,
    btcPrice: params.btcPrice ?? null,
    strikePrice: extractStrikePrice(params.market.question || ""),
    priceToBeatOpen: params.priceToBeat?.openingPrice ?? null,
    priceToBeatCurrent: params.priceToBeat?.currentPrice ?? null,
    priceToBeatDistance: params.priceToBeat?.distanceUsd ?? null,
    priceToBeatDirection: params.priceToBeat?.direction ?? null,
    priceToBeatSource: params.priceToBeat?.source ?? null,
    priceToBeatMode: params.priceToBeat?.mode ?? null,
    windowElapsedSeconds: params.windowElapsedSeconds,
    imbalanceSignal: params.imbalanceSignal ?? null,
    signalScore: params.signalScore ?? null,
    rsi: params.rsi ?? null,
    emaCross: params.emaCross ?? null,
    divergenceDirection: params.divergenceDirection ?? null,
    divergenceStrength: params.divergenceStrength ?? null,
    btcDelta30s: params.btcDelta30s ?? null,
    yesDelta30s: params.yesDelta30s ?? null,
    fastLoopDirection: params.fastLoopDirection ?? null,
    fastLoopStrength: params.fastLoopStrength ?? null,
    fastLoopVw: params.fastLoopVw ?? null,
    model,
    tradeExecuted: params.tradeExecuted ?? false,
    tradeAmount: params.tradeAmount ?? null,
    tradePrice: params.tradePrice ?? null,
    orderId: params.orderId ?? null,
  });

  saveDecisionSnapshot(entry);
  return entry;
}

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

// ── SSE clients for real-time push ────────────────────────────────────────────
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
  // Context captured at trade time — used for learning
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

// ── Adaptive learning state ───────────────────────────────────────────────────
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
// Global aliases kept for persistence (sum/avg not needed — persist per entry in lossMemory)
let adaptiveLossPenaltyEnabled = true;

function generateLesson(pending: PendingResult): string {
  const rules: string[] = [];
  const { direction, rsi, emaCross, signalScore, windowElapsedSeconds, confidence, entryPrice, imbalanceSignal } = pending;

  // ── Momentum contradictions ─────────────────────────────────────────────────
  if (direction === "UP"   && rsi !== undefined && rsi > 65)  rules.push(`RSI overbought (${rsi.toFixed(0)}) on UP — reversal risk`);
  if (direction === "DOWN" && rsi !== undefined && rsi < 35)  rules.push(`RSI oversold (${rsi.toFixed(0)}) on DOWN — reversal risk`);
  if (direction === "UP"   && rsi !== undefined && rsi > 55 && rsi <= 65) rules.push(`RSI elevated (${rsi.toFixed(0)}) on UP — limited upside room`);
  if (direction === "DOWN" && rsi !== undefined && rsi < 45 && rsi >= 35) rules.push(`RSI depressed (${rsi.toFixed(0)}) on DOWN — limited downside room`);
  if (direction === "UP"   && emaCross === "BEARISH") rules.push("EMA cross BEARISH contradicts UP direction");
  if (direction === "DOWN" && emaCross === "BULLISH") rules.push("EMA cross BULLISH contradicts DOWN direction");

  // ── Signal score alignment ─────────────────────────────────────────────────
  if (direction === "UP"   && signalScore !== undefined && signalScore < 0) rules.push(`Signal score ${signalScore} opposes UP direction`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore > 0) rules.push(`Signal score +${signalScore} opposes DOWN direction`);
  if (direction === "UP"   && signalScore !== undefined && signalScore === 0) rules.push(`Signal score neutral (0) — no technical edge on UP`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore === 0) rules.push(`Signal score neutral (0) — no technical edge on DOWN`);

  // ── Entry price zone ────────────────────────────────────────────────────────
  if (entryPrice >= 0.48 && entryPrice <= 0.53) rules.push(`Entry at coin-flip zone (${(entryPrice * 100).toFixed(0)}¢) — maximum binary market uncertainty`);
  if (entryPrice > 0.60) rules.push(`High entry price (${(entryPrice * 100).toFixed(0)}¢) — limited upside, asymmetric loss risk`);

  // ── Order book pressure ─────────────────────────────────────────────────────
  if (direction === "UP"   && imbalanceSignal === "SELL_PRESSURE") rules.push("Order book SELL_PRESSURE contradicted UP entry (crowd was selling YES)");
  if (direction === "DOWN" && imbalanceSignal === "BUY_PRESSURE")  rules.push("Order book BUY_PRESSURE contradicted DOWN entry (crowd was buying YES)");
  if (!imbalanceSignal || imbalanceSignal === "?")                  rules.push("Order book data unavailable at entry — blind entry without crowd signal");

  // ── Timing ─────────────────────────────────────────────────────────────────
  if (windowElapsedSeconds > 180) rules.push(`Late entry at ${windowElapsedSeconds}s — only ${300 - windowElapsedSeconds}s remaining`);
  if (windowElapsedSeconds >= 30 && windowElapsedSeconds <= 90)    rules.push(`Mid-window entry at ${windowElapsedSeconds}s — high-noise zone, FastLoop not yet stable`);
  if (windowElapsedSeconds < 20)  rules.push(`Very early entry at ${windowElapsedSeconds}s — insufficient market data`);

  // ── Confidence ─────────────────────────────────────────────────────────────
  if (confidence < 75) rules.push(`Borderline confidence (${confidence}%) — below strong conviction threshold`);

  return rules.length > 0 ? rules.join(" | ") : "Loss without clear signal contradictions — review divergence context";
}

function generateWinLesson(pending: PendingResult): string {
  const reasons: string[] = [];
  const { direction, rsi, emaCross, signalScore, windowElapsedSeconds, confidence } = pending;

  if (direction === "UP"   && rsi !== undefined && rsi < 45) reasons.push(`RSI oversold (${rsi.toFixed(0)}) on UP — momentum room available`);
  if (direction === "DOWN" && rsi !== undefined && rsi > 55) reasons.push(`RSI overbought (${rsi.toFixed(0)}) on DOWN — reversal confirmed`);
  if (direction === "UP"   && emaCross === "BULLISH")         reasons.push("EMA cross BULLISH aligned with UP direction");
  if (direction === "DOWN" && emaCross === "BEARISH")         reasons.push("EMA cross BEARISH aligned with DOWN direction");
  if (direction === "UP"   && signalScore !== undefined && signalScore > 0) reasons.push(`Strong positive signal score (+${signalScore}) on UP trade`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore < 0) reasons.push(`Strong negative signal score (${signalScore}) on DOWN trade`);
  if (windowElapsedSeconds <= 150) reasons.push(`Early entry at ${windowElapsedSeconds}s — maximum time for move to develop`);
  if (confidence >= 72)            reasons.push(`High confidence entry (${confidence}%) — strong conviction`);

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
  strategyTag?: "STANDARD" | "FAST_PATH" | "CORRELATED";
  windowEnd?: number;       // unix seconds — when the 5-min market resolves
  highestPrice?: string;
  trailingStopPrice?: string;
  lastPrice?: string;
  status?: string;
  lastExitOrderId?: string | null;
  updatedAt: Date;
  enteredAt?: Date | null;
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

async function loadBtcCandlesRange(startTime: number, endTime: number): Promise<Array<{ time: number; close: number }>> {
  const collection = await getCandlesCollection();
  if (!collection) return [];
  const safeStart = Math.max(0, Math.floor(startTime) - 60);
  const safeEnd = Math.max(safeStart, Math.floor(endTime) + 60);
  const docs = await collection
    .find(
      {
        symbol: "BTCUSDT",
        interval: "1m",
        time: { $gte: safeStart, $lte: safeEnd },
      },
      {
        projection: { _id: 0, time: 1, close: 1 },
        sort: { time: 1 },
      }
    )
    .toArray();

  return docs.map((doc) => ({
    time: Number(doc.time),
    close: Number(doc.close),
  }));
}

async function getPositionAutomationCollection() {
  const db = await getMongoDb();
  return db?.collection<PositionAutomationDocument>(MONGODB_POSITION_AUTOMATION_COLLECTION) || null;
}

async function getTradesCollection() {
  const db = await getMongoDb();
  return db?.collection<TradeLogEntry & { _id?: any }>(MONGODB_TRADES_COLLECTION) || null;
}

async function getDecisionLogCollection() {
  const db = await getMongoDb();
  return db?.collection<AlphaDecisionLogEntry & { _id?: any }>(MONGODB_DECISION_LOG_COLLECTION) || null;
}

async function ensureMongoCollections() {
  try {
    const db = await getMongoDb();
    if (!db) return;

    const marketCache = db.collection(MONGODB_CACHE_COLLECTION);
    const priceSnapshots = db.collection(MONGODB_PRICE_SNAPSHOTS_COLLECTION);
    const candles = db.collection(MONGODB_CHART_COLLECTION);
    const automations = db.collection(MONGODB_POSITION_AUTOMATION_COLLECTION);
    const decisionLog = db.collection(MONGODB_DECISION_LOG_COLLECTION);

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
      decisionLog.createIndex({ ts: -1 }),
      decisionLog.createIndex({ asset: 1, ts: -1 }),
      decisionLog.createIndex({ marketId: 1, ts: -1 }),
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

// ── Generic multi-asset fetchers (ETH, SOL via Binance/Coinbase) ─────────────
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

// ── Fast Loop Momentum (Simmer SDK-inspired CEX momentum signal) ───────────
interface FastLoopMomentum {
  raw: number;            // % price change over 5 candles (first → last)
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

// ── Telegram / Discord push notifications ────────────────────────────────────
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

// ── Divergence fast-path hook — wired up inside startServer() after local fns are defined ──
// The tracker calls this when STRONG divergence fires; startServer() sets the implementation.
let onStrongDivergence: ((direction: "UP" | "DOWN", snapshot: { yesAsk: number | null; noAsk: number | null; btcDelta: number }) => void) | null = null;

// ── Divergence Tracker: BTC price vs YES token price lag detector ─────────────
// Runs every 5s independently. Fills ring buffers and computes divergence score.
function startDivergenceTracker() {
  if (divergenceTrackerInterval) return;

  const tick = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);

      // 1. Asset price sample — stored per-asset to avoid cross-asset contamination
      const _asset = currentDivergenceAsset;
      const priceRingBuf = priceRingBufferByAsset.get(_asset)!;
      const yesRingBuf   = yesRingBufferByAsset.get(_asset)!;

      const btcData = await getAssetPrice(_asset);
      const btcPrice = btcData?.price ? parseFloat(btcData.price as any) : null;
      if (btcPrice && btcPrice > 0) {
        priceRingBuf.push({ ts: now, price: btcPrice });
        if (priceRingBuf.length > 120) priceRingBuf.shift(); // 10-min cap
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
            yesRingBuf.push({ ts: now, price: yesAsk });
            if (yesRingBuf.length > 120) yesRingBuf.shift();
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

      // 3. Compute 30s and 60s deltas from per-asset ring buffers
      const btcNow = priceRingBuf.length > 0 ? priceRingBuf[priceRingBuf.length - 1].price : null;
      const yesNow = yesRingBuf.length > 0 ? yesRingBuf[yesRingBuf.length - 1].price : null;

      const findNearest = (buf: PricePoint[], targetTs: number) =>
        buf.reduce<PricePoint | null>((best, p) => {
          if (p.ts > targetTs) return best;
          if (!best || Math.abs(p.ts - targetTs) < Math.abs(best.ts - targetTs)) return p;
          return best;
        }, null);

      const btc30ref = findNearest(priceRingBuf, now - 30);
      const btc60ref = findNearest(priceRingBuf, now - 60);
      const yes30ref = findNearest(yesRingBuf, now - 30);

      const btcDelta30s = btcNow && btc30ref ? btcNow - btc30ref.price : 0;
      const btcDelta60s = btcNow && btc60ref ? btcNow - btc60ref.price : 0;
      const yesDelta30s = yesNow && yes30ref ? (yesNow - yes30ref.price) * 100 : 0; // in ¢

      // 4. Classify divergence using asset-specific thresholds
      const divCfg = ASSET_CONFIG[currentDivergenceAsset];
      const BTC_STRONG = divCfg.divergenceStrong;
      const BTC_MOD    = divCfg.divergenceMod;
      const BTC_WEAK   = divCfg.divergenceWeak;
      const YES_LAG    = 2.0; // ¢ — YES hasn't moved at least 2¢ in asset's direction

      let direction: DivergenceState["direction"] = "NEUTRAL";
      let strength:  DivergenceState["strength"]  = "NONE";
      let divergence = 0;

      const absBtc = Math.abs(btcDelta30s);

      if (absBtc >= BTC_WEAK) {
        direction = btcDelta30s > 0 ? "UP" : "DOWN";
        const yesInBtcDir = direction === "UP" ? yesDelta30s : -yesDelta30s;
        const yesLagging  = yesInBtcDir < YES_LAG; // YES hasn't caught up

        divergence = absBtc / BTC_STRONG; // normalized 0–1+

        if      (absBtc >= BTC_STRONG && yesLagging) strength = "STRONG";
        else if (absBtc >= BTC_MOD    && yesLagging) strength = "MODERATE";
        else if (absBtc >= BTC_WEAK   && yesLagging) strength = "WEAK";
        else direction = "NEUTRAL"; // BTC moved but YES kept pace — no lag
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
          `⚡ <b>STRONG DIVERGENCE DETECTED</b>\nBTC: ${btcDelta30s >= 0 ? "+" : ""}$${btcDelta30s.toFixed(0)} (30s)\nYES: ${yesDelta30s >= 0 ? "+" : ""}${yesDelta30s.toFixed(2)}¢\nDirection: ${direction}\nBot may force-trade ${direction}`
        );
      }

      // ── STRONG DIVERGENCE: reset analyzed set so main cycle re-evaluates ────
      // If STRONG divergence fires mid-window and bot already marked the market
      // as analyzed (e.g. earlier NO_TRADE), clear the set so the next bot cycle
      // re-runs analysis with the new divergence context.
      if (strength === "STRONG" && (direction === "UP" || direction === "DOWN") && botEnabled) {
        const assetSet = botAnalyzedThisWindowByAsset.get(currentDivergenceAsset);
        if (assetSet && assetSet.size > 0) {
          console.log(`[DIV] STRONG divergence mid-window — clearing analyzed set for ${currentDivergenceAsset} to force re-evaluation`);
          assetSet.clear();
          currentWindowAiCache.delete(currentDivergenceAsset);
        }
      }

      // ── FAST PATH TRIGGER ─────────────────────────────────────────────────
      // Fire immediately on STRONG divergence — don't wait for next bot cycle.
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
  console.log("[Divergence] Tracker started — 5s BTC vs YES token lag detector");
}

async function startServer() {
  const app = express();
  const PORT = 3444;

  loadLearning();
  void ensureMongoCollections();
  void loadBotLogFromDb();
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

    if (!isTokenPrewarmed(tokenID)) {
      void preWarmMarketToken(tokenID);
    }

    const parsedAmount = Number(amount);
    const parsedSide = String(side || "BUY").toUpperCase() as Side;
    const normalizedMode = String(executionMode || "MANUAL").toUpperCase() as "MANUAL" | "PASSIVE" | "AGGRESSIVE";
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new Error("Trade amount must be greater than 0.");
    }

    const normalizedAmountMode =
      amountMode || (parsedSide === Side.BUY ? "SPEND" : "SIZE");
    const orderbook = await getNormalizedOrderBookSnapshot(tokenID);
    const bestBid = Number(orderbook.bestBid || "0");
    const bestAsk = Number(orderbook.bestAsk || "0");

    let parsedPrice = Number(price);
    let executionQuote: ExecutionQuote | null = null;
    if (normalizedMode === "AGGRESSIVE") {
      executionQuote = getExecutionQuoteDetailed(
        orderbook,
        parsedSide === Side.BUY ? "BUY" : "SELL",
        parsedAmount,
        normalizedAmountMode,
        parsedPrice
      );
      rememberExecutionQuote(executionQuote);
      parsedPrice =
        executionQuote.limitPrice ||
        (parsedSide === Side.BUY ? bestAsk || parsedPrice : bestBid || parsedPrice);
    } else if (normalizedMode === "PASSIVE") {
      parsedPrice = parsedSide === Side.BUY ? bestBid || parsedPrice : bestAsk || parsedPrice;
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice >= 1) {
      throw new Error("Limit price must be between 0 and 1.");
    }

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
      executionQuote,
      marketSnapshot: {
        bestBid: bestBid || null,
        bestAsk: bestAsk || null,
        spread: bestBid > 0 && bestAsk > 0 ? Number((bestAsk - bestBid).toFixed(4)) : null,
        distanceToMarket: Number(distanceToMarket.toFixed(4)),
        source: orderbook.source,
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
      strategyTag: payload.strategyTag ?? existing?.strategyTag ?? "STANDARD",
      highestPrice: payload.highestPrice ?? existing?.highestPrice,
      trailingStopPrice: payload.trailingStopPrice ?? existing?.trailingStopPrice,
      lastPrice: payload.lastPrice ?? existing?.lastPrice,
      status: payload.status ?? existing?.status ?? "Configured",
      lastExitOrderId: payload.lastExitOrderId ?? existing?.lastExitOrderId ?? null,
      updatedAt: new Date(),
      enteredAt: payload.enteredAt ?? existing?.enteredAt ?? null,
      lastTriggeredAt: payload.lastTriggeredAt ?? existing?.lastTriggeredAt ?? null,
    };

    await collection.updateOne({ assetId: payload.assetId }, { $set: updateDoc }, { upsert: true });
    return updateDoc;
  };

  const recommendAutomationLevels = (averagePrice: number) => {
    // TP/SL scaled to absolute price zone — binaries have non-linear payoff.
    // TP targets are deliberately tight: 5-min binary markets mean-revert fast,
    // so we take realistic gains rather than holding for a large move that rarely lands.
    let tpTarget: number;
    let slTarget: number;
    let trailingDistance: number;

    if (averagePrice < 0.35) {
      tpTarget = Math.min(0.68, averagePrice + 0.18); // was +0.30 — too ambitious
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

  const recommendFastPathAutomationLevels = (averagePrice: number) => {
    let tpTarget: number;
    let slTarget: number;
    let trailingDistance: number;

    if (averagePrice < 0.40) {
      tpTarget = Math.min(0.56, averagePrice + 0.09);
      slTarget = Math.max(0.01, averagePrice - 0.06);
      trailingDistance = 0.03;
    } else if (averagePrice < 0.50) {
      tpTarget = Math.min(0.58, averagePrice + 0.08);
      slTarget = Math.max(0.01, averagePrice - 0.055);
      trailingDistance = 0.03;
    } else if (averagePrice < 0.65) {
      tpTarget = Math.min(0.66, averagePrice + 0.07);
      slTarget = Math.max(0.01, averagePrice - 0.05);
      trailingDistance = 0.025;
    } else {
      tpTarget = Math.min(0.78, averagePrice + 0.06);
      slTarget = Math.max(0.01, averagePrice - 0.045);
      trailingDistance = 0.02;
    }

    return {
      takeProfit: tpTarget.toFixed(2),
      stopLoss: slTarget.toFixed(2),
      trailingStop: trailingDistance.toFixed(3),
    };
  };

  // ── Divergence Fast-Path Trade implementation ─────────────────────────────
  // Wired to onStrongDivergence so the tracker can call it directly without
  // waiting for the next bot cycle (saves the ~2-3s Gemini round-trip).
  onStrongDivergence = (
    direction: "UP" | "DOWN",
    snapshot: { yesAsk: number | null; noAsk: number | null; btcDelta: number }
  ) => {
    const fastAsset = currentDivergenceAsset;
    // Capture the market for this specific asset atomically before any async work
    const _fastMarket = activeBotMarketByAsset.get(fastAsset) ?? null;
    if (divergenceFastTradeRunning || !botEnabled || !_fastMarket) return;
    divergenceFastTradeRunning = true;
    const now = Math.floor(Date.now() / 1000);

    (async () => {
      try {
        const market = _fastMarket;
        const outcomeIndex = direction === "UP" ? 0 : 1;
        const tokenId: string = market.clobTokenIds?.[outcomeIndex];
        if (!tokenId) return;

        const tradeWindowStatus = getTradeWindowStatus(fastAsset, market.id);
        if (tradeWindowStatus) {
          botPrint("SKIP", `[DIV FAST][${fastAsset}] Trade ${tradeWindowStatus === "EXECUTED" ? "already executed" : "already submitting"} for this market in the current window — fast path cancelled`);
          return;
        }

        // Prevent double-analysis overlap with the normal bot cycle (per-asset set)
        const divAssetSet = botAnalyzedThisWindowByAsset.get(fastAsset)!;
        if (divAssetSet.has(market.id)) return;

        // Respect entry window timing (same gates as main cycle)
        const cfg = getActiveConfig();
        const windowElapsed = now - Math.floor(now / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
        if (windowElapsed < cfg.entryWindowStart || windowElapsed > cfg.entryWindowEnd) return;

        // Divergence trades need enough time for the move to develop.
        // Flash moves (< 15s) that cause divergence often mean-revert quickly.
        // Gate: minimum 120s remaining in the window.
        const divRemainingSeconds = MARKET_SESSION_SECONDS - windowElapsed;
        if (divRemainingSeconds < 120) {
          botPrint("SKIP", `[DIV FAST] Too late: only ${divRemainingSeconds}s remaining — divergence entry skipped (min 120s)`);
          return;
        }

        // Fetch fresh order book + implied price for the target token
        const book = await getNormalizedOrderBookSnapshot(tokenId);
        const clobAsk = book.bestAsk ?? 0;
        // Use outcomePrices from the atomically-captured market (not global alias which may have shifted)
        const divOutcomeIndex = direction === "UP" ? 0 : 1;
        const divImpliedPrice = parseFloat(market.outcomePrices?.[divOutcomeIndex] ?? "0");
        const bestAsk = (clobAsk > 0 && clobAsk < 0.97) ? clobAsk : divImpliedPrice > 0 ? divImpliedPrice : clobAsk;
        if (bestAsk <= 0) return;

        // Entry price gate — STRONG divergence gets the 85¢ override (same as main cycle)
        const MAX_ENTRY_PRICE = 0.85;
        if (bestAsk > MAX_ENTRY_PRICE) {
          botPrint("SKIP", `[DIV FAST] Price too high: ${(bestAsk * 100).toFixed(1)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ — window closed`);
          return;
        }

        const confidence = 78;
        const estimatedEdge = parseFloat((confidence / 100 - bestAsk).toFixed(2));
        if (confidence < cfg.minConfidence || estimatedEdge < cfg.minEdge) return;
        const nowWindowStart = Math.floor(now / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
        const fastPriceGuardReason = getBtcPremiumEntryBlockReason(fastAsset, bestAsk, confidence, estimatedEdge);
        if (fastPriceGuardReason) {
          botPrint("SKIP", `[DIV FAST] ${fastPriceGuardReason}`);
          return;
        }
        const fastPriceToBeat = updatePriceToBeatState(
          fastAsset,
          nowWindowStart,
          divergenceStateByAsset.get(fastAsset)?.currentBtcPrice ?? null,
          "divergence-proxy",
          "proxy"
        );

        // Kelly sizing — use last known balance (updated by bot cycle, fresh within ~30s)
        const balance = lastKnownBalance ?? botSessionStartBalance ?? 0;
        if (balance <= 0) return;

        const p = confidence / 100;
        const b = (1 - bestAsk) / bestAsk;
        const kelly = (p * b - (1 - p)) / b;
        if (kelly <= 0) return;

        const MIN_BET = Math.min(0.50, balance * 0.20);
        const betAmount = getFixedEntryBetAmount(balance);

        if (betAmount < MIN_BET) {
          botPrint("SKIP", `[DIV FAST] Bet too small: $${betAmount.toFixed(2)} < $${MIN_BET.toFixed(2)} min`);
          return;
        }

        rememberExecutionQuote(
          getExecutionQuoteDetailed(book, "BUY", betAmount, "SPEND", bestAsk)
        );

        botPrint("TRADE", `⚡ DIVERGENCE FAST PATH ⚡ STRONG BTC ${snapshot.btcDelta >= 0 ? "+" : ""}$${snapshot.btcDelta.toFixed(0)} (30s) → ${direction} | ask=${(bestAsk * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)} USDC | Gemini skipped`);

        // Mark handled before async execute — prevents race with bot cycle
        divAssetSet.add(market.id);
        markTradeExecutionStarted(fastAsset, market.id);
        lastDivergenceFastTradeAt = now;

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
        currentWindowAiCache.set(fastAsset, { windowStart: nowWindowStart, marketId: market.id, rec: fastRec });

        const tradeResult = await executePolymarketTrade({
          tokenID: tokenId,
          amount: betAmount,
          side: Side.BUY,
          price: bestAsk,
          executionMode: "AGGRESSIVE",
          amountMode: "SPEND",
        });
        markTradeExecutionFinished(fastAsset, market.id, true);

        botSessionTradesCount++;
        persistDecisionSnapshotFromSignal({
          asset: fastAsset,
          market,
          windowStart: nowWindowStart,
          windowElapsedSeconds: now - nowWindowStart,
          decision: "TRADE",
          action: "FAST_PATH_EXECUTED",
          direction,
          confidence,
          edge: estimatedEdge,
          riskLevel: "MEDIUM",
          reasoning: fastRec.reasoning,
          filterReasons: [],
          yesPrice: direction === "UP"
            ? bestAsk
            : Number(market.outcomePrices?.[0] ?? NaN) || null,
          noPrice: direction === "DOWN"
            ? bestAsk
            : Number(market.outcomePrices?.[1] ?? NaN) || null,
          estimatedBet: betAmount,
          btcPrice: null,
          priceToBeat: fastPriceToBeat,
          divergenceDirection: direction,
          divergenceStrength: "STRONG",
          btcDelta30s: snapshot.btcDelta,
          yesDelta30s: null,
          tradeExecuted: true,
          tradeAmount: betAmount,
          tradePrice: bestAsk,
          orderId: tradeResult.orderID,
        });
        botPrint("OK", `⚡ FAST PATH EXECUTED ✓ | ID: ${tradeResult.orderID} | Status: ${tradeResult.status}`);
        void sendNotification(
          `⚡ <b>FAST PATH TRADE</b>\nMarket: ${market.question?.slice(0, 60) ?? "BTC 5m"}\nDirection: ${direction === "UP" ? "▲ UP" : "▼ DOWN"}\nAmount: $${betAmount.toFixed(2)} USDC @ ${(bestAsk * 100).toFixed(1)}¢\nConf: ${confidence}% | Edge: ${estimatedEdge}¢\n(Gemini bypassed — STRONG divergence)`
        );

        const levels = recommendFastPathAutomationLevels(bestAsk);
        await savePositionAutomation({
          assetId: tokenId,
          market: market.question || market.id,
          outcome: market.outcomes?.[outcomeIndex] || direction,
          averagePrice: bestAsk.toFixed(4),
          size: tradeResult.orderSize.toFixed(6),
          takeProfit: levels.takeProfit,
          stopLoss: levels.stopLoss,
          trailingStop: levels.trailingStop,
          strategyTag: "FAST_PATH",
          windowEnd: nowWindowStart + MARKET_SESSION_SECONDS,
          armed: true,
          enteredAt: new Date(),
        });
        botPrint("OK", `FAST_PATH exit profile armed — TP ${(parseFloat(levels.takeProfit) * 100).toFixed(0)}¢ | SL ${(parseFloat(levels.stopLoss) * 100).toFixed(0)}¢ | TS ${(parseFloat(levels.trailingStop) * 100).toFixed(1)}¢ | time-stop 40–120s | expiry lock <=30s`);

        pendingResults.set(tokenId, {
          eventSlug: `${ASSET_CONFIG[fastAsset].polySlugPrefix}-${nowWindowStart}`,
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
          asset: fastAsset,
        });
        botPrint("INFO", `Result tracker armed — checking after ${new Date((nowWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);

        // ── Correlated multi-asset entry ──────────────────────────────────────
        // DISABLED: correlated entries amplify risk without independent signal.
        // Re-enable only after proving BTC divergence has sustained >55% win rate.
        const ENABLE_CORRELATED_ENTRY = false;
        // BTC STRONG divergence historically pulls ETH and SOL Polymarket prices
        // in the same direction — they often lag BTC by 1-2 cycles. Enter the same
        // direction at reduced Kelly (70%) since the signal is BTC-derived, not
        // the asset's own independent divergence.
        const correlatedAssets = ENABLED_ASSETS.filter(a => a !== fastAsset);
        if (ENABLE_CORRELATED_ENTRY && correlatedAssets.length > 0) {
          await Promise.allSettled(correlatedAssets.map(async (corrAsset) => {
            try {
              const corrMarket = activeBotMarketByAsset.get(corrAsset);
              if (!corrMarket) return;
              const corrMarketId = corrMarket.id;

              const corrTradeWindowStatus = getTradeWindowStatus(corrAsset, corrMarketId);
              if (corrTradeWindowStatus) {
                botPrint("SKIP", `[CORR-${corrAsset}] Trade ${corrTradeWindowStatus === "EXECUTED" ? "already executed" : "already submitting"} for this market in the current window — correlated entry cancelled`);
                return;
              }

              const corrSet = botAnalyzedThisWindowByAsset.get(corrAsset)!;
              if (corrSet.has(corrMarketId)) {
                botPrint("SKIP", `[CORR-${corrAsset}] Analysis already handled for this market in the current window — correlated entry skipped`);
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

              // Slightly lower confidence than main asset — signal is BTC-derived
              const corrConf = 72;
              const corrEdge = parseFloat((corrConf / 100 - corrBestAsk).toFixed(2));
              if (corrConf < cfg.minConfidence || corrEdge < cfg.minEdge) return;

              const corrP = corrConf / 100;
              const corrB = (1 - corrBestAsk) / corrBestAsk;
              const corrKelly = (corrP * corrB - (1 - corrP)) / corrB;
              if (corrKelly <= 0) return;

              // 70% of normal dynamic Kelly — correlated signal, not independent divergence
              const corrBetAmount = getFixedEntryBetAmount(balance);
              if (corrBetAmount < MIN_BET) {
                botPrint("SKIP", `[CORR-${corrAsset}] Bet too small: $${corrBetAmount.toFixed(2)}`);
                return;
              }

              botPrint("TRADE", `⚡ CORRELATED [${corrAsset}] BTC-driven ${direction} → ask=${(corrBestAsk * 100).toFixed(0)}¢ | $${corrBetAmount.toFixed(2)} USDC | conf=${corrConf}%`);
              corrSet.add(corrMarketId);
              markTradeExecutionStarted(corrAsset, corrMarketId);

              const corrResult = await executePolymarketTrade({
                tokenID: corrTokenId,
                amount: corrBetAmount,
                side: Side.BUY,
                price: corrBestAsk,
                executionMode: "AGGRESSIVE",
                amountMode: "SPEND",
              });
              markTradeExecutionFinished(corrAsset, corrMarketId, true);

              botSessionTradesCount++;
              botPrint("OK", `⚡ CORR [${corrAsset}] EXECUTED ✓ | ID: ${corrResult.orderID} | Status: ${corrResult.status}`);

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
                strategyTag: "CORRELATED",
                windowEnd: nowWindowStart + MARKET_SESSION_SECONDS,
                armed: true,
                enteredAt: new Date(),
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
                reasoning: `[CORRELATED] BTC STRONG divergence +$${snapshot.btcDelta.toFixed(0)} → ${corrAsset} same-direction entry`,
                windowElapsedSeconds: now - nowWindowStart,
                asset: corrAsset,
              });
            } catch (corrErr: any) {
              const corrMarketId = activeBotMarketByAsset.get(corrAsset)?.id;
              if (corrMarketId) markTradeExecutionFinished(corrAsset, corrMarketId, false);
              botPrint("WARN", `[CORR-${corrAsset}] Entry failed: ${corrErr?.message ?? corrErr}`);
            }
          }));
        }

      } catch (err: any) {
        markTradeExecutionFinished(fastAsset, _fastMarket?.id ?? "", false);
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
        // ── Fix 1: time-based expiry instead of position-lookup guard ──────
        // If the market window expired > 6 minutes ago, the position has
        // already resolved on-chain — no point monitoring or trying to exit.
        if (automation.windowEnd && nowSeconds > automation.windowEnd + 360) {
          await savePositionAutomation({
            assetId: automation.assetId,
            armed: false,
            status: "Market window expired — resolved on-chain",
            lastPrice: automation.lastPrice,
          });
          continue;
        }

        try {
          const book = await client.getOrderBook(automation.assetId);

          // ── Fix 2: 3-tier price estimation ─────────────────────────────
          // Tier 1: best bid (real exit price — prefer this always)
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
            // No liquidity at all — keep armed, try next tick
            await savePositionAutomation({
              assetId: automation.assetId,
              status: "No order book liquidity — retrying",
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
          const strategyTag = automation.strategyTag || "STANDARD";
          const isFastPathAutomation = strategyTag === "FAST_PATH";

          // ── Near-expiry forced exit ──────────────────────────────────────────
          // Binary markets collapse fast in the last minute — prices drop 20-30¢
          // in a single tick as market makers pull bids near resolution.
          // If ≤60s remain and the position is profitable, lock in the gain now.
          const secondsToExpiry = automation.windowEnd ? automation.windowEnd - nowSeconds : 9999;
          const isNearExpiry = secondsToExpiry > 0 && secondsToExpiry <= 60;
          const _isCriticalExpiry = secondsToExpiry > 0 && secondsToExpiry <= 30; void _isCriticalExpiry;

          // Determine if a trigger condition is met
          // TP: use bestBid as the real exit price — only trigger when there's actual liquidity.
          //     If no bid, fall back to mid. Either way execute immediately — never "wait for bid".
          // SL/trailing/expiry: use currentPrice (mid) for detection, then execute at best available.
          const tpCheckPrice = bestBid > 0 ? bestBid : currentPrice;
          let triggerReason: string | null = null;
          if (takeProfit > 0 && tpCheckPrice >= takeProfit) triggerReason = "take profit";
          if (!triggerReason && stopLoss > 0 && currentPrice <= stopLoss) triggerReason = "stop loss";
          if (!triggerReason && trailingStopPrice > 0 && currentPrice <= trailingStopPrice) triggerReason = "trailing stop";

          // ── Profit lock: tighten trailing stop when 70%+ of the way to TP ──────
          // Prevents giving back a large gain when price is near-TP then reverses.
          // When unrealized gain >= 70% of (TP - entry), shrink trailing stop to 3¢.
          if (!triggerReason && takeProfit > 0 && entryPrice > 0 && trailingStopDistance > 0.03) {
            const tpDistance = takeProfit - entryPrice;
            const unrealizedGain = currentPrice - entryPrice;
            if (tpDistance > 0 && unrealizedGain >= tpDistance * 0.70) {
              // Override trailing stop distance in MongoDB to 3¢ for this position
              await savePositionAutomation({
                assetId: automation.assetId,
                trailingStop: "0.03",
                status: `Profit lock: ${(unrealizedGain * 100).toFixed(0)}¢ gain — trailing tightened to 3¢`,
              });
              botPrint("INFO", `[TP LOCK] Position at ${(currentPrice * 100).toFixed(0)}¢ — trailing tightened to 3¢ (${(unrealizedGain * 100).toFixed(0)}¢ gain locked)`);
            }
          }

          // ── Spike capture: early large move — take it before it reverses ────────
          // If within first 120s after entry the price has spiked +12¢, exit immediately.
          // Raised from +8¢/90s — early spikes at +8¢ often continue, cutting profit short.
          const entryTimestamp = automation.enteredAt
            ? Math.floor(new Date(automation.enteredAt).getTime() / 1000)
            : automation.lastTriggeredAt
            ? Math.floor(new Date(automation.lastTriggeredAt).getTime() / 1000)
            : 0;
          const secondsSinceEntry = entryTimestamp > 0 ? nowSeconds - entryTimestamp : 9999;
          if (!triggerReason && entryPrice > 0 && secondsSinceEntry <= 120) {
            const spikeGain = currentPrice - entryPrice;
            const spikeThreshold = isFastPathAutomation ? 0.08 : 0.12;
            if (spikeGain >= spikeThreshold) {
              triggerReason = `spike capture (+${(spikeGain * 100).toFixed(0)}¢ in ${secondsSinceEntry}s — taking early gain)`;
            }
          }

          // ── FAST PATH: time-stop if divergence fails to continue ─────────────
          // These trades are meant to capture a short repricing, not sit flat.
          if (!triggerReason && isFastPathAutomation && entryPrice > 0 && secondsSinceEntry >= 40 && secondsSinceEntry <= 120) {
            const gain = currentPrice - entryPrice;
            if (gain <= 0.01) {
              triggerReason = `fast-path time stop (${secondsSinceEntry}s since entry with only ${(gain * 100).toFixed(1)}¢ progress)`;
            }
          }

          // Near-expiry: exit any profitable position (prevents late-window reversal)
          if (!triggerReason && isNearExpiry && entryPrice > 0 && currentPrice > entryPrice * 1.005) {
            triggerReason = `near-expiry exit (${secondsToExpiry}s remaining — locking ${(((currentPrice / entryPrice) - 1) * 100).toFixed(1)}% gain)`;
          }

          // ── FAST PATH: tighter profit lock and expiry salvage ────────────────
          if (!triggerReason && isFastPathAutomation && entryPrice > 0) {
            const bestSeenGain = highestPrice - entryPrice;
            const currentGain = currentPrice - entryPrice;

            if (bestSeenGain >= 0.04 && trailingStopDistance > 0.02) {
              await savePositionAutomation({
                assetId: automation.assetId,
                trailingStop: "0.02",
                status: `FAST_PATH profit lock: peak ${(bestSeenGain * 100).toFixed(0)}¢ — trailing tightened to 2¢`,
              });
              botPrint("INFO", `[FAST EXIT] Peak ${(bestSeenGain * 100).toFixed(0)}¢ seen — trailing tightened to 2¢`);
            }

            if (!triggerReason && secondsToExpiry > 0 && secondsToExpiry <= 30) {
              if (currentGain > 0) {
                triggerReason = `fast-path expiry lock (${secondsToExpiry}s remaining — preserving ${(currentGain * 100).toFixed(1)}¢ gain)`;
              } else if (bestSeenGain >= 0.03 && currentGain >= -0.01) {
                triggerReason = `fast-path expiry salvage (${secondsToExpiry}s remaining after giving back from +${(bestSeenGain * 100).toFixed(0)}¢)`;
              }
            }
          }

          if (triggerReason) {
            void (triggerReason === "take profit"); // isTakeProfit — guard removed; all triggers execute immediately
            // Execution price: best bid preferred. Fallback to ask * 0.97 (3¢ slippage) rather
            // than waiting forever — a slightly worse price is better than no exit at all.
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
              status: `Exit submitted by ${triggerReason} @ ${(executionPrice * 100).toFixed(0)}¢`,
              lastTriggeredAt: new Date(),
            });
            continue;
          }

          // No trigger — update tracking state and keep armed
          const expiryLabel = secondsToExpiry < 9999
            ? ` | Expiry: ${secondsToExpiry}s`
            : "";
          await savePositionAutomation({
            assetId: automation.assetId,
            highestPrice: highestPrice.toFixed(4),
            trailingStopPrice: trailingStopPrice > 0 ? trailingStopPrice.toFixed(4) : "",
            lastPrice: currentPrice.toFixed(4),
            status: `Monitoring — ${(currentPrice * 100).toFixed(0)}¢ | TP: ${(takeProfit * 100).toFixed(0)}¢ | SL: ${(stopLoss * 100).toFixed(0)}¢${expiryLabel}`,
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

  // ── Bot logging helper ────────────────────────────────────────────────────
  const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });
  const botPrint = (level: "INFO" | "WARN" | "TRADE" | "OK" | "SKIP" | "ERR", msg: string) => {
    const icons: Record<string, string> = {
      INFO:  "─",
      WARN:  "⚠",
      TRADE: "💰",
      OK:    "✓",
      SKIP:  "✗",
      ERR:   "✖",
    };
    const entry: RawLogEntry = { ts: ts(), level, msg };
    console.log(`[${entry.ts}] [BOT:${level.padEnd(5)}] ${icons[level]} ${msg}`);
    rawLog.unshift(entry);
    if (rawLog.length > 500) rawLog.pop();
    pushSSE("log", entry);
  };

  // ── Win / Loss result checker ─────────────────────────────────────────────
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

      // ── Step 1: Check OUR specific token's current price via CLOB ─────────
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

          botPrint("INFO", `Result check [CLOB] tokenId=${tokenId.slice(0, 10)}… bid=${bestBid ?? "none"} ask=${bestAsk ?? "none"}`);

          if (bestBid !== null && bestBid >= 0.90) {
            ourTokenPrice = bestBid;          // token worth ~$1 → WIN
            resolvedSource = `CLOB bid=${bestBid.toFixed(3)}`;
          } else if (bestBid !== null && bestBid <= 0.10) {
            ourTokenPrice = bestBid;          // token worth ~$0 → LOSS
            resolvedSource = `CLOB bid=${bestBid.toFixed(3)}`;
          } else if (bestBid === null && bestAsk === null) {
            // No order book at all — market likely settled, check prices-history
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
      } catch { /* CLOB unavailable — fall through to gamma */ }

      // ── Step 2: Fallback — Gamma API using correct outcome index ──────────
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
              botPrint("INFO", `Result check [gamma winner] ${mkt.winner} → ourToken=${ourTokenPrice}`);
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

      // ── Still can't determine — wait or give up ────────────────────────────
      if (ourTokenPrice === null) {
        if (giveUp) {
          botPrint("WARN", `Result UNKNOWN after 20min for "${pending.market.slice(0, 40)}" — removing tracker`);
          pendingResults.delete(tokenId);
        } else {
          const waitedMin = ((now - pending.windowEnd) / 60).toFixed(1);
          botPrint("INFO", `Result pending (${waitedMin}min elapsed) — retrying next cycle`);
        }
        continue;
      }

      // ── Determine WIN / LOSS ───────────────────────────────────────────────
      // PnL: shares × $1 payout minus cost (WIN), or full bet lost (LOSS)
      // won_final = pnl > 0: even $0.01 profit = WIN; no profit = LOSS
      const shares = pending.entryPrice > 0 ? pending.betAmount / pending.entryPrice : 0;
      const grossPayout = ourTokenPrice >= 0.90 ? shares * 1.0 : shares * ourTokenPrice;
      const pnl = parseFloat((grossPayout - pending.betAmount).toFixed(2));
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const won_final = pnl > 0;

      botPrint("INFO", `Result resolved via [${resolvedSource}] → ${won_final ? "WIN" : "LOSS"} (ourTokenPrice=${ourTokenPrice.toFixed(3)}, pnl=${pnlStr})`);

      if (won_final) {
        // ── WIN: relax adaptive threshold (per-asset) ──────────────────────
        const pendingAsset = pending.asset ?? "BTC";
        const cWins  = (consecutiveWinsByAsset.get(pendingAsset)  ?? 0) + 1;
        const cBoost =  adaptiveConfidenceByAsset.get(pendingAsset) ?? 0;
        consecutiveWinsByAsset.set(pendingAsset, cWins);
        consecutiveLossesByAsset.set(pendingAsset, 0);
        if (cWins >= 2 && cBoost > 0) {
          const newBoost = Math.max(cBoost - 3, 0);
          adaptiveConfidenceByAsset.set(pendingAsset, newBoost);
          botPrint("OK", `[${pendingAsset}] Adaptive: streak=${cWins}W — threshold relaxed to ${BOT_MIN_CONFIDENCE + newBoost}% (boost=${newBoost > 0 ? `+${newBoost}%` : "none"})`);
        }
        botPrint("OK", `━━━ 🏆 WIN  ━━━ ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
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
        // ── LOSS: record memory, tighten adaptive threshold (per-asset) ────
        const pendingAsset = pending.asset ?? "BTC";
        const cLosses = (consecutiveLossesByAsset.get(pendingAsset) ?? 0) + 1;
        consecutiveLossesByAsset.set(pendingAsset, cLosses);
        consecutiveWinsByAsset.set(pendingAsset, 0);
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
          botPrint("WARN", `[${pendingAsset}] Adaptive: streak=${cLosses}L — threshold raised to ${BOT_MIN_CONFIDENCE + newBoost}% (+${newBoost}% boost)`);
        } else if (!adaptiveLossPenaltyEnabled && cLosses >= 2) {
          botPrint("INFO", `[${pendingAsset}] Adaptive loss penalty disabled — streak=${cLosses}L recorded, threshold unchanged`);
        }
        botPrint("WARN", `━━━ ✗ LOSS ━━━ ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
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
        reasoning: `Market resolved ${won_final ? "IN YOUR FAVOR ✓" : "AGAINST YOU ✗"} | Direction: ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}${!won_final ? ` | Lesson: ${generateLesson(pending)}` : ""}`,
        tradeExecuted: false,
        tradeAmount: pending.betAmount,
        tradePrice: pending.entryPrice,
        orderId: pending.orderId,
      });
      if (botLog.length > 100) botLog.pop();

      pendingResults.delete(tokenId);
    }
  };

  // ── Bot cycle ──────────────────────────────────────────────────────────────
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
        for (const s of botExecutingTradesThisWindowByAsset.values()) s.clear();
        for (const s of botExecutedTradesThisWindowByAsset.values()) s.clear();
        currentWindowAiCache.clear();
        currentExecutionQuote = null;
        currentEntrySnapshot = null;
        botLastWindowStart = currentWindowStart;
        // Clear all per-asset YES ring buffers — old window's tokens are no longer valid
        for (const buf of yesRingBufferByAsset.values()) buf.length = 0;
        currentWindowYesTokenId = null;
        currentWindowNoTokenId  = null;
        currentWindowYesTokenIdByAsset.clear();
        currentWindowNoTokenIdByAsset.clear();
        void resetPolymarketStream();
        botPrint("INFO", `━━━━ NEW WINDOW ━━━━ ${new Date(currentWindowStart * 1000).toLocaleTimeString()} — ${new Date((currentWindowStart + 300) * 1000).toLocaleTimeString()}`);
        await Promise.all(ENABLED_ASSETS.map(async (asset) => {
          try {
            const priceData = await getAssetPrice(asset, true);
            const numericPrice = priceData?.price ? Number(priceData.price) : null;
            const snapshot = updatePriceToBeatState(asset, currentWindowStart, numericPrice, priceData?.source || null, "proxy");
            if (snapshot && asset === "BTC") {
              botPrint(
                "INFO",
                `[${asset}] Price to beat anchored @ $${snapshot.openingPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${snapshot.mode}:${snapshot.source})`
              );
            }
          } catch (error: any) {
            botPrint("WARN", `[${asset}] Failed to anchor price to beat: ${error?.message || "unknown error"}`);
          }
        }));
      }

      // Only trade in the valid entry zone
      const cfg = getActiveConfig();
      if (windowElapsedSeconds < cfg.entryWindowStart || windowElapsedSeconds > cfg.entryWindowEnd) {
        if (windowElapsedSeconds > cfg.entryWindowEnd) {
          botPrint("SKIP", `Window closing (${mm}:${ss} left) — waiting for next window`);
        } else {
          botPrint("SKIP", `Window too early (${windowElapsedSeconds}s) — ${mm}:${ss} remaining. Waiting.`);
        }
        return;
      }

      // ── Fetch all asset markets in parallel, then process sequentially ──────
      const marketsByAsset = new Map<TradingAsset, any[]>();
      await Promise.allSettled(ENABLED_ASSETS.map(async (asset) => {
        const slug = `${ASSET_CONFIG[asset].polySlugPrefix}-${currentWindowStart}`;
        botPrint("INFO", `[${asset}] Scanning window ${mm}:${ss} remaining | elapsed=${windowElapsedSeconds}s | slug=${slug}`);
        try {
          const discovery = await fetchMarketDiscoverySnapshot(asset, currentWindowStart);
          const markets = discovery.currentMarkets;
          if (markets.length === 0) {
            botPrint("WARN", `[${asset}] No markets found for slug: ${slug}`);
          } else {
            botPrint("INFO", `[${asset}] Found ${markets.length} market(s) for window | next=${discovery.nextMarkets.length} | prewarm=${discovery.prewarmedTokenIds.length}/${discovery.trackedTokenIds.length}`);
            marketsByAsset.set(asset, markets);
          }
        } catch (error: any) {
          botPrint("ERR", `[${asset}] Failed to fetch market for slug: ${slug} (${error?.message || "unknown error"})`);
        }
      }));

      // ── Process each asset sequentially (analysis is stateful per-asset) ──
      for (const currentAsset of ENABLED_ASSETS) {
        const analyzedThisWindow = botAnalyzedThisWindowByAsset.get(currentAsset)!;
        const markets = marketsByAsset.get(currentAsset);
        if (!markets) continue;

      for (const market of markets) {
        // Expose to divergence fast path so it can execute without waiting for this cycle
        activeBotMarketByAsset.set(currentAsset, market);
        activeBotMarket = market; // sync alias for divergence tracker
        currentDivergenceAsset = currentAsset; // tracker uses this asset's thresholds + token IDs
        // Sync YES/NO token IDs to divergence tracker for this asset
        currentWindowYesTokenId = currentWindowYesTokenIdByAsset.get(currentAsset) ?? null;
        currentWindowNoTokenId  = currentWindowNoTokenIdByAsset.get(currentAsset) ?? null;

        const tradeWindowStatus = getTradeWindowStatus(currentAsset, market.id);
        if (tradeWindowStatus) {
          botPrint(
            "SKIP",
            `[${currentAsset}] Trade ${tradeWindowStatus === "EXECUTED" ? "already executed" : "execution already in progress"} for this market in the current window — skipping re-analysis`
          );
          continue;
        }

        if (analyzedThisWindow.has(market.id)) {
          botPrint("SKIP", `[${currentAsset}] Analysis already completed for this market in the current window — waiting for a re-check trigger`);
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
          let priceToBeat: PriceToBeatSnapshot | null = getPriceToBeatSnapshot(currentAsset, currentWindowStart);

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

            const liveAssetPrice = btcPriceData?.price ? Number(btcPriceData.price) : null;
            priceToBeat = updatePriceToBeatState(
              currentAsset,
              currentWindowStart,
              liveAssetPrice,
              btcPriceData?.source || null,
              "proxy"
            );
            if (currentAsset === "BTC" && priceToBeat) {
              const beatSign = priceToBeat.distanceUsd >= 0 ? "+" : "";
              botPrint(
                "INFO",
                `Price to beat: open=$${priceToBeat.openingPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} | now=$${priceToBeat.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} | delta=${beatSign}$${priceToBeat.distanceUsd.toFixed(2)} | favored=${priceToBeat.favoredOutcome}${priceToBeat.distanceUsd === 0 ? " (tie goes UP)" : ""} | ${priceToBeat.mode}:${priceToBeat.source}`
              );
            }

            // ── Strike price vs current price analysis ──────────────────────
            // Parse strike from question e.g. "Will BTC be above $95,500 at 12:05?"
            const _strikeMatch = (market.question ?? "").match(/\$([0-9,]+(?:\.[0-9]+)?)/);
            const _strikePx = _strikeMatch ? parseFloat(_strikeMatch[1].replace(/,/g, "")) : null;
            const _currentPx = btcPriceData?.price ? parseFloat(btcPriceData.price) : null;
            if (_strikePx && _currentPx) {
              const _gapDollar = _strikePx - _currentPx;
              const _gapPct    = (_gapDollar / _currentPx) * 100;
              const _proximity = Math.abs(_gapPct) < 0.05 ? "AT STRIKE" : Math.abs(_gapPct) < 0.15 ? "NEAR" : Math.abs(_gapPct) < 0.40 ? "FAR" : "VERY FAR";
              botPrint("INFO", `Strike analysis: current=$${_currentPx.toLocaleString("en-US", { maximumFractionDigits: 0 })} | strike=$${_strikePx.toLocaleString("en-US")} | gap=${_gapDollar >= 0 ? "+" : ""}$${_gapDollar.toFixed(0)} (${_gapPct >= 0 ? "+" : ""}${_gapPct.toFixed(3)}%) | ${_proximity}`);
            }

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
                const book = await getNormalizedOrderBookSnapshot(tid);
                orderBooks[tid] = book;
                const outcome = market.outcomes?.[idx] ?? `Token${idx}`;
                botPrint("OK", `OrderBook [${outcome}]: bid=${book.bestBid ?? "?"} ask=${book.bestAsk ?? "?"} imbalance=${(book.imbalance * 100).toFixed(0)}% (${book.imbalanceSignal}) liquidity=$${book.totalLiquidityUsdc} [${book.source}]`);
              } catch (error: any) {
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
                botPrint("OK", `Market history: ${marketHistory.length} points | Latest YES: ${latestYes !== undefined ? (latestYes * 100).toFixed(1) + "¢" : "?"}`);
              } catch {
                botPrint("WARN", "Market price history unavailable — velocity signal disabled");
              }
            }
          }

          // Merge adaptive boost into effective threshold
          const assetBoost = adaptiveConfidenceByAsset.get(currentAsset) ?? 0;
          const effectiveMinConf = cfg.minConfidence + assetBoost;
          if (assetBoost > 0) {
            botPrint("INFO", `Threshold: ${effectiveMinConf}% (+${assetBoost}% [${currentAsset}] loss streak)`);
          }

          // ── Fast Loop Momentum (Simmer-style CEX signal) ──────────────
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

          // ── Read divergence state for this asset (fresh within 30s) ──────
          const divNow = Math.floor(Date.now() / 1000);
          const assetDivState = divergenceStateByAsset.get(currentAsset) ?? null;
          const div = (assetDivState && divNow - assetDivState.updatedAt < 30)
            ? assetDivState : null;

          if (div && div.strength !== "NONE") {
            botPrint("INFO",
              `Divergence: BTC ${div.btcDelta30s >= 0 ? "+" : ""}$${div.btcDelta30s.toFixed(0)} (30s) | YES ${div.yesDelta30s >= 0 ? "+" : ""}${div.yesDelta30s.toFixed(2)}¢ | direction=${div.direction} strength=${div.strength} score=${div.divergence.toFixed(2)}`
            );
          }

          const decisionTokenIds: string[] = market.clobTokenIds || [];
          const yesDecisionPriceRaw = orderBooks[decisionTokenIds[0]]?.asks?.[0]?.price ?? market.outcomePrices?.[0] ?? null;
          const noDecisionPriceRaw = orderBooks[decisionTokenIds[1]]?.asks?.[0]?.price ?? market.outcomePrices?.[1] ?? null;
          const yesDecisionPrice = yesDecisionPriceRaw !== null ? Number(yesDecisionPriceRaw) : null;
          const noDecisionPrice = noDecisionPriceRaw !== null ? Number(noDecisionPriceRaw) : null;
          const yesImbalanceSignal = decisionTokenIds[0] ? orderBooks[decisionTokenIds[0]]?.imbalanceSignal ?? null : null;
          const captureDecisionSnapshot = (payload: {
            decision: "TRADE" | "NO_TRADE";
            action: DecisionAction;
            direction: "UP" | "DOWN" | "NONE";
            confidence: number;
            edge: number;
            riskLevel: string;
            reasoning: string;
            filterReasons?: string[];
            tradeExecuted?: boolean;
            tradeAmount?: number | null;
            tradePrice?: number | null;
            orderId?: string | null;
          }) => persistDecisionSnapshotFromSignal({
            asset: currentAsset,
            market,
            windowStart: currentWindowStart,
            windowElapsedSeconds,
            decision: payload.decision,
            action: payload.action,
            direction: payload.direction,
            confidence: payload.confidence,
            edge: payload.edge,
            riskLevel: payload.riskLevel,
            reasoning: payload.reasoning,
            filterReasons: payload.filterReasons,
            yesPrice: yesDecisionPrice,
            noPrice: noDecisionPrice,
            estimatedBet: payload.decision === "TRADE" ? getActiveConfig().fixedTradeUsdc : null,
            btcPrice: btcPriceData?.price ? Number(btcPriceData.price) : null,
            priceToBeat,
            rsi: btcIndicatorsData?.rsi,
            emaCross: btcIndicatorsData?.emaCross,
            signalScore: btcIndicatorsData?.signalScore,
            imbalanceSignal: yesImbalanceSignal,
            divergenceDirection: div?.direction ?? null,
            divergenceStrength: div?.strength ?? null,
            btcDelta30s: div?.btcDelta30s ?? null,
            yesDelta30s: div?.yesDelta30s ?? null,
            fastLoopDirection: fastMom?.direction ?? null,
            fastLoopStrength: fastMom?.strength ?? null,
            fastLoopVw: fastMom?.volumeWeighted ?? null,
            tradeExecuted: payload.tradeExecuted,
            tradeAmount: payload.tradeAmount,
            tradePrice: payload.tradePrice,
            orderId: payload.orderId,
          });

          // ── Early window coin-flip guard ──────────────────────────────────
          // Block trade in first 60s if there's no divergence and BTC is flat.
          // At this point FastLoop hasn't built 5 fresh candles and any cached AI
          // rec is from the previous window — no real edge exists.
          if (windowElapsedSeconds < 60) {
            const btcFlat = !div || (div.strength === "NONE" && Math.abs(div.btcDelta30s) < 5);
            const noDivergence = !div || div.strength === "NONE";
            if (noDivergence && btcFlat) {
              botPrint("SKIP", `Early window coin-flip guard: elapsed=${windowElapsedSeconds}s, no divergence, BTC flat — waiting for signal | re-check enabled`);
              captureDecisionSnapshot({
                decision: "NO_TRADE",
                action: "NO_TRADE",
                direction: "NONE",
                confidence: 0,
                edge: 0,
                riskLevel: "HIGH",
                reasoning: "Early window coin-flip guard",
                filterReasons: ["No divergence and BTC flat in the first 60s"],
              });
              analyzedThisWindow.delete(market.id); // allow re-check once past 60s or when signal appears
              continue;
            }
          }

          // ── FastLoop pre-filter: skip AI when no momentum and no divergence ──
          const fastMomWeak = !fastMom || fastMom.direction === "NEUTRAL" || fastMom.strength === "WEAK";
          if (fastMomWeak && (!div || div.strength === "NONE")) {
            botPrint("SKIP", `FastLoop pre-filter: ${fastMom ? `${fastMom.direction} ${fastMom.strength}` : "no data"} (min=MODERATE) + no divergence — skipping AI | re-check enabled`);
            captureDecisionSnapshot({
              decision: "NO_TRADE",
              action: "NO_TRADE",
              direction: "NONE",
              confidence: 0,
              edge: 0,
              riskLevel: "HIGH",
              reasoning: "FastLoop pre-filter blocked trade evaluation",
              filterReasons: [`${fastMom ? `${fastMom.direction} ${fastMom.strength}` : "no data"} with no divergence`],
            });
            analyzedThisWindow.delete(market.id); // allow re-check when momentum/divergence appears later in the same window
            continue;
          }

          // ── FAST PATH: bypass Gemini when signals are overwhelmingly clear ────
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
          const noLossConflict = assetLossMemory.slice(0, 3).every(
            (l) => !(l.direction === fastPathDir && Math.abs((l.signalScore ?? 0)) >= 2)
          );
          const fastPathEligible = (
            fastPathDir !== null &&
            alignmentScore >= 4 &&
            divAgrees &&
            noLossConflict &&
            !(currentWindowAiCache.get(currentAsset)?.windowStart === currentWindowStart)
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
              reversalReasoning: "Fast path — strong multi-signal consensus",
            };
            botPrint("TRADE", `⚡ FAST PATH ⚡ ${alignmentScore}/5 aligned ${fastPathDir} | FastLoop STRONG | conf=${fastConf}% | edge=${fastEdge}¢ | Gemini skipped`);
            currentWindowAiCache.set(currentAsset, { windowStart: currentWindowStart, marketId: market.id, rec });

          // ── NORMAL PATH: price-lag signal synthesizer (Gemini removed) ───────
          } else if (currentWindowAiCache.get(currentAsset)?.windowStart === currentWindowStart && currentWindowAiCache.get(currentAsset)?.marketId === market.id) {
            rec = currentWindowAiCache.get(currentAsset)!.rec;
            botPrint("OK", `Reusing signal (price re-check): ${rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—"} ${rec.decision} ${rec.direction !== "NONE" ? rec.direction : ""} | conf=${rec.confidence}%`);
          } else {
            // Synthesize rec from FastLoop + divergence + alignment — no external AI call.
            const synthDir: "UP" | "DOWN" | "NONE" =
              fastMom && fastMom.direction !== "NEUTRAL" ? fastMom.direction
              : div && div.strength !== "NONE" && div.direction !== "NEUTRAL" ? div.direction as "UP" | "DOWN"
              : "NONE";

            if (synthDir === "NONE") {
              rec = {
                decision: "NO_TRADE", direction: "NONE", confidence: 0, estimatedEdge: 0,
                riskLevel: "HIGH", reasoning: "No directional signal from FastLoop or divergence",
                candlePatterns: [], dataMode: "FULL_DATA",
                reversalProbability: 50, oppositePressureProbability: 50,
                reversalReasoning: "No signal",
              };
            } else {
              const alignScore = synthDir === "UP" ? localAlignment.bullish : localAlignment.bearish;
              const divBoost   = div && div.strength === "STRONG" ? 10 : div && div.strength === "MODERATE" ? 5 : 0;
              const momBoost   = fastMom?.strength === "STRONG" ? 8 : fastMom?.strength === "MODERATE" ? 4 : 0;
              const techBoost  = btcIndicatorsData?.signalScore != null ? Math.min(6, Math.abs(btcIndicatorsData.signalScore) * 2) : 0;
              const lossStreak = assetLossMemory.filter(l => l.direction === synthDir).length;
              const streakPenalty = lossStreak >= 2 ? lossStreak * 3 : 0;

              let synthConf = 55 + alignScore * 4 + divBoost + momBoost + techBoost - streakPenalty;
              synthConf = Math.max(55, Math.min(88, Math.round(synthConf)));

              const riskLevel: "LOW" | "MEDIUM" | "HIGH" =
                synthConf >= 75 && alignScore >= 3 ? "LOW"
                : synthConf >= 65 ? "MEDIUM"
                : "HIGH";

              const entryRef  = synthDir === "UP"
                ? (parseFloat(market.outcomePrices?.[0] ?? "0.5"))
                : (parseFloat(market.outcomePrices?.[1] ?? "0.5"));
              const synthEdge = parseFloat(((synthConf / 100) - entryRef).toFixed(4));

              rec = {
                decision: synthEdge > 0 ? "TRADE" : "NO_TRADE",
                direction: synthDir,
                confidence: synthConf,
                estimatedEdge: synthEdge,
                riskLevel,
                reasoning: `[SYNTH] ${synthDir} | align=${alignScore}/5 | FastLoop=${fastMom?.strength ?? "N/A"} vw=${fastMom?.volumeWeighted?.toFixed(3) ?? "0"}% | div=${div?.strength ?? "NONE"} | tech=${btcIndicatorsData?.signalScore ?? 0} | streak-${synthDir}=${lossStreak}L`,
                candlePatterns: [],
                dataMode: "FULL_DATA" as const,
                reversalProbability: Math.max(15, 50 - alignScore * 7),
                oppositePressureProbability: 30,
                reversalReasoning: "Synthesized from local signals",
              };
              botPrint("INFO", `[SYNTH] ${synthDir} conf=${synthConf}% edge=${synthEdge}¢ align=${alignScore}/5 div=${div?.strength ?? "NONE"} mom=${fastMom?.strength ?? "N/A"}`);
            }
            currentWindowAiCache.set(currentAsset, { windowStart: currentWindowStart, marketId: market.id, rec });
          }

          // ── Apply divergence overrides AFTER AI decision ────────────────
          if (div && div.strength !== "NONE" && div.direction !== "NEUTRAL") {
            if (div.strength === "STRONG" && rec.decision !== "TRADE") {
              // Force trade only if enough time remains — flash moves revert quickly
              if (windowRemaining < 120) {
                botPrint("SKIP",
                  `DIVERGENCE OVERRIDE skipped — only ${windowRemaining}s remaining (min 120s). Flash move likely to revert.`
                );
              } else {
              // Force trade in divergence direction — market is clearly lagging BTC
              botPrint("TRADE",
                `DIVERGENCE OVERRIDE ✦ BTC +$${Math.abs(div.btcDelta30s).toFixed(0)} in 30s, YES only ${div.yesDelta30s.toFixed(2)}¢ — forcing ${div.direction} trade`
              );
              rec = { ...rec, decision: "TRADE", direction: div.direction, confidence: Math.max(rec.confidence, 72), riskLevel: "MEDIUM" };
              }
            } else if (div.strength === "MODERATE" && rec.decision === "TRADE" && rec.direction === div.direction) {
              // Same direction — boost confidence
              const boosted = Math.min(rec.confidence + 10, 95);
              botPrint("OK", `Divergence CONFIRMS AI direction (${div.direction}) — confidence boosted ${rec.confidence}% → ${boosted}%`);
              rec = { ...rec, confidence: boosted };
            } else if (div.strength === "STRONG" && rec.decision === "TRADE" && rec.direction !== div.direction) {
              // STRONG conflict — structural divergence wins, block the AI trade
              botPrint("WARN",
                `DIVERGENCE CONFLICT ✦ AI says ${rec.direction} but BTC divergence says ${div.direction} (STRONG) — trade blocked`
              );
              rec = { ...rec, decision: "NO_TRADE", reasoning: rec.reasoning + ` | BLOCKED: strong divergence conflict (BTC ${div.direction} vs AI ${rec.direction})` };
            } else if (div.strength === "MODERATE" && rec.decision === "TRADE" && rec.direction !== div.direction) {
              // MODERATE conflict — penalise confidence but don't block; data windows differ
              const penalised = Math.max(rec.confidence - 15, 50);
              botPrint("WARN",
                `DIVERGENCE FRICTION ✦ AI says ${rec.direction} but divergence says ${div.direction} (MODERATE) — confidence penalised ${rec.confidence}% → ${penalised}%`
              );
              rec = { ...rec, confidence: penalised, reasoning: rec.reasoning + ` | Confidence penalised: moderate divergence friction (BTC ${div.direction})` };
            }
          }

          // Log AI result
          const decisionIcon = rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—";
          botPrint(
            rec.decision === "TRADE" ? "INFO" : "SKIP",
            `AI Result: ${decisionIcon} ${rec.decision} ${rec.direction} | conf=${rec.confidence}% | edge=${rec.estimatedEdge}¢ | risk=${rec.riskLevel}`
          );
          botPrint("INFO", `Reasoning: ${rec.reasoning.slice(0, 120)}`);

          const decisionEntryPrice =
            rec.direction === "UP"
              ? yesDecisionPrice
              : rec.direction === "DOWN"
                ? noDecisionPrice
                : null;
          const requiredMinConfidence = getRequiredMinConfidence({
            baseMinConfidence: effectiveMinConf,
            minEdge: cfg.minEdge,
            direction: rec.direction,
            divergenceDirection: div?.direction ?? null,
            divergenceStrength: div?.strength ?? null,
            entryPrice: decisionEntryPrice,
            estimatedEdge: rec.estimatedEdge,
          });

          const alphaModel = buildAlphaModelSnapshot({
            asset: currentAsset,
            direction: rec.direction,
            confidence: rec.confidence,
            edge: rec.estimatedEdge,
            entryPrice: decisionEntryPrice,
            riskLevel: rec.riskLevel,
            imbalanceSignal: yesImbalanceSignal,
            signalScore: btcIndicatorsData?.signalScore,
            rsi: btcIndicatorsData?.rsi,
            emaCross: btcIndicatorsData?.emaCross,
            divergenceDirection: div?.direction ?? null,
            divergenceStrength: div?.strength ?? null,
            fastLoopDirection: fastMom?.direction ?? null,
            fastLoopStrength: fastMom?.strength ?? null,
            fastLoopVw: fastMom?.volumeWeighted ?? null,
            windowElapsedSeconds,
          });

          // ── Update entry snapshot for dashboard widget ──────────────────
          {
            const outcomeIdx = rec.direction === "DOWN" ? 1 : 0;
            const oppIdx     = outcomeIdx === 0 ? 1 : 0;
            const tokenIds: string[] = market.clobTokenIds || [];
            const yesAsk = orderBooks[tokenIds[0]]?.asks?.[0]?.price ?? market.outcomePrices?.[0] ?? null;
            const noAsk  = orderBooks[tokenIds[1]]?.asks?.[0]?.price ?? market.outcomePrices?.[1] ?? null;
            const entryAsk = orderBooks[tokenIds[outcomeIdx]]?.asks?.[0]?.price ?? market.outcomePrices?.[outcomeIdx] ?? null;
            const entryTokenId = tokenIds[outcomeIdx] || null;
            currentEntrySnapshot = {
              market: market.question || market.id,
              windowStart: currentWindowStart,
              yesPrice: yesAsk !== null ? parseFloat(yesAsk) : null,
              noPrice:  noAsk  !== null ? parseFloat(noAsk)  : null,
              direction: rec.decision === "TRADE" ? rec.direction : null,
              confidence: rec.confidence,
              edge: rec.estimatedEdge,
              riskLevel: rec.riskLevel,
              estimatedBet: rec.decision === "TRADE" ? getActiveConfig().fixedTradeUsdc : null,
              btcPrice: btcPriceData?.price ?? null,
              priceToBeat,
              asset: currentAsset,
              divergence: div && div.strength !== "NONE"
                ? { direction: div.direction, strength: div.strength, btcDelta30s: div.btcDelta30s, yesDelta30s: div.yesDelta30s }
                : null,
              fastLoopMomentum: fastMom ? { direction: fastMom.direction, strength: fastMom.strength, vw: fastMom.volumeWeighted } : null,
              alphaModel,
              updatedAt: new Date().toISOString(),
            };
            if (entryTokenId && orderBooks[entryTokenId] && entryAsk !== null) {
              rememberExecutionQuote(
                getExecutionQuoteDetailed(
                  orderBooks[entryTokenId],
                  "BUY",
                  getActiveConfig().fixedTradeUsdc,
                  "SPEND",
                  Number(entryAsk)
                )
              );
            } else if (rec.decision !== "TRADE") {
              rememberExecutionQuote(null);
            }
            void oppIdx;
          }

          if (
            currentAsset === "BTC" &&
            rec.decision === "TRADE" &&
            rec.confidence >= 75 &&
            rec.confidence <= 79 &&
            alphaModel &&
            !alphaModel.shouldTrade
          ) {
            const alphaReason = alphaModel.reasons[0] || `Alpha overlay rejected probability ${(alphaModel.probability ?? 0) * 100}%`;
            botPrint("SKIP", `Alpha overlay veto: ${alphaReason} | 75–79% BTC setup blocked`);
            captureDecisionSnapshot({
              decision: "TRADE",
              action: "FILTERED",
              direction: rec.direction,
              confidence: rec.confidence,
              edge: rec.estimatedEdge,
              riskLevel: rec.riskLevel,
              reasoning: rec.reasoning,
              filterReasons: [`Alpha overlay veto: ${alphaReason}`],
            });
            analyzedThisWindow.delete(market.id);
            continue;
          }

          const qualifies =
            rec.decision === "TRADE" &&
            rec.confidence >= requiredMinConfidence &&
            rec.estimatedEdge >= cfg.minEdge &&
            rec.riskLevel !== "HIGH";

          if (rec.decision === "TRADE" && !qualifies) {
            const reasons: string[] = [];
            if (rec.confidence < requiredMinConfidence) reasons.push(`conf ${rec.confidence}% < ${requiredMinConfidence}% (effective gate)`);
            if (rec.estimatedEdge < cfg.minEdge) reasons.push(`edge ${rec.estimatedEdge}¢ < ${cfg.minEdge}¢`);
            if (rec.riskLevel === "HIGH") reasons.push(`risk=${rec.riskLevel} (need LOW or MEDIUM)`);
            botPrint("SKIP", `Trade rejected by bot filters: ${reasons.join(" | ")} | re-check enabled`);
            captureDecisionSnapshot({
              decision: "TRADE",
              action: "FILTERED",
              direction: rec.direction,
              confidence: rec.confidence,
              edge: rec.estimatedEdge,
              riskLevel: rec.riskLevel,
              reasoning: rec.reasoning,
              filterReasons: reasons,
            });
            analyzedThisWindow.delete(market.id); // re-check if divergence or cached conditions improve later this window
          }

          // ── Order book pressure alignment filter ──────────────────────────────
          // Data from live trades shows:
          //   BUY_PRESSURE  → 67% WR (+$8.84)   ← trade with (UP) or allow (DOWN)
          //   NEUTRAL       → 40% WR (-$1.55)   ← trade with (marginal edge)
          //   SELL_PRESSURE → 20% WR (-$7.64)   ← BLOCK on UP trades only
          // Rule: block when order book pressure opposes trade direction.
          //   UP   trade → block if YES book shows SELL_PRESSURE (crowd selling YES against us)
          //   DOWN trade → block if YES book shows BUY_PRESSURE (crowd buying YES against us)
          //   UNKNOWN → block (no data = blind entry, hist WR ~17%)
          if (qualifies) {
            const tokenIds: string[] = market.clobTokenIds || [];
            const yesSignal = orderBooks[tokenIds[0]]?.imbalanceSignal ?? "UNKNOWN";
            const pressureOpposesDirection =
              (rec.direction === "UP" && (yesSignal === "SELL_PRESSURE" || yesSignal === "UNKNOWN")) ||
              (rec.direction === "DOWN" && (yesSignal === "BUY_PRESSURE" || yesSignal === "UNKNOWN"));

            if (pressureOpposesDirection) {
              botPrint("SKIP", `Pressure filter: direction=${rec.direction} | YES book=${yesSignal} — blocked (SELL_PRESSURE/UNKNOWN) | re-check next cycle`);
              captureDecisionSnapshot({
                decision: "TRADE",
                action: "FILTERED",
                direction: rec.direction,
                confidence: rec.confidence,
                edge: rec.estimatedEdge,
                riskLevel: rec.riskLevel,
                reasoning: rec.reasoning,
                filterReasons: [`Pressure filter blocked by YES book ${yesSignal}`],
              });
              analyzedThisWindow.delete(market.id); // re-check each cycle in case pressure shifts
              pushSSE("cycle", { ts: new Date().toISOString() });
              continue;
            }
            botPrint("INFO", `Pressure check: direction=${rec.direction} | YES book=${yesSignal} ✓`);
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
            botPrint("TRADE", `SIGNAL QUALIFIED ✓ — preparing to execute ${rec.direction} trade`);
            const client = await getClobClient();
            if (!client) {
              logEntry.error = "CLOB client not ready — trade skipped.";
              botPrint("ERR", "CLOB client not initialized. Check POLYGON_PRIVATE_KEY.");
              captureDecisionSnapshot({
                decision: "TRADE",
                action: "FILTERED",
                direction: rec.direction,
                confidence: rec.confidence,
                edge: rec.estimatedEdge,
                riskLevel: rec.riskLevel,
                reasoning: rec.reasoning,
                filterReasons: ["CLOB client not ready"],
              });
            } else {
              // Initialise session balance on first qualifying trade
              if (botSessionStartBalance === null) {
                try {
                  const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                  botSessionStartBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
                  botPrint("OK", `Session initialized. Starting balance: $${botSessionStartBalance.toFixed(2)} USDC`);
                } catch { /* non-fatal */ }
              }

              // ── Live balance check ─────────────────────────────────────────
              let currentBalance = botSessionStartBalance ?? 0;
              let balanceFresh = false;
              try {
                const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                currentBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
                lastKnownBalance = currentBalance; // keep fast path in sync
                balanceFresh = true;
              } catch {
                botPrint("WARN", `Balance fetch failed — using last known: $${currentBalance.toFixed(2)} USDC`);
              }

              botPrint("INFO", `Balance: $${currentBalance.toFixed(2)} USDC${balanceFresh ? " (live)" : " (cached)"} | Session start: $${botSessionStartBalance?.toFixed(2) ?? "?"}`);

              // Hard stop if wallet is empty
              if (currentBalance < 1) {
                botPrint("WARN", `Insufficient balance ($${currentBalance.toFixed(2)} USDC < $1 minimum). Skipping all trades this cycle.`);
                logEntry.reasoning += ` | Skipped: Insufficient balance ($${currentBalance.toFixed(2)}).`;
                captureDecisionSnapshot({
                  decision: "TRADE",
                  action: "FILTERED",
                  direction: rec.direction,
                  confidence: rec.confidence,
                  edge: rec.estimatedEdge,
                  riskLevel: rec.riskLevel,
                  reasoning: rec.reasoning,
                  filterReasons: [`Insufficient balance $${currentBalance.toFixed(2)}`],
                });
                botLog.unshift(logEntry);
                if (botLog.length > 100) botLog.pop();
                break;
              }

              // ── Kelly sizing with balance-aware adjustment ──────────────────
              const outcomeIndex = rec.direction === "UP" ? 0 : 1;
              const tokenId: string = market.clobTokenIds?.[outcomeIndex];
              if (tokenId) {
                const ob = orderBooks[tokenId];
                const clobAsk = Number(ob?.asks?.[0]?.price || "0");
                const bestBid = Number(ob?.bids?.[0]?.price || "0");

                // ── Use outcomePrices (AMM implied price) as primary fill reference ──
                // CLOB asks are almost always 99¢ in these 5m markets because nobody
                // places limit orders at fair value — execution happens via the AMM.
                // outcomePrices[outcomeIndex] reflects the real fill cost.
                const impliedPrice = parseFloat(market.outcomePrices?.[outcomeIndex] ?? "0");
                // Use CLOB ask only if it's realistic (between 1¢ and 97¢); else use AMM
                const CLOB_SPREAD_THRESHOLD = 0.97;
                const bestAsk = (clobAsk > 0 && clobAsk < CLOB_SPREAD_THRESHOLD)
                  ? clobAsk
                  : impliedPrice > 0 ? impliedPrice : clobAsk;

                // ── Dynamic entry price gate ─────────────────────────────────
                // Raised buffer from 10¢ to 15¢ for better EV per trade.
                //   75% conf → max 60¢  (EV = +15¢/share)
                //   80% conf → max 65¢  (EV = +15¢/share)
                //   85% conf → max 70¢  (EV = +15¢/share)
                //   90%+ conf → max 75¢ (capped; divergence gets 80¢ exception)
                // STRONG divergence is a structural edge (real price lag) → allow 80¢.
                if (bestAsk <= 0) {
                  botPrint("SKIP", `No price data available — skipping for now | re-check enabled`);
                  captureDecisionSnapshot({
                    decision: "TRADE",
                    action: "FILTERED",
                    direction: rec.direction,
                    confidence: rec.confidence,
                    edge: rec.estimatedEdge,
                    riskLevel: rec.riskLevel,
                    reasoning: rec.reasoning,
                    filterReasons: ["No price data available"],
                  });
                  analyzedThisWindow.delete(market.id);
                  continue;
                }

                const isDivergenceStrong = div?.strength === "STRONG";
                const MAX_ENTRY_PRICE = isDivergenceStrong
                  ? 0.80
                  : Math.min(0.75, (rec.confidence - 15) / 100);
                if (bestAsk > MAX_ENTRY_PRICE) {
                  const priceSource = (clobAsk > 0 && clobAsk < CLOB_SPREAD_THRESHOLD) ? "CLOB" : "AMM";
                  botPrint("SKIP", `Entry price too high: ${priceSource}=${( bestAsk * 100).toFixed(1)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ max (conf=${rec.confidence}%${isDivergenceStrong ? ", divergence override" : ""}). Monitoring for better price | re-check enabled`);
                  logEntry.reasoning += ` | Skipped: bestAsk ${(bestAsk * 100).toFixed(0)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ dynamic max (conf=${rec.confidence}%).`;
                  captureDecisionSnapshot({
                    decision: "TRADE",
                    action: "FILTERED",
                    direction: rec.direction,
                    confidence: rec.confidence,
                    edge: rec.estimatedEdge,
                    riskLevel: rec.riskLevel,
                    reasoning: rec.reasoning,
                    filterReasons: [`Entry price ${(bestAsk * 100).toFixed(1)}¢ > dynamic max ${(MAX_ENTRY_PRICE * 100).toFixed(1)}¢`],
                  });
                  botLog.unshift(logEntry);
                  if (botLog.length > 100) botLog.pop();
                  // Remove from analyzed set so next cycle re-checks the price
                  // (signal is still valid, only price was too high this moment)
                  analyzedThisWindow.delete(market.id);
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }

                const btcPremiumEntryGuard = getBtcPremiumEntryBlockReason(currentAsset, bestAsk, rec.confidence, rec.estimatedEdge);
                if (btcPremiumEntryGuard) {
                  botPrint("SKIP", `${btcPremiumEntryGuard} | re-check enabled`);
                  logEntry.reasoning += ` | Skipped: ${btcPremiumEntryGuard}.`;
                  captureDecisionSnapshot({
                    decision: "TRADE",
                    action: "FILTERED",
                    direction: rec.direction,
                    confidence: rec.confidence,
                    edge: rec.estimatedEdge,
                    riskLevel: rec.riskLevel,
                    reasoning: rec.reasoning,
                    filterReasons: [btcPremiumEntryGuard],
                  });
                  analyzedThisWindow.delete(market.id);
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }

                // Use bestAsk as fill price for Kelly (already AMM-corrected above).
                const kellyFillPrice = bestAsk > 0 ? bestAsk : parseFloat(market.outcomePrices[outcomeIndex] || "0.5");

                const p = rec.confidence / 100;
                const b = (1 - kellyFillPrice) / kellyFillPrice;
                const kelly = (p * b - (1 - p)) / b;

                // ── Volatility-adjusted Kelly ───────────────────────────────
                // Scale bet down when BTC is choppy (high ATR = noisy market).
                // ATR = avg true range of last 10 1-min candles.
                // Baseline: 0.15% of BTC price (e.g. $120 on $80K BTC).
                // Above baseline → reduce Kelly. Below → capped at 1.0 (no reward for calm).
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
                      botPrint("INFO", `Volatility gate: ATR=${atr.toFixed(0)} (${(normalizedAtr * 100).toFixed(2)}% of price) → Kelly scaled to ${(volMultiplier * 100).toFixed(0)}%`);
                    }
                  }
                }

                // Minimum bet scales with balance: floor at $0.50 or 20% of balance, whichever smaller
                const MIN_BET = Math.min(0.50, currentBalance * 0.20);

                // Entry sizing is fixed at the runtime-configured fixedTradeUsdc for every buy order.
                const betAmount = getFixedEntryBetAmount(currentBalance);

                botPrint("INFO", `Fixed sizing: conf=${rec.confidence}% | implied=${(impliedPrice * 100).toFixed(0)}¢ | target=$${getActiveConfig().fixedTradeUsdc.toFixed(2)} → final=$${betAmount.toFixed(2)} USDC`);
                botPrint("INFO", `Balance check: $${currentBalance.toFixed(2)} available | $${betAmount.toFixed(2)} to spend | $${(currentBalance - betAmount).toFixed(2)} remaining after trade`);

                if (betAmount < MIN_BET) {
                  botPrint("SKIP", `Adjusted bet too small ($${betAmount.toFixed(2)} USDC < $${MIN_BET.toFixed(2)} min). Balance may be too low or Kelly fraction too conservative. Skipping.`);
                  logEntry.reasoning += ` | Skipped: Adjusted bet $${betAmount.toFixed(2)} < $${MIN_BET.toFixed(2)} minimum (balance=$${currentBalance.toFixed(2)}).`;
                  captureDecisionSnapshot({
                    decision: "TRADE",
                    action: "FILTERED",
                    direction: rec.direction,
                    confidence: rec.confidence,
                    edge: rec.estimatedEdge,
                    riskLevel: rec.riskLevel,
                    reasoning: rec.reasoning,
                    filterReasons: [`Bet $${betAmount.toFixed(2)} < min $${MIN_BET.toFixed(2)}`],
                  });
                } else {
                  const executionStatus = getTradeWindowStatus(currentAsset, market.id);
                  if (executionStatus) {
                    botPrint("SKIP", `[${currentAsset}] Trade ${executionStatus === "EXECUTED" ? "already executed" : "already submitting"} for this market in the current window — order entry cancelled`);
                    captureDecisionSnapshot({
                      decision: "TRADE",
                      action: "FILTERED",
                      direction: rec.direction,
                      confidence: rec.confidence,
                      edge: rec.estimatedEdge,
                      riskLevel: rec.riskLevel,
                      reasoning: rec.reasoning,
                      filterReasons: [`Execution status ${executionStatus}`],
                    });
                    continue;
                  }

                  // ob, bestAsk, bestBid already fetched above for the hard gate
                  botPrint("TRADE", `━━━ EXECUTING ORDER ━━━`);
                  botPrint("TRADE", `Direction : ${rec.direction === "UP" ? "▲ UP (YES)" : "▼ DOWN (NO)"}`);
                  botPrint("TRADE", `Amount    : $${betAmount.toFixed(2)} USDC`);
                  botPrint("TRADE", `Price     : ${(bestAsk * 100).toFixed(1)}¢ (ask) | ${(bestBid * 100).toFixed(1)}¢ (bid)`);
                  botPrint("TRADE", `Confidence: ${rec.confidence}% | Edge: ${rec.estimatedEdge}¢ | Risk: ${rec.riskLevel}`);
                  try {
                    markTradeExecutionStarted(currentAsset, market.id);
                    const tradeResult = await executePolymarketTrade({
                      tokenID: tokenId,
                      amount: betAmount,
                      side: Side.BUY,
                      price: bestAsk,
                      executionMode: "AGGRESSIVE",
                      amountMode: "SPEND",
                    });
                    markTradeExecutionFinished(currentAsset, market.id, true);

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
                      strategyTag: "STANDARD",
                      windowEnd: currentWindowStart + MARKET_SESSION_SECONDS,
                      armed: true,
                      enteredAt: new Date(),
                    });

                    botSessionTradesCount++;
                    logEntry.tradeExecuted = true;
                    logEntry.tradeAmount = betAmount;
                    logEntry.tradePrice = bestAsk;
                    logEntry.orderId = tradeResult.orderID;
                    captureDecisionSnapshot({
                      decision: "TRADE",
                      action: "EXECUTED",
                      direction: rec.direction,
                      confidence: rec.confidence,
                      edge: rec.estimatedEdge,
                      riskLevel: rec.riskLevel,
                      reasoning: rec.reasoning,
                      filterReasons: [],
                      tradeExecuted: true,
                      tradeAmount: betAmount,
                      tradePrice: bestAsk,
                      orderId: tradeResult.orderID,
                    });
                    analyzedThisWindow.add(market.id);
                    botPrint("OK", `Order submitted! ID: ${tradeResult.orderID} | Status: ${tradeResult.status}`);
                    void sendNotification(
                      `✅ <b>TRADE EXECUTED</b>\nMarket: ${market.question?.slice(0, 60) ?? "BTC 5m"}\nDirection: ${rec.direction === "UP" ? "▲ UP" : "▼ DOWN"}\nAmount: $${betAmount.toFixed(2)} USDC @ ${(bestAsk * 100).toFixed(1)}¢\nConf: ${rec.confidence}% | Edge: ${rec.estimatedEdge}¢ | Risk: ${rec.riskLevel}`
                    );
                    botPrint("OK", `TP: ${(parseFloat(levels.takeProfit) * 100).toFixed(0)}¢ | SL: ${(parseFloat(levels.stopLoss) * 100).toFixed(0)}¢ | TS: ${(parseFloat(levels.trailingStop) * 100).toFixed(0)}¢ distance — automation ARMED`);
                    botPrint("OK", `Session trades: ${botSessionTradesCount} | Balance: ~$${currentBalance.toFixed(2)}`);

                    // Track this trade for win/loss resolution after window closes
                    pendingResults.set(tokenId, {
                      eventSlug: market.eventSlug,
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
                    botPrint("INFO", `Result tracker armed — checking after ${new Date((currentWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);
                  } catch (tradeErr: any) {
                    markTradeExecutionFinished(currentAsset, market.id, false);
                    logEntry.error = tradeErr?.message || String(tradeErr);
                    botPrint("ERR", `Trade execution failed: ${logEntry.error}`);
                    captureDecisionSnapshot({
                      decision: "TRADE",
                      action: "FILTERED",
                      direction: rec.direction,
                      confidence: rec.confidence,
                      edge: rec.estimatedEdge,
                      riskLevel: rec.riskLevel,
                      reasoning: rec.reasoning,
                      filterReasons: [`Execution failed: ${logEntry.error}`],
                    });
                  }
                }
              }
            }
          } else if (rec.decision === "NO_TRADE") {
            botPrint("SKIP", `No trade — conditions not met, will re-check next cycle`);
            captureDecisionSnapshot({
              decision: "NO_TRADE",
              action: "NO_TRADE",
              direction: rec.direction,
              confidence: rec.confidence,
              edge: rec.estimatedEdge,
              riskLevel: rec.riskLevel,
              reasoning: rec.reasoning,
              filterReasons: ["Synthesized signal did not qualify for trade"],
            });
            // Remove from analyzed set so next cycle re-evaluates if conditions change.
            // Keep AI cache so Gemini is not re-called — only re-check divergence/price/filters.
            analyzedThisWindow.delete(market.id);
          }

          botLog.unshift(logEntry);
          if (botLog.length > 100) botLog.pop();
          pushSSE("cycle", { ts: new Date().toISOString() });
        } catch (err: any) {
          botPrint("ERR", `Analysis error: ${err?.message || String(err)}`);
          analyzedThisWindow.delete(market.id); // transient fetch/AI errors should not lock the market for the rest of the window
        }
      } // end for (market of markets)
      } // end for (currentAsset of ENABLED_ASSETS)
    } finally {
      botRunning = false;
    }
  };

  // ── Polymarket heartbeat — must fire every <10s or all open orders are cancelled ──
  // Chain: first call uses "" → server returns heartbeat_id → each subsequent call passes that ID.
  // On 400: server returns the correct heartbeat_id in the response body — extract and use it.
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
        // The SDK throws on 400 but may attach the response body — try to extract it.
        const body = err?.response?.data ?? err?.data ?? null;
        const recoveredId = body?.heartbeat_id ?? body?.id ?? null;
        if (recoveredId) {
          console.warn(`[Heartbeat] 400 — recovered correct ID from response, re-chaining`);
          lastHeartbeatId = recoveredId;
        } else {
          console.warn("[Heartbeat] Failed:", err?.message ?? String(err), "— resetting chain");
          lastHeartbeatId = "";
        }
      }
    };
    void sendHeartbeat();
    heartbeatInterval = setInterval(() => void sendHeartbeat(), 5_000);
    console.log("[Heartbeat] Started — sending every 5s to keep open orders alive");
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    lastHeartbeatId = "";
    console.log("[Heartbeat] Stopped");
  };

  const startBot = () => {
    if (botInterval) return;
    console.log("");
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║          PolyBTC AI Trading Bot — STARTED         ║");
    console.log("╚═══════════════════════════════════════════════════╝");
    const startCfg = getActiveConfig();
    botPrint("INFO", `Min confidence : ${startCfg.minConfidence}%`);
    botPrint("INFO", `Min edge       : ${startCfg.minEdge}¢`);
    botPrint("INFO", `Fixed trade    : $${startCfg.fixedTradeUsdc.toFixed(2)} USDC`);
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

  // ── Bot control API ────────────────────────────────────────────────────────
  app.get("/api/bot/status", (_req, res) => {
    const nowUtcSeconds = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
    const windowElapsedSeconds = nowUtcSeconds - currentWindowStart;
    res.json({
      enabled: botEnabled,
      running: botRunning,
      sessionStartBalance: botSessionStartBalance,
      sessionTradesCount: botSessionTradesCount,
      windowElapsedSeconds,
      analyzedThisWindow: botAnalyzedThisWindow.size,
      entrySnapshot: currentEntrySnapshot,
      infra: getMarketInfraStatus(),
      enabledAssets: ENABLED_ASSETS,
      config: {
        minConfidence: getActiveConfig().minConfidence,
        minEdge: getActiveConfig().minEdge,
        kellyFraction: getActiveConfig().kellyFraction,
        maxBetUsdc: getActiveConfig().maxBetUsdc,
        fixedTradeUsdc: getActiveConfig().fixedTradeUsdc,
        scanIntervalMs: BOT_SCAN_INTERVAL_MS,
      },
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

  app.get("/api/bot/log", (req, res) => {
    const executedOnly =
      String(req.query.executedOnly || "").toLowerCase() === "1" ||
      String(req.query.executedOnly || "").toLowerCase() === "true";
    const log = executedOnly ? botLog.filter((entry) => entry.tradeExecuted) : botLog;
    res.json({ log });
  });

  app.get("/api/bot/rawlog", (_req, res) => {
    res.json({ log: rawLog });
  });

  // ── Ping / latency probe endpoint ──────────────────────────────────────────
  app.get("/api/bot/ping", async (_req, res) => {
    const targets = [
      { key: "clob",    label: "Polymarket CLOB",    url: "https://clob.polymarket.com/markets?limit=1" },
      { key: "gamma",   label: "Polymarket Gamma",   url: "https://gamma-api.polymarket.com/markets?limit=1" },
      { key: "data",    label: "Polymarket Data",    url: "https://data-api.polymarket.com/activity?limit=1" },
      { key: "binance", label: "Binance",            url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" },
      { key: "coinbase", label: "Coinbase",          url: "https://api.coinbase.com/v2/prices/BTC-USD/spot" },
    ];

    function gradeLatency(ms: number | null): "excellent" | "good" | "usable" | "slow" | "down" {
      if (ms == null) return "down";
      if (ms <= 80)  return "excellent";
      if (ms <= 150) return "good";
      if (ms <= 250) return "usable";
      return "slow";
    }

    const results = await Promise.all(targets.map(async (t) => {
      const start = Date.now();
      try {
        const r = await axios.get(t.url, { timeout: 6000, validateStatus: () => true });
        const latencyMs = Date.now() - start;
        const grade = gradeLatency(latencyMs);
        return { key: t.key, label: t.label, target: t.url, latencyMs, ok: r.status < 400, status: r.status, grade };
      } catch (err: any) {
        return { key: t.key, label: t.label, target: t.url, latencyMs: null, ok: false, status: null, error: err?.message ?? "timeout", grade: "down" as const };
      }
    }));

    const up = results.filter(r => r.latencyMs != null).map(r => r.latencyMs as number);
    const fastestMs  = up.length ? Math.min(...up) : null;
    const slowestMs  = up.length ? Math.max(...up) : null;
    const averageMs  = up.length ? Math.round(up.reduce((a, b) => a + b, 0) / up.length) : null;
    const overallGrade = gradeLatency(averageMs);
    const clob  = results.find(r => r.key === "clob");
    const gamma = results.find(r => r.key === "gamma");
    const criticalReady = (clob?.latencyMs ?? 9999) <= 150 && (gamma?.latencyMs ?? 9999) <= 150;

    res.json({
      testedAt: new Date().toISOString(),
      note: `${up.length}/${results.length} upstreams reachable`,
      summary: { fastestMs, slowestMs, averageMs, grade: overallGrade, criticalReady },
      upstreams: results,
    });
  });

  // ── SSE endpoint — real-time bot events ────────────────────────────────────
  app.get("/api/bot/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current log snapshot so the client is immediately up-to-date
    res.write(`event: snapshot\ndata: ${JSON.stringify({ log: rawLog.slice(0, 200) })}\n\n`);
    res.write(`event: infra\ndata: ${JSON.stringify(getMarketInfraStatus())}\n\n`);

    sseClients.add(res as unknown as ServerResponse);
    req.on("close", () => sseClients.delete(res as unknown as ServerResponse));
  });

  app.get("/api/bot/learning", (_req, res) => {
    const maxBoost = Math.max(...adaptiveConfidenceByAsset.values(), 0);
    res.json({
      consecutiveLossesByAsset: Object.fromEntries(consecutiveLossesByAsset),
      consecutiveWinsByAsset: Object.fromEntries(consecutiveWinsByAsset),
      adaptiveConfidenceByAsset: Object.fromEntries(adaptiveConfidenceByAsset),
      adaptiveLossPenaltyEnabled,
      effectiveMinConfidence: BOT_MIN_CONFIDENCE + maxBoost,
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

  app.get("/api/notifications/status", (_req, res) => {
    res.json({
      telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      discord: !!process.env.DISCORD_WEBHOOK_URL,
    });
  });

  app.post("/api/notifications/test-telegram", async (req, res) => {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (!telegramToken || !telegramChatId) {
      return res.status(400).json({ error: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID." });
    }

    const customMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const message =
      customMessage ||
      `🧪 <b>Telegram Test</b>\nBot: PolyBTC AI Trader\nTime: ${new Date().toLocaleString("en-US", { hour12: false })}\nStatus: local notification test`;

    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${telegramToken}/sendMessage`,
        { chat_id: telegramChatId, text: message, parse_mode: "HTML" },
        { timeout: 5000 }
      );
      return res.json({
        ok: true,
        telegram: true,
        result: response.data?.result ?? null,
      });
    } catch (error: any) {
      return res.status(500).json({
        error: "Failed to send Telegram test notification",
        detail: error?.response?.data?.description || error?.message || String(error),
      });
    }
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

  app.get("/api/backtest/trade-log-replay", (req, res) => {
    try {
      const days = Number.parseInt(String(req.query.days || ""), 10);
      const trades = filterTradeLogByDays(loadTradeLog(), days);
      const replay = buildTradeLogReplayReport(trades, getActiveConfig());
      res.json(replay);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Trade log replay failed" });
    }
  });

  app.get("/api/alpha/decision-log", (req, res) => {
    try {
      const days = Number.parseInt(String(req.query.days || ""), 10);
      const limit = Math.min(parseInt(String(req.query.limit || "100"), 10), 500);
      const entries = filterDecisionLogByDays(loadDecisionSnapshots(), days)
        .slice()
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      res.json({
        total: entries.length,
        entries: entries.slice(0, limit),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Decision log load failed" });
    }
  });

  app.get("/api/alpha/research", async (req, res) => {
    try {
      const days = Number.parseInt(String(req.query.days || ""), 10);
      const decisions = filterDecisionLogByDays(loadDecisionSnapshots(), days);
      const trades = filterTradeLogByDays(loadTradeLog(), days);
      const btcDecisions = decisions.filter((entry) => entry.asset === "BTC");
      const rangeStart = btcDecisions.length > 0
        ? Math.min(...btcDecisions.map((entry) => Math.floor(new Date(entry.ts).getTime() / 1000)))
        : 0;
      const rangeEnd = btcDecisions.length > 0
        ? Math.max(...btcDecisions.map((entry) => entry.windowEnd))
        : 0;
      const candles = rangeStart > 0 && rangeEnd > rangeStart
        ? await loadBtcCandlesRange(rangeStart, rangeEnd)
        : [];
      const report = buildAlphaResearchReport({
        decisions,
        trades: trades as ExecutedTradeSample[],
        candles,
      });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Alpha research analytics failed" });
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

  app.get("/api/analytics/btc-cutoffs", (req, res) => {
    try {
      const days = Number.parseInt(String(req.query.days || ""), 10);
      const trades = filterTradeLogByDays(loadTradeLog(), days);
      res.json(buildBtcCutoffReport(trades));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "BTC cutoff analytics failed" });
    }
  });

  app.post("/api/bot/config", (req, res) => {
    const { minConfidence, minEdge, fixedTradeUsdc } = req.body || {};
    if (minConfidence !== undefined) {
      const val = Number(minConfidence);
      if (isNaN(val) || val < 50 || val > 99) return res.status(400).json({ error: "minConfidence must be 50–99" });
      aggressiveMinConfidence = val;
    }
    if (minEdge !== undefined) {
      const val = Number(minEdge);
      if (isNaN(val) || val < 0.01 || val > 0.50) return res.status(400).json({ error: "minEdge must be 0.01–0.50" });
      aggressiveMinEdge = val;
    }
    if (fixedTradeUsdc !== undefined) {
      const val = Number(fixedTradeUsdc);
      if (isNaN(val) || val < 0.1 || val > BOT_MAX_BET_USDC) {
        return res.status(400).json({ error: `fixedTradeUsdc must be between 0.10 and ${BOT_MAX_BET_USDC.toFixed(2)}` });
      }
      aggressiveFixedTradeUsdc = parseFloat(val.toFixed(2));
    }
    const cfg = getActiveConfig();
    botPrint("INFO", `Config updated (AGGRESSIVE): conf≥${aggressiveMinConfidence}% edge≥${aggressiveMinEdge}¢ fixed=$${aggressiveFixedTradeUsdc.toFixed(2)}`);
    res.json({ ok: true, aggressiveMinConfidence, aggressiveMinEdge, aggressiveFixedTradeUsdc, config: cfg });
  });

  // ── Active market assets ──────────────────────────────────────────────────
  app.get("/api/bot/assets", (_req, res) => {
    res.json({ all: ALL_ASSETS, enabled: ENABLED_ASSETS });
  });

  app.post("/api/bot/assets", (_req, res) => {
    ENABLED_ASSETS = ["BTC"];
    res.json({ ok: true, enabled: ENABLED_ASSETS, locked: true });
  });

  app.post("/api/bot/reset-confidence", (_req, res) => {
    for (const a of ["BTC", "ETH", "SOL"] as const) {
      adaptiveConfidenceByAsset.set(a, 0);
      consecutiveLossesByAsset.set(a, 0);
      consecutiveWinsByAsset.set(a, 0);
    }
    saveLearning();
    botPrint("INFO", `Adaptive confidence reset to baseline ${BOT_MIN_CONFIDENCE}% for all assets (manual override)`);
    res.json({ ok: true, baseMinConfidence: BOT_MIN_CONFIDENCE, adaptiveConfidenceByAsset: Object.fromEntries(adaptiveConfidenceByAsset) });
  });

  app.get("/api/bot/trade-log", (req, res) => {
    const all = loadTradeLog();
    const days = Number.parseInt(String(req.query.days || ""), 10);
    const filtered = filterTradeLogByDays(all, days);
    const limit = Math.min(parseInt(String(req.query.limit || "200"), 10), 1000);
    const offset = parseInt(String(req.query.offset || "0"), 10);
    const entries = filtered.slice().reverse().slice(offset, offset + limit);
    const wins   = filtered.filter((e) => e.result === "WIN").length;
    const losses = filtered.filter((e) => e.result === "LOSS").length;
    const totalPnl = parseFloat(filtered.reduce((s, e) => s + e.pnl, 0).toFixed(2));
    const winRate  = filtered.length > 0 ? parseFloat(((wins / filtered.length) * 100).toFixed(1)) : 0;
    const divTrades = filtered.filter((e) => e.divergenceStrength === "STRONG" || e.divergenceStrength === "MODERATE");
    const divWins   = divTrades.filter((e) => e.result === "WIN").length;
    const divWinRate = divTrades.length > 0 ? parseFloat(((divWins / divTrades.length) * 100).toFixed(1)) : null;
    res.json({
      total: filtered.length, wins, losses, winRate, totalPnl,
      divergence: { trades: divTrades.length, wins: divWins, winRate: divWinRate },
      entries,
    });
  });

  // API Proxy for Polymarket — BTC/ETH/SOL Up/Down 5-Minute Events
  app.get("/api/polymarket/markets", async (req, res) => {
    try {
      const nowUtcSeconds = Math.floor(Date.now() / 1000);
      const currentStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
      const snapshots = await Promise.all(
        ENABLED_ASSETS.map((asset) => fetchMarketDiscoverySnapshot(asset, currentStart))
      );
      const markets = snapshots.flatMap((snapshot) => [...snapshot.currentMarkets, ...snapshot.nextMarkets]);
      res.json(markets);
    } catch (error: any) {
      console.error("Polymarket Events API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch BTC 5-min markets" });
    }
  });

  app.get("/api/polymarket/discovery", async (_req, res) => {
    try {
      const nowUtcSeconds = Math.floor(Date.now() / 1000);
      const currentStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
      const snapshots = await Promise.all(
        ENABLED_ASSETS.map((asset) => fetchMarketDiscoverySnapshot(asset, currentStart))
      );
      res.json({
        windowStart: currentStart,
        snapshots,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch market discovery", detail: error?.message || String(error) });
    }
  });

  // API for Polymarket CLOB Order Book (with imbalance signal)
  app.get("/api/polymarket/orderbook/:tokenID", async (req, res) => {
    try {
      const { tokenID } = req.params;
      const book = await getNormalizedOrderBookSnapshot(tokenID);
      const amount = Number(req.query.amount || getActiveConfig().fixedTradeUsdc);
      const amountMode = String(req.query.amountMode || "SPEND").toUpperCase() as QuoteAmountMode;
      const side = String(req.query.side || "BUY").toUpperCase() as QuoteSide;
      const includeQuote = String(req.query.includeQuote || "true").toLowerCase() !== "false";
      const quote = includeQuote && amount > 0
        ? getExecutionQuoteDetailed(book, side, amount, amountMode, side === "BUY" ? book.bestAsk : book.bestBid)
        : null;

      if (quote) rememberExecutionQuote(quote);

      res.json({
        ...book,
        updatedAt: new Date(book.updatedAt).toISOString(),
        quote,
      });
    } catch (error: any) {
      console.error("Polymarket CLOB API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch order book" });
    }
  });

  app.get("/api/polymarket/execution-quote/:tokenID", async (req, res) => {
    try {
      const { tokenID } = req.params;
      const amount = Number(req.query.amount || getActiveConfig().fixedTradeUsdc);
      const amountMode = String(req.query.amountMode || "SPEND").toUpperCase() as QuoteAmountMode;
      const side = String(req.query.side || "BUY").toUpperCase() as QuoteSide;
      if (!(amount > 0)) {
        return res.status(400).json({ error: "amount must be greater than 0" });
      }

      const book = await getNormalizedOrderBookSnapshot(tokenID);
      const quote = getExecutionQuoteDetailed(
        book,
        side,
        amount,
        amountMode,
        side === "BUY" ? book.bestAsk : book.bestBid
      );
      rememberExecutionQuote(quote);
      res.json({
        quote,
        book: {
          tokenId: tokenID,
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
          spread: book.spread,
          imbalanceSignal: book.imbalanceSignal,
          source: book.source,
          updatedAt: new Date(book.updatedAt).toISOString(),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to compute execution quote", detail: error?.message || String(error) });
    }
  });

  app.get("/api/polymarket/stream", (_req, res) => {
    res.json(getMarketInfraStatus().stream);
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

  // ── Helper: resolve trading address (proxy wallet or EOA) ────────────────
  const getTradingAddress = async (): Promise<string | null> => {
    if (POLYMARKET_FUNDER_ADDRESS) return POLYMARKET_FUNDER_ADDRESS;
    await getClobClient();
    return clobWallet?.address ?? null;
  };

  // ── Current positions (open) ───────────────────────────────────────────────
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

  // ── Closed positions ───────────────────────────────────────────────────────
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

  // ── Performance summary (aggregated from both APIs) ────────────────────────
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
      // Any CLOB error (400, 404, 422, 500…) — return empty array so UI doesn't break
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

  // Proxy for BTC Historical Data — 1m candles, last 60 (for chart + indicators)
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

  // BTC Technical Indicators — RSI(14), EMA(9), EMA(21), volume spike
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
