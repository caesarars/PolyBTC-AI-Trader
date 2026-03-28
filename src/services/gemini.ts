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
// { bullish: 0-4, bearish: 0-4, aligned: "UP"|"DOWN"|"MIXED" }
function computeMultiTimeframeAlignment(
  bias: "UP" | "DOWN" | "MIXED",
  confirmation: "UP" | "DOWN" | "MIXED",
  trigger: "UP" | "DOWN" | "MIXED",
  indicators: BTCIndicators | null
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

  const aligned =
    bullish >= 3 ? "UP" : bearish >= 3 ? "DOWN" : "MIXED";

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

export async function analyzeMarket(
  market: Market,
  btcPrice: string | null,
  history: BTCHistory[],
  sentiment: SentimentData | null,
  indicators: BTCIndicators | null,
  orderBooks: Record<string, OrderBook>,
  marketHistory: { t: number; yes: number; no: number }[] = [],
  windowElapsedSeconds: number = 150
): Promise<AIRecommendation> {
  const sentimentSummary = sentiment
    ? `${sentiment.value_classification} (${sentiment.value}/100)`
    : "Unknown";

  const hasBtcPrice = Boolean(btcPrice && Number.isFinite(Number(btcPrice)));
  const hasBtcHistory = history.length >= 5;
  const dataMode: "FULL_DATA" | "POLYMARKET_ONLY" =
    hasBtcPrice && hasBtcHistory ? "FULL_DATA" : "POLYMARKET_ONLY";

  const last15 = history.slice(-15);
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
    indicators
  );

  // Hard gate: window timing — no trade in first 30s or last 30s of window
  if (windowElapsedSeconds < 30 || windowElapsedSeconds > 270) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning:
        windowElapsedSeconds < 30
          ? `Too early: only ${windowElapsedSeconds}s into window. Market liquidity thin — waiting for price discovery (30s+).`
          : `Too late: ${windowElapsedSeconds}s elapsed, only ${300 - windowElapsedSeconds}s remaining. Entry risk too high.`,
      riskLevel: "HIGH",
      dataMode,
      reversalProbability: 50,
      oppositePressureProbability: 50,
      reversalReasoning: "Window timing gate triggered.",
    };
  }

  // Hard gate: order book liquidity — require $500+ total resting liquidity
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
      reasoning: `Insufficient order book liquidity: $${totalLiquidity.toFixed(0)} USDC total (minimum $500). Thin book = bad fills and market maker risk.`,
      riskLevel: "HIGH",
      dataMode,
      reversalProbability: 50,
      oppositePressureProbability: 50,
      reversalReasoning: "Liquidity gate triggered.",
    };
  }

  // Hard gate: order book must show directional pressure (>= 60% or <= 40% imbalance)
  const hasDirectionalPressure = gateTokenIds.some((tid) => {
    const ob = orderBooks[tid];
    return ob?.imbalanceSignal === "BUY_PRESSURE" || ob?.imbalanceSignal === "SELL_PRESSURE";
  });
  if (gateTokenIds.length > 0 && !hasDirectionalPressure) {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning: `Order book is neutral (no directional pressure ≥60%/≤40%). Market makers are balanced — no edge available.`,
      riskLevel: "MEDIUM",
      dataMode,
      reversalProbability: 50,
      oppositePressureProbability: 50,
      reversalReasoning: "Order book neutrality gate triggered.",
    };
  }

  // Pre-AI gate: require at least 3 of 4 signals aligned for a TRADE to be valid
  // If signals conflict strongly, return NO_TRADE without burning AI tokens
  if (hasBtcHistory && alignment.aligned === "MIXED") {
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      estimatedEdge: 0,
      candlePatterns: patterns,
      reasoning: `Signal alignment too weak to trade. Bullish signals: ${alignment.bullish}/4, Bearish signals: ${alignment.bearish}/4. Multi-timeframe conflict detected — waiting for cleaner setup.`,
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
- Multi-TF Alignment: ${alignment.aligned} (${alignment.bullish} bullish / ${alignment.bearish} bearish out of 4 signals)
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

== BTC PRICE ==
Current: ${hasBtcPrice ? `$${btcPrice}` : "Unavailable"}

== MULTI-TIMEFRAME DECISION STACK ==
${biasAnalysis.summary}
${confirmationAnalysis.summary}
${triggerAnalysis.summary}

== BTC CANDLESTICK DATA (last 15x 1m candles, oldest to newest) ==
${ohlcvTable}

== DETECTED CANDLE PATTERNS ==
${patterns.join(", ")}

== MARKET SENTIMENT ==
Fear and Greed: ${sentimentSummary}
${indicatorBlock}

== ORDER BOOK IMBALANCE ==
${obLines}

== POLYMARKET PRICE HISTORY (recent) ==
${marketHistoryBlock}
YES Price Velocity (per min): ${priceVelocityLabel}

== HIGH-PROBABILITY TRADE RULES ==
1. MINIMUM ALIGNMENT: Only output TRADE if at least 3 of these 4 signals agree on the same direction:
   - 60m bias
   - 5m confirmation
   - 1m trigger
   - Technical signal score (positive = bullish, negative = bearish)
   The Multi-TF Alignment field already shows you this count. If aligned = MIXED, output NO_TRADE.
2. MINIMUM CONFIDENCE: Never output TRADE with confidence < 68%. Below this threshold output NO_TRADE.
3. MINIMUM EDGE: Edge exists only when your probability estimate differs from implied price by more than 8 cents.
4. RISK LEVEL: Only output riskLevel = "LOW" when 4/4 signals aligned + no RSI extreme + no reversal risk. 3/4 signals = "MEDIUM". Any conflict or reversal risk > 40% = "HIGH". Only LOW risk setups should be traded.
5. STRONG SETUPS ONLY (confidence 68%+): All 4 signals aligned + volume confirmation + order book imbalance in same direction = 75%+. 3 of 4 signals aligned, no counter-signals = 68-74%. Do NOT output TRADE for setups below 68%.
6. MACD + EMA CROSS DOUBLE CONFIRM: If MACD histogram and EMA cross agree on direction, this counts as a strong single signal. If they conflict, treat both as neutral.
7. RSI EXTREMES: RSI < 30 = strong bullish reversal potential; RSI > 70 = strong bearish reversal potential. These override marginal opposing signals.
8. BOLLINGER BAND CONTEXT: Price at lower band in downtrend = mean-reversion caution. Price breaking above upper band with volume = momentum continuation signal.
9. ORDER BOOK PRESSURE: BUY_PRESSURE + bullish technical alignment = additional confirmation. SELL_PRESSURE + bearish = same. Conflicting order book reduces confidence by 10%.
10. POLYMARKET MOMENTUM: Use the price velocity (change per minute) as a leading indicator. Velocity > +0.04/min = strong UP confirmation. Velocity < -0.04/min = strong DOWN confirmation. Velocity near 0 = no momentum signal.
11. Estimate reversal risk precisely:
    - reversalProbability: probability price reverses against suggested direction in the next 3-5 minutes
    - oppositePressureProbability: probability the opposite side aggressively takes control
    - Both must be based on RSI extremes, BB position, volume, and signal conflicts
    - If reversalProbability > 40%, set riskLevel = HIGH and reduce confidence by 8%
12. WINDOW TIMING: If windowElapsedSeconds < 30, signals are unreliable (market just opened, liquidity thin) — output NO_TRADE. If windowElapsedSeconds > 270 (last 30s), output NO_TRADE (too late to enter). Optimal entry window is 60-240 seconds into the window.

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
