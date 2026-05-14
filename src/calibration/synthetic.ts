// ── Synthetic training data via SYNTH replay ───────────────────────────────────
// Walks 1-minute BTC candles and, at each historical decision point, runs the
// SYNTH heuristic to produce a (would-have-traded) labeled example. Labels are
// taken from the realized 5-minute Binance close direction.
//
// Used to bootstrap the calibrator when the live trade log has fewer than the
// minimum required samples. The features here are deliberately the same fields
// the runtime calibrator consumes, except those we cannot recover historically
// (order-book imbalance, divergence delta vs the YES token) — those default to
// neutral, mirroring what the runtime sees when those signals are unavailable.

import type { Candle } from "../backtest/replay.js";
import type { LabeledTrade } from "./calibrator.js";

interface SyntheticOpts {
  /** 1-min lookforward used to label the outcome. Default 5 (matches 5-min markets). */
  horizon?: number;
  /** Stride in candles between successive decision points. 1 = full overlap. */
  stride?: number;
  /** Min lookback candles required to compute indicators. */
  minLookback?: number;
  /** Assumed entry price for label/EV alignment with runtime. */
  entryPrice?: number;
}

// Local indicator implementation — kept small and identical-in-spirit to the
// runtime/backtester ports. Returns null if there is not enough history.
function computeIndicators(candles: Candle[]) {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close);
  const calcEma = (data: number[], period: number) => {
    const k = 2 / (period + 1);
    let r = data[0];
    for (let i = 1; i < data.length; i++) r = data[i] * k + r * (1 - k);
    return r;
  };
  let gains = 0, losses = 0;
  const start = Math.max(1, closes.length - 14);
  for (let i = start; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const count = closes.length - start;
  const avgGain = count > 0 ? gains / count : 0;
  const avgLoss = count > 0 ? losses / count : 0;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const ema9 = calcEma(closes, 9);
  const ema21 = calcEma(closes, 21);
  const emaBullish = ema9 > ema21;

  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = closes[0], e26 = closes[0];
  const macdHist: number[] = [];
  for (const p of closes) {
    e12 = p * k12 + e12 * (1 - k12);
    e26 = p * k26 + e26 * (1 - k26);
    macdHist.push(e12 - e26);
  }
  const kMacd = 2 / 10;
  let macdSig = macdHist[0];
  for (const m of macdHist) macdSig = m * kMacd + macdSig * (1 - kMacd);
  const macdHistogram = macdHist[macdHist.length - 1] - macdSig;

  const last3 = candles.slice(-3);
  const allUp = last3.every(c => c.close >= c.open);
  const allDown = last3.every(c => c.close < c.open);
  const momentum5 = closes.length >= 6
    ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
    : 0;

  let signalScore = 0;
  if (emaBullish) signalScore += 1; else signalScore -= 1;
  if (rsi < 35) signalScore += 2; else if (rsi > 65) signalScore -= 2;
  if (macdHistogram > 0) signalScore += 1; else if (macdHistogram < 0) signalScore -= 1;
  if (allUp) signalScore += 2; else if (allDown) signalScore -= 2;
  if (momentum5 > 0.15) signalScore += 1; else if (momentum5 < -0.15) signalScore -= 1;

  return { rsi, emaBullish, signalScore };
}

function computeFastLoop(candles: Candle[]) {
  const last5 = candles.slice(-5);
  if (last5.length < 5) return null;
  const closes = last5.map(c => c.close);
  const vols = last5.map(c => c.volume || 0);
  const totalVol = vols.reduce((a, b) => a + b, 0);
  let vw = 0;
  if (totalVol > 0) {
    for (let i = 1; i < 5; i++) {
      const ch = closes[i - 1] > 0 ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : 0;
      vw += ch * (vols[i] / totalVol);
    }
  } else {
    vw = closes[0] > 0 ? ((closes[4] - closes[0]) / closes[0]) * 100 : 0;
  }
  const absVw = Math.abs(vw);
  const direction: "UP" | "DOWN" | "NEUTRAL" =
    absVw < 0.02 ? "NEUTRAL" : vw > 0 ? "UP" : "DOWN";
  const strength: "STRONG" | "MODERATE" | "WEAK" =
    absVw >= 0.15 ? "STRONG" : absVw >= 0.05 ? "MODERATE" : "WEAK";
  return { direction, strength, vw };
}

interface SyntheticDecision {
  direction: "UP" | "DOWN";
  confidence: number;
  rsi: number;
  emaCross: "BULLISH" | "BEARISH";
  signalScore: number;
}

function synthDecision(candles: Candle[]): SyntheticDecision | null {
  const ind = computeIndicators(candles);
  const fast = computeFastLoop(candles);
  if (!ind || !fast) return null;

  // Local alignment scoring — mirror of server.ts synth path.
  let bullish = 0, bearish = 0;
  if (candles.length >= 20) {
    const first = candles[0].close;
    const last60 = candles[candles.length - 1].close;
    const move60 = first > 0 ? ((last60 - first) / first) * 100 : 0;
    const bias60 = (ind.emaBullish && move60 > 0.15) ? "UP"
      : (!ind.emaBullish && move60 < -0.15) ? "DOWN"
      : Math.abs(move60) < 0.1 ? "MIXED"
      : move60 > 0 ? "UP" : "DOWN";
    if (bias60 === "UP") bullish++; else if (bias60 === "DOWN") bearish++;
  }
  if (candles.length >= 5) {
    const recent5 = candles.slice(-5);
    const up5 = recent5.filter(c => c.close > c.open).length;
    const dn5 = recent5.filter(c => c.close < c.open).length;
    if (up5 >= 3) bullish++; else if (dn5 >= 3) bearish++;
  }
  if (candles.length >= 2) {
    const last = candles[candles.length - 1];
    if (last.close > last.open) bullish++; else if (last.close < last.open) bearish++;
  }
  if (ind.signalScore >= 2) bullish++; else if (ind.signalScore <= -2) bearish++;
  if (fast.strength !== "WEAK") {
    if (fast.direction === "UP") bullish++; else if (fast.direction === "DOWN") bearish++;
  }

  const direction: "UP" | "DOWN" | "NONE" =
    fast.direction !== "NEUTRAL" ? fast.direction
    : bullish > bearish ? "UP"
    : bearish > bullish ? "DOWN"
    : "NONE";
  if (direction === "NONE") return null;

  const alignScore = direction === "UP" ? bullish : bearish;
  const momBoost = fast.strength === "STRONG" ? 10 : fast.strength === "MODERATE" ? 5 : 0;
  const techBoost = Math.min(8, Math.abs(ind.signalScore) * 2);
  let conf = 60 + alignScore * 5 + momBoost + techBoost;
  conf = Math.max(55, Math.min(90, Math.round(conf)));

  return {
    direction,
    confidence: conf,
    rsi: ind.rsi,
    emaCross: ind.emaBullish ? "BULLISH" : "BEARISH",
    signalScore: ind.signalScore,
  };
}

/** Walks `candles` and produces a labeled trade per synth-qualifying decision. */
export function buildSyntheticTrainingSet(
  candles: Candle[],
  opts: SyntheticOpts = {}
): LabeledTrade[] {
  const horizon = opts.horizon ?? 5;
  const stride = Math.max(1, opts.stride ?? 1);
  const minLookback = opts.minLookback ?? 26;
  const entryPrice = opts.entryPrice ?? 0.52; // matches backtester slippage default
  const out: LabeledTrade[] = [];

  for (let i = minLookback; i + horizon < candles.length; i += stride) {
    const lookback = candles.slice(0, i + 1);
    const dec = synthDecision(lookback);
    if (!dec) continue;
    const entryClose = candles[i].close;
    const exitClose = candles[i + horizon].close;
    const realizedUp = exitClose >= entryClose;
    const result: "WIN" | "LOSS" =
      (dec.direction === "UP" && realizedUp) || (dec.direction === "DOWN" && !realizedUp)
        ? "WIN" : "LOSS";

    // Mid-window entry timing — randomized within the legal window so the
    // calibrator sees a realistic distribution. Deterministic per-row via index.
    const windowElapsed = 10 + ((i * 17) % 270);

    out.push({
      direction: dec.direction,
      confidence: dec.confidence,
      rsi: dec.rsi,
      emaCross: dec.emaCross,
      signalScore: dec.signalScore,
      imbalanceSignal: "NEUTRAL",       // not recoverable historically
      divergenceStrength: "NONE",        // not recoverable historically
      divergenceDirection: "NEUTRAL",   // not recoverable historically
      btcDelta30s: 0,
      yesDelta30s: 0,
      windowElapsedSeconds: windowElapsed,
      entryPrice,
      result,
    });
  }

  return out;
}
