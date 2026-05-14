// ── Polymarket order book ladder logger ───────────────────────────────────────
// Persists full bid/ask ladders to disk so Phase 1 book-replay can simulate
// fills against real depth instead of a flat 0.50 + slippage assumption.
//
// Format: append-only JSONL at data/orderbook_log.jsonl.
// Rotation: lazy — when the file exceeds OB_LOG_MAX_BYTES (default 256 MB)
// it is renamed to orderbook_log.<ts>.jsonl and a fresh file is started.
// Retention is the operator's job (a future S3-upload daemon).

import fs from "fs";
import path from "path";

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  ts: string;                      // ISO 8601
  windowStart: number;             // unix sec — 5-min window the snapshot belongs to
  asset: string;                   // "BTC"
  marketId: string;
  market: string;                  // human-readable question
  eventSlug?: string | null;
  tokenId: string;
  outcomeIndex: number;            // 0 = YES, 1 = NO
  outcome: string;                 // "Up" | "Down" | …
  bids: OrderBookLevel[];          // ladder, best first
  asks: OrderBookLevel[];          // ladder, best first
  midpoint: number | null;
  spread: number | null;
  totalLiquidityUsdc: number | null;
  imbalance: number | null;        // bidSize / (bidSize + askSize)
  imbalanceSignal: string | null;  // BUY_PRESSURE | SELL_PRESSURE | NEUTRAL
}

const OB_LOG_MAX_BYTES = Number(process.env.OB_LOG_MAX_BYTES ?? 256 * 1024 * 1024);
const MAX_LEVELS = Number(process.env.OB_LOG_MAX_LEVELS ?? 20);

function trimLadder(rows: any[] | undefined, limit: number): OrderBookLevel[] {
  if (!Array.isArray(rows)) return [];
  const out: OrderBookLevel[] = [];
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const p = parseFloat(rows[i]?.price ?? "");
    const s = parseFloat(rows[i]?.size ?? "");
    if (Number.isFinite(p) && Number.isFinite(s)) out.push({ price: p, size: s });
  }
  return out;
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < OB_LOG_MAX_BYTES) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rotated = filePath.replace(/\.jsonl$/, `.${ts}.jsonl`);
    fs.renameSync(filePath, rotated);
  } catch (e: any) {
    console.warn(`[OBLog] Rotation check failed: ${e?.message ?? e}`);
  }
}

/**
 * Build a typed snapshot from a raw Polymarket book payload + metadata.
 * Defensive: returns null if the book is empty or fundamentally malformed.
 */
export function buildSnapshot(input: {
  rawBook: any;
  marketId: string;
  market: string;
  eventSlug?: string | null;
  tokenId: string;
  outcomeIndex: number;
  outcome: string;
  asset: string;
  windowStart: number;
  imbalance?: number | null;
  imbalanceSignal?: string | null;
  totalLiquidityUsdc?: number | null;
}): OrderBookSnapshot | null {
  const bids = trimLadder(input.rawBook?.bids, MAX_LEVELS);
  const asks = trimLadder(input.rawBook?.asks, MAX_LEVELS);
  if (bids.length === 0 && asks.length === 0) return null;

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return {
    ts: new Date().toISOString(),
    windowStart: input.windowStart,
    asset: input.asset,
    marketId: input.marketId,
    market: input.market,
    eventSlug: input.eventSlug ?? null,
    tokenId: input.tokenId,
    outcomeIndex: input.outcomeIndex,
    outcome: input.outcome,
    bids,
    asks,
    midpoint: midpoint !== null ? parseFloat(midpoint.toFixed(4)) : null,
    spread: spread !== null ? parseFloat(spread.toFixed(4)) : null,
    totalLiquidityUsdc: input.totalLiquidityUsdc ?? null,
    imbalance: input.imbalance ?? null,
    imbalanceSignal: input.imbalanceSignal ?? null,
  };
}

export function appendOrderBookSnapshot(filePath: string, snapshot: OrderBookSnapshot): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, JSON.stringify(snapshot) + "\n", "utf8");
  } catch (e: any) {
    console.error(`[OBLog] Append failed: ${e?.message ?? e}`);
  }
}

export interface OrderBookLogStats {
  exists: boolean;
  sizeBytes: number;
  approxRecords: number;
  oldestTs: string | null;
  newestTs: string | null;
}

/**
 * Cheap stats for the live log — count newlines, sample first and last record.
 * Reading the whole file is fine up to ~256 MB rotation; beyond that this
 * function should be replaced by an indexed scan.
 */
export function readOrderBookLogStats(filePath: string): OrderBookLogStats {
  if (!fs.existsSync(filePath)) {
    return { exists: false, sizeBytes: 0, approxRecords: 0, oldestTs: null, newestTs: null };
  }
  const stat = fs.statSync(filePath);
  let oldest: string | null = null;
  let newest: string | null = null;
  let count = 0;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    count = lines.length;
    if (lines.length > 0) {
      try { oldest = JSON.parse(lines[0]).ts ?? null; } catch {}
      try { newest = JSON.parse(lines[lines.length - 1]).ts ?? null; } catch {}
    }
  } catch (e: any) {
    console.warn(`[OBLog] Stats read failed: ${e?.message ?? e}`);
  }
  return {
    exists: true,
    sizeBytes: stat.size,
    approxRecords: count,
    oldestTs: oldest,
    newestTs: newest,
  };
}

/** Stream the log line by line into a typed array. Used by the book replayer. */
export function readOrderBookLog(filePath: string): OrderBookSnapshot[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const out: OrderBookSnapshot[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch (e: any) {
    console.warn(`[OBLog] Read failed: ${e?.message ?? e}`);
    return [];
  }
}
