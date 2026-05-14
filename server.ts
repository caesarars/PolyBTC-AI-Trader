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
import { MongoClient, Db } from "mongodb";
import { runBacktest, type BacktestOptions, type Candle as BacktestCandle } from "./src/backtest/replay.js";
import {
  loadCalibrator,
  saveCalibrator,
  clearCalibrator,
  retrain as retrainCalibrator,
  getCalibratorState,
  isCalibratorReady,
  predictPWin,
} from "./src/calibration/runtime.js";
import { buildSyntheticTrainingSet } from "./src/calibration/synthetic.js";
import type { LabeledTrade, TradeFeatures } from "./src/calibration/calibrator.js";
import {
  appendOrderBookSnapshot,
  buildSnapshot as buildOrderBookSnapshot,
  readOrderBookLog,
  readOrderBookLogStats,
} from "./src/measurement/orderbookLogger.js";
import { buildPhase1Report, type TradeRecord } from "./src/measurement/phase1.js";
import { evaluatePolicy, getPolicyStatus } from "./src/measurement/signalPolicy.js";
import {
  runBookReplay,
  type BookReplayOptions,
  type StrategyTickContext,
  type StrategyTickDecision,
} from "./src/backtest/bookReplay.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Persistence: data/ directory ──────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, "data");
const LOSS_MEMORY_FILE = path.join(DATA_DIR, "loss_memory.json");
const TRADE_LOG_FILE   = path.join(DATA_DIR, "trade_log.jsonl");
const PAPER_TRADE_LOG_FILE = path.join(DATA_DIR, "paper_trade_log.jsonl");
const ORDERBOOK_LOG_FILE   = path.join(DATA_DIR, "orderbook_log.jsonl");

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
  isPaperTrade?: boolean;
}

type ResolvedOrderMeta = {
  assetId: string | null;
  market: string | null;
  outcome: string | null;
  createdAtMs: number | null;
};

const resolvedOrderMetaCache = new Map<string, Promise<ResolvedOrderMeta | null>>();

function normalizeLookupText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeOutcome(value: unknown): string {
  const normalized = normalizeLookupText(value);
  if (!normalized) return "";
  if (normalized === "yes" || normalized === "up") return "up";
  if (normalized === "no" || normalized === "down") return "down";
  return normalized;
}

function directionToOutcome(direction: TradeLogEntry["direction"]): string {
  return direction === "UP" ? "up" : direction === "DOWN" ? "down" : "";
}

function buildMarketOutcomeKey(market: unknown, outcome: unknown): string {
  return `${normalizeLookupText(market)}::${normalizeOutcome(outcome)}`;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundPnl(value: number): number {
  return Number(value.toFixed(4));
}

async function loadPersistedTradeLog(): Promise<TradeLogEntry[]> {
  let trades: TradeLogEntry[] = [];
  try {
    const collection = await getTradesCollection();
    if (collection) {
      const docs = await collection
        .find({}, { projection: { _id: 0 } })
        .sort({ ts: -1 })
        .limit(2000)
        .toArray();

      if (docs.length > 0) {
        trades = docs
          .reverse()
          .map((doc) => ({
            ts: doc.ts,
            market: doc.market,
            direction: doc.direction,
            confidence: Number(doc.confidence ?? 0),
            edge: Number(doc.edge ?? 0),
            betAmount: Number(doc.betAmount ?? 0),
            entryPrice: Number(doc.entryPrice ?? 0),
            pnl: Number(doc.pnl ?? 0),
            result: doc.result === "WIN" ? "WIN" : "LOSS",
            rsi: doc.rsi,
            emaCross: doc.emaCross,
            signalScore: doc.signalScore,
            imbalanceSignal: doc.imbalanceSignal,
            divergenceDirection: doc.divergenceDirection,
            divergenceStrength: doc.divergenceStrength,
            btcDelta30s: doc.btcDelta30s,
            yesDelta30s: doc.yesDelta30s,
            windowElapsedSeconds: Number(doc.windowElapsedSeconds ?? 0),
            orderId: doc.orderId ?? null,
          }));
      }
    }
  } catch (error: any) {
    console.warn("Failed to load persisted trades from MongoDB. Falling back to local trade log.", error?.message || error);
  }

  if (trades.length === 0) trades = loadTradeLog();

  // Merge paper trades
  const paperTrades = loadPaperTradeLog();
  if (paperTrades.length > 0) {
    trades = trades.concat(paperTrades);
    trades.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }
  return trades;
}

async function resolveOrderMeta(orderId: string | null | undefined): Promise<ResolvedOrderMeta | null> {
  if (!orderId) return null;
  const cached = resolvedOrderMetaCache.get(orderId);
  if (cached) return cached;

  const task = (async () => {
    try {
      const client = await getClobClient();
      if (!client) return null;

      const order = await client.getOrder(orderId);
      return {
        assetId: order?.asset_id ? String(order.asset_id) : null,
        market: order?.market ? String(order.market) : null,
        outcome: order?.outcome ? String(order.outcome) : null,
        createdAtMs: parseTimestampMs(order?.created_at ?? null),
      };
    } catch (error: any) {
      console.warn(`Failed to resolve CLOB order metadata for ${orderId}:`, error?.message || error);
      return null;
    }
  })();

  resolvedOrderMetaCache.set(orderId, task);
  return task;
}

async function matchClosedPositionsToPersistedTrades(closedPositionsRaw: any[]) {
  const trades = await loadPersistedTradeLog();
  if (!closedPositionsRaw.length || !trades.length) {
    return closedPositionsRaw.map((position) => ({
      ...position,
      orderId: null,
      orderIds: [] as string[],
      matchedTradeTs: null,
      matchedBy: null as "asset" | "market_outcome" | null,
    }));
  }

  const closedMarketKeys = new Set(
    closedPositionsRaw
      .map((position) => buildMarketOutcomeKey(position.title, position.outcome))
      .filter((key) => key !== "::")
  );
  const likelyMatchingTrades = closedMarketKeys.size > 0
    ? trades.filter((entry) => closedMarketKeys.has(buildMarketOutcomeKey(entry.market, directionToOutcome(entry.direction))))
    : trades;
  const tradesToMatch = likelyMatchingTrades.length > 0 ? likelyMatchingTrades : trades;

  const resolvedTrades = await Promise.all(
    tradesToMatch.map(async (entry) => {
      const orderMeta = await resolveOrderMeta(entry.orderId);
      return {
        entry,
        orderId: entry.orderId ?? null,
        assetId: orderMeta?.assetId ?? null,
        marketKey: buildMarketOutcomeKey(entry.market, orderMeta?.outcome ?? directionToOutcome(entry.direction)),
        tsMs: parseTimestampMs(entry.ts),
      };
    })
  );

  const tradesByAsset = new Map<string, typeof resolvedTrades>();
  const tradesByMarketOutcome = new Map<string, typeof resolvedTrades>();

  for (const trade of resolvedTrades) {
    if (trade.assetId) {
      const bucket = tradesByAsset.get(trade.assetId) ?? [];
      bucket.push(trade);
      tradesByAsset.set(trade.assetId, bucket);
    }

    if (trade.marketKey !== "::") {
      const bucket = tradesByMarketOutcome.get(trade.marketKey) ?? [];
      bucket.push(trade);
      tradesByMarketOutcome.set(trade.marketKey, bucket);
    }
  }

  return closedPositionsRaw.map((position) => {
    const assetMatches = tradesByAsset.get(String(position.asset ?? "")) ?? [];
    const fallbackMatches = assetMatches.length
      ? []
      : (tradesByMarketOutcome.get(buildMarketOutcomeKey(position.title, position.outcome)) ?? []);

    const closedTsMs = parseTimestampMs(position.timestamp);
    const matches = (assetMatches.length ? assetMatches : fallbackMatches)
      .slice()
      .sort((a, b) => {
        const aDist = a.tsMs != null && closedTsMs != null ? Math.abs(a.tsMs - closedTsMs) : Number.MAX_SAFE_INTEGER;
        const bDist = b.tsMs != null && closedTsMs != null ? Math.abs(b.tsMs - closedTsMs) : Number.MAX_SAFE_INTEGER;
        return aDist - bDist;
      });

    const orderIds = [...new Set(matches.map((match) => match.orderId).filter((value): value is string => Boolean(value)))];
    const primaryMatch = matches[0];

    return {
      ...position,
      orderId: orderIds[0] ?? null,
      orderIds,
      matchedTradeTs: primaryMatch?.entry.ts ?? null,
      matchedBy: assetMatches.length ? "asset" : fallbackMatches.length ? "market_outcome" : null,
    };
  });
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

function savePaperTradeLog(entry: TradeLogEntry): void {
  try {
    fs.appendFileSync(PAPER_TRADE_LOG_FILE, JSON.stringify({ ...entry, isPaperTrade: true }) + "\n", "utf8");
  } catch (e: any) {
    console.error("[Persist] Failed to write paper_trade_log.jsonl:", e.message);
  }
}

function loadPaperTradeLog(): TradeLogEntry[] {
  try {
    if (!fs.existsSync(PAPER_TRADE_LOG_FILE)) return [];
    return fs.readFileSync(PAPER_TRADE_LOG_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TradeLogEntry);
  } catch (e: any) {
    console.error("[Persist] Failed to read paper_trade_log.jsonl:", e.message);
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
    const assets: TradingAsset[] = ["BTC"];
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

// ── BTC-only market support ────────────────────────────────────────────────
type TradingAsset = "BTC";
const ALL_ASSETS: TradingAsset[] = ["BTC"];
// BTC only — no multi-asset switching
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
  BTC: { binanceSymbol: "BTCUSDT", coinbaseProduct: "BTC-USD", coinGeckoId: "bitcoin",  krakenPair: "XBTUSD",  polySlugPrefix: "btc-updown-5m", divergenceStrong: 85, divergenceMod: 50, divergenceWeak: 30,  label: "Bitcoin" },
};

// Per-asset in-memory caches (BTC uses legacy single vars below for backward compat)
const assetHistoryCaches = new Map<TradingAsset, { data: BtcCandle[]; expiresAt: number }>();
const assetPriceCaches   = new Map<TradingAsset, { data: { symbol: string; price: string; source?: string }; expiresAt: number }>();
const assetIndicatorsCaches = new Map<TradingAsset, { data: any; expiresAt: number }>();
const assetHeatCaches = new Map<TradingAsset, { data: import("./src/types.js").MarketHeatData; expiresAt: number }>();

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
const BTC_PRICE_CACHE_MS = 2_000;
const BTC_HISTORY_CACHE_MS = 8_000;
const BTC_INDICATORS_CACHE_MS = 15_000;
const HEAT_CACHE_MS = 30_000; // Binance funding / taker ratio updates every 5m, 30s cache is safe
const BTC_PRICE_SNAPSHOT_TTL_SECONDS = Number(process.env.BTC_PRICE_SNAPSHOT_TTL_SECONDS || 60 * 60 * 24 * 14);
const BTC_CANDLE_TTL_SECONDS = Number(process.env.BTC_CANDLE_TTL_SECONDS || 60 * 60 * 24 * 30);
const BTC_BACKGROUND_SYNC_MS = Number(process.env.BTC_BACKGROUND_SYNC_MS || 5_000);
const POSITION_AUTOMATION_SYNC_MS = Number(process.env.POSITION_AUTOMATION_SYNC_MS || 3_000);
const SESSION_PNL_LOOKBACK_DAYS = 7;

// ── Bot configuration ────────────────────────────────────────────────────────
const BOT_SCAN_INTERVAL_MS = Number(process.env.BOT_SCAN_INTERVAL_MS || 5_000);
// `confidence` is a heuristic point score (60 base + alignment + boosts), NOT a calibrated
// probability. `minEdge` is kept as a backward-compatible config/API name, but it now means
// minimum price headroom: maxEntryPriceFor(confidence, divergence) - entryPrice.
const BOT_MIN_CONFIDENCE = Number(process.env.BOT_MIN_CONFIDENCE || 75);
const BOT_MIN_EDGE = Number(process.env.BOT_MIN_EDGE || 0.15);
const BOT_MAX_BET_USDC = Number(process.env.BOT_MAX_BET_USDC || 250);
const BOT_FIXED_TRADE_USDC = Number(process.env.BOT_FIXED_TRADE_USDC || 1);

// ── Phase 0 risk / safety config ─────────────────────────────────────────────
// Live mode is gated behind PHASE_0_COMPLETE=true. Until set, paper mode is forced.
const PHASE_0_COMPLETE = process.env.PHASE_0_COMPLETE === "true";
const RISK_MAX_DRAWDOWN_PCT  = Number(process.env.RISK_MAX_DRAWDOWN_PCT  ?? 10);
const RISK_MAX_CONSEC_LOSSES = Number(process.env.RISK_MAX_CONSEC_LOSSES ?? 5);
const RISK_DAILY_LOSS_PCT    = Number(process.env.RISK_DAILY_LOSS_PCT    ?? 15);
// Microstructure gates (per trade)
const GATE_MAX_SPREAD          = Number(process.env.GATE_MAX_SPREAD          ?? 0.05);  // 5¢
const GATE_MIN_TOB_LIQ_USDC    = Number(process.env.GATE_MIN_TOB_LIQ_USDC    ?? 50);    // top-of-book notional both sides
const GATE_MAX_NORMALIZED_ATR  = Number(process.env.GATE_MAX_NORMALIZED_ATR  ?? 0.004); // 0.40% of price (1m ATR)
// Heartbeat watchdog
const HEARTBEAT_FAIL_WARN_AT   = Number(process.env.HEARTBEAT_FAIL_WARN_AT   ?? 2);
const HEARTBEAT_FAIL_HALT_AT   = Number(process.env.HEARTBEAT_FAIL_HALT_AT   ?? 3);
// Calibrator: authoritative EV gate. The trained logistic regression in
// src/calibration turns indicator features into a real P(WIN); this is the
// ONLY binding probability gate. Heuristic confidence is advisory only
// (BOT_CONFIDENCE_HARD_GATE=true restores the old behavior for ops who want it).
// If no model is loaded, the bot refuses to trade unless BOT_REQUIRE_CALIBRATOR
// is explicitly set to "false" (see startup auto-bootstrap below).
const BOT_CALIBRATED_MIN_EDGE  = Number(process.env.BOT_CALIBRATED_MIN_EDGE  ?? 0.05);
const BOT_CALIBRATED_MIN_PWIN  = Number(process.env.BOT_CALIBRATED_MIN_PWIN  ?? 0.55);
const BOT_REQUIRE_CALIBRATOR   = process.env.BOT_REQUIRE_CALIBRATOR !== "false";
const BOT_CONFIDENCE_HARD_GATE = process.env.BOT_CONFIDENCE_HARD_GATE === "true";

// Runtime-overrideable thresholds (UI-adjustable via /api/bot/config)
let aggressiveMinConfidence = BOT_MIN_CONFIDENCE;
let aggressiveMinEdge       = BOT_MIN_EDGE;
let aggressiveFixedTradeUsdc = BOT_FIXED_TRADE_USDC;
let aggressiveEntryWindowStart = 10;
let aggressiveEntryWindowEnd   = 280;

function getActiveConfig() {
  return {
    minConfidence:    aggressiveMinConfidence,
    minEdge:          aggressiveMinEdge,
    maxBetUsdc:       BOT_MAX_BET_USDC,
    fixedTradeUsdc:   aggressiveFixedTradeUsdc,
    balanceCap:       0.25,
    entryWindowStart: aggressiveEntryWindowStart,
    entryWindowEnd:   aggressiveEntryWindowEnd,
  };
}

function getFixedEntryBetAmount(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const reserve = Math.min(1.0, balance * 0.10);
  const spendable = Math.max(0, balance - reserve);
  return parseFloat(Math.min(getActiveConfig().fixedTradeUsdc, spendable).toFixed(2));
}

// ── Confidence is NOT a probability — flat sizing only ───────────────────────
// `confidence` is a heuristic point score (60 base + alignScore×5 + boosts,
// clamped to [55, 90]). It is uncalibrated — live data showed the 85–95%
// bucket winning ~33%. It is NEVER used as a probability, including for sizing.
//
// Sizing is FLAT via getFixedEntryBetAmount, regardless of confidence or pWin.
//
// Two gates run in series:
//   1. Heuristic price-cap (this function) — a policy cap derived from confidence.
//      It is a "do not pay more than X¢" rule, not a probability claim.
//   2. Calibrated EV gate (logistic regression in src/calibration) — predicts
//      P(WIN) from indicators and rejects trades when pWin < min or pWin − ask
//      < min edge. This is the authoritative EV gate; it runs after the cap.
function maxEntryPriceFor(confidence: number, isDivergenceStrong: boolean): number {
  if (isDivergenceStrong) return 0.80;
  // 75% conf → max 60¢, 80% → 65¢, 85% → 70¢, 90% → 75¢ (capped).
  // These are policy choices, not implied probabilities.
  return Math.min(0.75, Math.max(0.40, (confidence - 15) / 100));
}

// ── Calibrator auto-retrain (rate-limited) ──────────────────────────────────
// After each resolved trade we want to refresh the calibrator so it sees the
// new outcome. Training is O(samples × iterations) and only meaningful when
// we have ≥ minTrades samples, so we debounce.
const CALIBRATOR_AUTO_RETRAIN_MS = Number(process.env.CALIBRATOR_AUTO_RETRAIN_MS ?? 5 * 60 * 1000);
let lastCalibratorRetrainAt = 0;
let calibratorRetrainInFlight = false;
async function maybeRetrainCalibratorFromTradeLog(): Promise<void> {
  const now = Date.now();
  if (calibratorRetrainInFlight) return;
  if (now - lastCalibratorRetrainAt < CALIBRATOR_AUTO_RETRAIN_MS) return;
  calibratorRetrainInFlight = true;
  try {
    const trades = await loadPersistedTradeLog();
    const labeled: LabeledTrade[] = [];
    for (const t of trades) {
      if (t.isPaperTrade) continue;
      if (t.result !== "WIN" && t.result !== "LOSS") continue;
      labeled.push({
        direction: t.direction as "UP" | "DOWN",
        confidence: t.confidence,
        rsi: t.rsi,
        emaCross: t.emaCross,
        signalScore: t.signalScore,
        imbalanceSignal: t.imbalanceSignal,
        divergenceDirection: t.divergenceDirection,
        divergenceStrength: t.divergenceStrength,
        btcDelta30s: t.btcDelta30s,
        yesDelta30s: t.yesDelta30s,
        windowElapsedSeconds: t.windowElapsedSeconds,
        entryPrice: t.entryPrice,
        result: t.result,
      });
    }
    if (labeled.length < 20) return;
    const state = retrainCalibrator(labeled, {
      minTrades: Math.min(100, Math.floor(labeled.length * 0.5)),
    });
    lastCalibratorRetrainAt = now;
    if (state.ready) {
      console.log(`[Calibrate] Auto-retrained on ${state.nSamples} live trades. ${state.reason}`);
    }
  } catch (e: any) {
    console.warn(`[Calibrate] Auto-retrain failed: ${e?.message ?? e}`);
  } finally {
    calibratorRetrainInFlight = false;
  }
}

// ── Bot runtime state ────────────────────────────────────────────────────────
let botEnabled = process.env.BOT_AUTO_START === "true";
let botRunning = false;
// Phase 0: paper mode is forced ON until PHASE_0_COMPLETE=true is set in env.
let paperMode = (!PHASE_0_COMPLETE) || process.env.PAPER_MODE === "true";
if (!PHASE_0_COMPLETE) {
  console.warn("┌─────────────────────────────────────────────────────────────┐");
  console.warn("│ PHASE 0 NOT COMPLETE — paper mode FORCED. Live trades       │");
  console.warn("│ are disabled. Set PHASE_0_COMPLETE=true to allow real fills.│");
  console.warn("└─────────────────────────────────────────────────────────────┘");
}
let botInterval: NodeJS.Timeout | null = null;
let botSessionStartBalance: number | null = null;
let botSessionPeakBalance: number | null = null;
let botSessionTradesCount = 0;
let botLastWindowStart = 0;

// ── Risk halt state (Phase 0 fix 2 + 5) ──────────────────────────────────────
interface RiskHaltState {
  halted: boolean;
  reason: string;
  haltedAt: number; // unix seconds
}
const riskHalt: RiskHaltState = { halted: false, reason: "", haltedAt: 0 };

// Daily PnL tracker — keyed by YYYY-MM-DD (UTC). Used for daily-loss circuit breaker.
const dailyPnlByDate: Map<string, number> = new Map();
function dateKeyUtc(ts = Date.now()): string { return new Date(ts).toISOString().slice(0, 10); }
function recordDailyPnl(pnl: number, ts = Date.now()) {
  const k = dateKeyUtc(ts);
  dailyPnlByDate.set(k, (dailyPnlByDate.get(k) ?? 0) + pnl);
}
function todayPnl(): number {
  return dailyPnlByDate.get(dateKeyUtc()) ?? 0;
}

// Per-asset analyzed-this-window tracking (keyed by asset → Set of market IDs)
const botAnalyzedThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC"] as TradingAsset[]).map(a => [a, new Set<string>()])
);
// Per-asset trade execution locks for the current window.
// `executing` prevents duplicate submits during async races.
// `executed` blocks any re-analysis/re-entry after a real Polymarket fill attempt succeeded.
const botExecutingTradesThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC"] as TradingAsset[]).map(a => [a, new Set<string>()])
);
const botExecutedTradesThisWindowByAsset = new Map<TradingAsset, Set<string>>(
  (["BTC"] as TradingAsset[]).map(a => [a, new Set<string>()])
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

// ── Divergence tracker (BTC price vs YES token lag detector) ────────────────
interface PricePoint { ts: number; price: number; }
const priceRingBufferByAsset = new Map<TradingAsset, PricePoint[]>([["BTC",[]]]);
const yesRingBufferByAsset   = new Map<TradingAsset, PricePoint[]>([["BTC",[]]]);
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
  isPaperTrade?: boolean;
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

const consecutiveLossesByAsset   = new Map<TradingAsset, number>([["BTC",0]]);
const consecutiveWinsByAsset     = new Map<TradingAsset, number>([["BTC",0]]);
const adaptiveConfidenceByAsset  = new Map<TradingAsset, number>([["BTC",0]]);
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
  windowEnd?: number;       // unix seconds — when the 5-min market resolves
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

async function getTradesCollection() {
  const db = await getMongoDb();
  return db?.collection<TradeLogEntry & { _id?: any }>(MONGODB_TRADES_COLLECTION) || null;
}

async function ensureMongoCollections() {
  try {
    const db = await getMongoDb();
    if (!db) return;

    const marketCache = db.collection(MONGODB_CACHE_COLLECTION);
    const priceSnapshots = db.collection(MONGODB_PRICE_SNAPSHOTS_COLLECTION);
    const candles = db.collection(MONGODB_CHART_COLLECTION);
    const automations = db.collection(MONGODB_POSITION_AUTOMATION_COLLECTION);
    const trades = db.collection(MONGODB_TRADES_COLLECTION);

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
      trades.createIndex({ ts: -1 }),
      trades.createIndex({ orderId: 1 }, { sparse: true }),
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
        params: { symbol: "BTCUSDT", interval: "1m", limit: 1000 },
        timeout: 8000,
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

// ── Binance Futures market heat (funding + taker ratio + long/short) ─────────
async function fetchBinanceFundingRate(symbol: string) {
  try {
    const r = await axios.get("https://fapi.binance.com/fapi/v1/premiumIndex", {
      params: { symbol },
      timeout: 5000,
    });
    const d = r.data;
    return {
      fundingRate: parseFloat(d.lastFundingRate || "0"),
      nextFundingTime: Number(d.nextFundingTime || 0),
      time: Number(d.time || 0),
    };
  } catch { return null; }
}

async function fetchBinanceTakerRatio(symbol: string, period = "5m") {
  try {
    const r = await axios.get("https://fapi.binance.com/futures/data/takerlongshortRatio", {
      params: { symbol, period },
      timeout: 5000,
    });
    const arr = r.data as Array<{ buySellRatio: string; sellVol: string; buyVol: string; timestamp: number }>;
    if (!arr?.length) return null;
    const latest = arr[arr.length - 1];
    return {
      buySellRatio: parseFloat(latest.buySellRatio),
      buyVol: parseFloat(latest.buyVol),
      sellVol: parseFloat(latest.sellVol),
      timestamp: Number(latest.timestamp),
    };
  } catch { return null; }
}

async function fetchBinanceLongShortRatio(symbol: string, period = "5m") {
  try {
    const r = await axios.get("https://fapi.binance.com/futures/data/globalLongShortAccountRatio", {
      params: { symbol, period },
      timeout: 5000,
    });
    const arr = r.data as Array<{ longAccount: string; shortAccount: string; longShortRatio: string; timestamp: number }>;
    if (!arr?.length) return null;
    const latest = arr[arr.length - 1];
    return {
      longAccount: parseFloat(latest.longAccount),
      shortAccount: parseFloat(latest.shortAccount),
      longShortRatio: parseFloat(latest.longShortRatio),
      timestamp: Number(latest.timestamp),
    };
  } catch { return null; }
}

function computeHeatSignal(
  fundingRate: number,
  takerRatio: number,
  lsRatio: number
): { heatSignal: import("./src/types.js").MarketHeatData["heatSignal"]; squeezeRisk: import("./src/types.js").MarketHeatData["squeezeRisk"] } {
  // Funding extremes (>0.05% or <-0.05% per 8h = annualized ~22.8%)
  const fundingExtreme = Math.abs(fundingRate) > 0.0005;
  const fundingLongHeavy = fundingRate > 0.0003;
  const fundingShortHeavy = fundingRate < -0.0003;

  // Taker ratio: >1.5 = aggressive buying, <0.67 = aggressive selling
  const takerBuyHeavy = takerRatio > 1.5;
  const takerSellHeavy = takerRatio < 0.67;

  // Long/Short ratio: >1.5 = more longs, <0.67 = more shorts
  const lsLongHeavy = lsRatio > 1.5;
  const lsShortHeavy = lsRatio < 0.67;

  let heatSignal: import("./src/types.js").MarketHeatData["heatSignal"] = "NEUTRAL";
  if ((fundingLongHeavy && lsLongHeavy) || (fundingExtreme && fundingRate > 0)) heatSignal = "EXTREME_LONG";
  else if ((fundingShortHeavy && lsShortHeavy) || (fundingExtreme && fundingRate < 0)) heatSignal = "EXTREME_SHORT";
  else if (fundingLongHeavy || lsLongHeavy || takerBuyHeavy) heatSignal = "LONG_HEAVY";
  else if (fundingShortHeavy || lsShortHeavy || takerSellHeavy) heatSignal = "SHORT_HEAVY";

  let squeezeRisk: import("./src/types.js").MarketHeatData["squeezeRisk"] = "NONE";
  if (fundingExtreme && fundingRate > 0 && lsLongHeavy) squeezeRisk = "LONG_SQUEEZE";
  if (fundingExtreme && fundingRate < 0 && lsShortHeavy) squeezeRisk = "SHORT_SQUEEZE";

  return { heatSignal, squeezeRisk };
}

async function getAssetHeatData(asset: TradingAsset, forceRefresh = false): Promise<import("./src/types.js").MarketHeatData | null> {
  const cached = assetHeatCaches.get(asset);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;

  const cfg = ASSET_CONFIG[asset];
  const symbol = cfg.binanceSymbol;

  const [funding, taker, ls] = await Promise.all([
    fetchBinanceFundingRate(symbol),
    fetchBinanceTakerRatio(symbol, "5m"),
    fetchBinanceLongShortRatio(symbol, "5m"),
  ]);

  if (!funding && !taker && !ls) {
    return cached?.data ?? null;
  }

  const fundingRate = funding?.fundingRate ?? 0;
  const takerRatio = taker?.buySellRatio ?? 1;
  const lsRatio = ls?.longShortRatio ?? 1;
  const { heatSignal, squeezeRisk } = computeHeatSignal(fundingRate, takerRatio, lsRatio);

  const data: import("./src/types.js").MarketHeatData = {
    asset,
    fundingRate,
    fundingAnnualized: fundingRate * 3 * 365, // 3x per day * 365 days
    nextFundingTime: funding?.nextFundingTime ?? 0,
    takerBuySellRatio: takerRatio,
    takerBuyVol: taker?.buyVol ?? 0,
    takerSellVol: taker?.sellVol ?? 0,
    longShortRatio: lsRatio,
    longAccount: ls?.longAccount ?? 0.5,
    shortAccount: ls?.shortAccount ?? 0.5,
    heatSignal,
    squeezeRisk,
    updatedAt: Date.now(),
  };

  assetHeatCaches.set(asset, { data, expiresAt: Date.now() + HEAT_CACHE_MS });
  return data;
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
      // BTC-only divergence tracker
      // (shared ring buffer bug) → produces false signals. Restrict to BTC only.
      if (
        strength === "STRONG" &&
        (direction === "UP" || direction === "DOWN") &&
        botEnabled &&
        now - lastDivergenceFastTradeAt > 30 &&
        onStrongDivergence &&
        currentDivergenceAsset === "BTC"
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
  // Calibrator startup: load if present; else auto-bootstrap from synthetic
  // training data so BOT_REQUIRE_CALIBRATOR=true (now the default) does not
  // permanently halt trading on a fresh install. Synthetic = SYNTH replay on
  // historical Binance candles; consider it a prior, not a final model.
  // Override the auto-bootstrap with CALIBRATOR_AUTO_BOOTSTRAP=false.
  {
    const loaded = loadCalibrator();
    if (loaded?.ready) {
      const m = loaded.model!;
      const cv = Number.isFinite(m.cvBrier) ? m.cvBrier.toFixed(4) : "n/a";
      console.log(`[Calibrate] Model loaded: n=${loaded.nSamples} | CV Brier=${cv} | trained ${new Date(m.trainedAt).toISOString()}`);
    } else if (process.env.CALIBRATOR_AUTO_BOOTSTRAP !== "false") {
      console.log(`[Calibrate] No trained model on disk — auto-bootstrapping from synthetic training set…`);
      void (async () => {
        try {
          const history = await getBtcHistory(true);
          const candles = (history?.history ?? []).map((c: BtcCandle) => ({
            time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
          }));
          if (candles.length < 100) {
            console.warn(`[Calibrate] Bootstrap skipped — only ${candles.length} candles available (need ≥ 100). Train manually via POST /api/calibrator/train once history accumulates.`);
            return;
          }
          const synth = buildSyntheticTrainingSet(candles, { horizon: 5, stride: 1 });
          if (synth.length < 50) {
            console.warn(`[Calibrate] Bootstrap produced only ${synth.length} samples — skipping (need ≥ 50).`);
            return;
          }
          const state = retrainCalibrator(synth, {
            minTrades: Math.min(100, Math.floor(synth.length * 0.5)),
          });
          if (state.ready && state.model) {
            const cv = Number.isFinite(state.model.cvBrier) ? state.model.cvBrier.toFixed(4) : "n/a";
            console.log(`[Calibrate] Bootstrap trained on ${state.nSamples} synthetic samples | CV Brier=${cv}. Replace via POST /api/calibrator/train once you have live trades.`);
          } else {
            console.warn(`[Calibrate] Bootstrap completed but model not ready: ${state.reason}`);
          }
        } catch (e: any) {
          console.error(`[Calibrate] Bootstrap failed: ${e?.message ?? e}`);
        }
      })();
    } else {
      console.warn(`[Calibrate] No trained model on disk and auto-bootstrap disabled. ${BOT_REQUIRE_CALIBRATOR ? "Trades will be REFUSED" : "Trades will fall back to heuristic gate"} until POST /api/calibrator/train succeeds.`);
    }
  }

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

  // ── Retry helper for transient CLOB/network errors ─────────────────────────
  // Retries: timeout, connection reset, rate-limit (429), server errors (5xx).
  // Does NOT retry: permanent errors (insufficient balance, invalid params, auth).
  async function withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {}
  ): Promise<T> {
    const { maxRetries = 3, baseDelayMs = 500, label = "operation" } = opts;
    let lastErr: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || err?.error || "");
        const isTransient =
          /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket|network|rate limit|too many requests|429|5\d\d|temporarily unavailable|service unavailable/i.test(msg) ||
          err?.code === "ECONNRESET" ||
          err?.code === "ETIMEDOUT" ||
          err?.code === "ECONNREFUSED";

        if (!isTransient || attempt === maxRetries) throw err;

        const delay = baseDelayMs * Math.pow(2, attempt);
        botPrint("WARN", `[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.slice(0, 80)} — retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

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
    if (paperMode) {
      const parsedAmount = Number(amount);
      const parsedSide = String(side || "BUY").toUpperCase() as Side;
      const parsedPrice = Number(price) || 0.5;
      const normalizedAmountMode = amountMode || (parsedSide === Side.BUY ? "SPEND" : "SIZE");
      const orderSize = normalizedAmountMode === "SIZE"
        ? parsedAmount
        : parsedSide === Side.BUY
          ? parsedAmount / parsedPrice
          : parsedAmount;
      return {
        success: true,
        orderID: `PAPER-${Date.now()}`,
        status: "PENDING",
        tickSize: 0.01,
        negRisk: false,
        orderSize: Number(orderSize.toFixed(6)),
        spendingAmount: normalizedAmountMode === "SPEND" ? parsedAmount : Number((parsedAmount * parsedPrice).toFixed(6)),
        executionMode: String(executionMode || "MANUAL").toUpperCase(),
        amountMode: normalizedAmountMode,
        limitPriceUsed: parsedPrice,
        marketSnapshot: { bestBid: null, bestAsk: null, spread: null, distanceToMarket: 0 },
        raw: null,
      };
    }

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

    const orderbook = await withRetry(() => client.getOrderBook(tokenID), { label: "getOrderBook" });
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
      withRetry(() => client.getTickSize(tokenID), { label: "getTickSize" }),
      withRetry(() => client.getNegRisk(tokenID), { label: "getNegRisk" }),
    ]);

    if (parsedSide === Side.BUY && normalizedAmountMode === "SPEND") {
      const allowance = await withRetry(() => client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }), { label: "getBalanceAllowance" });
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

    const order = await withRetry(
      () => client.createAndPostOrder(
        {
          tokenID,
          size: Number(orderSize.toFixed(6)),
          side: parsedSide,
          price: parsedPrice,
        },
        { tickSize, negRisk },
        OrderType.GTC
      ),
      { label: "createAndPostOrder", maxRetries: 3 }
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
    // TP/SL scaled to absolute price zone — binaries have non-linear payoff.
    // TP targets are deliberately tight: 5-min binary markets mean-revert fast,
    // so we take realistic gains rather than holding for a large move that rarely lands.
    let tpTarget: number;
    let slTarget: number;
    let trailingDistance: number;

    if (averagePrice < 0.35) {
      tpTarget = Math.min(0.68, averagePrice + 0.18); // was +0.30 — too ambitious
      slTarget = Math.max(0.01, averagePrice - 0.08);
      trailingDistance = 0.06;
    } else if (averagePrice < 0.50) {
      tpTarget = Math.min(0.68, averagePrice + 0.14); // was +0.22
      slTarget = Math.max(0.01, averagePrice - 0.07);
      trailingDistance = 0.05;
    } else if (averagePrice < 0.65) {
      tpTarget = Math.min(0.74, averagePrice + 0.11); // was +0.18
      slTarget = Math.max(0.01, averagePrice - 0.07);
      trailingDistance = 0.04;
    } else {
      // High-price entry: very limited upside
      tpTarget = Math.min(0.84, averagePrice + 0.08); // was +0.10
      slTarget = Math.max(0.01, averagePrice - 0.06);
      trailingDistance = 0.03;
    }

    return {
      takeProfit: tpTarget.toFixed(2),
      stopLoss: slTarget.toFixed(2),
      trailingStop: trailingDistance.toFixed(2),
    };
  };

  // ── Divergence Fast-Path Trade implementation ─────────────────────────────
  // Wired to onStrongDivergence so the tracker can call it directly without
  // waiting for the next bot cycle (saves the ~2-3s round-trip).
  onStrongDivergence = (
    direction: "UP" | "DOWN",
    snapshot: { yesAsk: number | null; noAsk: number | null; btcDelta: number }
  ) => {
    // DISABLED: divergence fast path bypasses rules engine. Trade data shows 0% WR on divergence-only trades.
    // Divergence now serves ONLY as a signal input to the main rules engine.
    botPrint("SKIP", `[DIV FAST] Divergence fast path DISABLED. STRONG divergence logged as signal only.`);
    return;

    const fastAsset = currentDivergenceAsset;
    // Divergence fast path is BTC-only — ETH/SOL use a shared ring buffer that
    // compares BTC price deltas against ETH/SOL thresholds, causing false signals.
    if (fastAsset !== "BTC") {
      botPrint("SKIP", `[DIV FAST][${fastAsset}] Divergence fast path restricted to BTC only — skipping`);
      return;
    }
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

        // Entry price gate — STRONG divergence gets the 80¢ override (same as main cycle)
        const confidence = 78;
        const MAX_ENTRY_PRICE = maxEntryPriceFor(confidence, true);
        if (bestAsk > MAX_ENTRY_PRICE) {
          botPrint("SKIP", `[DIV FAST] Price too high: ${(bestAsk * 100).toFixed(1)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ — window closed`);
          return;
        }

        const priceHeadroom = parseFloat((MAX_ENTRY_PRICE - bestAsk).toFixed(4));
        if (confidence < cfg.minConfidence || priceHeadroom < cfg.minEdge) return;

        // Sizing — fixed bet from runtime config. `confidence` is a
        // heuristic point score, not a calibrated probability; sizing on it is unsafe.)
        const balance = lastKnownBalance ?? botSessionStartBalance ?? 0;
        if (balance <= 0) return;

        const MIN_BET = Math.min(0.50, balance * 0.20);
        const betAmount = getFixedEntryBetAmount(balance);

        if (betAmount < MIN_BET) {
          botPrint("SKIP", `[DIV FAST] Bet too small: $${betAmount.toFixed(2)} < $${MIN_BET.toFixed(2)} min`);
          return;
        }

        botPrint("TRADE", `⚡ DIVERGENCE FAST PATH ⚡ STRONG BTC ${snapshot.btcDelta >= 0 ? "+" : ""}$${snapshot.btcDelta.toFixed(0)} (30s) → ${direction} | ask=${(bestAsk * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)} USDC`);

        // Mark handled before async execute — prevents race with bot cycle
        divAssetSet.add(market.id);
        markTradeExecutionStarted(fastAsset, market.id);
        lastDivergenceFastTradeAt = now;

        const nowWindowStart = Math.floor(now / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;
        const fastRec = {
          decision: "TRADE",
          direction,
          confidence,
          estimatedEdge: priceHeadroom,
          riskLevel: "MEDIUM",
          reasoning: `[DIV FAST PATH] STRONG divergence: BTC ${snapshot.btcDelta >= 0 ? "+" : ""}$${snapshot.btcDelta.toFixed(0)} in 30s, YES lagging.`,
          candlePatterns: [],
          dataMode: "FULL_DATA" as const,
          reversalProbability: 30,
          oppositePressureProbability: 25,
          reversalReasoning: "Strong structural price lag",
        };
        // Cache so the next bot cycle reuses this result for the window
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
        botPrint("OK", `⚡ FAST PATH EXECUTED ✓ | ID: ${tradeResult.orderID} | Status: ${tradeResult.status}`);
        void sendNotification(
          `⚡ <b>FAST PATH TRADE</b>\nMarket: ${market.question?.slice(0, 60) ?? "BTC 5m"}\nDirection: ${direction === "UP" ? "▲ UP" : "▼ DOWN"}\nAmount: $${betAmount.toFixed(2)} USDC @ ${(bestAsk * 100).toFixed(1)}¢\nConf: ${confidence}% | Headroom: ${(priceHeadroom * 100).toFixed(1)}¢\n(STRONG divergence)`
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
          edge: priceHeadroom,
          reasoning: fastRec.reasoning,
          windowElapsedSeconds: now - nowWindowStart,
          asset: fastAsset,
          isPaperTrade: paperMode,
        });
        botPrint("INFO", `Result tracker armed — checking after ${new Date((nowWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);

        // ── Correlated multi-asset entry ──────────────────────────────────────
        // REMOVED: BTC-only mode. No ETH/SOL correlated entries.

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
          const entryTimestamp = automation.lastTriggeredAt
            ? Math.floor(new Date(automation.lastTriggeredAt).getTime() / 1000)
            : 0;
          const secondsSinceEntry = entryTimestamp > 0 ? nowSeconds - entryTimestamp : 9999;
          if (!triggerReason && entryPrice > 0 && secondsSinceEntry <= 120) {
            const spikeGain = currentPrice - entryPrice;
            if (spikeGain >= 0.12) {
              triggerReason = `spike capture (+${(spikeGain * 100).toFixed(0)}¢ in ${secondsSinceEntry}s — taking early gain)`;
            }
          }

          // Near-expiry: exit any profitable position (prevents late-window reversal)
          if (!triggerReason && isNearExpiry && entryPrice > 0 && currentPrice > entryPrice * 1.005) {
            triggerReason = `near-expiry exit (${secondsToExpiry}s remaining — locking ${(((currentPrice / entryPrice) - 1) * 100).toFixed(1)}% gain)`;
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

      // ── Daily PnL accounting (live trades only) ─────────────────────────
      if (!pending.isPaperTrade) recordDailyPnl(pnl);

      if (won_final) {
        if (!pending.isPaperTrade) {
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
        }
        const paperTag = pending.isPaperTrade ? " [PAPER]" : "";
        botPrint("OK", `━━━ 🏆 WIN${paperTag} ━━━ ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
        const winLesson = generateWinLesson(pending);
        if (!pending.isPaperTrade) winMemory.unshift({
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
        if (!pending.isPaperTrade && winMemory.length > 20) winMemory.pop();
        botPrint("INFO", `Win pattern recorded: ${winLesson}`);
        if (!pending.isPaperTrade) saveLearning();
        (pending.isPaperTrade ? savePaperTradeLog : saveTradeLog)({
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
        const lesson = generateLesson(pending);

        if (!pending.isPaperTrade) {
          const cLosses = (consecutiveLossesByAsset.get(pendingAsset) ?? 0) + 1;
          consecutiveLossesByAsset.set(pendingAsset, cLosses);
          consecutiveWinsByAsset.set(pendingAsset, 0);

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

          // ── Phase 0 risk halts ────────────────────────────────────────────
          if (cLosses >= RISK_MAX_CONSEC_LOSSES) {
            triggerRiskHalt(`Consecutive-loss limit hit (${cLosses} ≥ ${RISK_MAX_CONSEC_LOSSES})`);
          }
          if (botSessionStartBalance && botSessionStartBalance > 0) {
            const dailyLoss = -todayPnl(); // positive if losing money
            const dailyLossPct = (dailyLoss / botSessionStartBalance) * 100;
            if (dailyLossPct >= RISK_DAILY_LOSS_PCT) {
              triggerRiskHalt(`Daily loss limit hit (-${dailyLossPct.toFixed(1)}% ≥ -${RISK_DAILY_LOSS_PCT}%)`);
            }
          }
        }
        const paperTagLoss = pending.isPaperTrade ? " [PAPER]" : "";
        botPrint("WARN", `━━━ ✗ LOSS${paperTagLoss} ━━━ ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
        botPrint("INFO", `Lesson recorded: ${lesson}`);
        if (!pending.isPaperTrade) saveLearning();
        (pending.isPaperTrade ? savePaperTradeLog : saveTradeLog)({
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
        reasoning: `${pending.isPaperTrade ? "[PAPER] " : ""}Market resolved ${won_final ? "IN YOUR FAVOR ✓" : "AGAINST YOU ✗"} | Direction: ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}${!won_final ? ` | Lesson: ${generateLesson(pending)}` : ""}`,
        tradeExecuted: false,
        tradeAmount: pending.betAmount,
        tradePrice: pending.entryPrice,
        orderId: pending.orderId,
      });
      if (botLog.length > 100) botLog.pop();

      pendingResults.delete(tokenId);

      // Refresh the calibrator with the new outcome (debounced internally).
      // Live trades only; paper outcomes are excluded inside the helper.
      if (!pending.isPaperTrade) void maybeRetrainCalibratorFromTradeLog();
    }
  };

  // ── Bot cycle ──────────────────────────────────────────────────────────────
  const triggerRiskHalt = (reason: string) => {
    if (riskHalt.halted) return;
    riskHalt.halted = true;
    riskHalt.reason = reason;
    riskHalt.haltedAt = Math.floor(Date.now() / 1000);
    botEnabled = false;
    if (botInterval) { clearInterval(botInterval); botInterval = null; }
    stopHeartbeat();
    console.error(`[RISK HALT] ${reason}`);
    botPrint("ERR", `🛑 RISK HALT — ${reason}. Bot disabled until manual reset (/api/risk/reset).`);
    void sendNotification(`🛑 <b>RISK HALT</b>\n${reason}\nBot disabled. Reset via /api/risk/reset.`);
  };

  const runBotCycle = async () => {
    if (botRunning || !botEnabled) return;
    if (riskHalt.halted) {
      botPrint("SKIP", `Bot halted: ${riskHalt.reason}`);
      if (botInterval) { clearInterval(botInterval); botInterval = null; }
      return;
    }

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
        botLastWindowStart = currentWindowStart;
        // Clear all per-asset YES ring buffers — old window's tokens are no longer valid
        for (const buf of yesRingBufferByAsset.values()) buf.length = 0;
        currentWindowYesTokenId = null;
        currentWindowNoTokenId  = null;
        currentWindowYesTokenIdByAsset.clear();
        currentWindowNoTokenIdByAsset.clear();
        botPrint("INFO", `━━━━ NEW WINDOW ━━━━ ${new Date(currentWindowStart * 1000).toLocaleTimeString()} — ${new Date((currentWindowStart + 300) * 1000).toLocaleTimeString()}`);
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

      const parseArr = (val: any): any[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
        return [];
      };

      // ── Fetch all asset markets in parallel, then process sequentially ──────
      const marketsByAsset = new Map<TradingAsset, any[]>();
      await Promise.allSettled(ENABLED_ASSETS.map(async (asset) => {
        const slug = `${ASSET_CONFIG[asset].polySlugPrefix}-${currentWindowStart}`;
        botPrint("INFO", `[${asset}] Scanning window ${mm}:${ss} remaining | elapsed=${windowElapsedSeconds}s | slug=${slug}`);
        try {
          const eventRes = await axios.get(`https://gamma-api.polymarket.com/events/slug/${slug}`, { timeout: 8000 });
          const event = eventRes.data;
          const markets = (event?.markets || []).map((m: any) => ({
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
            botPrint("WARN", `[${asset}] No markets found for slug: ${slug}`);
          } else {
            botPrint("INFO", `[${asset}] Found ${markets.length} market(s) for window`);
            marketsByAsset.set(asset, markets);
          }
        } catch {
          botPrint("ERR", `[${asset}] Failed to fetch market for slug: ${slug}`);
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
          let heatData: import("./src/types.js").MarketHeatData | null = null;
          let orderBooks: Record<string, any>;
          let marketHistory: { t: number; yes: number; no: number }[];

          {
            // Fetch all data fresh (no prefetch)
            botPrint("INFO", `[${currentAsset}] Fetching price, history, indicators, sentiment...`);
            [btcPriceData, btcHistoryResult, btcIndicatorsData, sentimentData, heatData] = await Promise.all([
              getAssetPrice(currentAsset),
              getAssetHistory(currentAsset),
              getAssetIndicators(currentAsset),
              axios.get("https://api.alternative.me/fng/", { timeout: 5000 })
                .then((r) => r.data.data[0]).catch(() => null),
              getAssetHeatData(currentAsset),
            ]);
            botPrint("OK", `[${currentAsset}] $${btcPriceData?.price ?? "?"} | Candles: ${btcHistoryResult?.history?.length ?? 0} | RSI: ${btcIndicatorsData?.rsi?.toFixed(1) ?? "?"} | EMA: ${btcIndicatorsData?.emaCross ?? "?"} | Sentiment: ${sentimentData?.value_classification ?? "?"} | Heat: ${heatData?.heatSignal ?? "?"} squeeze=${heatData?.squeezeRisk ?? "?"}`);

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
                // Phase 1 — append full ladder snapshot to disk for the
                // book-replay backtester. Disabled via OB_LOG_DISABLED=true.
                if (process.env.OB_LOG_DISABLED !== "true") {
                  const snap = buildOrderBookSnapshot({
                    rawBook: raw,
                    marketId: String(market.id),
                    market: market.question || String(market.id),
                    eventSlug: market.eventSlug ?? null,
                    tokenId: tid,
                    outcomeIndex: idx,
                    outcome,
                    asset: currentAsset,
                    windowStart: currentWindowStart,
                    imbalance,
                    imbalanceSignal,
                    totalLiquidityUsdc,
                  });
                  if (snap) appendOrderBookSnapshot(ORDERBOOK_LOG_FILE, snap);
                }
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

          // ── Early window coin-flip guard ──────────────────────────────────
          // Block trade in first 30s if there's no divergence and BTC is flat.
          // Relaxed from 60s: FastLoop + alignment fallback now provides direction
          // even with fewer candles, so 30s is sufficient to avoid pure coin-flip.
          if (windowElapsedSeconds < 30) {
            const btcFlat = !div || (div.strength === "NONE" && Math.abs(div.btcDelta30s) < 5);
            const noDivergence = !div || div.strength === "NONE";
            if (noDivergence && btcFlat) {
              botPrint("SKIP", `Early window coin-flip guard: elapsed=${windowElapsedSeconds}s, no divergence, BTC flat — waiting for signal | re-check enabled`);
              analyzedThisWindow.delete(market.id); // allow re-check once past 30s or when signal appears
              continue;
            }
          }

          // ── FAST PATH: synthesize directly when signals are overwhelmingly clear ────
          // Conditions (ALL must be true):
          //   1. FastLoop STRONG and directional
          //   2. Multi-TF alignment 4/5 or 5/5 in same direction
          //   3. Divergence STRONG or MODERATE in same direction (or no conflict)
          //   4. No recent loss pattern match (avoid repeating bad setups)

          // Compute local alignment score
          // Signals: 60m bias, 5m confirmation, 1m trigger, technical score, FastLoop, Market Heat
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
          // Market heat alignment (contrarian short-term: extreme positioning = fade signal)
          if (heatData) {
            if (heatData.heatSignal === "EXTREME_LONG" || heatData.heatSignal === "LONG_HEAVY") {
              _localBearish++; // crowd already long, fading upside
            } else if (heatData.heatSignal === "EXTREME_SHORT" || heatData.heatSignal === "SHORT_HEAVY") {
              _localBullish++; // crowd already short, fading downside
            }
          }
          const localAlignment = { bullish: _localBullish, bearish: _localBearish };

          // ── FastLoop pre-filter: skip only when momentum flat AND alignment too weak ──
          // Relaxed: WEAK FastLoop no longer blocks if ≥2 technical signals agree.
          // This allows SYNTH to run when e.g. EMA + signalScore align even without strong momentum.
          const fastMomWeak = !fastMom || fastMom.direction === "NEUTRAL" || fastMom.strength === "WEAK";
          const techAlignScore = Math.max(localAlignment.bullish, localAlignment.bearish);
          if (fastMomWeak && (!div || div.strength === "NONE") && techAlignScore < 2) {
            botPrint("SKIP", `FastLoop pre-filter: ${fastMom ? `${fastMom.direction} ${fastMom.strength}` : "no data"} + no divergence + align=${techAlignScore}/5 — skipping | re-check enabled`);
            analyzedThisWindow.delete(market.id);
            continue;
          }

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
            const fastEntryRef = fastPathDir === "UP"
              ? parseFloat(market.outcomePrices?.[0] ?? "0.5")
              : parseFloat(market.outcomePrices?.[1] ?? "0.5");
            const fastMaxEntry = maxEntryPriceFor(fastConf, div?.strength === "STRONG");
            const fastHeadroom = parseFloat((fastMaxEntry - fastEntryRef).toFixed(4));
            rec = {
              decision: fastEntryRef > 0 && fastEntryRef <= fastMaxEntry ? "TRADE" : "NO_TRADE",
              direction: fastPathDir,
              confidence: fastConf,
              estimatedEdge: fastHeadroom,
              candlePatterns: [],
              reasoning: `[FAST PATH] ${alignmentScore}/5 signals aligned ${fastPathDir} | FastLoop STRONG vw=${fastMom!.volumeWeighted.toFixed(3)}% accel=${fastMom!.acceleration.toFixed(3)}%${div && div.strength !== "NONE" ? ` | Divergence ${div.strength} ${div.direction}` : ""}${heatData ? ` | heat=${heatData.heatSignal} squeeze=${heatData.squeezeRisk}` : ""}`,
              riskLevel: alignmentScore === 5 ? "LOW" : "MEDIUM",
              dataMode: "FULL_DATA" as const,
              reversalProbability: alignmentScore === 5 ? 20 : 30,
              oppositePressureProbability: 25,
              reversalReasoning: "Fast path — strong multi-signal consensus",
            };
            botPrint(rec.decision === "TRADE" ? "TRADE" : "SKIP", `⚡ FAST PATH ⚡ ${alignmentScore}/5 aligned ${fastPathDir} | FastLoop STRONG | conf=${fastConf}% | headroom=${(fastHeadroom * 100).toFixed(1)}¢${heatData ? ` | heat=${heatData.heatSignal}` : ""}`);
            currentWindowAiCache.set(currentAsset, { windowStart: currentWindowStart, marketId: market.id, rec });

          // ── NORMAL PATH: price-lag signal synthesizer ───────
          } else if (currentWindowAiCache.get(currentAsset)?.windowStart === currentWindowStart && currentWindowAiCache.get(currentAsset)?.marketId === market.id) {
            rec = currentWindowAiCache.get(currentAsset)!.rec;
            botPrint("OK", `Reusing signal (price re-check): ${rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—"} ${rec.decision} ${rec.direction !== "NONE" ? rec.direction : ""} | conf=${rec.confidence}%`);
          } else {
            // Synthesize rec from FastLoop + divergence + alignment — no external AI call.
            // Fallback: if FastLoop is NEUTRAL, use alignment majority direction.
            const alignDir: "UP" | "DOWN" | "NONE" =
              localAlignment.bullish > localAlignment.bearish ? "UP"
              : localAlignment.bearish > localAlignment.bullish ? "DOWN"
              : "NONE";
            const synthDir: "UP" | "DOWN" | "NONE" =
              fastMom && fastMom.direction !== "NEUTRAL" ? fastMom.direction
              : div && div.strength !== "NONE" && div.direction !== "NEUTRAL" ? div.direction as "UP" | "DOWN"
              : alignDir !== "NONE" ? alignDir
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
              const momBoost   = fastMom?.strength === "STRONG" ? 10 : fastMom?.strength === "MODERATE" ? 5 : 0;
              const techBoost  = btcIndicatorsData?.signalScore != null ? Math.min(8, Math.abs(btcIndicatorsData.signalScore) * 2) : 0;
              const lossStreak = assetLossMemory.filter(l => l.direction === synthDir).length;
              const streakPenalty = lossStreak >= 2 ? lossStreak * 3 : 0;

              // Market heat squeeze boost: squeeze in same direction = momentum catalyst
              let heatBoost = 0;
              if (heatData) {
                if (heatData.squeezeRisk === "LONG_SQUEEZE" && synthDir === "UP") heatBoost = 4;
                else if (heatData.squeezeRisk === "SHORT_SQUEEZE" && synthDir === "DOWN") heatBoost = 4;
                else if (heatData.squeezeRisk === "LONG_SQUEEZE" && synthDir === "DOWN") heatBoost = -3;
                else if (heatData.squeezeRisk === "SHORT_SQUEEZE" && synthDir === "UP") heatBoost = -3;
              }

              // Base 60 (was 55) + align weight ×5 (was ×4) → 3/5 align + MODERATE FastLoop = 60+15+5=80%
              let synthConf = 60 + alignScore * 5 + divBoost + momBoost + techBoost + heatBoost - streakPenalty;
              synthConf = Math.max(55, Math.min(90, Math.round(synthConf)));

              const riskLevel: "LOW" | "MEDIUM" | "HIGH" =
                synthConf >= 75 && alignScore >= 3 ? "LOW"
                : synthConf >= 65 ? "MEDIUM"
                : "HIGH";

              const entryRef  = synthDir === "UP"
                ? (parseFloat(market.outcomePrices?.[0] ?? "0.5"))
                : (parseFloat(market.outcomePrices?.[1] ?? "0.5"));
              // Price-cap framing: would we pay this
              // implied price given our heuristic conviction? Headroom is purely
              // for display / logging, never for sizing.
              const isDivergenceStrongForCap = div?.strength === "STRONG" && div.direction === synthDir;
              const synthMaxEntry = maxEntryPriceFor(synthConf, isDivergenceStrongForCap);
              const synthHeadroom = parseFloat((synthMaxEntry - entryRef).toFixed(4));

              rec = {
                decision: entryRef > 0 && entryRef <= synthMaxEntry ? "TRADE" : "NO_TRADE",
                direction: synthDir,
                confidence: synthConf,
                // `estimatedEdge` retained for back-compat with persisted trade logs.
                // It now stores the price headroom (maxEntry − entry).
                estimatedEdge: synthHeadroom,
                riskLevel,
                reasoning: `[SYNTH] ${synthDir} | align=${alignScore}/5 | FastLoop=${fastMom?.strength ?? "N/A"} vw=${fastMom?.volumeWeighted?.toFixed(3) ?? "0"}% | div=${div?.strength ?? "NONE"} | tech=${btcIndicatorsData?.signalScore ?? 0} | heat=${heatData?.heatSignal ?? "?"} squeeze=${heatData?.squeezeRisk ?? "?"} | streak-${synthDir}=${lossStreak}L`,
                candlePatterns: [],
                dataMode: "FULL_DATA" as const,
                reversalProbability: Math.max(15, 50 - alignScore * 7),
                oppositePressureProbability: 30,
                reversalReasoning: "Synthesized from local signals",
              };
              botPrint("INFO", `[SYNTH] ${synthDir} conf=${synthConf}% maxEntry=${(synthMaxEntry*100).toFixed(0)}¢ implied=${(entryRef*100).toFixed(0)}¢ headroom=${(synthHeadroom*100).toFixed(1)}¢ align=${alignScore}/5 div=${div?.strength ?? "NONE"} mom=${fastMom?.strength ?? "N/A"} heat=${heatData?.heatSignal ?? "?"} squeeze=${heatData?.squeezeRisk ?? "?"}`);
            }
            currentWindowAiCache.set(currentAsset, { windowStart: currentWindowStart, marketId: market.id, rec });
          }

          // ── Apply divergence overrides AFTER AI decision ────────────────
          // DISABLED: divergence overrides removed. Divergence now serves ONLY as a signal
          // input (via divBoost in synthConf and alignment scoring). Trade data showed
          // divergence-only trades at 0% WR while non-divergence trades hit 66%.
          // if (div && div.strength !== "NONE" && div.direction !== "NEUTRAL") {
          //   ... override logic removed ...
          // }

          // Log AI result
          const decisionIcon = rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—";
          botPrint(
            rec.decision === "TRADE" ? "INFO" : "SKIP",
            `AI Result: ${decisionIcon} ${rec.decision} ${rec.direction} | conf=${rec.confidence}% | headroom=${(rec.estimatedEdge * 100).toFixed(1)}¢ | risk=${rec.riskLevel}`
          );
          botPrint("INFO", `Reasoning: ${rec.reasoning.slice(0, 120)}`);

          // ── Update entry snapshot for dashboard widget ──────────────────
          {
            const outcomeIdx = rec.direction === "DOWN" ? 1 : 0;
            const oppIdx     = outcomeIdx === 0 ? 1 : 0;
            const tokenIds: string[] = market.clobTokenIds || [];
            const yesAsk = orderBooks[tokenIds[0]]?.asks?.[0]?.price ?? market.outcomePrices?.[0] ?? null;
            const noAsk  = orderBooks[tokenIds[1]]?.asks?.[0]?.price ?? market.outcomePrices?.[1] ?? null;
            const entryAsk = orderBooks[tokenIds[outcomeIdx]]?.asks?.[0]?.price ?? market.outcomePrices?.[outcomeIdx] ?? null;
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
              asset: currentAsset,
              divergence: div && div.strength !== "NONE"
                ? { direction: div.direction, strength: div.strength, btcDelta30s: div.btcDelta30s, yesDelta30s: div.yesDelta30s }
                : null,
              fastLoopMomentum: fastMom ? { direction: fastMom.direction, strength: fastMom.strength, vw: fastMom.volumeWeighted } : null,
              updatedAt: new Date().toISOString(),
            };
            void oppIdx; void entryAsk; // suppress unused warnings
          }

          // ── Pre-calibrator filters ────────────────────────────────────────
          // Phase 1 measurement showed heuristic confidence is anti-informative
          // (Brier 0.349 > 0.25 coin-flip; 87%-bucket realized 33%). The
          // calibrator (run later) is the binding probability gate. The checks
          // below are sanity gates only:
          //   • risk=HIGH: reject (the synth path's own data-quality flag).
          //   • headroom: optional, still useful as a "don't pay >75¢ for a coin".
          //   • confidence: ADVISORY only — does not reject by default.
          //     BOT_CONFIDENCE_HARD_GATE=true restores the legacy hard gate.
          //   • signal policy (KILL rules from Phase 1): blocks BEARISH EMA
          //     cross and SELL_PRESSURE imbalance (override via POLICY_BLOCK_*).
          const policyDecision = evaluatePolicy({
            direction: rec.direction as "UP" | "DOWN",
            emaCross: btcIndicatorsData?.emaCross,
            imbalanceSignal: orderBooks[market.clobTokenIds?.[0]]?.imbalanceSignal,
            rsi: btcIndicatorsData?.rsi,
            divergenceStrength: div?.strength,
          });
          const confidenceShortfall = rec.confidence < effectiveMinConf;
          const qualifies =
            rec.decision === "TRADE" &&
            rec.estimatedEdge >= cfg.minEdge &&
            rec.riskLevel !== "HIGH" &&
            !policyDecision.block &&
            (!BOT_CONFIDENCE_HARD_GATE || !confidenceShortfall);

          if (rec.decision === "TRADE" && !qualifies) {
            const reasons: string[] = [];
            if (policyDecision.block) reasons.push(...policyDecision.reasons);
            if (BOT_CONFIDENCE_HARD_GATE && confidenceShortfall) {
              reasons.push(`conf ${rec.confidence}% < ${effectiveMinConf}% (adaptive, hard gate)`);
            }
            if (rec.estimatedEdge < cfg.minEdge) reasons.push(`headroom ${(rec.estimatedEdge * 100).toFixed(1)}¢ < ${(cfg.minEdge * 100).toFixed(1)}¢`);
            if (rec.riskLevel === "HIGH") reasons.push(`risk=${rec.riskLevel} (need LOW or MEDIUM)`);
            botPrint("SKIP", `Trade rejected by pre-calibrator filters: ${reasons.join(" | ")} | re-check enabled`);
            analyzedThisWindow.delete(market.id); // re-check if divergence or cached conditions improve later this window
          } else if (rec.decision === "TRADE" && confidenceShortfall) {
            // Confidence is below the adaptive floor but the calibrator is now
            // the gate — log the advisory so it's visible without blocking.
            botPrint("INFO", `Advisory: conf ${rec.confidence}% < ${effectiveMinConf}% adaptive floor (heuristic only — calibrator decides)`);
          }

          // ── Order book pressure alignment filter ──────────────────────────────
          // Data from live trades shows:
          //   BUY_PRESSURE  → 67% WR (+$8.84)   ← trade with (UP) or allow (DOWN)
          //   NEUTRAL       → 40% WR (-$1.55)   ← trade with (marginal edge)
          //   SELL_PRESSURE → 20% WR (-$7.64)   ← BLOCK on UP trades only
          // Rule: block when order book pressure opposes trade direction.
          //   UP   trade → block if YES book shows SELL_PRESSURE (crowd selling YES against us)
          //   DOWN trade → block if YES book shows BUY_PRESSURE (crowd buying YES against us)
          //   UNKNOWN → allow if confidence ≥75% (high-confidence setups shouldn't be
          //   blocked by missing order book data, which is common early in the window)
          if (qualifies) {
            const tokenIds: string[] = market.clobTokenIds || [];
            const yesSignal = orderBooks[tokenIds[0]]?.imbalanceSignal ?? "UNKNOWN";
            const pressureOpposesDirection =
              (rec.direction === "UP" && yesSignal === "SELL_PRESSURE") ||
              (rec.direction === "DOWN" && yesSignal === "BUY_PRESSURE");
            const unknownBlocked = yesSignal === "UNKNOWN" && rec.confidence < 75;

            if (pressureOpposesDirection || unknownBlocked) {
              const reason = pressureOpposesDirection
                ? `${yesSignal} opposes ${rec.direction}`
                : "UNKNOWN book (conf<75%)";
              botPrint("SKIP", `Pressure filter: direction=${rec.direction} | YES book=${yesSignal} — blocked (${reason}) | re-check next cycle`);
              analyzedThisWindow.delete(market.id); // re-check each cycle in case pressure shifts
              pushSSE("cycle", { ts: new Date().toISOString() });
              continue;
            }
            botPrint("INFO", `Pressure check: direction=${rec.direction} | YES book=${yesSignal} ✓${yesSignal === "UNKNOWN" ? " (conf≥75% bypass)" : ""}`);
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
                botLog.unshift(logEntry);
                if (botLog.length > 100) botLog.pop();
                break;
              }

              // ── Sizing (flat) + microstructure & risk gates ─────────────────
              // `confidence` is a heuristic score, NOT a probability — sizing stays flat.
              const outcomeIndex = rec.direction === "UP" ? 0 : 1;
              const tokenId: string = market.clobTokenIds?.[outcomeIndex];
              if (tokenId) {
                const ob = orderBooks[tokenId];
                const clobAsk = Number(ob?.asks?.[0]?.price || "0");
                const bestBid = Number(ob?.bids?.[0]?.price || "0");

                // ── Session drawdown gate (Phase 0 fix 2) ─────────────────────
                if (botSessionStartBalance && botSessionStartBalance > 0) {
                  if (botSessionPeakBalance === null || currentBalance > botSessionPeakBalance) {
                    botSessionPeakBalance = currentBalance;
                  }
                  const peak = botSessionPeakBalance ?? botSessionStartBalance;
                  const ddPct = peak > 0 ? ((peak - currentBalance) / peak) * 100 : 0;
                  if (ddPct >= RISK_MAX_DRAWDOWN_PCT) {
                    triggerRiskHalt(`Session drawdown limit hit (-${ddPct.toFixed(1)}% from peak ≥ -${RISK_MAX_DRAWDOWN_PCT}%)`);
                    break;
                  }
                }

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
                // This is a heuristic price cap. Confidence is not used as
                // a probability; sizing remains flat unless a calibrated model is wired in.
                if (bestAsk <= 0) {
                  botPrint("SKIP", `No price data available — skipping for now | re-check enabled`);
                  analyzedThisWindow.delete(market.id);
                  continue;
                }

                const isDivergenceStrong = div?.strength === "STRONG";
                const MAX_ENTRY_PRICE = maxEntryPriceFor(rec.confidence, isDivergenceStrong);
                if (bestAsk > MAX_ENTRY_PRICE) {
                  const priceSource = (clobAsk > 0 && clobAsk < CLOB_SPREAD_THRESHOLD) ? "CLOB" : "AMM";
                  botPrint("SKIP", `Entry price too high: ${priceSource}=${( bestAsk * 100).toFixed(1)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ max (conf=${rec.confidence}%${isDivergenceStrong ? ", divergence override" : ""}). Monitoring for better price | re-check enabled`);
                  logEntry.reasoning += ` | Skipped: bestAsk ${(bestAsk * 100).toFixed(0)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ dynamic max (conf=${rec.confidence}%).`;
                  botLog.unshift(logEntry);
                  if (botLog.length > 100) botLog.pop();
                  // Remove from analyzed set so next cycle re-checks the price
                  // (signal is still valid, only price was too high this moment)
                  analyzedThisWindow.delete(market.id);
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }

                // ── Phase 0 Fix 6: spread / liquidity / volatility gates ────
                // Spread: skip if too wide — wide books mean adverse selection risk.
                if (bestBid > 0 && bestAsk > 0) {
                  const spread = bestAsk - bestBid;
                  if (spread > GATE_MAX_SPREAD) {
                    botPrint("SKIP", `Spread gate: ${(spread * 100).toFixed(1)}¢ > ${(GATE_MAX_SPREAD * 100).toFixed(1)}¢ max — book too wide | re-check enabled`);
                    analyzedThisWindow.delete(market.id);
                    pushSSE("cycle", { ts: new Date().toISOString() });
                    continue;
                  }
                }
                // Top-of-book liquidity: notional USDC at touch must exceed floor.
                const tobBidSize = Number(ob?.bids?.[0]?.size || "0");
                const tobAskSize = Number(ob?.asks?.[0]?.size || "0");
                const tobNotional = (tobBidSize * (bestBid || 0)) + (tobAskSize * (bestAsk || 0));
                if (tobNotional < GATE_MIN_TOB_LIQ_USDC) {
                  botPrint("SKIP", `Liquidity gate: TOB notional $${tobNotional.toFixed(2)} < $${GATE_MIN_TOB_LIQ_USDC} min — thin book | re-check enabled`);
                  analyzedThisWindow.delete(market.id);
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }
                // Volatility: skip if normalized 1m ATR is above ceiling (news / flash move).
                const btcCandles = btcHistoryResult?.history ?? [];
                if (btcCandles.length >= 5 && btcPriceData?.price) {
                  const last10 = btcCandles.slice(-10);
                  const atr = last10.reduce((sum: number, c: BtcCandle) => sum + (c.high - c.low), 0) / last10.length;
                  const btcPriceNum = Number(btcPriceData.price);
                  if (btcPriceNum > 0) {
                    const normalizedAtr = atr / btcPriceNum;
                    if (normalizedAtr > GATE_MAX_NORMALIZED_ATR) {
                      botPrint("SKIP", `Volatility gate: ATR=${atr.toFixed(0)} (${(normalizedAtr * 100).toFixed(2)}% of price) > ${(GATE_MAX_NORMALIZED_ATR * 100).toFixed(2)}% max — too choppy | re-check enabled`);
                      analyzedThisWindow.delete(market.id);
                      pushSSE("cycle", { ts: new Date().toISOString() });
                      continue;
                    }
                  }
                }

                // ── Phase 0 Fix 1: authoritative EV gate via calibrated P(WIN) ───
                // `confidence` is a heuristic point score, NOT a probability. The
                // calibrator (logistic regression on outcome ~ indicators) turns
                // it into a real P(WIN) which is then compared against bestAsk
                // to produce an actual EV. If the model isn't loaded yet, we fall
                // back to the heuristic gate UNLESS BOT_REQUIRE_CALIBRATOR=true.
                const yesImbalanceForCalibrator = orderBooks[market.clobTokenIds?.[0]]?.imbalanceSignal ?? "NEUTRAL";
                const tradeFeatures: TradeFeatures = {
                  direction: rec.direction as "UP" | "DOWN",
                  confidence: rec.confidence,
                  rsi: btcIndicatorsData?.rsi,
                  emaCross: btcIndicatorsData?.emaCross,
                  signalScore: btcIndicatorsData?.signalScore,
                  imbalanceSignal: yesImbalanceForCalibrator,
                  divergenceDirection: div?.direction,
                  divergenceStrength: div?.strength,
                  btcDelta30s: div?.btcDelta30s,
                  yesDelta30s: div?.yesDelta30s,
                  windowElapsedSeconds,
                  entryPrice: bestAsk,
                };
                let calibratedPWin: number | null = null;
                if (isCalibratorReady()) {
                  calibratedPWin = predictPWin(tradeFeatures);
                }

                if (calibratedPWin === null) {
                  if (BOT_REQUIRE_CALIBRATOR) {
                    botPrint("SKIP", `Calibrator not ready and BOT_REQUIRE_CALIBRATOR=true — refusing to trade on heuristic confidence | re-check enabled`);
                    analyzedThisWindow.delete(market.id);
                    pushSSE("cycle", { ts: new Date().toISOString() });
                    continue;
                  }
                  botPrint("WARN", `Calibrator not loaded — falling back to heuristic gate (no EV measurement). Train via POST /api/calibrator/train.`);
                } else {
                  const calibratedEdge = calibratedPWin - bestAsk;
                  botPrint("INFO", `Calibrated: pWin=${(calibratedPWin * 100).toFixed(1)}% | entry=${(bestAsk * 100).toFixed(1)}¢ | EV=${(calibratedEdge * 100).toFixed(1)}¢/share`);
                  if (calibratedPWin < BOT_CALIBRATED_MIN_PWIN) {
                    botPrint("SKIP", `Calibrator gate: pWin ${(calibratedPWin * 100).toFixed(1)}% < ${(BOT_CALIBRATED_MIN_PWIN * 100).toFixed(0)}% min — model says coin-flip or worse | re-check enabled`);
                    analyzedThisWindow.delete(market.id);
                    pushSSE("cycle", { ts: new Date().toISOString() });
                    continue;
                  }
                  if (calibratedEdge < BOT_CALIBRATED_MIN_EDGE) {
                    botPrint("SKIP", `Calibrator gate: EV ${(calibratedEdge * 100).toFixed(1)}¢ < ${(BOT_CALIBRATED_MIN_EDGE * 100).toFixed(1)}¢/share min — price too rich for calibrated probability | re-check enabled`);
                    analyzedThisWindow.delete(market.id);
                    pushSSE("cycle", { ts: new Date().toISOString() });
                    continue;
                  }
                }

                // Minimum bet scales with balance: floor at $0.50 or 20% of balance, whichever smaller
                const MIN_BET = Math.min(0.50, currentBalance * 0.20);

                // Entry sizing is fixed at the runtime-configured fixedTradeUsdc for every buy order.
                // `confidence` is a heuristic score; calibrated pWin (above) is the EV gate. Sizing stays flat.
                const betAmount = getFixedEntryBetAmount(currentBalance);

                botPrint("INFO", `Flat sizing: conf=${rec.confidence}% (heuristic)${calibratedPWin !== null ? ` | pWin=${(calibratedPWin * 100).toFixed(1)}% (calibrated)` : ""} | implied=${(impliedPrice * 100).toFixed(0)}¢ | target=$${getActiveConfig().fixedTradeUsdc.toFixed(2)} → final=$${betAmount.toFixed(2)} USDC`);
                botPrint("INFO", `Balance check: $${currentBalance.toFixed(2)} available | $${betAmount.toFixed(2)} to spend | $${(currentBalance - betAmount).toFixed(2)} remaining after trade`);

                if (betAmount < MIN_BET) {
                  botPrint("SKIP", `Adjusted bet too small ($${betAmount.toFixed(2)} USDC < $${MIN_BET.toFixed(2)} min). Balance too low. Skipping.`);
                  logEntry.reasoning += ` | Skipped: Adjusted bet $${betAmount.toFixed(2)} < $${MIN_BET.toFixed(2)} minimum (balance=$${currentBalance.toFixed(2)}).`;
                } else {
                  const executionStatus = getTradeWindowStatus(currentAsset, market.id);
                  if (executionStatus) {
                    botPrint("SKIP", `[${currentAsset}] Trade ${executionStatus === "EXECUTED" ? "already executed" : "already submitting"} for this market in the current window — order entry cancelled`);
                    continue;
                  }

                  // ob, bestAsk, bestBid already fetched above for the hard gate
                  botPrint("TRADE", `━━━ EXECUTING ORDER ━━━`);
                  botPrint("TRADE", `Direction : ${rec.direction === "UP" ? "▲ UP (YES)" : "▼ DOWN (NO)"}`);
                  botPrint("TRADE", `Amount    : $${betAmount.toFixed(2)} USDC`);
                  botPrint("TRADE", `Price     : ${(bestAsk * 100).toFixed(1)}¢ (ask) | ${(bestBid * 100).toFixed(1)}¢ (bid)`);
                  botPrint("TRADE", `Confidence: ${rec.confidence}% | Headroom: ${(rec.estimatedEdge * 100).toFixed(1)}¢ | Risk: ${rec.riskLevel}`);
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
                      windowEnd: currentWindowStart + MARKET_SESSION_SECONDS,
                      armed: true,
                    });

                    botSessionTradesCount++;
                    logEntry.tradeExecuted = true;
                    logEntry.tradeAmount = betAmount;
                    logEntry.tradePrice = bestAsk;
                    logEntry.orderId = tradeResult.orderID;
                    analyzedThisWindow.add(market.id);
                    botPrint("OK", `Order submitted! ID: ${tradeResult.orderID} | Status: ${tradeResult.status}`);
                    void sendNotification(
                      `✅ <b>TRADE EXECUTED</b>\nMarket: ${market.question?.slice(0, 60) ?? "BTC 5m"}\nDirection: ${rec.direction === "UP" ? "▲ UP" : "▼ DOWN"}\nAmount: $${betAmount.toFixed(2)} USDC @ ${(bestAsk * 100).toFixed(1)}¢\nConf: ${rec.confidence}% | Headroom: ${(rec.estimatedEdge * 100).toFixed(1)}¢ | Risk: ${rec.riskLevel}`
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
                      isPaperTrade: paperMode,
                    });
                    botPrint("INFO", `Result tracker armed — checking after ${new Date((currentWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);
                  } catch (tradeErr: any) {
                    markTradeExecutionFinished(currentAsset, market.id, false);
                    logEntry.error = tradeErr?.message || String(tradeErr);
                    botPrint("ERR", `Trade execution failed: ${logEntry.error}`);
                  }
                }
              }
            }
          } else if (rec.decision === "NO_TRADE") {
            botPrint("SKIP", `No trade — conditions not met, will re-check next cycle`);
            // Remove from analyzed set so next cycle re-evaluates if conditions change.
            // Keep signal cache — only re-check divergence/price/filters.
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
  // Watchdog: N consecutive failures → notification, then risk halt.
  let heartbeatConsecutiveFailures = 0;
  let heartbeatWarnedAt = 0;
  const startHeartbeat = () => {
    if (heartbeatInterval) return;
    const sendHeartbeat = async () => {
      const cl = await getClobClient();
      if (!cl) return;
      try {
        const resp = await cl.postHeartbeat(lastHeartbeatId || null);
        lastHeartbeatId = resp?.heartbeat_id ?? "";
        if (heartbeatConsecutiveFailures > 0) {
          console.log(`[Heartbeat] Recovered after ${heartbeatConsecutiveFailures} failures`);
          botPrint("OK", `Heartbeat recovered after ${heartbeatConsecutiveFailures} failed beats`);
        }
        heartbeatConsecutiveFailures = 0;
      } catch (err: any) {
        // Polymarket returns 400 with the correct heartbeat_id when we send a stale/wrong ID.
        // The SDK throws on 400 but may attach the response body — try to extract it.
        const body = err?.response?.data ?? err?.data ?? null;
        const recoveredId = body?.heartbeat_id ?? body?.id ?? null;
        if (recoveredId) {
          console.warn(`[Heartbeat] 400 — recovered correct ID from response, re-chaining`);
          lastHeartbeatId = recoveredId;
          heartbeatConsecutiveFailures = 0;
          return;
        }
        heartbeatConsecutiveFailures++;
        console.warn(`[Heartbeat] Failed (${heartbeatConsecutiveFailures} consecutive):`, err?.message ?? String(err), "— resetting chain");
        lastHeartbeatId = "";
        const nowMs = Date.now();
        // Warn once per 60s on sustained failures before halt threshold.
        if (heartbeatConsecutiveFailures >= HEARTBEAT_FAIL_WARN_AT &&
            heartbeatConsecutiveFailures < HEARTBEAT_FAIL_HALT_AT &&
            nowMs - heartbeatWarnedAt > 60_000) {
          heartbeatWarnedAt = nowMs;
          botPrint("WARN", `Heartbeat watchdog: ${heartbeatConsecutiveFailures} consecutive failures — open orders may be at risk`);
          void sendNotification(
            `⚠️ <b>HEARTBEAT WATCHDOG</b>\n${heartbeatConsecutiveFailures} consecutive failures.\nPolymarket will cancel open orders after ~10s without heartbeat.`
          );
        }
        if (heartbeatConsecutiveFailures >= HEARTBEAT_FAIL_HALT_AT) {
          triggerRiskHalt(`Heartbeat watchdog tripped (${heartbeatConsecutiveFailures} consecutive failures ≥ ${HEARTBEAT_FAIL_HALT_AT})`);
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
    botPrint("INFO", `Min headroom   : ${(startCfg.minEdge * 100).toFixed(1)}¢`);
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
    const nowSec = Math.floor(Date.now() / 1000);
    res.json({
      enabled: botEnabled,
      running: botRunning,
      paperMode,
      sessionStartBalance: botSessionStartBalance,
      sessionTradesCount: botSessionTradesCount,
      windowElapsedSeconds,
      analyzedThisWindow: botAnalyzedThisWindow.size,
      entrySnapshot: currentEntrySnapshot,
      enabledAssets: ENABLED_ASSETS,
      config: {
        minConfidence: getActiveConfig().minConfidence,
        minEdge: getActiveConfig().minEdge,
        maxBetUsdc: getActiveConfig().maxBetUsdc,
        fixedTradeUsdc: getActiveConfig().fixedTradeUsdc,
        entryWindowStart: getActiveConfig().entryWindowStart,
        entryWindowEnd: getActiveConfig().entryWindowEnd,
        scanIntervalMs: BOT_SCAN_INTERVAL_MS,
      },
      riskHalt,
      phase0Complete: PHASE_0_COMPLETE,
    });
  });

  app.post("/api/bot/control", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required." });
    }
    if (enabled) {
      if (riskHalt.halted) {
        return res.status(409).json({
          error: `Bot is risk-halted: ${riskHalt.reason}. Reset via POST /api/risk/reset before enabling.`,
          riskHalt,
        });
      }
      botEnabled = true;
      botSessionStartBalance = null; // reset session on re-enable
      botSessionPeakBalance = null;
      botSessionTradesCount = 0;
      startBot();
      res.json({ enabled: true, message: "Bot started." });
    } else {
      stopBot();
      res.json({ enabled: false, message: "Bot stopped." });
    }
  });

  app.post("/api/bot/paper-mode", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled (boolean) is required." });
    }
    if (!enabled && !PHASE_0_COMPLETE) {
      return res.status(403).json({
        error: "Cannot disable paper mode: PHASE_0_COMPLETE is not set. Live trading is locked.",
        paperMode,
      });
    }
    paperMode = enabled;
    botPrint("OK", `Paper mode ${enabled ? "ENABLED" : "DISABLED"}`);
    res.json({ ok: true, paperMode });
  });

  // ── Risk halt control (Phase 0 fix 2 + 5) ────────────────────────────────
  app.get("/api/risk/status", (_req, res) => {
    res.json({
      riskHalt,
      sessionStartBalance: botSessionStartBalance,
      sessionPeakBalance: botSessionPeakBalance,
      todayPnl: todayPnl(),
      limits: {
        maxDrawdownPct: RISK_MAX_DRAWDOWN_PCT,
        maxConsecLosses: RISK_MAX_CONSEC_LOSSES,
        dailyLossPct: RISK_DAILY_LOSS_PCT,
        gateMaxSpread: GATE_MAX_SPREAD,
        gateMinTobLiqUsdc: GATE_MIN_TOB_LIQ_USDC,
        gateMaxNormalizedAtr: GATE_MAX_NORMALIZED_ATR,
        heartbeatFailWarnAt: HEARTBEAT_FAIL_WARN_AT,
        heartbeatFailHaltAt: HEARTBEAT_FAIL_HALT_AT,
      },
      phase0Complete: PHASE_0_COMPLETE,
    });
  });

  app.post("/api/risk/reset", (_req, res) => {
    const wasHalted = riskHalt.halted;
    const prevReason = riskHalt.reason;
    riskHalt.halted = false;
    riskHalt.reason = "";
    riskHalt.haltedAt = 0;
    botSessionPeakBalance = null;
    botPrint("OK", `Risk halt cleared${wasHalted ? ` (was: ${prevReason})` : ""}`);
    res.json({ ok: true, cleared: wasHalted, previousReason: prevReason });
  });

  // ── Calibrator endpoints (Phase 0 Fix 1) ────────────────────────────────
  // Trains a logistic regression on outcome ~ heuristic features. Produces a
  // *real* P(WIN) used as the authoritative EV gate at trade time. This
  // replaces the dangerous practice of treating heuristic confidence/100 as
  // a probability.
  app.get("/api/calibrator/status", (_req, res) => {
    const state = getCalibratorState();
    res.json({
      ready: state.ready,
      reason: state.reason,
      nSamples: state.nSamples,
      minTrades: state.minTrades,
      buckets: state.buckets,
      model: state.model
        ? {
            trainedAt: state.model.trainedAt,
            trainBrier: state.model.trainBrier,
            trainLogLoss: state.model.trainLogLoss,
            cvBrier: Number.isFinite(state.model.cvBrier) ? state.model.cvBrier : null,
            cvLogLoss: Number.isFinite(state.model.cvLogLoss) ? state.model.cvLogLoss : null,
            features: state.model.features,
            hyper: state.model.hyper,
          }
        : null,
      thresholds: {
        minPWin: BOT_CALIBRATED_MIN_PWIN,
        minEdge: BOT_CALIBRATED_MIN_EDGE,
        requireCalibrator: BOT_REQUIRE_CALIBRATOR,
      },
    });
  });

  app.post("/api/calibrator/train", async (req, res) => {
    const body = (req.body || {}) as {
      source?: "live" | "synthetic" | "both";
      minTrades?: number;
      iterations?: number;
      learningRate?: number;
      l2?: number;
      cvFolds?: number;
      syntheticStride?: number;
    };
    const source = body.source ?? "both";

    try {
      const labeled: LabeledTrade[] = [];

      // ── Live trades from persisted log ────────────────────────────────────
      if (source === "live" || source === "both") {
        const live = await loadPersistedTradeLog();
        for (const t of live) {
          if (t.isPaperTrade) continue;            // paper outcomes aren't real
          if (t.result !== "WIN" && t.result !== "LOSS") continue;
          labeled.push({
            direction: t.direction as "UP" | "DOWN",
            confidence: t.confidence,
            rsi: t.rsi,
            emaCross: t.emaCross,
            signalScore: t.signalScore,
            imbalanceSignal: t.imbalanceSignal,
            divergenceDirection: t.divergenceDirection,
            divergenceStrength: t.divergenceStrength,
            btcDelta30s: t.btcDelta30s,
            yesDelta30s: t.yesDelta30s,
            windowElapsedSeconds: t.windowElapsedSeconds,
            entryPrice: t.entryPrice,
            result: t.result,
          });
        }
      }

      // ── Synthetic from historical Binance candles (bootstrap) ────────────
      if (source === "synthetic" || source === "both") {
        const history = await getBtcHistory(true);
        const candles = (history?.history ?? []).map((c) => ({
          time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        }));
        if (candles.length >= 100) {
          const synth = buildSyntheticTrainingSet(candles, {
            horizon: 5,
            stride: Math.max(1, body.syntheticStride ?? 1),
          });
          labeled.push(...synth);
        }
      }

      if (labeled.length === 0) {
        return res.status(503).json({ error: "No training data available (live log empty and Binance history unavailable)." });
      }

      const state = retrainCalibrator(labeled, {
        minTrades: body.minTrades ?? Math.min(100, Math.floor(labeled.length * 0.5)),
        iterations: body.iterations,
        learningRate: body.learningRate,
        l2: body.l2,
        cvFolds: body.cvFolds,
      });

      if (state.ready) {
        botPrint("OK", `[Calibrate] Retrained on ${state.nSamples} samples (source=${source}). ${state.reason}`);
      } else {
        botPrint("WARN", `[Calibrate] Train completed but model not ready: ${state.reason}`);
      }

      res.json({
        ok: state.ready,
        source,
        labeledSamples: labeled.length,
        state: {
          ready: state.ready,
          reason: state.reason,
          nSamples: state.nSamples,
          buckets: state.buckets,
          model: state.model
            ? {
                trainedAt: state.model.trainedAt,
                trainBrier: state.model.trainBrier,
                trainLogLoss: state.model.trainLogLoss,
                cvBrier: Number.isFinite(state.model.cvBrier) ? state.model.cvBrier : null,
                cvLogLoss: Number.isFinite(state.model.cvLogLoss) ? state.model.cvLogLoss : null,
              }
            : null,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Calibrator training failed" });
    }
  });

  app.post("/api/calibrator/clear", (_req, res) => {
    clearCalibrator();
    saveCalibrator(); // writes the cleared state too (no-op if no model)
    botPrint("OK", `[Calibrate] Model cleared. Trades will fall back to heuristic gate.`);
    res.json({ ok: true });
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
    // CORS — allow EventSource from any origin (echo Origin if present, else *)
    const origin = req.headers.origin as string | undefined;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx response buffering

    // Disable socket idle timeout so the stream stays open
    if (res.socket) {
      res.socket.setTimeout(0);
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true);
    }

    res.flushHeaders();

    // Send current log snapshot so the client is immediately up-to-date
    res.write(`retry: 5000\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify({ log: rawLog.slice(0, 200) })}\n\n`);

    sseClients.add(res as unknown as ServerResponse);

    // Heartbeat every 25s — prevents proxies/load balancers from killing idle SSE
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res as unknown as ServerResponse);
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      sseClients.delete(res as unknown as ServerResponse);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);
  });

  // Preflight for browsers that send OPTIONS before the SSE GET
  app.options("/api/bot/events", (req, res) => {
    const origin = req.headers.origin as string | undefined;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
    res.setHeader("Vary", "Origin");
    res.status(204).end();
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
      confidenceIsHardGate: BOT_CONFIDENCE_HARD_GATE,
      requireCalibrator: BOT_REQUIRE_CALIBRATOR,
      signalPolicy: getPolicyStatus(),
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

  // ── Phase 0 Fix 10: honest backtest ─────────────────────────────────────
  // Replays SYNTH heuristic on real Binance 1-min candles with realistic
  // entry, slippage, fees, ATR gate, heuristic-confidence calibration buckets, and a
  // baseline "always buy YES" benchmark. Replaces the old direction-accuracy toy.
  app.post("/api/backtest/replay", async (req, res) => {
    try {
      const body = (req.body || {}) as Partial<BacktestOptions> & {
        useCalibratorGate?: boolean;
        minCalibratedPWin?: number;
        minCalibratedEdge?: number;
      };
      const opts: BacktestOptions = {
        windows:          Number(body.windows          ?? 200),
        minConfidence:    Number(body.minConfidence    ?? aggressiveMinConfidence),
        minEdge:          Number(body.minEdge          ?? aggressiveMinEdge),
        betUsdc:          Number(body.betUsdc          ?? aggressiveFixedTradeUsdc),
        slippage:         Number(body.slippage         ?? 0.02),
        feeUsdc:          Number(body.feeUsdc          ?? 0),
        maxNormalizedAtr: Number(body.maxNormalizedAtr ?? GATE_MAX_NORMALIZED_ATR),
        calibratorPredict: isCalibratorReady()
          ? (features) => predictPWin(features as TradeFeatures)
          : undefined,
        useCalibratorGate: body.useCalibratorGate ?? false,
        minCalibratedPWin: body.minCalibratedPWin ?? BOT_CALIBRATED_MIN_PWIN,
        minCalibratedEdge: body.minCalibratedEdge ?? BOT_CALIBRATED_MIN_EDGE,
      };
      const historyResult = await getBtcHistory(true);
      const history = historyResult?.history ?? [];
      if (history.length < 50) {
        return res.status(503).json({ error: `Insufficient candle history (have ${history.length}, need ≥50)` });
      }
      const candles: BacktestCandle[] = history.map((c) => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      const result = runBacktest(candles, opts);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Backtest failed" });
    }
  });

  // ── Phase 1 — Honest measurement endpoint ─────────────────────────────────
  // Pulls the persisted trade log, computes Brier on confidence/100 (this is
  // a measurement of how miscalibrated that anti-pattern is), and emits a
  // per-signal keep/kill/recalibrate verdict.
  app.get("/api/measurement/phase1", async (req, res) => {
    try {
      const includePaper = String(req.query.includePaper || "").toLowerCase() === "true";
      const minBucketN = req.query.minBucketN ? Number(req.query.minBucketN) : undefined;
      const trades = await loadPersistedTradeLog();
      const records: TradeRecord[] = trades
        .filter((t) => t.result === "WIN" || t.result === "LOSS")
        .map((t) => ({
          ts: t.ts,
          market: t.market,
          direction: t.direction as "UP" | "DOWN",
          confidence: t.confidence,
          entryPrice: t.entryPrice,
          pnl: t.pnl,
          result: t.result,
          rsi: t.rsi,
          emaCross: t.emaCross,
          signalScore: t.signalScore,
          imbalanceSignal: t.imbalanceSignal,
          divergenceDirection: t.divergenceDirection,
          divergenceStrength: t.divergenceStrength,
          btcDelta30s: t.btcDelta30s,
          yesDelta30s: t.yesDelta30s,
          windowElapsedSeconds: t.windowElapsedSeconds,
          isPaperTrade: t.isPaperTrade,
        }));
      const report = buildPhase1Report(records, { includePaper, minBucketN });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Phase 1 report failed" });
    }
  });

  // ── Phase 1 — Order book log stats ─────────────────────────────────────────
  app.get("/api/measurement/orderbook-log", (_req, res) => {
    try {
      const stats = readOrderBookLogStats(ORDERBOOK_LOG_FILE);
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Order book log stats failed" });
    }
  });

  // ── Phase 1 — Book replay backtest ─────────────────────────────────────────
  // Replays the SYNTH heuristic against the logged Polymarket order books with
  // realistic depth-aware fills. Until the log has accumulated enough data,
  // returns `insufficient: true` with the reason.
  app.post("/api/backtest/bookReplay", async (req, res) => {
    try {
      const body = (req.body || {}) as {
        betUsdc?: number;
        feeUsdc?: number;
        minSnapshotsPerWindow?: number;
        minConfidence?: number;
      };
      const snapshots = readOrderBookLog(ORDERBOOK_LOG_FILE);
      const historyResult = await getBtcHistory(true);
      const candles: BacktestCandle[] = (historyResult?.history ?? []).map((c: BtcCandle) => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      const minConfidence = Number(body.minConfidence ?? aggressiveMinConfidence);
      // Minimal in-replay strategy hook: re-use the synth feature set from the
      // YES book + BTC candles. Server-side SYNTH is not directly re-importable
      // (it lives inline in startServer), so this skeleton uses the calibrator
      // when ready and otherwise enters after a fixed `windowElapsedSec` floor.
      const strategy: BookReplayOptions["strategy"] = (ctx: StrategyTickContext): StrategyTickDecision => {
        if (ctx.windowElapsedSec < 30) return { decision: "NO_TRADE", reason: "warm-up" };
        // Direction from the latest 5-min candle slope.
        const lastN = ctx.btcCandles.slice(-5);
        if (lastN.length < 2) return { decision: "NO_TRADE", reason: "no candles" };
        const slope = lastN[lastN.length - 1].close - lastN[0].open;
        const direction: "UP" | "DOWN" = slope >= 0 ? "UP" : "DOWN";
        return {
          decision: "TRADE",
          direction,
          confidence: 75,
          reason: `slope=${slope.toFixed(2)}`,
        };
      };
      const opts: BookReplayOptions = {
        betUsdc: Number(body.betUsdc ?? aggressiveFixedTradeUsdc),
        feeUsdc: Number(body.feeUsdc ?? 0),
        minSnapshotsPerWindow: Number(body.minSnapshotsPerWindow ?? 3),
        strategy,
        calibratorPredict: isCalibratorReady()
          ? (snap, dec) => predictPWin({
              direction: dec.direction,
              confidence: dec.confidence,
              rsi: 50,
              emaCross: "BULLISH",
              signalScore: 0,
              imbalanceSignal: snap.imbalanceSignal ?? "NEUTRAL",
              divergenceStrength: "NONE",
              divergenceDirection: "NEUTRAL",
              btcDelta30s: 0,
              yesDelta30s: 0,
              windowElapsedSeconds: snap.midpoint ? Math.min(280, 60) : 60,
              entryPrice: snap.asks[0]?.price ?? 0.5,
            })
          : undefined,
      };
      void minConfidence;
      const result = runBookReplay(snapshots, candles, opts);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Book replay failed" });
    }
  });

  // Deprecated direction-accuracy backtest kept as an alias to avoid breaking
  // any existing UI callers. Internally delegates to the replay backtester
  // and projects a thin "results" view onto the response.
  app.post("/api/backtest", async (_req, res) => {
    try {
      const historyResult = await getBtcHistory(true);
      const history = historyResult?.history ?? [];
      if (history.length < 50) {
        return res.json({ error: `Insufficient candle history (have ${history.length}, need ≥50)` });
      }
      const candles: BacktestCandle[] = history.map((c) => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      }));
      const result = runBacktest(candles, {
        windows: 40,
        minConfidence: 0,   // include all signaled — preserves "every signal" shape
        minEdge: 0,
        betUsdc: 1,
        slippage: 0.02,
        feeUsdc: 0,
        maxNormalizedAtr: 1,
      });
      res.json({
        deprecated: "Use /api/backtest/replay for the honest backtester.",
        totalWindows: result.totalWindows,
        signaledCount: result.signaled,
        correctCount: result.wins,
        winRate: result.winRate || null,
        netPnl: result.netPnl,
        brier: result.brier,
        results: result.trades.map((t) => ({
          ts: t.windowStart,
          signaled: true,
          signalDirection: t.direction,
          actualDir: t.btcMovePct >= 0 ? "UP" : "DOWN",
          correct: t.outcome === "WIN",
          confidence: t.confidence,
          entryClose: parseFloat(t.btcOpen.toFixed(0)),
          exitClose: parseFloat(t.btcClose.toFixed(0)),
          pnl: t.pnl,
        })),
      });
    } catch (err: any) {
      res.json({ error: err?.message || "Backtest failed" });
    }
  });

  app.get("/api/analytics", async (_req, res) => {
    try {
      const trades = await loadPersistedTradeLog();
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
    const { minConfidence, minEdge, fixedTradeUsdc, entryWindowStart, entryWindowEnd } = req.body || {};
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
      if (isNaN(val) || !Number.isInteger(val) || val < 1 || val > 15) {
        return res.status(400).json({ error: "fixedTradeUsdc must be an integer 1–15" });
      }
      aggressiveFixedTradeUsdc = val;
    }
    if (entryWindowStart !== undefined) {
      const val = Number(entryWindowStart);
      if (isNaN(val) || val < 0 || val > 120) return res.status(400).json({ error: "entryWindowStart must be 0–120" });
      aggressiveEntryWindowStart = val;
    }
    if (entryWindowEnd !== undefined) {
      const val = Number(entryWindowEnd);
      if (isNaN(val) || val < 180 || val > 295) return res.status(400).json({ error: "entryWindowEnd must be 180–295" });
      aggressiveEntryWindowEnd = val;
    }
    const cfg = getActiveConfig();
    botPrint("INFO", `Config updated: conf≥${aggressiveMinConfidence}% headroom≥${(aggressiveMinEdge * 100).toFixed(1)}¢ fixed=$${aggressiveFixedTradeUsdc.toFixed(2)} win=[${aggressiveEntryWindowStart}s–${aggressiveEntryWindowEnd}s]`);
    res.json({ ok: true, config: cfg });
  });

  // ── Active market assets ──────────────────────────────────────────────────
  app.get("/api/bot/assets", (_req, res) => {
    res.json({ all: ALL_ASSETS, enabled: ENABLED_ASSETS });
  });

  app.post("/api/bot/assets", (_req, res) => {
    res.status(400).json({ error: "BTC-only mode. Asset switching is disabled." });
  });

  app.post("/api/bot/reset-confidence", (_req, res) => {
    for (const a of ["BTC"] as const) {
      adaptiveConfidenceByAsset.set(a, 0);
      consecutiveLossesByAsset.set(a, 0);
      consecutiveWinsByAsset.set(a, 0);
    }
    saveLearning();
    botPrint("INFO", `Adaptive confidence reset to baseline ${BOT_MIN_CONFIDENCE}% for all assets (manual override)`);
    res.json({ ok: true, baseMinConfidence: BOT_MIN_CONFIDENCE, adaptiveConfidenceByAsset: Object.fromEntries(adaptiveConfidenceByAsset) });
  });

  app.get("/api/bot/trade-log", async (req, res) => {
    const all = await loadPersistedTradeLog();
    const days = Number.parseInt(String(req.query.days || ""), 10);
    let filtered = filterTradeLogByDays(all, days);
    const paperOnly = String(req.query.paperOnly || "").toLowerCase() === "true" || String(req.query.paperOnly || "").toLowerCase() === "1";
    const realOnly = String(req.query.realOnly || "").toLowerCase() === "true" || String(req.query.realOnly || "").toLowerCase() === "1";
    if (paperOnly) filtered = filtered.filter((e) => e.isPaperTrade);
    if (realOnly) filtered = filtered.filter((e) => !e.isPaperTrade);
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

  app.get("/api/bot/paper-trade-stats", async (_req, res) => {
    const paper = loadPaperTradeLog();
    const wins = paper.filter((e) => e.result === "WIN").length;
    const losses = paper.filter((e) => e.result === "LOSS").length;
    const totalPnl = parseFloat(paper.reduce((s, e) => s + e.pnl, 0).toFixed(2));
    const winRate = paper.length > 0 ? parseFloat(((wins / paper.length) * 100).toFixed(1)) : 0;
    res.json({
      total: paper.length, wins, losses, winRate, totalPnl,
      lastTrade: paper[paper.length - 1] || null,
    });
  });

  // API Proxy for Polymarket — BTC Up/Down 5-Minute Events
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

      // Gamma API returns outcomes/outcomePrices/clobTokenIds as JSON strings — parse them
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

      console.log(`Fetched ${events.length}/${slugs.length} events → ${markets.length} markets`);
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
          params: { user: userAddress, limit: 500, sortBy: "TIMESTAMP", sortDirection: "DESC" },
          timeout: 10000,
        }),
      ]);

      const openPositionsRaw: any[] = openRes.status === "fulfilled" ? (openRes.value.data ?? []) : [];
      const closedPositionsRaw: any[] = closedRes.status === "fulfilled" ? (closedRes.value.data ?? []) : [];
      const matchedClosedPositionsRaw = await matchClosedPositionsToPersistedTrades(closedPositionsRaw);
      const sessionCutoffMs = Date.now() - SESSION_PNL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      const sessionClosedPositionsRaw = matchedClosedPositionsRaw.filter((position) => {
        const closedAtMs = parseTimestampMs(position.timestamp);
        return closedAtMs != null && closedAtMs >= sessionCutoffMs;
      });

      // Aggregate stats from closed positions
      const winCount  = closedPositionsRaw.filter((p) => p.realizedPnl > 0).length;
      const lossCount = closedPositionsRaw.filter((p) => p.realizedPnl < 0).length;
      const closedTrades = closedPositionsRaw.length;
      const winRate = closedTrades > 0 ? (winCount / closedTrades) * 100 : 0;
      const realizedPnl = closedPositionsRaw.reduce((sum, p) => sum + (p.realizedPnl ?? 0), 0);
      let cumulativeSessionPnl = 0;
      const sessionHistory = sessionClosedPositionsRaw
        .slice()
        .sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
        .map((position, index) => {
          const tradePnl = roundPnl(Number(position.realizedPnl ?? 0));
          cumulativeSessionPnl = roundPnl(cumulativeSessionPnl + tradePnl);
          return {
            index: index + 1,
            timestamp: Number(position.timestamp ?? 0),
            market: position.title ?? "",
            outcome: position.outcome ?? "",
            trade: tradePnl,
            cumulative: cumulativeSessionPnl,
            decision: tradePnl > 0 ? "WIN" : tradePnl < 0 ? "LOSS" : "FLAT",
            orderId: position.orderId ?? null,
            orderIds: position.orderIds ?? [],
            matched: Array.isArray(position.orderIds) && position.orderIds.length > 0,
            matchedTradeTs: position.matchedTradeTs ?? null,
          };
        });

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
        closedPositions: sessionClosedPositionsRaw.map((p) => ({
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
          orderId:     p.orderId ?? null,
          orderIds:    p.orderIds ?? [],
          matched:     Array.isArray(p.orderIds) && p.orderIds.length > 0,
          matchedTradeTs: p.matchedTradeTs ?? null,
          matchedBy:   p.matchedBy ?? null,
        })),
        history: sessionHistory, // legacy field kept for App.tsx compatibility
        sessionHistory,
        sessionWindowDays: SESSION_PNL_LOOKBACK_DAYS,
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

  // Market heat: Binance funding rate + taker ratio + long/short ratio
  app.get("/api/market-heat/:asset?", async (req, res) => {
    try {
      const assetParam = (req.params.asset || "BTC").toUpperCase();
      const asset = ALL_ASSETS.includes(assetParam as TradingAsset) ? (assetParam as TradingAsset) : "BTC";
      const data = await getAssetHeatData(asset, true);
      if (!data) return res.status(503).json({ error: "Market heat data unavailable" });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch market heat data", detail: error?.message });
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
