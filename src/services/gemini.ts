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
  marketHistory: { t: number; yes: number; no: number }[] = []
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

  const indicatorBlock = indicators
    ? `
TECHNICAL INDICATORS (last 60x 1m candles):
- RSI(14): ${indicators.rsi} ${indicators.rsi > 70 ? "Overbought" : indicators.rsi < 30 ? "Oversold" : "Neutral"}
- EMA9: $${indicators.ema9} | EMA21: $${indicators.ema21} -> ${indicators.emaCross}
- Trend (last 3): ${indicators.trend}
- Volume spike: ${indicators.volumeSpike}x avg ${indicators.volumeSpike > 2 ? "High" : "Normal"}
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

  const prompt = `You are a quantitative trader analyzing a Polymarket BTC 5-minute prediction market.
Determine if there is a profitable edge to trade, and which direction.
Current analysis mode: ${dataMode}.

== MARKET ==
Question: ${market.question}
Outcomes and implied probabilities:
${impliedProbs}
Volume: $${parseFloat(market.volume || "0").toLocaleString()} | Liquidity: $${parseFloat(market.liquidity || "0").toLocaleString()}
Window: ${market.startDate} -> ${market.endDate}

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

== EDGE ANALYSIS RULES ==
1. Edge exists only when your probability estimate differs from implied price by more than 5 cents.
2. Use a strict hierarchy:
   - 60m bias decides directional preference
   - 5m confirmation validates short-term alignment
   - 1m trigger decides exact entry timing
3. Highest confidence only when 60m bias, 5m confirmation, 1m trigger, and order book all align.
4. If 60m bias conflicts with 5m and 1m trigger, prefer NO_TRADE or reduce confidence sharply.
5. If only 1m trigger exists without 5m/60m support, confidence must stay low.
6. Strong Polymarket momentum plus order book imbalance can still justify a trade even if BTC feed is unavailable, but reduce confidence.
7. If BTC price/candles are unavailable, still analyze using Polymarket probabilities, history, liquidity, and order book only, but reduce confidence.
8. Add an Astrology Trading Assist layer as general context only:
   - infer a broad market mood as BULLISH, BEARISH, or NEUTRAL
   - use symbolic timing language only as an auxiliary sentiment overlay
   - this astrology layer must never override strong contrary market structure
   - if astrology conflicts with actual price action, mention the conflict clearly
9. Keep astrology separate from the main trading decision. Decision/confidence must still be grounded primarily in market data.
10. Estimate reversal risk:
   - reversalProbability: probability that price suddenly reverses against the suggested direction in the next short window
   - oppositePressureProbability: probability that the opposite side aggressively takes control (example: if direction is DOWN, chance of sudden BUY squeeze)
   - these should be based on spread, imbalance, recent candles, and conflict between 60m/5m/1m layers

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
  "astrologyBias": "BULLISH" | "BEARISH" | "NEUTRAL",
  "astrologyConfidence": number,
  "astrologyReasoning": "string",
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
      astrologyBias: result.astrologyBias || "NEUTRAL",
      astrologyConfidence: result.astrologyConfidence || 0,
      astrologyReasoning: result.astrologyReasoning || "Astrology layer unavailable.",
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
      astrologyBias: "NEUTRAL",
      astrologyConfidence: 0,
      astrologyReasoning: "Astrology layer unavailable.",
      reversalProbability: 0,
      oppositePressureProbability: 0,
      reversalReasoning: "Reversal layer unavailable.",
    };
  }
}
