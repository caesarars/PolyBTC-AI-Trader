// ── Phase 1 — Book replay backtester ──────────────────────────────────────────
// Replays the existing strategy against logged Polymarket order books. Unlike
// `replay.ts` (which assumes entry price = 0.50 + slippage and uses Binance
// candles only), this module:
//   • walks real bid/ask ladders captured by src/measurement/orderbookLogger,
//   • fills the bet by sweeping the ask side until the requested USDC is filled
//     (so slippage emerges from real depth, not a flat 2¢ assumption),
//   • settles WIN/LOSS against the realized BTC close direction for the window.
//
// Fee model is a single per-trade USDC value passed in (Polymarket = 0 today).
//
// The current implementation is an honest skeleton: it loads logged books,
// groups them by 5-min market window, and reports a `BookReplayResult`. The
// strategy hook is supplied by the caller as a function from "lookback book
// history" → entry decision, so server.ts can plug in the live SYNTH/FAST
// path without this module having to mirror it.

import type { OrderBookSnapshot, OrderBookLevel } from "../measurement/orderbookLogger.js";
import type { Candle } from "./replay.js";

export interface BookReplayOptions {
  /** Minimum samples per market window. Windows with fewer book snapshots are
   *  skipped (we cannot synthesize an entry timing). Default 3. */
  minSnapshotsPerWindow?: number;
  /** Flat bet size in USDC for every qualified trade. */
  betUsdc: number;
  /** Polymarket per-trade fee in USDC. Currently 0. */
  feeUsdc: number;
  /** Strategy hook: called once per scan tick within a window. Return a TRADE
   *  decision (with direction) to attempt entry at that tick's best ask, or
   *  NO_TRADE to advance. Returning TRADE more than once per window is allowed
   *  but only the first is executed. */
  strategy: (ctx: StrategyTickContext) => StrategyDecision;
  /** Optional override of the calibrated P(WIN). If provided and the trade is
   *  taken, it is recorded for Brier/log-loss measurement after the run.
   *  Only invoked for TRADE decisions — type narrowed for caller ergonomics. */
  calibratorPredict?: (snapshot: OrderBookSnapshot, decision: Extract<StrategyTickDecision, { decision: "TRADE" }>) => number | null;
}

export interface StrategyTickContext {
  windowStart: number;          // unix sec
  windowElapsedSec: number;     // 0..299
  yesBook: OrderBookSnapshot;
  noBook: OrderBookSnapshot | null;
  history: OrderBookSnapshot[]; // YES-side, prior ticks this window
  btcCandles: Candle[];         // up to and including current tick
}

export type StrategyTickDecision =
  | { decision: "TRADE"; direction: "UP" | "DOWN"; confidence: number; reason: string }
  | { decision: "NO_TRADE"; reason: string };

export type StrategyDecision = StrategyTickDecision;

export interface BookReplayTrade {
  windowStart: number;
  windowElapsedSec: number;
  direction: "UP" | "DOWN";
  confidence: number;
  // Real fill: best ask after sweeping `betUsdc` worth of depth.
  filledShares: number;
  averageFillPrice: number;
  topOfBookAsk: number;
  slippageCents: number;        // (averageFillPrice − topOfBookAsk) × 100
  betUsdc: number;
  feeUsdc: number;
  outcome: "WIN" | "LOSS";
  pnl: number;                  // shares × payout − bet − fee
  btcOpen: number;
  btcClose: number;
  calibratedPWin: number | null;
}

export interface BookReplayResult {
  insufficient: boolean;
  reason: string;
  windowsConsidered: number;
  windowsWithData: number;
  trades: BookReplayTrade[];
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  meanSlippageCents: number;
  // Brier on calibrated pWin, if the predictor was supplied.
  brier: number | null;
  logLoss: number | null;
  // Baseline: flat YES at midpoint every window with book data.
  baselineMidpointYesNetPnl: number;
  baselineMidpointYesWinRate: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sweepAsk(asks: OrderBookLevel[], notionalUsdc: number): { shares: number; avgPrice: number } | null {
  if (asks.length === 0 || notionalUsdc <= 0) return null;
  let remaining = notionalUsdc;
  let shares = 0;
  let spent = 0;
  for (const level of asks) {
    if (remaining <= 0) break;
    if (!Number.isFinite(level.price) || level.price <= 0) continue;
    const levelNotional = level.price * level.size;
    if (levelNotional <= 0) continue;
    const take = Math.min(remaining, levelNotional);
    const takeShares = take / level.price;
    shares += takeShares;
    spent += take;
    remaining -= take;
  }
  if (shares <= 0) return null;
  return { shares, avgPrice: spent / shares };
}

function groupByWindow(snapshots: OrderBookSnapshot[]): Map<number, OrderBookSnapshot[]> {
  const grouped = new Map<number, OrderBookSnapshot[]>();
  for (const s of snapshots) {
    const arr = grouped.get(s.windowStart) ?? [];
    arr.push(s);
    grouped.set(s.windowStart, arr);
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  return grouped;
}

function realizedDirection(btcCandlesForWindow: Candle[]): "UP" | "DOWN" | null {
  if (btcCandlesForWindow.length === 0) return null;
  const open = btcCandlesForWindow[0].open;
  const close = btcCandlesForWindow[btcCandlesForWindow.length - 1].close;
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
  return close >= open ? "UP" : "DOWN";
}

// ── Main entry ───────────────────────────────────────────────────────────────

export function runBookReplay(
  snapshots: OrderBookSnapshot[],
  btcCandles: Candle[],
  opts: BookReplayOptions
): BookReplayResult {
  const minSnaps = opts.minSnapshotsPerWindow ?? 3;
  const trades: BookReplayTrade[] = [];
  let slippageSum = 0;

  if (snapshots.length === 0) {
    return {
      insufficient: true,
      reason: "No order book snapshots logged yet. Run the bot for ≥1 day to accumulate data.",
      windowsConsidered: 0,
      windowsWithData: 0,
      trades,
      wins: 0,
      losses: 0,
      winRate: 0,
      netPnl: 0,
      meanSlippageCents: 0,
      brier: null,
      logLoss: null,
      baselineMidpointYesNetPnl: 0,
      baselineMidpointYesWinRate: 0,
    };
  }

  // Split YES (outcomeIndex 0) and NO (outcomeIndex 1) per window.
  const grouped = groupByWindow(snapshots);
  const windowStarts = Array.from(grouped.keys()).sort((a, b) => a - b);

  // Index BTC candles by minute for fast slicing.
  const candleByMinute = new Map<number, Candle>();
  for (const c of btcCandles) candleByMinute.set(c.time, c);

  let windowsWithData = 0;
  let baselineWins = 0;
  let baselineTotal = 0;
  let baselineNetPnl = 0;
  const baselineEntry = (snap: OrderBookSnapshot): number | null => snap.midpoint;

  for (const ws of windowStarts) {
    const all = grouped.get(ws) ?? [];
    const yesSnaps = all.filter((s) => s.outcomeIndex === 0);
    const noSnaps = all.filter((s) => s.outcomeIndex === 1);
    if (yesSnaps.length < minSnaps) continue;
    windowsWithData++;

    // BTC candles inside [ws, ws+300).
    const windowCandles: Candle[] = [];
    for (let t = ws; t < ws + 300; t += 60) {
      const c = candleByMinute.get(t);
      if (c) windowCandles.push(c);
    }
    const actualDir = realizedDirection(windowCandles);
    if (!actualDir) continue;

    // Baseline: enter YES at midpoint of first YES snapshot.
    const baseSnap = yesSnaps[0];
    const baseEntry = baselineEntry(baseSnap);
    if (baseEntry && baseEntry > 0) {
      const shares = opts.betUsdc / baseEntry;
      const payout = actualDir === "UP" ? shares * 1.0 : 0;
      const pnl = payout - opts.betUsdc - opts.feeUsdc;
      baselineNetPnl += pnl;
      if (pnl > 0) baselineWins++;
      baselineTotal++;
    }

    // Walk yes-side ticks; call the strategy at each.
    const history: OrderBookSnapshot[] = [];
    let executed = false;
    for (const tick of yesSnaps) {
      history.push(tick);
      const noTick = noSnaps.find((s) => s.ts === tick.ts) ?? null;
      const elapsed = Math.max(0, Math.floor((Date.parse(tick.ts) - ws * 1000) / 1000));
      // Candles available up to current tick.
      const candlesSoFar: Candle[] = [];
      for (let t = ws - 60 * 25; t <= ws + elapsed; t += 60) {
        const c = candleByMinute.get(t);
        if (c) candlesSoFar.push(c);
      }
      const dec = opts.strategy({
        windowStart: ws,
        windowElapsedSec: elapsed,
        yesBook: tick,
        noBook: noTick,
        history,
        btcCandles: candlesSoFar,
      });
      if (dec.decision !== "TRADE") continue;

      const sideBook = dec.direction === "UP" ? tick : noTick;
      if (!sideBook) continue;
      const fill = sweepAsk(sideBook.asks, opts.betUsdc);
      if (!fill) continue;

      const topAsk = sideBook.asks[0]?.price ?? fill.avgPrice;
      const slip = (fill.avgPrice - topAsk) * 100;
      slippageSum += slip;

      const win = dec.direction === actualDir;
      const payout = win ? fill.shares * 1.0 : 0;
      const pnl = payout - opts.betUsdc - opts.feeUsdc;
      const pWin = opts.calibratorPredict
        ? opts.calibratorPredict(sideBook, dec as Extract<StrategyTickDecision, { decision: "TRADE" }>)
        : null;

      trades.push({
        windowStart: ws,
        windowElapsedSec: elapsed,
        direction: dec.direction,
        confidence: dec.confidence,
        filledShares: parseFloat(fill.shares.toFixed(4)),
        averageFillPrice: parseFloat(fill.avgPrice.toFixed(4)),
        topOfBookAsk: parseFloat(topAsk.toFixed(4)),
        slippageCents: parseFloat(slip.toFixed(2)),
        betUsdc: opts.betUsdc,
        feeUsdc: opts.feeUsdc,
        outcome: win ? "WIN" : "LOSS",
        pnl: parseFloat(pnl.toFixed(4)),
        btcOpen: windowCandles[0]?.open ?? 0,
        btcClose: windowCandles[windowCandles.length - 1]?.close ?? 0,
        calibratedPWin: pWin,
      });
      executed = true;
      break;
    }
    void executed;
  }

  const wins = trades.filter((t) => t.outcome === "WIN").length;
  const losses = trades.length - wins;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const meanSlip = trades.length > 0 ? slippageSum / trades.length : 0;

  let brier: number | null = null;
  let logLoss: number | null = null;
  const labeled = trades.filter((t) => t.calibratedPWin !== null);
  if (labeled.length > 0) {
    let b = 0, l = 0;
    for (const t of labeled) {
      const p = Math.min(0.9999, Math.max(0.0001, t.calibratedPWin!));
      const y = t.outcome === "WIN" ? 1 : 0;
      b += (p - y) ** 2;
      l += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
    brier = parseFloat((b / labeled.length).toFixed(4));
    logLoss = parseFloat((l / labeled.length).toFixed(4));
  }

  const insufficient = trades.length === 0 && windowsWithData < 10;
  const reason = insufficient
    ? `Replayed ${windowsWithData} windows but produced ${trades.length} trades. Accumulate more book data or relax the strategy hook to enable measurement.`
    : `Replayed ${windowsWithData} windows; took ${trades.length} trades.`;

  return {
    insufficient,
    reason,
    windowsConsidered: windowStarts.length,
    windowsWithData,
    trades,
    wins,
    losses,
    winRate: trades.length > 0 ? parseFloat(((wins / trades.length) * 100).toFixed(1)) : 0,
    netPnl: parseFloat(netPnl.toFixed(2)),
    meanSlippageCents: parseFloat(meanSlip.toFixed(2)),
    brier,
    logLoss,
    baselineMidpointYesNetPnl: parseFloat(baselineNetPnl.toFixed(2)),
    baselineMidpointYesWinRate: baselineTotal > 0 ? parseFloat(((baselineWins / baselineTotal) * 100).toFixed(1)) : 0,
  };
}
