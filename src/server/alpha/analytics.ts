import {
  scoreExecutedTradeSample,
  ALPHA_MODEL_VERSION,
} from "./model.js";
import type {
  AlphaCalibrationBucket,
  AlphaMarkoutBucket,
  AlphaResearchReport,
  AlphaShadowReplayRow,
  DecisionLogEntry,
  ExecutedTradeSample,
} from "./types.js";

type CandlePoint = { time: number; close: number };

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function bucketProbability(probability: number): string {
  const pct = Math.round(probability * 100);
  if (pct < 55) return "<55%";
  if (pct < 60) return "55-59%";
  if (pct < 65) return "60-64%";
  if (pct < 70) return "65-69%";
  if (pct < 75) return "70-74%";
  if (pct < 80) return "75-79%";
  if (pct < 85) return "80-84%";
  if (pct < 90) return "85-89%";
  return "90%+";
}

function buildCalibrationBuckets(
  rows: Array<{ probability: number; edge: number | null; pnl: number; result: "WIN" | "LOSS" }>
): AlphaCalibrationBucket[] {
  const buckets = new Map<string, { trades: number; wins: number; losses: number; probabilitySum: number; edgeSum: number; edgeCount: number; pnl: number }>();

  for (const row of rows) {
    const label = bucketProbability(row.probability);
    const bucket = buckets.get(label) || {
      trades: 0,
      wins: 0,
      losses: 0,
      probabilitySum: 0,
      edgeSum: 0,
      edgeCount: 0,
      pnl: 0,
    };
    bucket.trades += 1;
    if (row.result === "WIN") bucket.wins += 1;
    else bucket.losses += 1;
    bucket.probabilitySum += row.probability;
    if (row.edge != null) {
      bucket.edgeSum += row.edge;
      bucket.edgeCount += 1;
    }
    bucket.pnl += row.pnl;
    buckets.set(label, bucket);
  }

  return Array.from(buckets.entries())
    .map(([label, bucket]) => ({
      label,
      trades: bucket.trades,
      wins: bucket.wins,
      losses: bucket.losses,
      predictedRate: bucket.trades > 0 ? round((bucket.probabilitySum / bucket.trades) * 100, 1) : null,
      realizedRate: bucket.trades > 0 ? round((bucket.wins / bucket.trades) * 100, 1) : null,
      avgEdge: bucket.edgeCount > 0 ? round(bucket.edgeSum / bucket.edgeCount, 4) : null,
      pnl: round(bucket.pnl),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function buildCandleLookup(candles: CandlePoint[]): (targetTime: number) => number | null {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  return (targetTime: number) => {
    for (const candle of sorted) {
      if (candle.time >= targetTime) return candle.close;
    }
    return sorted.length > 0 ? sorted[sorted.length - 1].close : null;
  };
}

function buildMarkouts(decisions: DecisionLogEntry[], candles: CandlePoint[]): AlphaResearchReport["markouts"] {
  const lookupClose = buildCandleLookup(candles);
  const horizons = [
    { label: "60s", seconds: 60 },
    { label: "180s", seconds: 180 },
    { label: "To Close", seconds: null as number | null },
  ];
  const markoutRows = new Map<string, number[]>();
  const favorableRows = new Map<string, number[]>();
  const actionRows = new Map<string, number[]>();

  for (const horizon of horizons) {
    markoutRows.set(horizon.label, []);
    favorableRows.set(horizon.label, []);
  }

  for (const decision of decisions) {
    if (decision.asset !== "BTC" || decision.direction === "NONE" || !decision.btcPrice) continue;
    const directionSign = decision.direction === "UP" ? 1 : -1;
    for (const horizon of horizons) {
      const baseTime = Math.floor(new Date(decision.ts).getTime() / 1000);
      const targetTime = horizon.seconds == null ? decision.windowEnd : Math.min(baseTime + horizon.seconds, decision.windowEnd);
      const close = lookupClose(targetTime);
      if (!close) continue;
      const signedBps = directionSign * (((close - decision.btcPrice) / decision.btcPrice) * 10_000);
      markoutRows.get(horizon.label)?.push(signedBps);
      favorableRows.get(horizon.label)?.push(signedBps > 0 ? 1 : 0);
      const actionLabel = decision.action;
      const actionBucket = actionRows.get(actionLabel) || [];
      actionBucket.push(signedBps);
      actionRows.set(actionLabel, actionBucket);
    }
  }

  const horizonBuckets: AlphaMarkoutBucket[] = horizons.map((horizon) => {
    const values = markoutRows.get(horizon.label) || [];
    const favorable = favorableRows.get(horizon.label) || [];
    return {
      label: horizon.label,
      count: values.length,
      favorableRate: favorable.length > 0 ? round((favorable.reduce((sum, value) => sum + value, 0) / favorable.length) * 100, 1) : null,
      avgSignedBps: values.length > 0 ? round((average(values) || 0), 1) : null,
      medianSignedBps: values.length > 0 ? round((median(values) || 0), 1) : null,
    };
  });

  const byAction = Array.from(actionRows.entries())
    .map(([label, values]) => ({
      label,
      favorableRate: values.length > 0 ? round((values.filter((value) => value > 0).length / values.length) * 100, 1) : null,
      avgSignedBps: values.length > 0 ? round((average(values) || 0), 1) : null,
      count: values.length,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    horizons: horizonBuckets,
    byAction,
  };
}

export function buildAlphaResearchReport(args: {
  decisions: DecisionLogEntry[];
  trades: ExecutedTradeSample[];
  candles: CandlePoint[];
}): AlphaResearchReport {
  const btcDecisions = args.decisions
    .filter((entry) => entry.asset === "BTC")
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const btcTrades = args.trades.filter((entry) => /bitcoin|btc/i.test(entry.market));

  const modeledTrades = btcTrades.map((trade) => {
    const model = scoreExecutedTradeSample(trade);
    return { trade, model };
  });

  const heuristicRows = modeledTrades.map(({ trade }) => ({
    probability: trade.confidence / 100,
    edge: trade.edge >= 1 ? Number((trade.edge / 100).toFixed(4)) : trade.edge,
    pnl: trade.pnl,
    result: trade.result,
  }));
  const modelRows = modeledTrades
    .filter(({ model }) => model.probability != null)
    .map(({ trade, model }) => ({
      probability: model.probability as number,
      edge: model.edge,
      pnl: trade.pnl,
      result: trade.result,
    }));

  const heuristicBrier = heuristicRows.length > 0
    ? round(
      heuristicRows.reduce((sum, row) => {
        const actual = row.result === "WIN" ? 1 : 0;
        return sum + (row.probability - actual) ** 2;
      }, 0) / heuristicRows.length,
      4
    )
    : null;
  const modelBrier = modelRows.length > 0
    ? round(
      modelRows.reduce((sum, row) => {
        const actual = row.result === "WIN" ? 1 : 0;
        return sum + (row.probability - actual) ** 2;
      }, 0) / modelRows.length,
      4
    )
    : null;

  const keptTrades = modeledTrades.filter(({ model }) => model.shouldTrade);
  const blockedTrades = modeledTrades.filter(({ model }) => !model.shouldTrade);
  const keptPnl = round(keptTrades.reduce((sum, row) => sum + row.trade.pnl, 0));
  const baselinePnl = round(modeledTrades.reduce((sum, row) => sum + row.trade.pnl, 0));
  const blockedPnl = round(blockedTrades.reduce((sum, row) => sum + row.trade.pnl, 0));

  const actionCounts = new Map<string, number>();
  const directionCounts = new Map<string, number>();
  for (const decision of btcDecisions) {
    actionCounts.set(decision.action, (actionCounts.get(decision.action) || 0) + 1);
    directionCounts.set(decision.direction, (directionCounts.get(decision.direction) || 0) + 1);
  }

  const markouts = buildMarkouts(btcDecisions, args.candles);

  const recentShadow: AlphaShadowReplayRow[] = modeledTrades
    .slice()
    .sort((a, b) => new Date(b.trade.ts).getTime() - new Date(a.trade.ts).getTime())
    .slice(0, 12)
    .map(({ trade, model }) => ({
      market: trade.market,
      ts: trade.ts,
      direction: trade.direction,
      result: trade.result,
      pnl: round(trade.pnl),
      confidence: trade.confidence,
      modelProbability: model.probability,
      modelEdge: model.edge,
      modelAllowed: model.shouldTrade,
      reasons: model.reasons,
    }));

  return {
    generatedAt: new Date().toISOString(),
    scope: {
      asset: "BTC",
      decisionCount: btcDecisions.length,
      tradeCount: btcTrades.length,
    },
    decisionSummary: {
      total: btcDecisions.length,
      byAction: Array.from(actionCounts.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      byDirection: Array.from(directionCounts.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      executed: btcDecisions.filter((entry) => entry.tradeExecuted).length,
      filtered: btcDecisions.filter((entry) => entry.action === "FILTERED").length,
      noTrade: btcDecisions.filter((entry) => entry.decision === "NO_TRADE").length,
    },
    modelSummary: {
      version: ALPHA_MODEL_VERSION,
      avgProbability: modelRows.length > 0 ? round((average(modelRows.map((row) => row.probability)) || 0) * 100, 1) : null,
      avgModelEdge: modelRows.length > 0 ? round(average(modelRows.map((row) => row.edge || 0)) || 0, 4) : null,
      avgHeuristicEdge: heuristicRows.length > 0 ? round(average(heuristicRows.map((row) => row.edge || 0)) || 0, 4) : null,
      heuristicBrier,
      modelBrier,
    },
    calibration: {
      heuristic: buildCalibrationBuckets(heuristicRows),
      model: buildCalibrationBuckets(modelRows),
    },
    markouts,
    modelShadowReplay: {
      baselineTrades: modeledTrades.length,
      baselinePnl,
      keptTrades: keptTrades.length,
      keptPnl,
      blockedTrades: blockedTrades.length,
      blockedPnl,
      pnlDelta: round(keptPnl - baselinePnl),
    },
    recentDecisions: btcDecisions.slice(0, 15),
    recentShadow,
  };
}
