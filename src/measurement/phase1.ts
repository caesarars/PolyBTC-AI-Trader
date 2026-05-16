// ── Phase 1 — Honest measurement on the existing trade log ────────────────────
// Computes:
//   • Base rate and fee-aware net PnL over the persisted trade log.
//   • Brier score and log-loss treating heuristic confidence/100 as a probability.
//     This is a *measurement* of how miscalibrated that practice is — NEVER use
//     confidence/100 as a probability at runtime. Sizing must remain flat or
//     gated by the trained logistic calibrator (src/calibration/).
//   • Per-signal breakdown (RSI bucket, EMA cross, signalScore bucket,
//     imbalanceSignal, divergenceStrength, direction). For each bucket:
//     n, wins, win-rate, lift-vs-base-rate, Brier.
//   • Keep / Kill / Recalibrate verdict per bucket using a lift threshold and
//     minimum sample size.

export interface TradeRecord {
  ts: string;
  market?: string;
  direction: "UP" | "DOWN";
  confidence: number;
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
  windowElapsedSeconds?: number;
}

export interface SignalBucket {
  signal: string;
  bucket: string;
  n: number;
  wins: number;
  winRate: number;          // %
  lift: number;             // pp vs base rate
  brier: number;            // confidence/100 vs outcome inside the bucket
  verdict: "KEEP" | "KILL" | "RECALIBRATE" | "INSUFFICIENT";
}

export interface Phase1Report {
  generatedAt: string;
  source: { trades: number; livePaperSplit: { live: number; paper: number } };
  baseRate: { winRate: number; n: number; wins: number; losses: number };
  pnl: { netUsdc: number; grossUsdc: number; meanPerTrade: number };
  brier: {
    n: number;
    // Treats confidence/100 as a probability. This is the anti-pattern we want
    // to *measure*, not to use. Lower is better; 0.25 is coin-flip.
    confidenceAsProbability: { brier: number; logLoss: number };
    // Bucketed reliability: declared mean confidence vs realized win rate.
    reliability: Array<{ range: string; predicted: number; realized: number; n: number }>;
  };
  perSignal: SignalBucket[];
  notes: string[];
}

interface MeasurementOptions {
  /** Minimum samples per bucket to render a verdict (else INSUFFICIENT). */
  minBucketN?: number;
  /** Win-rate lift threshold (pp) above which a bucket is KEEP. */
  keepLiftPp?: number;
  /** Win-rate lift threshold (pp) below which a bucket is KILL. */
  killLiftPp?: number;
}

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.9999, Math.max(0.0001, p));
}

function brierLogLoss(records: TradeRecord[], probOf: (r: TradeRecord) => number) {
  if (records.length === 0) return { brier: NaN, logLoss: NaN };
  let brier = 0;
  let ll = 0;
  for (const r of records) {
    const p = clamp01(probOf(r));
    const y = r.result === "WIN" ? 1 : 0;
    brier += (p - y) ** 2;
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return { brier: brier / records.length, logLoss: ll / records.length };
}

function reliabilityBuckets(records: TradeRecord[]) {
  const buckets: Record<string, { sum: number; wins: number; n: number }> = {
    "55-65": { sum: 0, wins: 0, n: 0 },
    "65-75": { sum: 0, wins: 0, n: 0 },
    "75-85": { sum: 0, wins: 0, n: 0 },
    "85-95": { sum: 0, wins: 0, n: 0 },
  };
  for (const r of records) {
    const c = r.confidence;
    const k = c < 65 ? "55-65" : c < 75 ? "65-75" : c < 85 ? "75-85" : "85-95";
    buckets[k].sum += c;
    buckets[k].n += 1;
    if (r.result === "WIN") buckets[k].wins += 1;
  }
  return Object.entries(buckets)
    .filter(([, v]) => v.n > 0)
    .map(([range, v]) => ({
      range,
      predicted: parseFloat((v.sum / v.n).toFixed(1)),
      realized: parseFloat(((v.wins / v.n) * 100).toFixed(1)),
      n: v.n,
    }));
}

type BucketFn = (r: TradeRecord) => string | null;

const SIGNAL_BUCKETS: Array<{ signal: string; bucket: BucketFn }> = [
  {
    signal: "direction",
    bucket: (r) => r.direction,
  },
  {
    signal: "rsi",
    bucket: (r) => {
      const v = r.rsi;
      if (v === undefined || v === null || !Number.isFinite(v)) return null;
      if (v < 30) return "oversold (<30)";
      if (v <= 70) return "neutral (30-70)";
      return "overbought (>70)";
    },
  },
  {
    signal: "emaCross",
    bucket: (r) => r.emaCross ?? null,
  },
  {
    signal: "signalScore",
    bucket: (r) => {
      const v = r.signalScore;
      if (v === undefined || v === null || !Number.isFinite(v)) return null;
      if (v <= -2) return "strong bearish (≤-2)";
      if (v < 0)   return "bearish (-1)";
      if (v === 0) return "neutral (0)";
      if (v < 2)   return "bullish (+1)";
      return "strong bullish (≥+2)";
    },
  },
  {
    signal: "imbalanceSignal",
    bucket: (r) => r.imbalanceSignal ?? null,
  },
  {
    signal: "divergenceStrength",
    bucket: (r) => r.divergenceStrength ?? null,
  },
  {
    signal: "windowElapsed",
    bucket: (r) => {
      const v = r.windowElapsedSeconds;
      if (v === undefined || v === null || !Number.isFinite(v)) return null;
      if (v < 60)  return "0-60s";
      if (v < 120) return "60-120s";
      if (v < 180) return "120-180s";
      if (v < 240) return "180-240s";
      return "240-300s";
    },
  },
];

function verdictFor(n: number, lift: number, opts: Required<MeasurementOptions>): SignalBucket["verdict"] {
  if (n < opts.minBucketN) return "INSUFFICIENT";
  if (lift >= opts.keepLiftPp) return "KEEP";
  if (lift <= opts.killLiftPp) return "KILL";
  return "RECALIBRATE";
}

export function buildPhase1Report(
  trades: TradeRecord[],
  options: MeasurementOptions = {}
): Phase1Report {
  const opts: Required<MeasurementOptions> = {
    minBucketN: options.minBucketN ?? 10,
    keepLiftPp: options.keepLiftPp ?? 5,
    killLiftPp: options.killLiftPp ?? -5,
  };

  const liveCount = trades.length;
  const filtered = trades;

  const wins = filtered.filter((t) => t.result === "WIN").length;
  const losses = filtered.length - wins;
  const baseWinRate = filtered.length > 0 ? (wins / filtered.length) * 100 : 0;

  const netPnl = filtered.reduce((s, t) => s + (Number.isFinite(t.pnl) ? t.pnl : 0), 0);
  const grossPnl = filtered.reduce((s, t) => {
    // Gross = payout difference; with $1 payout on WIN this is shares − bet.
    // We approximate by re-deriving from pnl + fees. Polymarket fee = 0 today,
    // so gross ≡ net for now. Keeping the field for forward-compat.
    return s + (Number.isFinite(t.pnl) ? t.pnl : 0);
  }, 0);
  const meanPerTrade = filtered.length > 0 ? netPnl / filtered.length : 0;

  const bl = brierLogLoss(filtered, (r) => r.confidence / 100);

  const perSignal: SignalBucket[] = [];
  for (const { signal, bucket } of SIGNAL_BUCKETS) {
    const groups = new Map<string, TradeRecord[]>();
    for (const r of filtered) {
      const key = bucket(r);
      if (key === null) continue;
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    for (const [bucketName, records] of groups) {
      const w = records.filter((r) => r.result === "WIN").length;
      const winRate = records.length > 0 ? (w / records.length) * 100 : 0;
      const lift = winRate - baseWinRate;
      const { brier } = brierLogLoss(records, (r) => r.confidence / 100);
      perSignal.push({
        signal,
        bucket: bucketName,
        n: records.length,
        wins: w,
        winRate: parseFloat(winRate.toFixed(1)),
        lift: parseFloat(lift.toFixed(1)),
        brier: parseFloat(brier.toFixed(4)),
        verdict: verdictFor(records.length, lift, opts),
      });
    }
  }
  perSignal.sort((a, b) => {
    if (a.signal !== b.signal) return a.signal.localeCompare(b.signal);
    return b.n - a.n;
  });

  const notes: string[] = [];
  if (filtered.length < 100) {
    notes.push(`Sample size is small (n=${filtered.length}). Per-signal verdicts with n < ${opts.minBucketN} are reported as INSUFFICIENT and should not drive keep/kill decisions yet.`);
  }
  if (bl.brier > 0.25) {
    notes.push(`Brier on confidence/100 is ${bl.brier.toFixed(3)} — worse than a 50-50 coin (0.250). Heuristic confidence is anti-informative as a probability; this is exactly what motivates the calibrator.`);
  }
  return {
    generatedAt: new Date().toISOString(),
    source: { trades: filtered.length, livePaperSplit: { live: liveCount, paper: 0 } },
    baseRate: {
      winRate: parseFloat(baseWinRate.toFixed(1)),
      n: filtered.length,
      wins,
      losses,
    },
    pnl: {
      netUsdc: parseFloat(netPnl.toFixed(2)),
      grossUsdc: parseFloat(grossPnl.toFixed(2)),
      meanPerTrade: parseFloat(meanPerTrade.toFixed(4)),
    },
    brier: {
      n: filtered.length,
      confidenceAsProbability: {
        brier: parseFloat(bl.brier.toFixed(4)),
        logLoss: parseFloat(bl.logLoss.toFixed(4)),
      },
      reliability: reliabilityBuckets(filtered),
    },
    perSignal,
    notes,
  };
}
