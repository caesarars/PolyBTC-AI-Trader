import { GoogleGenAI } from "@google/genai";
import { Market, AIRecommendation, BTCHistory, SentimentData, OrderBook, BTCIndicators } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function aggregateCandles(history: BTCHistory[], bucketSize: number): Candle[] {
  if (!history.length || bucketSize <= 1) return history;

  const aggregated: Candle[] = [];
  for (let i = 0; i < history.length; i += bucketSize) {
    const bucket = history.slice(i, i + bucketSize);
    if (!bucket.length) continue;
    aggregated.push({
      open: bucket[0].open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return aggregated;
}

function computeDirectionalBias(candles: Candle[]): "UP" | "DOWN" | "MIXED" {
  if (candles.length < 3) return "MIXED";
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const risingCloses = candles.slice(-3).every((c, i, arr) => i === 0 || c.close >= arr[i - 1].close);
  const fallingCloses = candles.slice(-3).every((c, i, arr) => i === 0 || c.close <= arr[i - 1].close);

  if (last > first && risingCloses) return "UP";
  if (last < first && fallingCloses) return "DOWN";
  return "MIXED";
}

// Returns number of signals aligned in each direction
// { bullish: 0-5, bearish: 0-5, aligned: "UP"|"DOWN"|"MIXED" }
function computeMultiTimeframeAlignment(
  bias: "UP" | "DOWN" | "MIXED",
  confirmation: "UP" | "DOWN" | "MIXED",
  trigger: "UP" | "DOWN" | "MIXED",
  indicators: BTCIndicators | null,
  fastMomentum?: FastLoopMomentum | null
): { bullish: number; bearish: number; aligned: "UP" | "DOWN" | "MIXED" } {
  let bullish = 0;
  let bearish = 0;

  if (bias === "UP") bullish++;
  else if (bias === "DOWN") bearish++;

  if (confirmation === "UP") bullish++;
  else if (confirmation === "DOWN") bearish++;

  if (trigger === "UP") bullish++;
  else if (trigger === "DOWN") bearish++;

  if (indicators) {
    if (indicators.signalScore >= 2) bullish++;
    else if (indicators.signalScore <= -2) bearish++;
  }

  // Fast loop momentum as 5th signal (only counts when MODERATE or STRONG)
  if (fastMomentum && fastMomentum.strength !== "WEAK") {
    if (fastMomentum.direction === "UP") bullish++;
    else if (fastMomentum.direction === "DOWN") bearish++;
  }

  const aligned =
    bullish >= 2 ? "UP" : bearish >= 2 ? "DOWN" : "MIXED";

  return { bullish, bearish, aligned };
}

function describeSixtyMinuteBias(history: BTCHistory[], indicators: BTCIndicators | null) {
  if (history.length < 20) {
    return {
      bias: "MIXED" as const,
      summary: "60m bias unavailable.",
    };
  }

  const first = history[0].close;
  const last = history[history.length - 1].close;
  const movePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const rangeHigh = Math.max(...history.map((c) => c.high));
  const rangeLow = Math.min(...history.map((c) => c.low));
  const bias =
    indicators?.emaCross === "BULLISH" && movePct > 0.15
      ? "UP"
      : indicators?.emaCross === "BEARISH" && movePct < -0.15
        ? "DOWN"
        : Math.abs(movePct) < 0.1
          ? "MIXED"
          : movePct > 0
            ? "UP"
            : "DOWN";

  return {
    bias,
    summary: `60m bias: ${bias}. Move ${movePct.toFixed(2)}%. Range ${rangeLow.toFixed(1)} -> ${rangeHigh.toFixed(1)}. EMA cross ${indicators?.emaCross ?? "UNKNOWN"}. RSI ${indicators?.rsi ?? "?"}.`,
  };
}

function describeFiveMinuteConfirmation(history: BTCHistory[]) {
  const candles5m = aggregateCandles(history.slice(-30), 5);
  if (candles5m.length < 3) {
    return {
      confirmation: "MIXED" as const,
      summary: "5m confirmation unavailable.",
    };
  }

  const recent = candles5m.slice(-4);
  const direction = computeDirectionalBias(recent);
  const last = recent[recent.length - 1];
  const previous = recent[recent.length - 2];
  const breakout = last.close > previous.high ? "bullish breakout" : last.close < previous.low ? "bearish breakdown" : "inside range";

  return {
    confirmation: direction,
    summary: `5m confirmation: ${direction}. Last 5m candle O:${last.open.toFixed(1)} H:${last.high.toFixed(1)} L:${last.low.toFixed(1)} C:${last.close.toFixed(1)} with ${breakout}.`,
  };
}

function describeOneMinuteTrigger(history: BTCHistory[]) {
  const last5 = history.slice(-5);
  if (last5.length < 3) {
    return {
      trigger: "MIXED" as const,
      summary: "1m trigger unavailable.",
    };
  }

  const patterns = detectPatterns(last5);
  const direction = computeDirectionalBias(last5);
  const last = last5[last5.length - 1];
  const trigger =
    patterns.some((p) => /Bullish|Hammer|Pin Bar|White Soldiers/i.test(p)) && last.close >= last.open
      ? "UP"
      : patterns.some((p) => /Bearish|Shooting Star|Black Crows/i.test(p)) && last.close <= last.open
        ? "DOWN"
        : direction;

  return {
    trigger,
    patterns,
    summary: `1m trigger: ${trigger}. Last candle O:${last.open.toFixed(1)} H:${last.high.toFixed(1)} L:${last.low.toFixed(1)} C:${last.close.toFixed(1)}. Patterns: ${patterns.join(", ")}.`,
  };
}

function detectPatterns(candles: Candle[]): string[] {
  if (candles.length < 2) return [];

  const patterns: string[] = [];
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const bullish = c.close > c.open;

  if (range > 0 && body / range < 0.1) patterns.push("Doji");

  if (lowerWick > body * 2 && upperWick < body * 0.5 && range > 0) {
    patterns.push(bullish ? "Hammer (bullish)" : "Hanging Man (bearish)");
  }

  if (upperWick > body * 2 && lowerWick < body * 0.5 && range > 0) {
    patterns.push(bullish ? "Inverted Hammer" : "Shooting Star (bearish)");
  }

  if (!(p.close > p.open) && bullish && c.open < p.close && c.close > p.open) {
    patterns.push("Bullish Engulfing");
  }

  if (p.close > p.open && !bullish && c.open > p.close && c.close < p.open) {
    patterns.push("Bearish Engulfing");
  }

  if (lowerWick > body * 3) patterns.push("Bullish Pin Bar");
  if (upperWick > body * 3) patterns.push("Bearish Pin Bar");

  if (upperWick < body * 0.05 && lowerWick < body * 0.05 && body > 0) {
    patterns.push(bullish ? "Bullish Marubozu" : "Bearish Marubozu");
  }

  if (c.high < p.high && c.low > p.low) patterns.push("Inside Bar (consolidation)");

  if (c.volume > p.volume * 1.5 && patterns.length > 0) {
    patterns.push("High Volume Confirmation");
  }

  if (candles.length >= 3) {
    const c2 = candles[candles.length - 3];
    const allBull = c.close > c.open && p.close > p.open && c2.close > c2.open;
    const allBear = c.close < c.open && p.close < p.open && c2.close < c2.open;
    if (allBull) patterns.push("Three White Soldiers (strong bullish)");
    if (allBear) patterns.push("Three Black Crows (strong bearish)");
  }

  return patterns.length > 0 ? patterns : ["No clear pattern"];
}

interface LossPattern {
  direction: string;
  confidence: number;
  entryPrice: number;
  windowElapsedSeconds: number;
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  lesson: string;
}

interface WinPattern {
  direction: string;
  confidence: number;
  entryPrice: number;
  pnl: number;
  windowElapsedSeconds: number;
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  lesson: string;
}

interface DivergenceSignal {
  btcDelta30s: number;
  btcDelta60s: number;
  yesDelta30s: number;
  divergence: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK" | "NONE";
  currentBtcPrice: number | null;
  currentYesAsk: number | null;
  currentNoAsk: number | null;
  updatedAt: number;
}

interface FastLoopMomentum {
  raw: number;
  volumeWeighted: number;
  acceleration: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
}

export async function analyzeMarket(
  market: Market,
  btcPrice: string | null,
  history: BTCHistory[],
  sentiment: SentimentData | null,
  indicators: BTCIndicators | null,
  orderBooks: Record<string, OrderBook>,
  marketHistory: { t: number; yes: number; no: number }[] = [],
  windowElapsedSeconds: number = 150,
  lossPatterns: LossPattern[] = [],
  divergence: DivergenceSignal | null = null,
  winPatterns: WinPattern[] = [],
  fastLoopMomentum: FastLoopMomentum | null = null,
  assetSymbol: string = "BTC"
): Promise<AIRecommendation> {
  const sentimentSummary = sentiment
    ? `${sentiment.value_classification} (${sentiment.value}/100)`
    : "Unknown";

  const hasBtcPrice = Boolean(btcPrice && Number.isFinite(Number(btcPrice)));
  const hasBtcHistory = history.length >= 5;
  const dataMode: "FULL_DATA" | "POLYMARKET_ONLY" =
    hasBtcPrice && hasBtcHistory ? "FULL_DATA" : "POLYMARKET_ONLY";

  const triggerAnalysis = hasBtcHistory
    ? describeOneMinuteTrigger(history)
    : { trigger: "MIXED" as const, patterns: ["BTC candlestick feed unavailable"], summary: "1m trigger unavailable." };
  const confirmationAnalysis = hasBtcHistory
    ? describeFiveMinuteConfirmation(history)
    : { confirmation: "MIXED" as const, summary: "5m confirmation unavailable." };
  const biasAnalysis = hasBtcHistory
    ? describeSixtyMinuteBias(history, indicators)
    : { bias: "MIXED" as const, summary: "60m bias unavailable." };
  const patterns = triggerAnalysis.patterns;

  const last15 = history.slice(-15);
  const ohlcvTable =
    last15
      .map((h, i) => {
        const dir = h.close >= h.open ? "UP" : "DOWN";
        return `  [${i + 1}] ${dir} O:${h.open.toFixed(1)} H:${h.high.toFixed(1)} L:${h.low.toFixed(1)} C:${h.close.toFixed(1)} Vol:${h.volume.toFixed(2)}`;
      })
      .join("\n") || "BTC candlestick feed unavailable.";

  const alignment = computeMultiTimeframeAlignment(
    biasAnalysis.bias as "UP" | "DOWN" | "MIXED",
    confirmationAnalysis.confirmation as "UP" | "DOWN" | "MIXED",
    triggerAnalysis.trigger as "UP" | "DOWN" | "MIXED",
    indicators,
    fastLoopMomentum
  );

  // Hard gate: window timing — no trade in first 10s or last 15s of window (aggressive mode)
  if (windowElapsedSeconds < 10 || windowElapsedSeconds > 285) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning:
        windowElapsedSeconds < 10
          ? `Too early: only ${windowElapsedSeconds}s into window. Waiting for minimal price discovery (10s).`
          : `Too late: ${windowElapsedSeconds}s elapsed, only ${300 - windowElapsedSeconds}s remaining. Entry risk too high.`,
      riskLevel: "HIGH",
      dataMode,
      reversalProbability: 50,
      oppositePressureProbability: 50,
      reversalReasoning: "Window timing gate triggered.",
    };
  }

  // Hard gate: order book liquidity — require $150+ total resting liquidity (aggressive mode)
  const gateTokenIds = market.clobTokenIds || [];
  const totalLiquidity = gateTokenIds.reduce((sum, tid) => {
    const ob = orderBooks[tid];
    return sum + (ob?.totalLiquidityUsdc ?? 0);
  }, 0);
  if (totalLiquidity > 0 && totalLiquidity < 500) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning: `Insufficient order book liquidity: $${totalLiquidity.toFixed(0)} USDC total (minimum $500). Book too thin for any fill.`,
      riskLevel: "HIGH",
      dataMode,
      reversalProbability: 50,
      oppositePressureProbability: 50,
      reversalReasoning: "Liquidity gate triggered.",
    };
  }

  // Order book imbalance is passed to the prompt — AI evaluates it per trade rules (>60/40 to count as signal)

  // Pre-AI gate: require at least 2 of 5 signals aligned (aggressive mode allows thinner setups)
  if (hasBtcHistory && alignment.bullish < 2 && alignment.bearish < 2) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning: `Signal alignment too weak to trade. Bullish: ${alignment.bullish}/5, Bearish: ${alignment.bearish}/5. No directional edge — skipping.`,
      riskLevel: "HIGH",
      dataMode,
      reversalProbability: 50,
      oppositePressureProbability: 50,
      reversalReasoning: "Conflicting signals make reversal risk high.",
    };
  }

  const indicatorBlock = indicators
    ? `
TECHNICAL INDICATORS (last 60x 1m candles):
- RSI(14): ${indicators.rsi} ${indicators.rsi > 70 ? "⚠ Overbought" : indicators.rsi < 30 ? "⚠ Oversold" : "Neutral"}
- EMA9: $${indicators.ema9} | EMA21: $${indicators.ema21} -> ${indicators.emaCross}
- MACD: ${indicators.macd} | Signal: ${indicators.macdSignal} | Histogram: ${indicators.macdHistogram} -> ${indicators.macdTrend}
- Bollinger Bands: Upper $${indicators.bbUpper} | Mid $${indicators.bbMiddle} | Lower $${indicators.bbLower} | Position: ${indicators.bbPosition}
- 5-candle Momentum: ${indicators.momentum5}%
- Trend (last 3): ${indicators.trend}
- Volume spike: ${indicators.volumeSpike}x avg ${indicators.volumeSpike > 2 ? "⚠ High" : "Normal"}
- Pre-computed Signal Score: ${indicators.signalScore > 0 ? "+" : ""}${indicators.signalScore} (positive=bullish, negative=bearish, range -8 to +8)
- Multi-TF Alignment: ${alignment.aligned} (${alignment.bullish} bullish / ${alignment.bearish} bearish out of 5 signals)
`
    : "BTC indicators unavailable.";

  const tokenIds = market.clobTokenIds || [];
  const obLines = tokenIds
    .map((tid, i) => {
      const ob = orderBooks[tid];
      if (!ob) return `  ${market.outcomes[i]}: No data`;
      return `  ${market.outcomes[i]}: imbalance=${ob.imbalance ?? "?"} -> ${ob.imbalanceSignal ?? "NEUTRAL"} | bid=${ob.bids[0]?.price ?? "?"} ask=${ob.asks[0]?.price ?? "?"}`;
    })
    .join("\n");

  const impliedProbs = market.outcomePrices
    .map((p, i) => `  ${market.outcomes[i]}: ${(parseFloat(p) * 100).toFixed(1)}c`)
    .join("\n");

  const marketHistoryBlock =
    marketHistory.length > 0
      ? marketHistory
          .slice(-10)
          .map((point, i) => `  [${i + 1}] yes=${(point.yes * 100).toFixed(1)}c no=${(point.no * 100).toFixed(1)}c t=${point.t}`)
          .join("\n")
      : "Polymarket market history unavailable.";

  // Price velocity: change in YES price per minute over the last ~3 minutes
  let priceVelocity = 0;
  let priceVelocityLabel = "Insufficient data";
  if (marketHistory.length >= 2) {
    const latest = marketHistory[marketHistory.length - 1];
    const lookback = marketHistory.find((p) => latest.t - p.t >= 180) || marketHistory[0];
    const elapsedMinutes = (latest.t - lookback.t) / 60;
    if (elapsedMinutes > 0) {
      priceVelocity = (latest.yes - lookback.yes) / elapsedMinutes;
      priceVelocityLabel =
        priceVelocity > 0.04
          ? `+${priceVelocity.toFixed(3)}/min ⚡ STRONG UP MOMENTUM`
          : priceVelocity < -0.04
            ? `${priceVelocity.toFixed(3)}/min ⚡ STRONG DOWN MOMENTUM`
            : `${priceVelocity.toFixed(3)}/min (neutral)`;
    }
  }

  const windowMinutes = Math.floor(windowElapsedSeconds / 60);
  const windowSeconds = windowElapsedSeconds % 60;
  const windowTimeLabel = `${windowMinutes}:${String(windowSeconds).padStart(2, "0")} elapsed of 5:00`;

  const lossPatternBlock = lossPatterns.length > 0
    ? `== ADAPTIVE LEARNING: RECENT LOSS PATTERNS (AVOID THESE SETUPS) ==
${lossPatterns.map((l, i) =>
  `[${i + 1}] Dir: ${l.direction} | Entry: ${(l.entryPrice * 100).toFixed(1)}¢ | Conf: ${l.confidence}% | Window: ${l.windowElapsedSeconds}s | RSI: ${l.rsi?.toFixed(0) ?? "?"} | EMA: ${l.emaCross ?? "?"} | Signal: ${l.signalScore !== undefined ? (l.signalScore > 0 ? `+${l.signalScore}` : l.signalScore) : "?"} | OB: ${l.imbalanceSignal ?? "?"}
    Lesson: ${l.lesson}`
).join("\n")}
`
    : "";

  const winPatternBlock = winPatterns.length > 0
    ? `== ADAPTIVE LEARNING: RECENT WIN PATTERNS (REPLICATE THESE SETUPS) ==
${winPatterns.map((w, i) =>
  `[${i + 1}] Dir: ${w.direction} | Entry: ${(w.entryPrice * 100).toFixed(1)}¢ | Conf: ${w.confidence}% | PnL: +$${w.pnl.toFixed(2)} | Window: ${w.windowElapsedSeconds}s | RSI: ${w.rsi?.toFixed(0) ?? "?"} | EMA: ${w.emaCross ?? "?"} | Signal: ${w.signalScore !== undefined ? (w.signalScore > 0 ? `+${w.signalScore}` : w.signalScore) : "?"} | OB: ${w.imbalanceSignal ?? "?"}
    Why it won: ${w.lesson}`
).join("\n")}
`
    : "";

  const prompt = `You are a quantitative trader analyzing a Polymarket BTC 5-minute prediction market.
Determine if there is a profitable edge to trade, and which direction.
Current analysis mode: ${dataMode}.

== MARKET ==
Question: ${market.question}
Outcomes and implied probabilities:
${impliedProbs}
Volume: $${parseFloat(market.volume || "0").toLocaleString()} | Liquidity: $${parseFloat(market.liquidity || "0").toLocaleString()}
Window: ${market.startDate} -> ${market.endDate}
Window Position: ${windowTimeLabel} (windowElapsedSeconds=${windowElapsedSeconds})

== ${assetSymbol} PRICE ==
Current: ${hasBtcPrice ? `$${btcPrice}` : "Unavailable"}

== MULTI-TIMEFRAME DECISION STACK ==
${biasAnalysis.summary}
${confirmationAnalysis.summary}
${triggerAnalysis.summary}

== ${assetSymbol} CANDLESTICK DATA (last 15x 1m candles, oldest to newest) ==
${ohlcvTable}

== DETECTED CANDLE PATTERNS ==
${patterns.join(", ")}

== MARKET SENTIMENT ==
Fear and Greed: ${sentimentSummary}
${indicatorBlock}

${fastLoopMomentum ? `== FAST LOOP MOMENTUM (Simmer-style CEX signal, last 5 x 1m candles) ==
Direction: ${fastLoopMomentum.direction} | Strength: ${fastLoopMomentum.strength}
Raw momentum: ${fastLoopMomentum.raw >= 0 ? "+" : ""}${fastLoopMomentum.raw.toFixed(3)}%
Volume-weighted: ${fastLoopMomentum.volumeWeighted >= 0 ? "+" : ""}${fastLoopMomentum.volumeWeighted.toFixed(3)}% (volume-confirmed price pressure)
Acceleration: ${fastLoopMomentum.acceleration >= 0 ? "+" : ""}${fastLoopMomentum.acceleration.toFixed(3)}% (positive = momentum building, negative = fading)
Signal: ${fastLoopMomentum.strength === "STRONG" ? `Strong ${fastLoopMomentum.direction} CEX pressure — counts as 5th aligned signal` : fastLoopMomentum.strength === "MODERATE" ? `Moderate ${fastLoopMomentum.direction} pressure — counts as 5th signal` : "Weak/flat — not counted as signal"}

` : ""}== ORDER BOOK IMBALANCE ==
${obLines}

== POLYMARKET PRICE HISTORY (recent) ==
${marketHistoryBlock}
YES Price Velocity (per min): ${priceVelocityLabel}

${(() => {
  if (!divergence || divergence.strength === "NONE") return "";
  const btcDir = divergence.btcDelta30s >= 0 ? "UP" : "DOWN";
  const lag = divergence.direction !== "NEUTRAL" && divergence.yesDelta30s * (divergence.direction === "UP" ? 1 : -1) < 2.0;
  return `== PRICE LAG DIVERGENCE (HIGHEST PRIORITY SIGNAL) ==
BTC moved: ${divergence.btcDelta30s >= 0 ? "+" : ""}$${divergence.btcDelta30s.toFixed(0)} in last 30s (${btcDir})
BTC 60s change: ${divergence.btcDelta60s >= 0 ? "+" : ""}$${divergence.btcDelta60s.toFixed(0)}
YES token moved: ${divergence.yesDelta30s >= 0 ? "+" : ""}${divergence.yesDelta30s.toFixed(2)}¢ in last 30s
Market lag: ${lag ? `YES — Polymarket has NOT priced in the BTC move yet` : "NO — market already caught up"}
Divergence direction: ${divergence.direction}
Divergence strength: ${divergence.strength}
Interpretation: ${
  divergence.strength === "STRONG"
    ? `BTC made a STRONG move ${divergence.direction} but Polymarket is lagging — this is a near-certain mispricing. TRADE ${divergence.direction} immediately.`
    : divergence.strength === "MODERATE"
      ? `BTC moved ${divergence.direction} and Polymarket is slow to reprice. High-confidence ${divergence.direction} entry.`
      : `Mild BTC momentum ${divergence.direction}, Polymarket slightly lagging. Treat as supporting signal.`
}

`;
})()}${lossPatternBlock}${winPatternBlock}== TRADE RULES (precision over frequency — only trade clear, quantifiable edges) ==

CRITICAL CALIBRATION: This is a 5-minute binary BTC market. The base rate is exactly 50/50 — a coin flip.
Technical indicators (RSI, EMA, MACD) measure what BTC HAS ALREADY DONE, not what it will do next.
For a trade to be worth placing, you need clear evidence that the true probability is ≥ 70%.
Confidence calibration: 50% = coin flip (no edge), 60% = slight lean (marginal), 65% = real signal (minimum to trade), 75%+ = strong signal.
Fewer high-conviction trades beat many marginal trades. When in doubt, output NO_TRADE.

1. MINIMUM ALIGNMENT: Require at least 3 of these 5 signals agreeing on the SAME direction:
   - 60m bias
   - 5m confirmation
   - 1m trigger
   - Technical signal score (positive = bullish, negative = bearish)
   - Fast loop momentum (CEX volume-weighted, only counts if MODERATE or STRONG strength)
   Exception: if PRICE LAG DIVERGENCE is STRONG or MODERATE, 2/5 alignment is sufficient.
   Output NO_TRADE if fewer than 3 signals align AND no strong divergence is present.

2. MINIMUM CONFIDENCE: Output TRADE only if confidence >= 65%.
   Below 65% you cannot clearly beat the 50% base rate — output NO_TRADE.
   Do NOT output confidence 65%+ unless at least 3 signals are genuinely aligned.

3. REAL EDGE: Edge = your estimated probability minus the 50% base rate.
   A 70% estimate = +20% edge over coin flip. A 60% estimate = +10% = not tradeable.
   Only report estimatedEdge when backed by at least 3 aligned signals or strong divergence.
   If you are uncertain or signals are mixed, output NO_TRADE — do not fabricate edge.

4. RISK LEVEL: 5/5 signals aligned = "LOW". 4/5 or 3/5 signals = "MEDIUM". 2/5 or fewer = "HIGH" (only trade if STRONG divergence).
   Set riskLevel = HIGH if reversalProbability > 50% OR if signals are split.

5. QUALITY OVER FREQUENCY: Do NOT trade just because signals slightly lean one way.
   Neutral, ambiguous, or contradictory setups = NO_TRADE.
   The goal is profitable trades, not maximum trade count.

6. MACD + EMA CROSS: Only count as a signal if it clearly agrees with the trade direction.
   Conflicting MACD and EMA = they cancel each other — count as 0 signals, not 1.

7. RSI CONTEXT: RSI reflects what BTC has already done, not what it will do.
   Only use RSI as a signal when it aligns with 60m + 5m trend AND divergence is present.
   RSI alone or with only 1 other signal is NOT sufficient justification for a trade.

8. BOLLINGER BAND: Supporting signal only. Count as 1 signal only when price is at the band (within 0.5%).
   Price near the middle of the band = neutral, adds nothing.

9. ORDER BOOK PRESSURE: Count as 1 signal only when imbalance is clearly skewed (>60/40 bid/ask ratio).
   A slightly tilted or neutral book does not count.

10. POLYMARKET MOMENTUM: Count velocity as a signal only when strong (>0.05¢/min).
    Weak velocity (<0.05¢/min) is market noise — do not count.

11. WINDOW TIMING: windowElapsedSeconds < 10 = too early (NO_TRADE). windowElapsedSeconds > 285 = too late (NO_TRADE).
    Optimal entry zone: 30–200s — enough price discovery has occurred, enough time remains.

12. LOSS PATTERN LEARNING: If current setup matches a recent loss pattern, output NO_TRADE unless
    this setup has at least 3 clearly aligned signals AND strong divergence is present.

13. WIN PATTERN REPLICATION: If current setup closely matches a recent win pattern with 3+ aligned signals,
    increase confidence by 5%. Do not apply this to setups with fewer than 3 aligned signals.

14. PRICE LAG DIVERGENCE (HIGHEST PRIORITY): STRONG or MODERATE divergence overrides all other rules.
    The Polymarket price has NOT priced in the BTC move yet — this is a real, quantifiable mispricing.
    Trade in divergence direction with confidence >= 75%, riskLevel="LOW".
    WEAK divergence only adds 1 signal count — not sufficient to trade on its own.

Respond with JSON only:
{
  "decision": "TRADE" | "NO_TRADE",
  "direction": "UP" | "DOWN" | "NONE",
  "confidence": number,
  "estimatedEdge": number,
  "candlePatterns": ["pattern1", "pattern2"],
  "reasoning": "string",
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "dataMode": "FULL_DATA" | "POLYMARKET_ONLY",
  "reversalProbability": number,
  "oppositePressureProbability": number,
  "reversalReasoning": "string"
}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });

    const result = JSON.parse(response.text || "{}");
    return {
      decision: result.decision || "NO_TRADE",
      direction: result.direction || "NONE",
      confidence: result.confidence || 0,
      estimatedEdge: result.estimatedEdge || 0,
      candlePatterns: result.candlePatterns || patterns,
      reasoning: result.reasoning || "Failed to generate analysis.",
      riskLevel: result.riskLevel || "MEDIUM",
      dataMode: result.dataMode || dataMode,
      reversalProbability: result.reversalProbability || 0,
      oppositePressureProbability: result.oppositePressureProbability || 0,
      reversalReasoning: result.reversalReasoning || "Reversal layer unavailable.",
    };
  } catch (error) {
    console.error("AI Analysis Error:", error);
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning: "Error occurred during AI analysis.",
      riskLevel: "HIGH",
      dataMode,
      reversalProbability: 0,
      oppositePressureProbability: 0,
      reversalReasoning: "Reversal layer unavailable.",
    };
  }
}
