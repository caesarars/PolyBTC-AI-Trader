// ── Calibrator — turns heuristic `confidence` + indicators into a real P(WIN) ─
// Trains a logistic regression on the persisted trade log. Until enough samples
// are accumulated, calibration is unavailable and consumers fall back to "unknown".
//
// IMPORTANT: this module produces a *measurement* of true win probability. The
// surrounding code MUST NOT collapse heuristic confidence into probability — the
// heuristic confidence is a point score, not a probability. Use the calibrator
// or use flat sizing.

import { trainLogistic, predictLogistic, type LogisticModel } from "./logistic.js";

export const FEATURE_NAMES = [
  "dir_up",            // 1 if UP direction, 0 if DOWN
  "confidence",        // heuristic confidence score
  "rsi",               // RSI(14), 0 imputed → 50
  "ema_bullish",       // 1 if EMA9 > EMA21
  "signal_score",      // composite signal score
  "imb_buy",           // 1 if order-book imbalance = BUY_PRESSURE
  "imb_sell",          // 1 if order-book imbalance = SELL_PRESSURE
  "div_strong",        // 1 if divergenceStrength = STRONG
  "div_moderate",      // 1 if divergenceStrength = MODERATE
  "btc_aligned_30s",   // btcDelta30s signed by direction (positive = trade direction confirmed)
  "yes_aligned_30s",   // yesDelta30s signed by direction
  "win_elapsed",       // windowElapsedSeconds (entry timing in window)
  "entry_price",       // bestAsk paid
];

export interface TradeFeatures {
  direction: "UP" | "DOWN";
  confidence: number;
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  divergenceDirection?: string;
  divergenceStrength?: string;
  btcDelta30s?: number;
  yesDelta30s?: number;
  windowElapsedSeconds: number;
  entryPrice: number;
}

export function featurizeTrade(t: TradeFeatures): number[] {
  const sgn = t.direction === "UP" ? 1 : -1;
  return [
    t.direction === "UP" ? 1 : 0,
    t.confidence,
    t.rsi ?? 50,
    t.emaCross === "BULLISH" ? 1 : 0,
    t.signalScore ?? 0,
    t.imbalanceSignal === "BUY_PRESSURE" ? 1 : 0,
    t.imbalanceSignal === "SELL_PRESSURE" ? 1 : 0,
    t.divergenceStrength === "STRONG" ? 1 : 0,
    t.divergenceStrength === "MODERATE" ? 1 : 0,
    (t.btcDelta30s ?? 0) * sgn,
    (t.yesDelta30s ?? 0) * sgn,
    t.windowElapsedSeconds,
    t.entryPrice,
  ];
}

export interface CalibratorState {
  model: LogisticModel | null;
  ready: boolean;
  minTrades: number;
  nSamples: number;
  reason: string;
  // Convenience: declared-vs-realized win rate per confidence bucket — useful
  // even when n < minTrades, because it directly shows calibration drift.
  buckets: Array<{ range: string; predicted: number; realized: number; n: number }>;
  // Retained for older API consumers. Null because heuristic confidence is not
  // scored as a probability.
  heuristicBrier: number | null;
}

export interface LabeledTrade extends TradeFeatures {
  result: "WIN" | "LOSS";
}

function bucketLabel(c: number): string {
  if (c < 65) return "55-65";
  if (c < 75) return "65-75";
  if (c < 85) return "75-85";
  return "85-90";
}

function computeBuckets(trades: LabeledTrade[]) {
  const acc: Record<string, { sum: number; wins: number; n: number }> = {
    "55-65": { sum: 0, wins: 0, n: 0 },
    "65-75": { sum: 0, wins: 0, n: 0 },
    "75-85": { sum: 0, wins: 0, n: 0 },
    "85-90": { sum: 0, wins: 0, n: 0 },
  };
  for (const t of trades) {
    const k = bucketLabel(t.confidence);
    acc[k].sum += t.confidence;
    acc[k].n += 1;
    if (t.result === "WIN") acc[k].wins += 1;
  }
  return Object.entries(acc)
    .filter(([, v]) => v.n > 0)
    .map(([range, v]) => ({
      range,
      predicted: parseFloat((v.sum / v.n).toFixed(1)),
      realized: parseFloat(((v.wins / v.n) * 100).toFixed(1)),
      n: v.n,
    }));
}

export interface TrainCalibratorOptions {
  minTrades?: number;
  learningRate?: number;
  iterations?: number;
  l2?: number;
  cvFolds?: number;
}

export function trainCalibrator(
  trades: LabeledTrade[],
  opts: TrainCalibratorOptions = {}
): CalibratorState {
  const minTrades = opts.minTrades ?? 100;
  const buckets = computeBuckets(trades);
  const heuristicBrier = null;

  if (trades.length < minTrades) {
    return {
      model: null,
      ready: false,
      minTrades,
      nSamples: trades.length,
      reason: `Insufficient data: have ${trades.length}, need ≥${minTrades} to train.`,
      buckets,
      heuristicBrier,
    };
  }

  const X = trades.map((t) => featurizeTrade(t));
  const y = trades.map((t) => (t.result === "WIN" ? 1 : 0));
  const model = trainLogistic(X, y, FEATURE_NAMES, {
    learningRate: opts.learningRate,
    iterations: opts.iterations,
    l2: opts.l2,
    cvFolds: opts.cvFolds,
  });

  const cv = Number.isNaN(model.cvBrier) ? "n/a" : model.cvBrier.toFixed(4);
  const tr = model.trainBrier.toFixed(4);
  return {
    model,
    ready: true,
    minTrades,
    nSamples: trades.length,
    reason: `Trained on ${trades.length} trades. CV Brier=${cv} (train=${tr}).`,
    buckets,
    heuristicBrier,
  };
}

export function calibrateProbability(state: CalibratorState, t: TradeFeatures): number | null {
  if (!state.ready || !state.model) return null;
  try {
    return predictLogistic(state.model, featurizeTrade(t));
  } catch {
    return null;
  }
}
