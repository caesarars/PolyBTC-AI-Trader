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

// ── Persistence: data/ directory ──────────────────────────────────────────────
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

let btcHistoryCache: { data: BtcCandle[]; expiresAt: number } | null = null;
let btcPriceCache: { data: { symbol: string; price: string; source?: string }; expiresAt: number } | null = null;
let btcIndicatorsCache: { data: any; expiresAt: number } | null = null;
let mongoDb: Db | null = null;
let mongoInitPromise: Promise<Db | null> | null = null;
let btcSyncInterval: NodeJS.Timeout | null = null;
let positionAutomationInterval: NodeJS.Timeout | null = null;
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
const POSITION_AUTOMATION_SYNC_MS = Number(process.env.POSITION_AUTOMATION_SYNC_MS || 10_000);

// ── Bot configuration ────────────────────────────────────────────────────────
const BOT_SCAN_INTERVAL_MS = Number(process.env.BOT_SCAN_INTERVAL_MS || 5_000);
const BOT_MIN_CONFIDENCE = Number(process.env.BOT_MIN_CONFIDENCE || 70);
const BOT_MIN_EDGE = Number(process.env.BOT_MIN_EDGE || 0.10);
const BOT_KELLY_FRACTION = Number(process.env.BOT_KELLY_FRACTION || 0.40);
const BOT_MAX_BET_USDC = Number(process.env.BOT_MAX_BET_USDC || 250);
const BOT_SESSION_LOSS_LIMIT = Number(process.env.BOT_SESSION_LOSS_LIMIT || 0.30);

// ── Bot mode: AGGRESSIVE (default) vs CONSERVATIVE ───────────────────────────
let botMode: "AGGRESSIVE" | "CONSERVATIVE" = "AGGRESSIVE";

const CONSERVATIVE_CONFIG = {
  minConfidence:    75,
  minEdge:          0.12,
  kellyFraction:    0.20,
  maxBetUsdc:       50,
  sessionLossLimit: 0.15,
  balanceCap:       0.10,
  entryWindowStart: 30,
  entryWindowEnd:   240,
} as const;

function getActiveConfig() {
  if (botMode === "CONSERVATIVE") return CONSERVATIVE_CONFIG;
  return {
    minConfidence:    BOT_MIN_CONFIDENCE,
    minEdge:          BOT_MIN_EDGE,
    kellyFraction:    BOT_KELLY_FRACTION,
    maxBetUsdc:       BOT_MAX_BET_USDC,
    sessionLossLimit: BOT_SESSION_LOSS_LIMIT,
    balanceCap:       0.25,
    entryWindowStart: 10,
    entryWindowEnd:   285,
  };
}

// ── Bot runtime state ────────────────────────────────────────────────────────
let botEnabled = process.env.BOT_AUTO_START === "true";
let botRunning = false;
let botInterval: NodeJS.Timeout | null = null;
let botSessionStartBalance: number | null = null;
let botSessionTradesCount = 0;
let botLastWindowStart = 0;
const botAnalyzedThisWindow = new Set<string>();

// ── Pre-fetch cache for next window ───────────────────────────────────────────
interface PreFetchCache {
  windowStart: number;
  fetchedAt: number;
  slug: string;
  markets: any[];
  btcPriceData: any;
  btcHistoryResult: any;
  btcIndicatorsData: any;
  sentimentData: any;
  orderBooks: Record<string, any>;
  marketHistory: { t: number; yes: number; no: number }[];
  rec: any;
}
let preFetchCache: PreFetchCache | null = null;
let preFetchRunning = false;

// ── Divergence tracker (BTC vs YES token lag detector) ────────────────────────
interface PricePoint { ts: number; price: number; }
const btcRingBuffer: PricePoint[] = [];   // 5s samples, 10-min window
const yesRingBuffer: PricePoint[] = [];   // YES token ask price
let currentWindowYesTokenId: string | null = null;
let currentWindowNoTokenId:  string | null = null;

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
let divergenceState: DivergenceState | null = null;
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
  divergence: { direction: string; strength: string; btcDelta30s: number; yesDelta30s: number; } | null;
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
}
const pendingResults = new Map<string, PendingResult>();

// ── Adaptive learning state ───────────────────────────────────────────────────
interface LossMemory {
  timestamp: string;
  market: string;
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

let consecutiveLosses = 0;
let consecutiveWins   = 0;
let adaptiveConfidenceBoost = 0; // added on top of BOT_MIN_CONFIDENCE

function generateLesson(pending: PendingResult): string {
  const rules: string[] = [];
  const { direction, rsi, emaCross, signalScore, windowElapsedSeconds, confidence } = pending;

  if (direction === "UP"   && rsi !== undefined && rsi > 65) rules.push(`RSI overbought (${rsi.toFixed(0)}) on UP — reversal risk`);
  if (direction === "DOWN" && rsi !== undefined && rsi < 35) rules.push(`RSI oversold (${rsi.toFixed(0)}) on DOWN — reversal risk`);
  if (direction === "UP"   && emaCross === "BEARISH")         rules.push("EMA cross was BEARISH during UP trade");
  if (direction === "DOWN" && emaCross === "BULLISH")         rules.push("EMA cross was BULLISH during DOWN trade");
  if (direction === "UP"   && signalScore !== undefined && signalScore < 0) rules.push(`Negative signal score (${signalScore}) on UP trade`);
  if (direction === "DOWN" && signalScore !== undefined && signalScore > 0) rules.push(`Positive signal score (+${signalScore}) on DOWN trade`);
  if (windowElapsedSeconds > 220)  rules.push(`Late entry at ${windowElapsedSeconds}s — limited time for move`);
  if (confidence < 60)             rules.push(`Low confidence entry (${confidence}%) — insufficient conviction`);

  return rules.length > 0 ? rules.join(" | ") : "No dominant pattern — low probability setup";
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

// ── Divergence Tracker: BTC price vs YES token price lag detector ─────────────
// Runs every 5s independently. Fills ring buffers and computes divergence score.
function startDivergenceTracker() {
  if (divergenceTrackerInterval) return;

  const tick = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);

      // 1. BTC price sample
      const btcData = await getBtcPrice();
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
      const yesDelta30s = yesNow && yes30ref ? (yesNow - yes30ref.price) * 100 : 0; // in ¢

      // 4. Classify divergence
      // A divergence occurs when BTC moves meaningfully but the YES token hasn't repriced
      const BTC_STRONG = 100; // $100 in 30s
      const BTC_MOD    = 60;  // $60
      const BTC_WEAK   = 30;  // $30
      const YES_LAG    = 2.0; // ¢ — YES hasn't moved at least 2¢ in BTC's direction

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

      divergenceState = {
        btcDelta30s, btcDelta60s, yesDelta30s,
        divergence, direction, strength,
        currentBtcPrice: btcNow,
        currentYesAsk: yesAsk,
        currentNoAsk: noAsk,
        updatedAt: now,
      };

    } catch { /* never crash the tracker */ }
  };

  void tick();
  divergenceTrackerInterval = setInterval(() => void tick(), 5000);
  console.log("[Divergence] Tracker started — 5s BTC vs YES token lag detector");
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
    // TP/SL scaled to absolute price zone — binaries have non-linear payoff
    let tpTarget: number;
    let slTarget: number;
    let trailingDistance: number;

    if (averagePrice < 0.35) {
      tpTarget = Math.min(0.78, averagePrice + 0.30);
      slTarget = Math.max(0.01, averagePrice - 0.12);
      trailingDistance = 0.10;
    } else if (averagePrice < 0.50) {
      tpTarget = Math.min(0.75, averagePrice + 0.22);
      slTarget = Math.max(0.01, averagePrice - 0.10);
      trailingDistance = 0.08;
    } else if (averagePrice < 0.65) {
      tpTarget = Math.min(0.82, averagePrice + 0.18);
      slTarget = Math.max(0.01, averagePrice - 0.12);
      trailingDistance = 0.07;
    } else {
      // High-price entry: limited upside, tight risk
      tpTarget = Math.min(0.90, averagePrice + 0.10);
      slTarget = Math.max(0.01, averagePrice - 0.08);
      trailingDistance = 0.05;
    }

    return {
      takeProfit: tpTarget.toFixed(2),
      stopLoss: slTarget.toFixed(2),
      trailingStop: trailingDistance.toFixed(2),
    };
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
          const isCriticalExpiry = secondsToExpiry > 0 && secondsToExpiry <= 30;

          // Determine if a trigger condition is met (uses currentPrice for detection)
          let triggerReason: string | null = null;
          if (takeProfit > 0 && currentPrice >= takeProfit) triggerReason = "take profit";
          if (!triggerReason && stopLoss > 0 && currentPrice <= stopLoss) triggerReason = "stop loss";
          if (!triggerReason && trailingStopPrice > 0 && currentPrice <= trailingStopPrice) triggerReason = "trailing stop";

          // Near-expiry: exit any profitable position (prevents late-window reversal)
          if (!triggerReason && isNearExpiry && entryPrice > 0 && currentPrice > entryPrice * 1.005) {
            triggerReason = `near-expiry exit (${secondsToExpiry}s remaining — locking ${(((currentPrice / entryPrice) - 1) * 100).toFixed(1)}% gain)`;
          }

          if (triggerReason) {
            // TP: only execute if there's a real bid (need an actual buyer)
            // SL/trailing/near-expiry: execute AGGRESSIVE even on thin bid
            const isTakeProfit = triggerReason === "take profit";
            const executionPrice = bestBid > 0 ? bestBid : (bestAsk > 0 ? bestAsk * 0.90 : null);

            // In critical expiry zone (≤30s), skip the wait-for-bid guard entirely
            if (isTakeProfit && !(bestBid > 0) && !isCriticalExpiry) {
              // TP hit on price estimate but no buyer yet — wait for a real bid
              await savePositionAutomation({
                assetId: automation.assetId,
                highestPrice: highestPrice.toFixed(4),
                trailingStopPrice: trailingStopPrice > 0 ? trailingStopPrice.toFixed(4) : "",
                lastPrice: currentPrice.toFixed(4),
                status: `TP level reached (${(currentPrice * 100).toFixed(0)}¢) — waiting for bid`,
              });
              continue;
            }

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

  // ── Pre-fetch next window data while current window is closing ───────────
  const prefetchNextWindow = async (nextWindowStart: number) => {
    if (preFetchRunning) return;
    if (preFetchCache?.windowStart === nextWindowStart) return;
    preFetchRunning = true;

    const nextSlug = `btc-updown-5m-${nextWindowStart}`;
    botPrint("INFO", `━━━ PRE-FETCH ━━━ Preparing next window ${new Date(nextWindowStart * 1000).toLocaleTimeString()}…`);

    try {
      const parseArr = (val: any): any[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
        return [];
      };

      // Step 1: fetch next window market
      let markets: any[] = [];
      try {
        const eventRes = await axios.get(`https://gamma-api.polymarket.com/events/slug/${nextSlug}`, { timeout: 8000 });
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
      } catch {
        botPrint("WARN", `Pre-fetch: next window market not yet live (${nextSlug}) — will retry`);
        preFetchRunning = false;
        return;
      }

      if (markets.length === 0) {
        botPrint("WARN", `Pre-fetch: no markets found for ${nextSlug} — will retry`);
        preFetchRunning = false;
        return;
      }

      // Step 2: BTC data + sentiment in parallel
      const [btcPriceData, btcHistoryResult, btcIndicatorsData, sentimentData] = await Promise.all([
        getBtcPrice(),
        getBtcHistory(),
        getBtcIndicators(),
        axios.get("https://api.alternative.me/fng/", { timeout: 5000 })
          .then((r) => r.data.data[0]).catch(() => null),
      ]);
      botPrint("OK", `Pre-fetch: BTC $${btcPriceData?.price ?? "?"} | RSI: ${btcIndicatorsData?.rsi?.toFixed(1) ?? "?"} | EMA: ${btcIndicatorsData?.emaCross ?? "?"}`);

      // Step 3: order books for next window tokens
      const market = markets[0];
      const tokenIds: string[] = market.clobTokenIds || [];
      const orderBooks: Record<string, any> = {};
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
          botPrint("OK", `Pre-fetch OB [${market.outcomes?.[idx] ?? `Token${idx}`}]: bid=${raw.bids?.[0]?.price ?? "?"} ask=${raw.asks?.[0]?.price ?? "?"} liq=$${totalLiquidityUsdc}`);
        } catch {
          botPrint("WARN", `Pre-fetch: OB fetch failed for token ${tid.slice(0, 12)}…`);
        }
      }));

      // Step 4: market price history
      let marketHistory: { t: number; yes: number; no: number }[] = [];
      const yesId = tokenIds[0];
      if (yesId) {
        try {
          const [yRes, nRes] = await Promise.all([
            axios.get("https://clob.polymarket.com/prices-history", { params: { market: yesId, interval: "1m", fidelity: 10 }, timeout: 5000 }),
            tokenIds[1] ? axios.get("https://clob.polymarket.com/prices-history", { params: { market: tokenIds[1], interval: "1m", fidelity: 10 }, timeout: 5000 }) : Promise.resolve({ data: [] }),
          ]);
          const yesData: { t: number; p: number }[] = Array.isArray(yRes.data) ? yRes.data : (yRes.data?.history ?? []);
          const noData:  { t: number; p: number }[] = Array.isArray(nRes.data)  ? nRes.data  : (nRes.data?.history  ?? []);
          const noMap = new Map(noData.map((d) => [d.t, d.p]));
          marketHistory = yesData.map((d) => ({ t: d.t, yes: d.p, no: noMap.get(d.t) ?? 1 - d.p }));
        } catch { /* non-fatal */ }
      }

      // Step 5: Gemini analysis (simulate 15s into next window for context)
      botPrint("INFO", `Pre-fetch: running Gemini analysis for next window…`);
      const rec = await analyzeMarket(
        market,
        btcPriceData?.price ?? null,
        btcHistoryResult?.history ?? [],
        sentimentData,
        btcIndicatorsData,
        orderBooks,
        marketHistory,
        15,
        lossMemory.slice(0, 5),
        undefined,
        winMemory.slice(0, 3)
      );

      const icon = rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—";
      botPrint(rec.decision === "TRADE" ? "OK" : "INFO",
        `Pre-fetch: ${icon} ${rec.decision} ${rec.direction !== "NONE" ? rec.direction : ""} | conf=${rec.confidence}% | edge=${rec.estimatedEdge}¢ | risk=${rec.riskLevel}`);

      preFetchCache = {
        windowStart: nextWindowStart,
        fetchedAt: Math.floor(Date.now() / 1000),
        slug: nextSlug,
        markets,
        btcPriceData,
        btcHistoryResult,
        btcIndicatorsData,
        sentimentData,
        orderBooks,
        marketHistory,
        rec,
      };
      botPrint("OK", `━━━ PRE-FETCH DONE ━━━ Next window ready — will fire immediately at 10s mark`);
    } catch (err: any) {
      botPrint("WARN", `Pre-fetch error: ${err?.message || String(err)}`);
    } finally {
      preFetchRunning = false;
    }
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
        // ── WIN: relax adaptive threshold ──────────────────────────────────
        consecutiveWins++;
        consecutiveLosses = 0;
        if (consecutiveWins >= 2 && adaptiveConfidenceBoost > 0) {
          adaptiveConfidenceBoost = Math.max(adaptiveConfidenceBoost - 3, 0);
          botPrint("OK", `Adaptive learning: streak=${consecutiveWins}W — threshold relaxed to ${BOT_MIN_CONFIDENCE + adaptiveConfidenceBoost}% (boost=${adaptiveConfidenceBoost > 0 ? `+${adaptiveConfidenceBoost}%` : "none"})`);
        }
        botPrint("OK", `━━━ 🏆 WIN  ━━━ ${pending.market.slice(0, 45)} | ${pending.direction} | Entry: ${(pending.entryPrice * 100).toFixed(1)}¢ | Bet: $${pending.betAmount.toFixed(2)} | PnL: ${pnlStr}`);
        const winLesson = generateWinLesson(pending);
        winMemory.unshift({
          timestamp: new Date().toISOString(),
          market: pending.market,
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
          divergenceDirection: divergenceState?.direction,
          divergenceStrength: divergenceState?.strength,
          btcDelta30s: divergenceState?.btcDelta30s,
          yesDelta30s: divergenceState?.yesDelta30s,
          windowElapsedSeconds: pending.windowElapsedSeconds,
          orderId: pending.orderId,
        });
      } else {
        // ── LOSS: record memory, tighten adaptive threshold ────────────────
        consecutiveLosses++;
        consecutiveWins = 0;
        const lesson = generateLesson(pending);

        lossMemory.unshift({
          timestamp: new Date().toISOString(),
          market: pending.market,
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

        if (consecutiveLosses >= 2) {
          adaptiveConfidenceBoost = Math.min(adaptiveConfidenceBoost + 5, 20);
          botPrint("WARN", `Adaptive learning: streak=${consecutiveLosses}L — threshold raised to ${BOT_MIN_CONFIDENCE + adaptiveConfidenceBoost}% (+${adaptiveConfidenceBoost}% boost)`);
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
          divergenceDirection: divergenceState?.direction,
          divergenceStrength: divergenceState?.strength,
          btcDelta30s: divergenceState?.btcDelta30s,
          yesDelta30s: divergenceState?.yesDelta30s,
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
        botAnalyzedThisWindow.clear();
        botLastWindowStart = currentWindowStart;
        // Clear YES ring buffer — old window's token is no longer valid
        yesRingBuffer.length = 0;
        currentWindowYesTokenId = null;
        currentWindowNoTokenId  = null;
        botPrint("INFO", `━━━━ NEW WINDOW ━━━━ ${new Date(currentWindowStart * 1000).toLocaleTimeString()} — ${new Date((currentWindowStart + 300) * 1000).toLocaleTimeString()}`);
      }

      // During closing period (>270s): kick off async pre-fetch for next window
      if (windowElapsedSeconds > 270) {
        const nextWindowStart = currentWindowStart + MARKET_SESSION_SECONDS;
        if (!preFetchRunning && preFetchCache?.windowStart !== nextWindowStart) {
          void prefetchNextWindow(nextWindowStart);
        }
      }

      // Only trade in the valid entry zone (10s–285s elapsed) — aggressive mode
      const cfg = getActiveConfig();
      if (windowElapsedSeconds < cfg.entryWindowStart || windowElapsedSeconds > cfg.entryWindowEnd) {
        if (windowElapsedSeconds > cfg.entryWindowEnd) {
          const nextWindowStart = currentWindowStart + MARKET_SESSION_SECONDS;
          const pfStatus = preFetchRunning
            ? "analyzing…"
            : preFetchCache?.windowStart === nextWindowStart
              ? "READY ✓"
              : "pending…";
          botPrint("SKIP", `Window closing (${mm}:${ss} left) — next window pre-fetch: ${pfStatus}`);
        } else {
          botPrint("SKIP", `Window too early (${windowElapsedSeconds}s) — ${mm}:${ss} remaining. Waiting.`);
        }
        return;
      }

      // ── Check pre-fetch cache for this window ────────────────────────────
      let cachedWindowData: PreFetchCache | null = null;
      if (preFetchCache?.windowStart === currentWindowStart) {
        cachedWindowData = preFetchCache;
        preFetchCache = null;
        botPrint("OK", `━━━ CACHE HIT ━━━ Using pre-fetched analysis from ${new Date(cachedWindowData.fetchedAt * 1000).toLocaleTimeString()} — executing immediately`);
      }

      // Fetch current market
      const slug = cachedWindowData?.slug ?? `btc-updown-5m-${currentWindowStart}`;
      const parseArr = (val: any): any[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
        return [];
      };

      botPrint("INFO", `Scanning window ${mm}:${ss} remaining | elapsed=${windowElapsedSeconds}s | slug=${slug}`);

      let markets: any[] = cachedWindowData?.markets ?? [];
      if (markets.length === 0) {
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
            botPrint("WARN", `No markets found for slug: ${slug}`);
            return;
          }
          botPrint("INFO", `Found ${markets.length} market(s) for window`);
        } catch {
          botPrint("ERR", `Failed to fetch market for slug: ${slug}`);
          return;
        }
      } else {
        botPrint("INFO", `Using ${markets.length} pre-fetched market(s) for window`);
      }

      for (const market of markets) {
        if (botAnalyzedThisWindow.has(market.id)) {
          botPrint("SKIP", `Already analyzed this window: ${market.question?.slice(0, 50)}`);
          continue;
        }
        botAnalyzedThisWindow.add(market.id);

        botPrint("INFO", `Analyzing: ${market.question?.slice(0, 60)}`);

        try {
          // ── Use pre-fetched data if cache hit, otherwise fetch fresh ───────
          let btcPriceData: any;
          let btcHistoryResult: any;
          let btcIndicatorsData: any;
          let sentimentData: any;
          let orderBooks: Record<string, any>;
          let marketHistory: { t: number; yes: number; no: number }[];

          if (cachedWindowData) {
            btcPriceData      = cachedWindowData.btcPriceData;
            btcHistoryResult  = cachedWindowData.btcHistoryResult;
            btcIndicatorsData = cachedWindowData.btcIndicatorsData;
            sentimentData     = cachedWindowData.sentimentData;
            orderBooks        = cachedWindowData.orderBooks;
            marketHistory     = cachedWindowData.marketHistory;
            botPrint("OK", `Cached: BTC $${btcPriceData?.price ?? "?"} | RSI: ${btcIndicatorsData?.rsi?.toFixed(1) ?? "?"} | EMA: ${btcIndicatorsData?.emaCross ?? "?"} | Sentiment: ${sentimentData?.value_classification ?? "?"}`);
          } else {
            // Fetch all data in parallel
            botPrint("INFO", "Fetching BTC price, history, indicators, sentiment...");
            [btcPriceData, btcHistoryResult, btcIndicatorsData, sentimentData] = await Promise.all([
              getBtcPrice(),
              getBtcHistory(),
              getBtcIndicators(),
              axios.get("https://api.alternative.me/fng/", { timeout: 5000 })
                .then((r) => r.data.data[0]).catch(() => null),
            ]);
            botPrint("OK", `BTC $${btcPriceData?.price ?? "?"} | Candles: ${btcHistoryResult?.history?.length ?? 0} | RSI: ${btcIndicatorsData?.rsi?.toFixed(1) ?? "?"} | EMA: ${btcIndicatorsData?.emaCross ?? "?"} | Sentiment: ${sentimentData?.value_classification ?? "?"}`);

            // Fetch order books with computed imbalance + liquidity
            botPrint("INFO", "Fetching order books...");
            const tokenIds: string[] = market.clobTokenIds || [];
            // Register token IDs for divergence tracker
            if (tokenIds[0] && !currentWindowYesTokenId) currentWindowYesTokenId = tokenIds[0];
            if (tokenIds[1] && !currentWindowNoTokenId)  currentWindowNoTokenId  = tokenIds[1];
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
                botPrint("OK", `Market history: ${marketHistory.length} points | Latest YES: ${latestYes !== undefined ? (latestYes * 100).toFixed(1) + "¢" : "?"}`);
              } catch {
                botPrint("WARN", "Market price history unavailable — velocity signal disabled");
              }
            }
          }

          const effectiveMinConf = cfg.minConfidence + adaptiveConfidenceBoost;
          if (adaptiveConfidenceBoost > 0) {
            botPrint("INFO", `Adaptive threshold active: ${effectiveMinConf}% (+${adaptiveConfidenceBoost}% from ${consecutiveLosses} loss streak | ${lossMemory.length} patterns stored)`);
          }

          // ── Read divergence state (fresh within 30s) ───────────────────
          const divNow = Math.floor(Date.now() / 1000);
          const div = (divergenceState && divNow - divergenceState.updatedAt < 30)
            ? divergenceState : null;

          if (div && div.strength !== "NONE") {
            botPrint("INFO",
              `Divergence: BTC ${div.btcDelta30s >= 0 ? "+" : ""}$${div.btcDelta30s.toFixed(0)} (30s) | YES ${div.yesDelta30s >= 0 ? "+" : ""}${div.yesDelta30s.toFixed(2)}¢ | direction=${div.direction} strength=${div.strength} score=${div.divergence.toFixed(2)}`
            );
          }

          // Use pre-analyzed Gemini result if available, otherwise call fresh
          let rec: any;
          if (cachedWindowData?.rec) {
            rec = cachedWindowData.rec;
            botPrint("OK", `Cached AI: ${rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—"} ${rec.decision} ${rec.direction !== "NONE" ? rec.direction : ""} | conf=${rec.confidence}% | edge=${rec.estimatedEdge}¢ | risk=${rec.riskLevel}`);
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
              lossMemory.slice(0, 5),
              div,
              winMemory.slice(0, 3)
            );
          }

          // ── Apply divergence overrides AFTER AI decision ────────────────
          if (div && div.strength !== "NONE" && div.direction !== "NEUTRAL") {
            if (div.strength === "STRONG" && rec.decision !== "TRADE") {
              // Force trade in divergence direction — market is clearly lagging BTC
              botPrint("TRADE",
                `DIVERGENCE OVERRIDE ✦ BTC +$${Math.abs(div.btcDelta30s).toFixed(0)} in 30s, YES only ${div.yesDelta30s.toFixed(2)}¢ — forcing ${div.direction} trade`
              );
              rec = { ...rec, decision: "TRADE", direction: div.direction, confidence: Math.max(rec.confidence, 72), riskLevel: "MEDIUM" };
            } else if (div.strength === "MODERATE" && rec.decision === "TRADE" && rec.direction === div.direction) {
              // Same direction — boost confidence
              const boosted = Math.min(rec.confidence + 10, 95);
              botPrint("OK", `Divergence CONFIRMS AI direction (${div.direction}) — confidence boosted ${rec.confidence}% → ${boosted}%`);
              rec = { ...rec, confidence: boosted };
            } else if ((div.strength === "STRONG" || div.strength === "MODERATE") && rec.decision === "TRADE" && rec.direction !== div.direction) {
              // Conflict — BTC going one way, AI says opposite → skip
              botPrint("WARN",
                `DIVERGENCE CONFLICT ✦ AI says ${rec.direction} but BTC divergence says ${div.direction} (${div.strength}) — trade blocked`
              );
              rec = { ...rec, decision: "NO_TRADE", reasoning: rec.reasoning + ` | BLOCKED: divergence conflict (BTC ${div.direction} vs AI ${rec.direction})` };
            }
          }

          // Log AI result
          const decisionIcon = rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—";
          botPrint(
            rec.decision === "TRADE" ? "INFO" : "SKIP",
            `AI Result: ${decisionIcon} ${rec.decision} ${rec.direction} | conf=${rec.confidence}% | edge=${rec.estimatedEdge}¢ | risk=${rec.riskLevel}`
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
              divergence: div && div.strength !== "NONE"
                ? { direction: div.direction, strength: div.strength, btcDelta30s: div.btcDelta30s, yesDelta30s: div.yesDelta30s }
                : null,
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
            if (rec.estimatedEdge < cfg.minEdge) reasons.push(`edge ${rec.estimatedEdge}¢ < ${cfg.minEdge}¢`);
            if (rec.riskLevel === "HIGH") reasons.push(`risk=${rec.riskLevel} (need LOW or MEDIUM)`);
            botPrint("SKIP", `Trade rejected by bot filters: ${reasons.join(" | ")}`);
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

              const sessionLossPct = botSessionStartBalance && botSessionStartBalance > 0
                ? (botSessionStartBalance - currentBalance) / botSessionStartBalance
                : 0;

              if (sessionLossPct >= cfg.sessionLossLimit) {
                botPrint("WARN", `━━━ SESSION LOSS LIMIT HIT: ${(sessionLossPct * 100).toFixed(1)}% drawdown ≥ ${cfg.sessionLossLimit * 100}% limit. BOT HALTED. ━━━`);
                botEnabled = false;
                logEntry.reasoning = `SESSION STOP: Down ${(sessionLossPct * 100).toFixed(1)}% — bot halted.`;
                botLog.unshift(logEntry);
                if (botLog.length > 100) botLog.pop();
                break;
              }

              // ── Kelly sizing with balance-aware adjustment ──────────────────
              const outcomeIndex = rec.direction === "UP" ? 0 : 1;
              const tokenId: string = market.clobTokenIds?.[outcomeIndex];
              if (tokenId) {
                // Fetch live order book price FIRST — before Kelly calc.
                // market.outcomePrices can be stale/mid; bestAsk is the real fill cost.
                const ob = orderBooks[tokenId];
                const bestAsk = Number(ob?.asks?.[0]?.price || "0");
                const bestBid = Number(ob?.bids?.[0]?.price || "0");

                // ── Dynamic entry price gate ─────────────────────────────────
                // Break-even win rate = entry price for binary $1 payouts.
                // So at 70% confidence, paying 70¢ is break-even — we need
                // a buffer to actually profit. Formula: max = (confidence - 10) / 100
                //   70% conf → max 60¢  (EV = +10¢/share)
                //   75% conf → max 65¢  (EV = +10¢/share)
                //   80% conf → max 70¢  (EV = +10¢/share)
                //   85%+ conf → max 75¢ (capped; divergence gets 85¢ exception)
                // STRONG divergence is a structural edge (real price lag) → allow 85¢.
                const isDivergenceStrong = div?.strength === "STRONG";
                const MAX_ENTRY_PRICE = isDivergenceStrong
                  ? 0.85
                  : Math.min(0.75, (rec.confidence - 10) / 100);
                if (bestAsk > 0 && bestAsk > MAX_ENTRY_PRICE) {
                  botPrint("SKIP", `Entry price too high: bestAsk=${(bestAsk * 100).toFixed(0)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ max (conf=${rec.confidence}%${isDivergenceStrong ? ", divergence override" : ""}). Negative EV — skipping.`);
                  logEntry.reasoning += ` | Skipped: bestAsk ${(bestAsk * 100).toFixed(0)}¢ > ${(MAX_ENTRY_PRICE * 100).toFixed(0)}¢ dynamic max (conf=${rec.confidence}%).`;
                  botLog.unshift(logEntry);
                  if (botLog.length > 100) botLog.pop();
                  pushSSE("cycle", { ts: new Date().toISOString() });
                  continue;
                }

                // Use bestAsk as impliedPrice for Kelly when available —
                // this reflects the actual fill cost, not a stale API mid-price.
                const marketImplied = parseFloat(market.outcomePrices[outcomeIndex] || "0.5");
                const impliedPrice = bestAsk > 0 ? bestAsk : marketImplied;

                const p = rec.confidence / 100;
                const b = (1 - impliedPrice) / impliedPrice;
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

                const rawBet = kelly > 0 ? currentBalance * kelly * cfg.kellyFraction * volMultiplier : 0;

                // Cap to Kelly formula, max bet config, and balance cap (mode-dependent)
                const kellyCapped = Math.min(rawBet, cfg.maxBetUsdc, currentBalance * cfg.balanceCap);

                // Reserve $1 minimum buffer — never spend the last dollar
                const BALANCE_RESERVE = 1.0;
                const spendable = Math.max(0, currentBalance - BALANCE_RESERVE);

                // Final bet: clamped to what we can actually afford
                const betAmount = parseFloat(Math.min(kellyCapped, spendable).toFixed(2));

                botPrint("INFO", `Kelly calc: implied=${(impliedPrice * 100).toFixed(0)}¢ (${bestAsk > 0 ? "live ask" : "market mid"}) raw=$${rawBet.toFixed(2)} → capped=$${kellyCapped.toFixed(2)} → final=$${betAmount.toFixed(2)} USDC [${botMode}]`);
                botPrint("INFO", `Balance check: $${currentBalance.toFixed(2)} available | $${betAmount.toFixed(2)} to spend | $${(currentBalance - betAmount).toFixed(2)} remaining after trade`);

                if (betAmount < 1) {
                  botPrint("SKIP", `Adjusted bet too small ($${betAmount.toFixed(2)} USDC). Balance may be too low or Kelly fraction too conservative. Skipping.`);
                  logEntry.reasoning += ` | Skipped: Adjusted bet $${betAmount.toFixed(2)} < $1 minimum (balance=$${currentBalance.toFixed(2)}).`;
                } else {
                  // ob, bestAsk, bestBid already fetched above for the hard gate
                  botPrint("TRADE", `━━━ EXECUTING ORDER ━━━`);
                  botPrint("TRADE", `Direction : ${rec.direction === "UP" ? "▲ UP (YES)" : "▼ DOWN (NO)"}`);
                  botPrint("TRADE", `Amount    : $${betAmount.toFixed(2)} USDC`);
                  botPrint("TRADE", `Price     : ${(bestAsk * 100).toFixed(1)}¢ (ask) | ${(bestBid * 100).toFixed(1)}¢ (bid)`);
                  botPrint("TRADE", `Confidence: ${rec.confidence}% | Edge: ${rec.estimatedEdge}¢ | Risk: ${rec.riskLevel}`);
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
                    botPrint("OK", `TP: ${(parseFloat(levels.takeProfit) * 100).toFixed(0)}¢ | SL: ${(parseFloat(levels.stopLoss) * 100).toFixed(0)}¢ | TS: ${(parseFloat(levels.trailingStop) * 100).toFixed(0)}¢ distance — automation ARMED`);
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
                    });
                    botPrint("INFO", `Result tracker armed — checking after ${new Date((currentWindowStart + MARKET_SESSION_SECONDS + 90) * 1000).toLocaleTimeString()}`);
                  } catch (tradeErr: any) {
                    logEntry.error = tradeErr?.message || String(tradeErr);
                    botPrint("ERR", `Trade execution failed: ${logEntry.error}`);
                  }
                }
              }
            }
          } else if (rec.decision === "NO_TRADE") {
            botPrint("SKIP", `No trade — waiting for next qualifying setup`);
          }

          botLog.unshift(logEntry);
          if (botLog.length > 100) botLog.pop();
          pushSSE("cycle", { ts: new Date().toISOString() });
        } catch (err: any) {
          botPrint("ERR", `Analysis error: ${err?.message || String(err)}`);
        }
      }
    } finally {
      botRunning = false;
    }
  };

  const startBot = () => {
    if (botInterval) return;
    console.log("");
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║          PolyBTC AI Trading Bot — STARTED         ║");
    console.log("╚═══════════════════════════════════════════════════╝");
    const startCfg = getActiveConfig();
    botPrint("INFO", `Mode           : ${botMode}`);
    botPrint("INFO", `Min confidence : ${startCfg.minConfidence}%`);
    botPrint("INFO", `Min edge       : ${startCfg.minEdge}¢`);
    botPrint("INFO", `Max bet        : $${startCfg.maxBetUsdc} USDC`);
    botPrint("INFO", `Kelly fraction : ${startCfg.kellyFraction * 100}%`);
    botPrint("INFO", `Session limit  : -${startCfg.sessionLossLimit * 100}% halt`);
    botPrint("INFO", `Scan interval  : every ${BOT_SCAN_INTERVAL_MS / 1000}s`);
    console.log("");
    void runBotCycle();
    botInterval = setInterval(() => void runBotCycle(), BOT_SCAN_INTERVAL_MS);
  };

  const stopBot = () => {
    if (botInterval) { clearInterval(botInterval); botInterval = null; }
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
      config: {
        mode: botMode,
        minConfidence: getActiveConfig().minConfidence,
        minEdge: getActiveConfig().minEdge,
        kellyFraction: getActiveConfig().kellyFraction,
        maxBetUsdc: getActiveConfig().maxBetUsdc,
        sessionLossLimit: getActiveConfig().sessionLossLimit,
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

  app.get("/api/bot/log", (_req, res) => {
    res.json({ log: botLog });
  });

  app.get("/api/bot/rawlog", (_req, res) => {
    res.json({ log: rawLog });
  });

  // ── SSE endpoint — real-time bot events ────────────────────────────────────
  app.get("/api/bot/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current log snapshot so the client is immediately up-to-date
    res.write(`event: snapshot\ndata: ${JSON.stringify({ log: rawLog.slice(0, 200) })}\n\n`);

    sseClients.add(res as unknown as ServerResponse);
    req.on("close", () => sseClients.delete(res as unknown as ServerResponse));
  });

  app.get("/api/bot/learning", (_req, res) => {
    res.json({
      consecutiveLosses,
      consecutiveWins,
      adaptiveConfidenceBoost,
      effectiveMinConfidence: BOT_MIN_CONFIDENCE + adaptiveConfidenceBoost,
      baseMinConfidence: BOT_MIN_CONFIDENCE,
      lossMemoryCount: lossMemory.length,
      winMemoryCount: winMemory.length,
      recentLosses: lossMemory.slice(0, 10),
      recentWins: winMemory.slice(0, 10),
    });
  });

  app.post("/api/bot/mode", (req, res) => {
    const { mode } = req.body || {};
    if (mode !== "AGGRESSIVE" && mode !== "CONSERVATIVE") {
      return res.status(400).json({ error: "mode must be AGGRESSIVE or CONSERVATIVE" });
    }
    botMode = mode;
    const cfg = getActiveConfig();
    botPrint("INFO", `Bot mode switched to ${botMode} — conf≥${cfg.minConfidence}% edge≥${cfg.minEdge}¢ maxBet=$${cfg.maxBetUsdc} kelly=${cfg.kellyFraction * 100}% sessionLimit=${cfg.sessionLossLimit * 100}% window=${cfg.entryWindowStart}–${cfg.entryWindowEnd}s`);
    res.json({ ok: true, mode: botMode, config: cfg });
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

  // API Proxy for Polymarket — BTC Up/Down 5-Minute Events (5 timeframes)
  app.get("/api/polymarket/markets", async (req, res) => {
    try {
      const nowUtcSeconds = Math.floor(Date.now() / 1000);
      const currentStart = Math.floor(nowUtcSeconds / MARKET_SESSION_SECONDS) * MARKET_SESSION_SECONDS;

      // Generate 2 slugs: current window + next upcoming window
      const slugs = Array.from({ length: 2 }, (_, i) => {
        const ts = currentStart + i * MARKET_SESSION_SECONDS;
        return `btc-updown-5m-${ts}`;
      });

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

      // Flatten each event's markets and attach event metadata
      const markets = events.flatMap((event: any) =>
        (event.markets || []).map((m: any) => ({
          ...m,
          outcomes: parseArr(m.outcomes),
          outcomePrices: parseArr(m.outcomePrices),
          clobTokenIds: parseArr(m.clobTokenIds),
          eventSlug: event.slug,
          eventTitle: event.title,
          eventId: event.id,
          startDate: event.startDate,
          endDate: event.endDate,
        }))
      );

      console.log(`Fetched ${events.length}/2 events → ${markets.length} markets`);
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
