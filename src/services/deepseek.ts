import axios from "axios";

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export interface DeepSeekPrediction {
  direction: "UP" | "DOWN" | "NEUTRAL";
  confidence: number;
  reasoning: string;
}

export interface MarketContext {
  btcPrice: number;
  priceChange5m: number;
  priceChange1h: number;
  fastLoopDirection: string;
  fastLoopStrength: string;
  fastLoopVW: number;
  rsi?: number;
  emaCross?: string;
  fundingRate?: number;
  longShortRatio?: number;
  heatSignal?: string;
  orderbookImbalance?: string;
  windowElapsedSeconds: number;
}

const SYSTEM_PROMPT = `You are a professional BTC futures trader specializing in 5-minute prediction markets.
Your task is to predict whether BTC price will be UP or DOWN at the end of the current 5-minute window.

Respond ONLY in JSON format with these exact fields:
{
  "direction": "UP" | "DOWN" | "NEUTRAL",
  "confidence": number (0-100),
  "reasoning": "brief explanation in English"
}

Rules:
- UP means BTC price will be higher at window close
- DOWN means BTC price will be lower at window close
- NEUTRAL means no clear direction (avoid unless truly uncertain)
- confidence 90+ only for extremely strong signals
- confidence 50-60 for marginal signals
- Be decisive. Avoid NEUTRAL unless absolutely necessary.`;

function buildPrompt(personality: string, context: MarketContext): string {
  return `${personality}

Current Market Data:
- BTC Price: $${context.btcPrice.toFixed(2)}
- 5m Change: ${context.priceChange5m >= 0 ? "+" : ""}${context.priceChange5m.toFixed(3)}%
- 1h Change: ${context.priceChange1h >= 0 ? "+" : ""}${context.priceChange1h.toFixed(3)}%
- FastLoop: ${context.fastLoopDirection} (${context.fastLoopStrength}) vw=${context.fastLoopVW.toFixed(3)}%
${context.rsi != null ? `- RSI: ${context.rsi.toFixed(1)}\n` : ""}${context.emaCross ? `- EMA Cross: ${context.emaCross}\n` : ""}${context.fundingRate != null ? `- Funding Rate: ${(context.fundingRate * 100).toFixed(4)}%\n` : ""}${context.longShortRatio != null ? `- Long/Short Ratio: ${context.longShortRatio.toFixed(2)}\n` : ""}${context.heatSignal ? `- Market Heat: ${context.heatSignal}\n` : ""}${context.orderbookImbalance ? `- Orderbook: ${context.orderbookImbalance}\n` : ""}- Window Elapsed: ${context.windowElapsedSeconds}s

Based on this data, predict BTC direction for the remaining ~${300 - context.windowElapsedSeconds}s of this 5-minute window.`;
}

export async function askDeepSeek(
  personality: string,
  context: MarketContext,
  temperature: number = 0.7
): Promise<DeepSeekPrediction> {
  if (!DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not configured");
  }

  const prompt = buildPrompt(personality, context);

  try {
    const response = await axios.post(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      {
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature,
        max_tokens: 256,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from DeepSeek");
    }

    const parsed = JSON.parse(content);

    const direction = ["UP", "DOWN", "NEUTRAL"].includes(parsed.direction)
      ? (parsed.direction as "UP" | "DOWN" | "NEUTRAL")
      : "NEUTRAL";

    const confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 50));

    return {
      direction,
      confidence,
      reasoning: String(parsed.reasoning || "").slice(0, 200),
    };
  } catch (err: any) {
    if (err?.response?.status === 429) {
      throw new Error("RATE_LIMIT: DeepSeek rate limit exceeded");
    }
    if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") {
      throw new Error("TIMEOUT: DeepSeek API timeout");
    }
    throw new Error(`DeepSeek API error: ${err?.message || String(err)}`);
  }
}

// Batch prediction with concurrency limit
export async function batchPredict(
  bots: { id: number; personality: string; temperature: number }[],
  context: MarketContext,
  concurrency: number = 5
): Promise<Map<number, DeepSeekPrediction>> {
  const results = new Map<number, DeepSeekPrediction>();

  for (let i = 0; i < bots.length; i += concurrency) {
    const batch = bots.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (bot) => {
        const prediction = await askDeepSeek(bot.personality, context, bot.temperature);
        return { botId: bot.id, prediction };
      })
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.set(result.value.botId, result.value.prediction);
      }
    }
  }

  return results;
}
