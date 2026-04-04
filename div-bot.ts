/**
 * div-bot.ts — Standalone Divergence-Only Trading Bot
 *
 * Strategy:
 *   Monitor CEX asset price (BTC/ETH/SOL) via Binance/Coinbase every 5s.
 *   When CEX price moves sharply but Polymarket YES token hasn't caught up
 *   (price lag / divergence), immediately enter in the direction of the move.
 *   No AI, no candle analysis — pure structural mispricing.
 *
 * Run: tsx div-bot.ts
 */

import "dotenv/config";
import axios from "axios";
import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
// Config (all overridable via env)
// ─────────────────────────────────────────────────────────────────────────────
const ENABLED_ASSETS     = (process.env.DIV_ASSETS || "BTC,ETH,SOL").split(",").map(s => s.trim().toUpperCase()) as Asset[];
const FIXED_BET_USDC     = Number(process.env.BOT_FIXED_TRADE_USDC || 1.5);
const MAX_ENTRY_PRICE    = 0.85;    // don't enter above 85¢ (window closing)
const MIN_REMAINING_SEC  = 120;     // need at least 2 min left in window
const ENTRY_WINDOW_START = 10;      // skip first 10s (no data yet)
const ENTRY_WINDOW_END   = 220;     // stop entering after 220s
const TRACKER_INTERVAL   = 5_000;  // 5s tick
const COOLDOWN_PER_ASSET = 30;     // seconds between fast-path fires per asset
const MARKET_WINDOW_SEC  = 300;    // 5-min Polymarket windows

// Divergence thresholds — CEX price move in 30s (absolute $)
// If abs(delta) >= STRONG and YES hasn't caught up by 2¢ → fire trade
const DIV_CONFIG: Record<Asset, { strong: number; mod: number; weak: number }> = {
  BTC: { strong: 100, mod: 60,  weak: 30  },
  ETH: { strong: 6,   mod: 3.5, weak: 1.5 },
  SOL: { strong: 6,   mod: 3.5, weak: 1.5 },  // raised from 2 — was too sensitive
};
const YES_LAG_THRESHOLD = 2.0; // ¢ — YES must be at least 2¢ behind

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type Asset = "BTC" | "ETH" | "SOL";
type Direction = "UP" | "DOWN";
interface PricePoint { ts: number; price: number; }

const ASSET_CONFIG: Record<Asset, {
  binanceSymbol: string;
  coinbaseProduct: string;
  polySlugPrefix: string;
}> = {
  BTC: { binanceSymbol: "BTCUSDT", coinbaseProduct: "BTC-USD", polySlugPrefix: "btc-updown-5m" },
  ETH: { binanceSymbol: "ETHUSDT", coinbaseProduct: "ETH-USD", polySlugPrefix: "eth-updown-5m" },
  SOL: { binanceSymbol: "SOLUSDT", coinbaseProduct: "SOL-USD", polySlugPrefix: "sol-updown-5m" },
};

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
// Per-asset price ring buffers (5s samples, 10-min window = 120 points max)
const priceRingBuf = new Map<Asset, PricePoint[]>([["BTC",[]], ["ETH",[]], ["SOL",[]]]);
const yesRingBuf   = new Map<Asset, PricePoint[]>([["BTC",[]], ["ETH",[]], ["SOL",[]]]);

// Current active market per asset (fetched each window)
const activeMarket    = new Map<Asset, any | null>();
const tradedThisWindow = new Map<Asset, Set<string>>([["BTC", new Set()], ["ETH", new Set()], ["SOL", new Set()]]);
const lastFireAt      = new Map<Asset, number>([["BTC", 0], ["ETH", 0], ["SOL", 0]]);

// YES/NO token IDs for order book polling
const yesTokenId = new Map<Asset, string | null>([["BTC", null], ["ETH", null], ["SOL", null]]);
const noTokenId  = new Map<Asset, string | null>([["BTC", null], ["ETH", null], ["SOL", null]]);

let lastWindowStart = 0;
let clobClient: ClobClient | null = null;
let lastKnownBalance = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────
function log(tag: string, msg: string) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] [${tag.padEnd(5)}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOB Client
// ─────────────────────────────────────────────────────────────────────────────
async function getClob(): Promise<ClobClient> {
  if (clobClient) return clobClient;
  const provider = new ethers.providers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com", { name: "polygon", chainId: 137 });
  const wallet = new ethers.Wallet(process.env.POLYGON_PRIVATE_KEY!, provider);
  const client = new ClobClient(
    "https://clob.polymarket.com",
    137,
    wallet,
    {
      key:        process.env.POLYMARKET_API_KEY!,
      secret:     process.env.POLYMARKET_API_SECRET!,
      passphrase: process.env.POLYMARKET_API_PASSPHRASE!,
    },
    Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1),
    process.env.POLYMARKET_FUNDER_ADDRESS,
  );
  await client.deriveApiKey().catch(() => {});
  clobClient = client;
  return client;
}

async function getBalance(): Promise<number> {
  try {
    const client = await getClob();
    const allowance = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const bal = Number(ethers.utils.formatUnits((allowance as any).balance || "0", 6));
    lastKnownBalance = bal;
    return bal;
  } catch { return lastKnownBalance; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Price fetchers
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCexPrice(asset: Asset): Promise<number | null> {
  const cfg = ASSET_CONFIG[asset];
  // Try Binance first (3 hosts), then Coinbase
  const binanceHosts = ["https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com"];
  for (const host of binanceHosts) {
    try {
      const r = await axios.get(`${host}/api/v3/ticker/price`, { params: { symbol: cfg.binanceSymbol }, timeout: 4000 });
      return parseFloat(r.data.price);
    } catch { /* try next */ }
  }
  try {
    const r = await axios.get(`https://api.coinbase.com/v2/prices/${cfg.coinbaseProduct}/spot`, { timeout: 4000 });
    return parseFloat(r.data?.data?.amount);
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Market fetcher
// ─────────────────────────────────────────────────────────────────────────────
function parseArr(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") { try { return JSON.parse(val); } catch { return []; } }
  return [];
}

async function fetchActiveMarkets(windowStart: number): Promise<void> {
  await Promise.allSettled(ENABLED_ASSETS.map(async (asset) => {
    const slug = `${ASSET_CONFIG[asset].polySlugPrefix}-${windowStart}`;
    try {
      const r = await axios.get(`https://gamma-api.polymarket.com/events/slug/${slug}`, { timeout: 8000 });
      const event = r.data;
      const markets: any[] = (event?.markets || []).map((m: any) => ({
        ...m,
        outcomes:      parseArr(m.outcomes),
        outcomePrices: parseArr(m.outcomePrices),
        clobTokenIds:  parseArr(m.clobTokenIds),
        eventSlug:     event.slug,
      }));
      if (markets.length === 0) { log("WARN", `[${asset}] No market for ${slug}`); return; }

      const market = markets[0];
      activeMarket.set(asset, market);

      // Wire YES/NO token IDs for order book polling
      const yId: string = market.clobTokenIds?.[0] ?? null;
      const nId: string = market.clobTokenIds?.[1] ?? null;
      yesTokenId.set(asset, yId);
      noTokenId.set(asset, nId);

      log("INFO", `[${asset}] Market loaded: ${market.question?.slice(0, 60)}`);
    } catch {
      log("ERR", `[${asset}] Failed to fetch market for ${slug}`);
    }
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute trade
// ─────────────────────────────────────────────────────────────────────────────
async function executeTrade(asset: Asset, direction: Direction, tokenId: string, askPrice: number, betAmount: number) {
  const client = await getClob();
  const orderbook = await client.getOrderBook(tokenId);
  const liveAsk = Number(orderbook?.asks?.[0]?.price || askPrice);
  const price = liveAsk > 0 && liveAsk < 0.97 ? liveAsk : askPrice;

  if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error(`Invalid price: ${price}`);

  const orderSize = betAmount / price;
  const [tickSize, negRisk] = await Promise.all([client.getTickSize(tokenId), client.getNegRisk(tokenId)]);

  const order = await client.createOrder({
    tokenID:   tokenId,
    price:     price,
    side:      Side.BUY,
    size:      orderSize,
    feeRateBps: 0,
    orderType: OrderType.GTC,
    nonce:     0,
    expiration: 0,
    taker:     "",
  });

  const resp = await client.postOrder(order, OrderType.GTC);
  return { orderID: (resp as any).orderID ?? (resp as any).id ?? "?", status: (resp as any).status ?? "submitted", price, size: orderSize };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core divergence logic — called every tick per asset
// ─────────────────────────────────────────────────────────────────────────────
async function processDivergence(asset: Asset, now: number, yesAsk: number | null) {
  const pBuf = priceRingBuf.get(asset)!;
  const yBuf = yesRingBuf.get(asset)!;

  const findNearest = (buf: PricePoint[], targetTs: number) =>
    buf.reduce<PricePoint | null>((best, p) => {
      if (p.ts > targetTs) return best;
      if (!best || Math.abs(p.ts - targetTs) < Math.abs(best.ts - targetTs)) return p;
      return best;
    }, null);

  const priceNow = pBuf.length > 0 ? pBuf[pBuf.length - 1].price : null;
  const yesNow   = yBuf.length > 0 ? yBuf[yBuf.length - 1].price : null;

  const price30ref = findNearest(pBuf, now - 30);
  const yes30ref   = findNearest(yBuf, now - 30);

  if (!priceNow || !price30ref) return; // not enough history yet

  const priceDelta30s = priceNow - price30ref.price;
  const yesDelta30s   = yesNow && yes30ref ? (yesNow - yes30ref.price) * 100 : 0;

  const cfg = DIV_CONFIG[asset];
  const absDelta = Math.abs(priceDelta30s);
  if (absDelta < cfg.strong) return; // not STRONG enough

  const direction: Direction = priceDelta30s > 0 ? "UP" : "DOWN";
  const yesInDir  = direction === "UP" ? yesDelta30s : -yesDelta30s;
  const yesLagging = yesInDir < YES_LAG_THRESHOLD;
  if (!yesLagging) return; // YES already caught up — no mispricing

  // ── Guards ──────────────────────────────────────────────────────────────────
  const windowStart   = Math.floor(now / MARKET_WINDOW_SEC) * MARKET_WINDOW_SEC;
  const windowElapsed = now - windowStart;
  const windowRemaining = MARKET_WINDOW_SEC - windowElapsed;

  if (windowElapsed < ENTRY_WINDOW_START || windowElapsed > ENTRY_WINDOW_END) return;
  if (windowRemaining < MIN_REMAINING_SEC) {
    log("SKIP", `[${asset}] DIV: only ${windowRemaining}s left — skip`);
    return;
  }

  // Cooldown per asset
  const lastFire = lastFireAt.get(asset) ?? 0;
  if (now - lastFire < COOLDOWN_PER_ASSET) return;

  const market = activeMarket.get(asset);
  if (!market) return;

  // Already traded this window?
  const traded = tradedThisWindow.get(asset)!;
  if (traded.has(market.id)) return;

  // ── Get token + order book ──────────────────────────────────────────────────
  const outcomeIndex = direction === "UP" ? 0 : 1;
  const tokenId: string = market.clobTokenIds?.[outcomeIndex];
  if (!tokenId) return;

  // Fetch fresh order book
  let bestAsk = 0;
  try {
    const r = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, { timeout: 3000 });
    const asks: any[] = r.data?.asks ?? [];
    const bids: any[] = r.data?.bids ?? [];
    const clobAsk = asks.length > 0 ? parseFloat(asks[0].price) : 0;
    const implied = parseFloat(market.outcomePrices?.[outcomeIndex] ?? "0");
    bestAsk = clobAsk > 0 && clobAsk < 0.97 ? clobAsk : implied > 0 ? implied : clobAsk;
  } catch {
    log("WARN", `[${asset}] Failed to fetch CLOB book — skip`);
    return;
  }

  if (bestAsk <= 0 || bestAsk > MAX_ENTRY_PRICE) {
    log("SKIP", `[${asset}] DIV: ask ${(bestAsk*100).toFixed(0)}¢ out of range — skip`);
    return;
  }

  // Coin-flip zone guard (48–52¢) — maximum uncertainty
  if (bestAsk >= 0.48 && bestAsk <= 0.52) {
    log("SKIP", `[${asset}] DIV: coin-flip zone (${(bestAsk*100).toFixed(0)}¢) — skip`);
    return;
  }

  // ── Bet sizing ──────────────────────────────────────────────────────────────
  const balance = await getBalance();
  if (balance <= 0) { log("SKIP", `[${asset}] No balance`); return; }

  const reserve   = Math.min(1.0, balance * 0.10);
  const spendable = Math.max(0, balance - reserve);
  const betAmount = parseFloat(Math.min(FIXED_BET_USDC, spendable).toFixed(2));
  const MIN_BET   = Math.min(0.50, balance * 0.20);

  if (betAmount < MIN_BET) {
    log("SKIP", `[${asset}] Bet $${betAmount} < min $${MIN_BET.toFixed(2)}`);
    return;
  }

  // ── Fire! ───────────────────────────────────────────────────────────────────
  log("TRADE", `⚡ [${asset}] DIVERGENCE ${direction} | Δprice=${priceDelta30s >= 0 ? "+" : ""}$${priceDelta30s.toFixed(0)} (30s) | YES lag=${yesDelta30s.toFixed(2)}¢ | ask=${(bestAsk*100).toFixed(0)}¢ | $${betAmount} USDC`);

  traded.add(market.id);
  lastFireAt.set(asset, now);

  try {
    const result = await executeTrade(asset, direction, tokenId, bestAsk, betAmount);
    log("OK", `⚡ [${asset}] EXECUTED ✓ orderId=${result.orderID} price=${(result.price*100).toFixed(1)}¢ size=${result.size.toFixed(4)}`);
  } catch (err: any) {
    // Rollback guard so we can retry next tick
    traded.delete(market.id);
    log("ERR", `[${asset}] Trade failed: ${err?.message ?? err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main tick — runs every 5s
// ─────────────────────────────────────────────────────────────────────────────
async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / MARKET_WINDOW_SEC) * MARKET_WINDOW_SEC;

  // New window → reset state & reload markets
  if (windowStart !== lastWindowStart) {
    lastWindowStart = windowStart;
    for (const s of tradedThisWindow.values()) s.clear();
    for (const buf of yesRingBuf.values()) buf.length = 0;
    for (const asset of ENABLED_ASSETS) {
      activeMarket.set(asset, null);
      yesTokenId.set(asset, null);
      noTokenId.set(asset, null);
    }
    log("INFO", `━━━ NEW WINDOW ━━━ ${new Date(windowStart * 1000).toLocaleTimeString()} → ${new Date((windowStart + MARKET_WINDOW_SEC) * 1000).toLocaleTimeString()}`);
    await fetchActiveMarkets(windowStart);
  }

  // Sample CEX prices and YES ask for all assets in parallel
  await Promise.allSettled(ENABLED_ASSETS.map(async (asset) => {
    const pBuf = priceRingBuf.get(asset)!;
    const yBuf = yesRingBuf.get(asset)!;

    // 1. CEX price sample
    const cexPrice = await fetchCexPrice(asset);
    if (cexPrice && cexPrice > 0) {
      pBuf.push({ ts: now, price: cexPrice });
      if (pBuf.length > 120) pBuf.shift();
    }

    // 2. YES token ask sample
    let yesAsk: number | null = null;
    const yId = yesTokenId.get(asset);
    if (yId) {
      try {
        const r = await axios.get(`https://clob.polymarket.com/book?token_id=${yId}`, { timeout: 3000 });
        const asks: any[] = r.data?.asks ?? [];
        const bids: any[] = r.data?.bids ?? [];
        yesAsk = asks.length > 0 ? parseFloat(asks[0].price)
               : bids.length > 0 ? parseFloat(bids[0].price) : null;
        if (yesAsk && yesAsk > 0) {
          yBuf.push({ ts: now, price: yesAsk });
          if (yBuf.length > 120) yBuf.shift();
        }
      } catch { /* non-fatal */ }
    }

    // 3. Check divergence and maybe fire trade
    await processDivergence(asset, now, yesAsk);
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   PolyBTC Divergence Bot — STARTED       ║");
  console.log("╚══════════════════════════════════════════╝");
  log("INFO", `Assets  : ${ENABLED_ASSETS.join(", ")}`);
  log("INFO", `Bet     : $${FIXED_BET_USDC} USDC fixed`);
  log("INFO", `Thresholds (STRONG): BTC=$${DIV_CONFIG.BTC.strong} ETH=$${DIV_CONFIG.ETH.strong} SOL=$${DIV_CONFIG.SOL.strong}`);
  log("INFO", `Tick    : every ${TRACKER_INTERVAL / 1000}s`);
  console.log("");

  // Warm up CLOB client and fetch initial balance
  try {
    await getClob();
    const bal = await getBalance();
    log("INFO", `Balance : $${bal.toFixed(2)} USDC`);
  } catch (err: any) {
    log("ERR", `CLOB init failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Run first tick immediately, then every 5s
  await tick().catch(err => log("ERR", `tick error: ${err?.message ?? err}`));
  setInterval(() => {
    tick().catch(err => log("ERR", `tick error: ${err?.message ?? err}`));
  }, TRACKER_INTERVAL);
}

main();
