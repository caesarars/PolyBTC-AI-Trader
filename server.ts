import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { MongoClient, Db, Collection } from "mongodb";
import { analyzeMarket } from "./src/services/gemini.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const BOT_SCAN_INTERVAL_MS = Number(process.env.BOT_SCAN_INTERVAL_MS || 10_000);
const BOT_MIN_CONFIDENCE = Number(process.env.BOT_MIN_CONFIDENCE || 68);
const BOT_MIN_EDGE = Number(process.env.BOT_MIN_EDGE || 8);
const BOT_KELLY_FRACTION = Number(process.env.BOT_KELLY_FRACTION || 0.15);
const BOT_MAX_BET_USDC = Number(process.env.BOT_MAX_BET_USDC || 50);
const BOT_SESSION_LOSS_LIMIT = Number(process.env.BOT_SESSION_LOSS_LIMIT || 0.10);

// ── Bot runtime state ────────────────────────────────────────────────────────
let botEnabled = process.env.BOT_AUTO_START === "true";
let botRunning = false;
let botInterval: NodeJS.Timeout | null = null;
let botSessionStartBalance: number | null = null;
let botSessionTradesCount = 0;
let botLastWindowStart = 0;
const botAnalyzedThisWindow = new Set<string>();

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
  highestPrice?: string;
  trailingStopPrice?: string;
  lastPrice?: string;
  status?: string;
  lastExitOrderId?: string | null;
  updatedAt: Date;
  lastTriggeredAt?: Date | null;
};

type TradePerformancePosition = {
  assetId: string;
  market: string;
  outcome: string;
  size: string;
  costBasis: string;
  averagePrice: string;
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

function computePerformanceData(trades: any[]) {
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(b.match_time).getTime() - new Date(a.match_time).getTime()
  );

  const inventory = new Map<string, { qty: number; cost: number; outcome: string; market: string }>();
  let realizedPnl = 0;
  let winCount = 0;
  let lossCount = 0;

  const history = sortedTrades.map((trade) => {
    const qty = Number(trade.size || "0");
    const price = Number(trade.price || "0");
    const notional = qty * price;
    const key = trade.asset_id;
    const current = inventory.get(key) || { qty: 0, cost: 0, outcome: trade.outcome, market: trade.market };
    let tradePnl = 0;

    if (trade.side === Side.BUY) {
      current.qty += qty;
      current.cost += notional;
      inventory.set(key, current);
    } else {
      const avgCost = current.qty > 0 ? current.cost / current.qty : 0;
      const matchedQty = Math.min(qty, current.qty);
      tradePnl = (price - avgCost) * matchedQty;
      realizedPnl += tradePnl;

      if (matchedQty > 0) {
        if (tradePnl > 0) winCount += 1;
        else if (tradePnl < 0) lossCount += 1;
      }

      current.qty = Math.max(0, current.qty - qty);
      current.cost = Math.max(0, current.cost - avgCost * qty);
      inventory.set(key, current);
    }

    return {
      id: trade.id,
      market: trade.market,
      outcome: trade.outcome,
      side: trade.side,
      traderSide: trade.trader_side,
      status: trade.status,
      size: qty.toFixed(4),
      price: price.toFixed(4),
      notional: notional.toFixed(4),
      pnl: tradePnl.toFixed(4),
      matchTime: trade.match_time,
      transactionHash: trade.transaction_hash,
      assetId: trade.asset_id,
    };
  });

  const openPositions = Array.from(inventory.entries())
    .filter(([, position]) => position.qty > 0)
    .map(([assetId, position]) => ({
      assetId,
      market: position.market,
      outcome: position.outcome,
      size: position.qty.toFixed(4),
      costBasis: position.cost.toFixed(4),
      averagePrice: position.qty > 0 ? (position.cost / position.qty).toFixed(4) : "0.0000",
    })) as TradePerformancePosition[];

  const closedTrades = winCount + lossCount;
  const winRate = closedTrades > 0 ? (winCount / closedTrades) * 100 : 0;
  const openExposure = openPositions.reduce((sum, position) => sum + Number(position.costBasis), 0);

  return {
    summary: {
      totalMatchedTrades: history.length,
      closedTrades,
      winCount,
      lossCount,
      winRate: winRate.toFixed(2),
      realizedPnl: realizedPnl.toFixed(4),
      openExposure: openExposure.toFixed(4),
    },
    history,
    openPositions,
  };
}

async function getOpenPositionsSnapshot(client: ClobClient) {
  const trades = await client.getTrades();
  const performance = computePerformanceData(trades);
  return performance.openPositions;
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  void ensureMongoCollections();
  startBtcBackgroundSync();

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

      const openPositions = await getOpenPositionsSnapshot(client);
      const openMap = new Map(openPositions.map((position) => [position.assetId, position]));

      for (const automation of armedAutomations) {
        const openPosition = openMap.get(automation.assetId);
        if (!openPosition) {
          await savePositionAutomation({
            assetId: automation.assetId,
            armed: false,
            status: "Position already closed",
            lastPrice: automation.lastPrice,
          });
          continue;
        }

        try {
          const book = await client.getOrderBook(automation.assetId);
          const bestBid = Number(book?.bids?.[0]?.price || "0");
          if (!(bestBid > 0)) {
            await savePositionAutomation({
              assetId: automation.assetId,
              ...openPosition,
              status: "No live bid available",
              lastPrice: "",
            });
            continue;
          }

          const highestPrice = Math.max(Number(automation.highestPrice || "0"), bestBid);
          const trailingStopDistance = Number(automation.trailingStop || "0");
          const trailingStopPrice =
            trailingStopDistance > 0 ? Math.max(0.01, highestPrice - trailingStopDistance) : 0;
          const takeProfit = Number(automation.takeProfit || "0");
          const stopLoss = Number(automation.stopLoss || "0");

          let triggerReason: string | null = null;
          if (takeProfit > 0 && bestBid >= takeProfit) triggerReason = "take profit";
          if (!triggerReason && stopLoss > 0 && bestBid <= stopLoss) triggerReason = "stop loss";
          if (!triggerReason && trailingStopPrice > 0 && bestBid <= trailingStopPrice) triggerReason = "trailing stop";

          if (triggerReason) {
            const exit = await executePolymarketTrade({
              tokenID: automation.assetId,
              amount: openPosition.size,
              side: Side.SELL,
              price: bestBid.toFixed(4),
            });
            await savePositionAutomation({
              assetId: automation.assetId,
              ...openPosition,
              armed: false,
              highestPrice: highestPrice.toFixed(4),
              trailingStopPrice: trailingStopPrice > 0 ? trailingStopPrice.toFixed(4) : "",
              lastPrice: bestBid.toFixed(4),
              lastExitOrderId: exit.orderID,
              status: `Exit submitted by ${triggerReason}`,
              lastTriggeredAt: new Date(),
            });
            continue;
          }

          await savePositionAutomation({
            assetId: automation.assetId,
            ...openPosition,
            highestPrice: highestPrice.toFixed(4),
            trailingStopPrice: trailingStopPrice > 0 ? trailingStopPrice.toFixed(4) : "",
            lastPrice: bestBid.toFixed(4),
            status: "Monitoring",
          });
        } catch (error: any) {
          await savePositionAutomation({
            assetId: automation.assetId,
            ...openPosition,
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
    console.log(`[${ts()}] [BOT:${level.padEnd(5)}] ${icons[level]} ${msg}`);
  };

  // ── Bot cycle ──────────────────────────────────────────────────────────────
  const runBotCycle = async () => {
    if (botRunning || !botEnabled) return;
    botRunning = true;
    try {
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
        botPrint("INFO", `━━━━ NEW WINDOW ━━━━ ${new Date(currentWindowStart * 1000).toLocaleTimeString()} — ${new Date((currentWindowStart + 300) * 1000).toLocaleTimeString()}`);
      }

      // Only trade in the valid entry zone (30s–270s elapsed)
      if (windowElapsedSeconds < 30 || windowElapsedSeconds > 270) {
        botPrint("SKIP", `Window ${windowElapsedSeconds < 30 ? "too early (< 30s)" : "closing soon (> 270s)"} — ${mm}:${ss} remaining. Waiting.`);
        return;
      }

      // Fetch current market
      const slug = `btc-updown-5m-${currentWindowStart}`;
      const parseArr = (val: any): any[] => {
        if (Array.isArray(val)) return val;
        if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
        return [];
      };

      botPrint("INFO", `Scanning window ${mm}:${ss} remaining | elapsed=${windowElapsedSeconds}s | slug=${slug}`);

      let markets: any[] = [];
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

      for (const market of markets) {
        if (botAnalyzedThisWindow.has(market.id)) {
          botPrint("SKIP", `Already analyzed this window: ${market.question?.slice(0, 50)}`);
          continue;
        }
        botAnalyzedThisWindow.add(market.id);

        botPrint("INFO", `Analyzing: ${market.question?.slice(0, 60)}`);

        try {
          // Fetch all data in parallel
          botPrint("INFO", "Fetching BTC price, history, indicators, sentiment...");
          const [btcPriceData, btcHistoryResult, btcIndicatorsData, sentimentData] = await Promise.all([
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
              const outcome = market.outcomes?.[idx] ?? `Token${idx}`;
              botPrint("OK", `OrderBook [${outcome}]: bid=${raw.bids?.[0]?.price ?? "?"} ask=${raw.asks?.[0]?.price ?? "?"} imbalance=${(imbalance * 100).toFixed(0)}% (${imbalanceSignal}) liquidity=$${totalLiquidityUsdc}`);
            } catch {
              botPrint("WARN", `Failed to fetch order book for token ${tid.slice(0, 12)}...`);
            }
          }));

          // Fetch Polymarket price history for velocity signal
          let marketHistory: { t: number; yes: number; no: number }[] = [];
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

          botPrint("INFO", "Calling Gemini AI for analysis...");
          const rec = await analyzeMarket(
            market,
            btcPriceData?.price ?? null,
            btcHistoryResult?.history ?? [],
            sentimentData,
            btcIndicatorsData,
            orderBooks,
            marketHistory,
            windowElapsedSeconds
          );

          // Log AI result
          const decisionIcon = rec.decision === "TRADE" ? (rec.direction === "UP" ? "▲" : "▼") : "—";
          botPrint(
            rec.decision === "TRADE" ? "INFO" : "SKIP",
            `AI Result: ${decisionIcon} ${rec.decision} ${rec.direction} | conf=${rec.confidence}% | edge=${rec.estimatedEdge}¢ | risk=${rec.riskLevel}`
          );
          botPrint("INFO", `Reasoning: ${rec.reasoning.slice(0, 120)}`);

          const qualifies =
            rec.decision === "TRADE" &&
            rec.confidence >= BOT_MIN_CONFIDENCE &&
            rec.estimatedEdge >= BOT_MIN_EDGE &&
            rec.riskLevel === "LOW";

          if (rec.decision === "TRADE" && !qualifies) {
            const reasons: string[] = [];
            if (rec.confidence < BOT_MIN_CONFIDENCE) reasons.push(`conf ${rec.confidence}% < ${BOT_MIN_CONFIDENCE}%`);
            if (rec.estimatedEdge < BOT_MIN_EDGE) reasons.push(`edge ${rec.estimatedEdge}¢ < ${BOT_MIN_EDGE}¢`);
            if (rec.riskLevel !== "LOW") reasons.push(`risk=${rec.riskLevel} (need LOW)`);
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

              // Session loss guard
              let currentBalance = botSessionStartBalance ?? 0;
              try {
                const col = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
                currentBalance = Number(ethers.utils.formatUnits(col.balance || "0", 6));
                botPrint("INFO", `Current balance: $${currentBalance.toFixed(2)} USDC (session start: $${botSessionStartBalance?.toFixed(2) ?? "?"})`);
              } catch { /* use last known */ }

              const sessionLossPct = botSessionStartBalance && botSessionStartBalance > 0
                ? (botSessionStartBalance - currentBalance) / botSessionStartBalance
                : 0;

              if (sessionLossPct >= BOT_SESSION_LOSS_LIMIT) {
                botPrint("WARN", `━━━ SESSION LOSS LIMIT HIT: ${(sessionLossPct * 100).toFixed(1)}% drawdown ≥ ${BOT_SESSION_LOSS_LIMIT * 100}% limit. BOT HALTED. ━━━`);
                botEnabled = false;
                logEntry.reasoning = `SESSION STOP: Down ${(sessionLossPct * 100).toFixed(1)}% — bot halted.`;
                botLog.unshift(logEntry);
                if (botLog.length > 100) botLog.pop();
                break;
              }

              // Compute Kelly bet capped at 3% bankroll and BOT_MAX_BET_USDC
              const outcomeIndex = rec.direction === "UP" ? 0 : 1;
              const tokenId: string = market.clobTokenIds?.[outcomeIndex];
              if (tokenId) {
                const impliedPrice = parseFloat(market.outcomePrices[outcomeIndex] || "0.5");
                const p = rec.confidence / 100;
                const b = (1 - impliedPrice) / impliedPrice;
                const kelly = (p * b - (1 - p)) / b;
                const rawBet = kelly > 0 ? currentBalance * kelly * BOT_KELLY_FRACTION : 0;
                const betAmount = parseFloat(Math.min(rawBet, BOT_MAX_BET_USDC, currentBalance * 0.03).toFixed(2));
                botPrint("INFO", `Kelly calc: raw=$${rawBet.toFixed(2)} → capped=$${betAmount.toFixed(2)} (max_bet=$${BOT_MAX_BET_USDC}, 3%_bankroll=$${(currentBalance * 0.03).toFixed(2)})`);

                if (betAmount < 1) {
                  botPrint("SKIP", `Bet too small ($${betAmount.toFixed(2)} < $1 minimum). Skipping trade.`);
                  logEntry.reasoning += ` | Skipped: Kelly bet too small ($${betAmount.toFixed(2)}).`;
                } else {
                  const ob = orderBooks[tokenId];
                  const bestAsk = Number(ob?.asks?.[0]?.price || impliedPrice.toString());
                  const bestBid = Number(ob?.bids?.[0]?.price || "0");
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
    botPrint("INFO", `Min confidence : ${BOT_MIN_CONFIDENCE}%`);
    botPrint("INFO", `Min edge       : ${BOT_MIN_EDGE}¢`);
    botPrint("INFO", `Max bet        : $${BOT_MAX_BET_USDC} USDC`);
    botPrint("INFO", `Kelly fraction : ${BOT_KELLY_FRACTION * 100}%`);
    botPrint("INFO", `Session limit  : -${BOT_SESSION_LOSS_LIMIT * 100}% halt`);
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
      config: {
        minConfidence: BOT_MIN_CONFIDENCE,
        minEdge: BOT_MIN_EDGE,
        kellyFraction: BOT_KELLY_FRACTION,
        maxBetUsdc: BOT_MAX_BET_USDC,
        sessionLossLimit: BOT_SESSION_LOSS_LIMIT,
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

  app.get("/api/polymarket/performance", async (_req, res) => {
    try {
      const client = await getClobClient();
      if (!client) {
        return res.status(400).json({ error: "CLOB client not initialized. Check credentials." });
      }

      const trades = await client.getTrades();
      res.json(computePerformanceData(trades));
    } catch (error: any) {
      console.error("Performance Lookup Error:", error);
      res.status(500).json(formatTradeError(error));
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
