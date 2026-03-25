export interface Order {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: Order[];
  asks: Order[];
  hash?: string;
}

export interface Market {
  id: string;
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
}

export interface BTCPrice {
  symbol: string;
  price: string;
}

export interface BTCHistory {
  time: number;
  price: number;
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
  reasoning: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}
