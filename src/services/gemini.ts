import { GoogleGenAI } from "@google/genai";
import { Market, AIRecommendation, BTCHistory, SentimentData } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function analyzeMarket(
  market: Market, 
  btcPrice: string, 
  history: BTCHistory[], 
  sentiment: SentimentData | null
): Promise<AIRecommendation> {
  const historySummary = history.map(h => `$${h.price.toLocaleString()} at ${new Date(h.time).toLocaleTimeString()}`).join(", ");
  const sentimentSummary = sentiment ? `${sentiment.value_classification} (${sentiment.value}/100)` : "Unknown";

  const prompt = `
    Analyze the following Polymarket BTC price prediction market and provide a trade recommendation.
    
    Current BTC Price: $${btcPrice}
    
    Historical BTC Price (Last 24h, 1h intervals):
    ${historySummary}
    
    Crypto Market Sentiment (Fear & Greed Index):
    ${sentimentSummary}
    
    Market Question: ${market.question}
    Market Description: ${market.description}
    Outcomes: ${market.outcomes.join(", ")}
    Outcome Prices: ${market.outcomePrices.join(", ")}
    Market Volume: ${market.volume}
    Market Liquidity: ${market.liquidity}
    
    Consider the current price relative to the market's target price (if mentioned in the question).
    Use the historical trend and market sentiment to inform your confidence and reasoning.
    Provide your response in JSON format with the following structure:
    {
      "decision": "TRADE" | "NO_TRADE",
      "direction": "UP" | "DOWN" | "NONE",
      "confidence": number (0-100),
      "reasoning": "string",
      "riskLevel": "LOW" | "MEDIUM" | "HIGH"
    }
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const result = JSON.parse(response.text || "{}");
    return {
      decision: result.decision || "NO_TRADE",
      direction: result.direction || "NONE",
      confidence: result.confidence || 0,
      reasoning: result.reasoning || "Failed to generate analysis.",
      riskLevel: result.riskLevel || "MEDIUM"
    };
  } catch (error) {
    console.error("AI Analysis Error:", error);
    return {
      decision: "NO_TRADE",
      direction: "NONE",
      confidence: 0,
      reasoning: "Error occurred during AI analysis.",
      riskLevel: "HIGH"
    };
  }
}
