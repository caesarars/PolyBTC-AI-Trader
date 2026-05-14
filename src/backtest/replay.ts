// ── Phase 0 — Honest backtester ────────────────────────────────────────────────
// Replays the SYNTH heuristic against historical BTC 1-min candles with a
// realistic fill / fee / slippage model. Compared to the toy /api/backtest
// endpoint, this version:
//   • applies a configurable slippage on the implied entry price,
//   • applies a configurable per-trade fee (Polymarket is 0¢ today; future-proof),
//   • computes net PnL on a flat $ bet, not direction-only accuracy,
//   • tracks declared-vs-realized calibration buckets on the heuristic confidence,
//   • reports separate counts for SIGNAL (any direction) vs QUALIFIED (≥ thresholds),
//   • includes a baseline "always buy YES at 0.50" benchmark for honesty.
//
// NOTE: We cannot replay Polymarket order books historically without paid data,
// so the entry price is modelled as 0.50 + slippage. Real entries averaged 0.504
// in the live log, so 0.50 + 0.02 slippage is a slightly conservative but realistic
// assumption. Window outcome is derived from Binance 1-min close direction.

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export interface BacktestOptions {
  /** Number of 5-min windows to simulate (walks backward from end of history). */
  windows: number;
  /** Min heuristic confidence to qualify a trade (matches BOT_MIN_CONFIDENCE). */
  minConfidence: number;
  /** Min price headroom: maxEntryPriceFor(confidence) - entryPrice. */
  minEdge: number;
  /** Flat bet size in USDC. */
  betUsdc: number;
  /** Simulated slippage on entry, in cents (0.02 = 2¢). */
  slippage: number;
  /** Polymarket per-trade fee in USDC. Currently 0. */
  feeUsdc: number;
  /** Microstructure gate proxies. ATR check uses real candles; spread/liquidity
   *  are skipped here because we have no historical book — assume passable. */
  maxNormalizedAtr: number;
  /** Optional calibrated P(WIN) predictor — when provided, Brier/log-loss are
   *  computed against it and `useCalibratorGate` can enforce an EV threshold. */
  calibratorPredict?: (features: CalibratorInput) => number | null;
  /** When true and a predictor is provided, trades are gated on calibrated EV
   *  in addition to the heuristic confidence/edge gate. */
  useCalibratorGate?: boolean;
  /** Calibrated EV threshold (pWin − entryPrice). Only used when gating. */
  minCalibratedEdge?: number;
  /** Calibrated probability floor. Only used when gating. */
  minCalibratedPWin?: number;
}

/** Minimal feature payload passed to the calibrator. Mirrors `TradeFeatures`
 *  from the runtime, but inlined here so this module stays self-contained. */
export interface CalibratorInput {
  direction: "UP" | "DOWN";
  confidence: number;
  rsi?: number;
  emaCross?: "BULLISH" | "BEARISH";
  signalScore?: number;
  imbalanceSignal?: string;
  divergenceDirection?: string;
  divergenceStrength?: string;
  btcDelta30s?: number;
  yesDelta30s?: number;
  windowElapsedSeconds: number;
  entryPrice: number;
}

export interface BacktestTrade {
  windowStart: number;        // unix sec
  direction: "UP" | "DOWN";
  confidence: number;
  edge: number;                 // legacy field: price headroom
  entryPrice: number;         // 0.50 + slippage
  shares: number;
  outcome: "WIN" | "LOSS";
  pnl: number;
  btcOpen: number;
  btcClose: number;
  btcMovePct: number;
  reason: string;
  calibratedPWin?: number;    // populated when a calibrator predictor was supplied
}

export interface CalibrationBucket {
  range: string;             // e.g. "75-80"
  predicted: number;          // avg declared confidence (%)
  realized: number;           // realized win rate (%)
  n: number;
}

export interface BacktestResult {
  options: BacktestOptions;
  totalWindows: number;       // windows that produced indicators
  signaled: number;           // SYNTH produced TRADE in any direction
  qualified: number;          // signaled AND passed confidence/edge gates
  filteredByAtr: number;
  filteredByCalibrator: number;
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  winRate: number;            // %
  grossPnl: number;
  netPnl: number;
  /** Brier on calibrated probabilities. Null if no calibrator was supplied. */
  brier: number | null;
  /** Log-loss on calibrated probabilities. Null if no calibrator was supplied. */
  logLoss: number | null;
  /** Number of trades that contributed to Brier/log-loss. */
  scoredN: number;
  calibration: CalibrationBucket[];
  // Honest comparison baselines
  baselineAlwaysYesNetPnl: number;
  baselineAlwaysYesWinRate: number;
}

// ── Indicator helpers (kept local + identical-by-construction to runtime) ────
function computeIndicators(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume || 0);
  if (closes.length < 15) return null;

  const calcEma = (data: number[], period: number) => {
    const k = 2 / (period + 1);
    let r = data[0];
    for (let i = 1; i < data.length; i++) r = data[i] * k + r * (1 - k);
    return r;
  };

  const rsiPeriod = 14;
  let gains = 0, losses = 0;
  const start = Math.max(1, closes.length - rsiPeriod);
  for (let i = start; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const count = closes.length - start;
  const avgGain = count > 0 ? gains / count : 0;
  const avgLoss = count > 0 ? losses / count : 0;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const ema9 = calcEma(closes, 9);
  const ema21 = calcEma(closes, 21);
  const emaCross: "BULLISH" | "BEARISH" = ema9 > ema21 ? "BULLISH" : "BEARISH";

  // MACD (12, 26, 9)
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

  // Trend: last-3 direction
  const last3 = candles.slice(-3).map(c => c.close >= c.open ? "UP" : "DOWN");
  const trend: "STRONG_UP" | "STRONG_DOWN" | "MIXED" =
    last3.every(d => d === "UP") ? "STRONG_UP"
    : last3.every(d => d === "DOWN") ? "STRONG_DOWN"
    : "MIXED";

  // BB position (20, 2)
  const bbPeriod = Math.min(20, closes.length);
  const bbCloses = closes.slice(-bbPeriod);
  const bbMiddle = bbCloses.reduce((a, b) => a + b, 0) / bbCloses.length;
  const bbStd = Math.sqrt(bbCloses.reduce((s, c) => s + (c - bbMiddle) ** 2, 0) / bbCloses.length);
  const bbUpper = bbMiddle + 2 * bbStd;
  const bbLower = bbMiddle - 2 * bbStd;
  const currentClose = closes[closes.length - 1];
  const bbPosition =
    currentClose > bbUpper ? "ABOVE_UPPER"
    : currentClose > bbMiddle + bbStd ? "NEAR_UPPER"
    : currentClose < bbLower ? "BELOW_LOWER"
    : currentClose < bbMiddle - bbStd ? "NEAR_LOWER"
    : "MIDDLE";

  const momentum5 = closes.length >= 6
    ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
    : 0;

  let signalScore = 0;
  if (ema9 > ema21) signalScore += 1; else signalScore -= 1;
  if (rsi < 35) signalScore += 2; else if (rsi > 65) signalScore -= 2;
  if (macdHistogram > 0) signalScore += 1; else if (macdHistogram < 0) signalScore -= 1;
  if (trend === "STRONG_UP") signalScore += 2; else if (trend === "STRONG_DOWN") signalScore -= 2;
  if (momentum5 > 0.15) signalScore += 1; else if (momentum5 < -0.15) signalScore -= 1;
  if (bbPosition === "NEAR_LOWER" || bbPosition === "BELOW_LOWER") signalScore += 1;
  else if (bbPosition === "NEAR_UPPER" || bbPosition === "ABOVE_UPPER") signalScore -= 1;

  // ATR over last 10
  const last10 = candles.slice(-10);
  const atr = last10.reduce((s, c) => s + (c.high - c.low), 0) / last10.length;
  const normalizedAtr = currentClose > 0 ? atr / currentClose : 0;

  void volumes; // unused in this minimal port — kept for parity
  return { rsi, emaCross, signalScore, trend, normalizedAtr };
}

function computeFastLoop(candles: Candle[]) {
  const last5 = candles.slice(-5);
  if (last5.length < 5) return null;
  const closes = last5.map(c => c.close);
  const volumes = last5.map(c => c.volume || 0);
  const totalVol = volumes.reduce((a, b) => a + b, 0);
  let vw = 0;
  if (totalVol > 0) {
    for (let i = 1; i < 5; i++) {
      const change = closes[i - 1] > 0 ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : 0;
      vw += change * (volumes[i] / totalVol);
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

function maxEntryPriceFor(confidence: number): number {
  return Math.min(0.75, Math.max(0.40, (confidence - 15) / 100));
}

// ── SYNTH heuristic — kept faithful to runtime decision path ─────────────────
function synthDecision(candles: Candle[]):
  | { decision: "TRADE"; direction: "UP" | "DOWN"; confidence: number; reason: string }
  | { decision: "NO_TRADE"; reason: string } {
  const ind = computeIndicators(candles);
  const fast = computeFastLoop(candles);
  if (!ind || !fast) return { decision: "NO_TRADE", reason: "insufficient candles" };

  // Local alignment (subset of runtime — uses same indicators)
  let bullish = 0, bearish = 0;
  if (candles.length >= 20) {
    const first = candles[0].close;
    const last60 = candles[candles.length - 1].close;
    const move60 = first > 0 ? ((last60 - first) / first) * 100 : 0;
    const bias60 = (ind.emaCross === "BULLISH" && move60 > 0.15) ? "UP"
      : (ind.emaCross === "BEARISH" && move60 < -0.15) ? "DOWN"
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

  const synthDir: "UP" | "DOWN" | "NONE" =
    fast.direction !== "NEUTRAL" ? fast.direction
    : bullish > bearish ? "UP"
    : bearish > bullish ? "DOWN"
    : "NONE";

  if (synthDir === "NONE") return { decision: "NO_TRADE", reason: "no directional signal" };

  const alignScore = synthDir === "UP" ? bullish : bearish;
  const momBoost = fast.strength === "STRONG" ? 10 : fast.strength === "MODERATE" ? 5 : 0;
  const techBoost = Math.min(8, Math.abs(ind.signalScore) * 2);
  let conf = 60 + alignScore * 5 + momBoost + techBoost;
  conf = Math.max(55, Math.min(90, Math.round(conf)));

  return {
    decision: "TRADE",
    direction: synthDir,
    confidence: conf,
    reason: `align=${alignScore}/5 mom=${fast.strength} signalScore=${ind.signalScore}`,
  };
}

// ── Main entry ───────────────────────────────────────────────────────────────
export function runBacktest(candles: Candle[], opts: BacktestOptions): BacktestResult {
  const trades: BacktestTrade[] = [];
  let signaled = 0, qualified = 0, filteredByAtr = 0;
  let filteredByCalibrator = 0;
  const calBuckets: Record<string, { sum: number; wins: number; n: number }> = {
    "55-65": { sum: 0, wins: 0, n: 0 },
    "65-75": { sum: 0, wins: 0, n: 0 },
    "75-85": { sum: 0, wins: 0, n: 0 },
    "85-90": { sum: 0, wins: 0, n: 0 },
  };
  let baselineWins = 0, baselineTotal = 0;
  const baselineEntry = 0.50 + opts.slippage;

  // Brier / log-loss accumulators — only meaningful when a calibrator is supplied.
  let brierSum = 0;
  let logLossSum = 0;
  let scoredN = 0;

  // Need at least 25 prior candles for indicators + 5 future candles for outcome.
  // Step backward in 5-candle increments to align with 5-min windows.
  const minLookback = 25;
  const horizon = 5;
  const usable = Math.max(0, Math.floor((candles.length - minLookback - horizon) / horizon));
  const maxWindows = Math.min(opts.windows, usable);

  let totalWindows = 0;
  for (let w = 0; w < maxWindows; w++) {
    // Entry candle: end of the lookback window
    const entryIdx = candles.length - horizon - (w * horizon) - 1;
    if (entryIdx < minLookback) break;
    const lookback = candles.slice(0, entryIdx + 1);
    const future = candles.slice(entryIdx + 1, entryIdx + 1 + horizon);
    if (future.length < horizon) continue;
    totalWindows++;

    const entryClose = candles[entryIdx].close;
    const exitClose = future[future.length - 1].close;
    const actualDir: "UP" | "DOWN" = exitClose >= entryClose ? "UP" : "DOWN";

    // Baseline: always buy YES at 0.50 + slippage
    {
      const shares = opts.betUsdc / baselineEntry;
      const payout = actualDir === "UP" ? shares * 1.0 : 0;
      const pnl = payout - opts.betUsdc - opts.feeUsdc;
      if (pnl > 0) baselineWins++;
      baselineTotal++;
    }

    const dec = synthDecision(lookback);
    if (dec.decision !== "TRADE") continue;
    signaled++;

    // ATR gate (proxy for the live volatility gate)
    const ind = computeIndicators(lookback);
    if (ind && ind.normalizedAtr > opts.maxNormalizedAtr) {
      filteredByAtr++;
      continue;
    }

    // Confidence + price-headroom gate. This intentionally does not interpret
    // confidence as a win probability.
    const entryPrice = 0.50 + opts.slippage;
    const edge = maxEntryPriceFor(dec.confidence) - entryPrice;
    if (dec.confidence < opts.minConfidence || edge < opts.minEdge) continue;

    // Optional calibrated EV gate. When a predictor is supplied we always
    // score Brier/log-loss against it; when `useCalibratorGate` is set we
    // additionally reject trades that fail the calibrated EV threshold.
    let calibratedPWin: number | null = null;
    if (opts.calibratorPredict) {
      calibratedPWin = opts.calibratorPredict({
        direction: dec.direction,
        confidence: dec.confidence,
        rsi: ind?.rsi,
        emaCross: ind?.emaCross,
        signalScore: ind?.signalScore,
        imbalanceSignal: "NEUTRAL",
        divergenceDirection: "NEUTRAL",
        divergenceStrength: "NONE",
        btcDelta30s: 0,
        yesDelta30s: 0,
        windowElapsedSeconds: 60, // mid-window proxy; matches synthetic trainer
        entryPrice,
      });
      if (opts.useCalibratorGate && calibratedPWin !== null) {
        const minP = opts.minCalibratedPWin ?? 0.55;
        const minE = opts.minCalibratedEdge ?? 0.05;
        if (calibratedPWin < minP || (calibratedPWin - entryPrice) < minE) {
          filteredByCalibrator++;
          continue;
        }
      }
    }
    qualified++;

    const shares = opts.betUsdc / entryPrice;
    const correct = dec.direction === actualDir;
    const payout = correct ? shares * 1.0 : 0;
    const pnl = parseFloat((payout - opts.betUsdc - opts.feeUsdc).toFixed(4));

    const bucket =
      dec.confidence < 65 ? "55-65"
      : dec.confidence < 75 ? "65-75"
      : dec.confidence < 85 ? "75-85"
      : "85-90";
    calBuckets[bucket].sum += dec.confidence;
    calBuckets[bucket].n += 1;
    if (correct) calBuckets[bucket].wins += 1;

    if (calibratedPWin !== null) {
      const y = correct ? 1 : 0;
      brierSum += (calibratedPWin - y) ** 2;
      const pClip = Math.min(0.9999, Math.max(0.0001, calibratedPWin));
      logLossSum += -(y * Math.log(pClip) + (1 - y) * Math.log(1 - pClip));
      scoredN++;
    }

    trades.push({
      windowStart: candles[entryIdx].time,
      direction: dec.direction,
      confidence: dec.confidence,
      edge,
      entryPrice,
      shares,
      outcome: correct ? "WIN" : "LOSS",
      pnl,
      btcOpen: entryClose,
      btcClose: exitClose,
      btcMovePct: ((exitClose - entryClose) / entryClose) * 100,
      reason: dec.reason,
      calibratedPWin: calibratedPWin ?? undefined,
    });
  }

  const wins = trades.filter(t => t.outcome === "WIN").length;
  const losses = trades.length - wins;
  const grossPnl = trades.reduce((s, t) => s + (t.outcome === "WIN" ? t.shares - opts.betUsdc : -opts.betUsdc), 0);
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);

  const calibration: CalibrationBucket[] = Object.entries(calBuckets)
    .filter(([, v]) => v.n > 0)
    .map(([range, v]) => ({
      range,
      predicted: parseFloat((v.sum / v.n).toFixed(1)),
      realized: parseFloat(((v.wins / v.n) * 100).toFixed(1)),
      n: v.n,
    }));

  const baselineWinRate = baselineTotal > 0 ? (baselineWins / baselineTotal) * 100 : 0;
  const baselineShares = opts.betUsdc / baselineEntry;
  const baselineNetPnl =
    baselineWins * (baselineShares - opts.betUsdc - opts.feeUsdc)
    + (baselineTotal - baselineWins) * (-opts.betUsdc - opts.feeUsdc);

  return {
    options: opts,
    totalWindows,
    signaled,
    qualified,
    filteredByAtr,
    filteredByCalibrator,
    trades,
    wins,
    losses,
    winRate: trades.length > 0 ? parseFloat(((wins / trades.length) * 100).toFixed(1)) : 0,
    grossPnl: parseFloat(grossPnl.toFixed(2)),
    netPnl: parseFloat(netPnl.toFixed(2)),
    brier: scoredN > 0 ? parseFloat((brierSum / scoredN).toFixed(4)) : null,
    logLoss: scoredN > 0 ? parseFloat((logLossSum / scoredN).toFixed(4)) : null,
    scoredN,
    calibration,
    baselineAlwaysYesNetPnl: parseFloat(baselineNetPnl.toFixed(2)),
    baselineAlwaysYesWinRate: parseFloat(baselineWinRate.toFixed(1)),
  };
}
