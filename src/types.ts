export interface Order {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: Order[];
  asks: Order[];
  hash?: string;
  imbalance?: number;
  imbalanceSignal?: "BUY_PRESSURE" | "SELL_PRESSURE" | "NEUTRAL";
}

export interface BTCIndicators {
  rsi: number;
  ema9: number;
  ema21: number;
  emaCross: "BULLISH" | "BEARISH";
  volumeSpike: number;
  trend: "STRONG_UP" | "STRONG_DOWN" | "MIXED";
  last3Candles: { open: number; high: number; low: number; close: number; direction: "UP" | "DOWN" }[];
  currentPrice: number;
}

export interface Market {
  id: string;
  conditionId: string;
  question: string;
  description: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
  endDate: string;
  image: string;
  icon: string;
  category: string;
  volume: string;
  liquidity: string;
  eventSlug: string;
  eventTitle: string;
  eventId: string;
  startDate: string;
  endDate: string;
}

export interface BTCPrice {
  symbol: string;
  price: string;
}

export interface BTCHistory {
  time: number;   // Unix seconds (for lightweight-charts)
  open: number;
  high: number;
  low: number;
  close: number;
  price: number;  // alias for close, backward compat
  volume: number;
}

export interface SentimentData {
  value: number;
  value_classification: string;
  timestamp: string;
}

export interface AIRecommendation {
  decision: "TRADE" | "NO_TRADE";
  direction: "UP" | "DOWN" | "NONE";
  confidence: number;
  estimatedEdge: number;
  candlePatterns: string[];
  reasoning: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  dataMode?: "FULL_DATA" | "POLYMARKET_ONLY";
  astrologyBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  astrologyConfidence?: number;
  astrologyReasoning?: string;
  reversalProbability?: number;
  oppositePressureProbability?: number;
  reversalReasoning?: string;
}
