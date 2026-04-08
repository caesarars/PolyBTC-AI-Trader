export type AlphaAsset = "BTC" | "ETH" | "SOL";
export type AlphaDirection = "UP" | "DOWN" | "NONE";
export type DecisionAction =
  | "NO_TRADE"
  | "FILTERED"
  | "QUALIFIED"
  | "EXECUTED"
  | "FAST_PATH_EXECUTED";

export interface AlphaModelSnapshot {
  version: string;
  probability: number | null;
  edge: number | null;
  score: number | null;
  conviction: "LOW" | "MEDIUM" | "HIGH" | null;
  agreement: "ALIGNED" | "MIXED" | "CONFLICT" | "NEUTRAL";
  shouldTrade: boolean;
  reasons: string[];
}

export interface AlphaScoringInput {
  asset: AlphaAsset;
  direction: AlphaDirection;
  confidence: number;
  edge: number;
  entryPrice: number | null;
  imbalanceSignal?: string | null;
  riskLevel?: string | null;
  signalScore?: number | null;
  rsi?: number | null;
  emaCross?: string | null;
  divergenceDirection?: string | null;
  divergenceStrength?: string | null;
  fastLoopDirection?: string | null;
  fastLoopStrength?: string | null;
  fastLoopVw?: number | null;
  windowElapsedSeconds?: number | null;
}

export interface DecisionLogEntry {
  id: string;
  ts: string;
  windowStart: number;
  windowEnd: number;
  asset: AlphaAsset;
  market: string;
  marketId: string;
  eventSlug: string;
  decision: "TRADE" | "NO_TRADE";
  action: DecisionAction;
  direction: AlphaDirection;
  confidence: number;
  edge: number;
  riskLevel: string;
  reasoning: string;
  filterReasons: string[];
  entryPrice: number | null;
  yesPrice: number | null;
  noPrice: number | null;
  estimatedBet: number | null;
  btcPrice: number | null;
  strikePrice: number | null;
  priceToBeatOpen: number | null;
  priceToBeatCurrent: number | null;
  priceToBeatDistance: number | null;
  priceToBeatDirection: "UP" | "DOWN" | "FLAT" | null;
  priceToBeatSource: string | null;
  priceToBeatMode: "proxy" | "chainlink" | null;
  windowElapsedSeconds: number;
  imbalanceSignal: string | null;
  signalScore: number | null;
  rsi: number | null;
  emaCross: string | null;
  divergenceDirection: string | null;
  divergenceStrength: string | null;
  btcDelta30s: number | null;
  yesDelta30s: number | null;
  fastLoopDirection: string | null;
  fastLoopStrength: string | null;
  fastLoopVw: number | null;
  model: AlphaModelSnapshot | null;
  tradeExecuted: boolean;
  tradeAmount: number | null;
  tradePrice: number | null;
  orderId: string | null;
}

export interface ExecutedTradeSample {
  ts: string;
  market: string;
  direction: "UP" | "DOWN";
  confidence: number;
  edge: number;
  entryPrice: number;
  pnl: number;
  result: "WIN" | "LOSS";
  rsi?: number;
  emaCross?: string;
  signalScore?: number;
  imbalanceSignal?: string;
  divergenceDirection?: string;
  divergenceStrength?: string;
  windowElapsedSeconds: number;
}

export interface AlphaCalibrationBucket {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  predictedRate: number | null;
  realizedRate: number | null;
  avgEdge: number | null;
  pnl: number;
}

export interface AlphaMarkoutBucket {
  label: string;
  count: number;
  favorableRate: number | null;
  avgSignedBps: number | null;
  medianSignedBps: number | null;
}

export interface AlphaShadowReplayRow {
  market: string;
  ts: string;
  direction: "UP" | "DOWN";
  result: "WIN" | "LOSS";
  pnl: number;
  confidence: number;
  modelProbability: number | null;
  modelEdge: number | null;
  modelAllowed: boolean;
  reasons: string[];
}

export interface AlphaResearchReport {
  generatedAt: string;
  scope: {
    asset: "BTC";
    decisionCount: number;
    tradeCount: number;
  };
  decisionSummary: {
    total: number;
    byAction: Array<{ label: string; count: number }>;
    byDirection: Array<{ label: string; count: number }>;
    executed: number;
    filtered: number;
    noTrade: number;
  };
  modelSummary: {
    version: string;
    avgProbability: number | null;
    avgModelEdge: number | null;
    avgHeuristicEdge: number | null;
    heuristicBrier: number | null;
    modelBrier: number | null;
  };
  calibration: {
    heuristic: AlphaCalibrationBucket[];
    model: AlphaCalibrationBucket[];
  };
  markouts: {
    horizons: AlphaMarkoutBucket[];
    byAction: Array<{ label: string; favorableRate: number | null; avgSignedBps: number | null; count: number }>;
  };
  modelShadowReplay: {
    baselineTrades: number;
    baselinePnl: number;
    keptTrades: number;
    keptPnl: number;
    blockedTrades: number;
    blockedPnl: number;
    pnlDelta: number;
  };
  recentDecisions: DecisionLogEntry[];
  recentShadow: AlphaShadowReplayRow[];
}
