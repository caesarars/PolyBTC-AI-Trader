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
  totalLiquidityUsdc?: number;
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
  // MACD
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  // Bollinger Bands
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbPosition: "ABOVE_UPPER" | "NEAR_UPPER" | "MIDDLE" | "NEAR_LOWER" | "BELOW_LOWER";
  // Momentum
  momentum5: number;
  // Pre-computed signal alignment score (-6 bullish to +6 bearish, negative = bullish)
  signalScore: number;
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
  reversalProbability?: number;
  oppositePressureProbability?: number;
  reversalReasoning?: string;
}
