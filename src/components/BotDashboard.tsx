import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Bot,
  Play,
  Square,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  BarChart3,
  Zap,
  LineChart as LineChartIcon,
  Tag,
  Shield,
  Flame,
  Gauge,
  Bell,
  FlaskConical,
  BarChart2,
  Wifi,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}

interface EntrySnapshot {
  market: string;
  windowStart: number;
  yesPrice: number | null;
  noPrice: number | null;
  direction: string | null;
  confidence: number | null;
  edge: number | null;
  riskLevel: string | null;
  estimatedBet: number | null;
  btcPrice: number | null;
  priceToBeat: {
    windowStart: number;
    openingPrice: number;
    currentPrice: number;
    distanceUsd: number;
    distancePct: number;
    direction: "UP" | "DOWN" | "FLAT";
    favoredOutcome: "UP" | "DOWN";
    tieGoesToUp: true;
    source: string;
    mode: "proxy" | "chainlink";
    updatedAt: string;
  } | null;
  asset?: string; // "BTC"
  divergence: { direction: string; strength: string; btcDelta30s: number; yesDelta30s: number; } | null;
  fastLoopMomentum: { direction: string; strength: string; vw: number; } | null;
  alphaModel: {
    version: string;
    probability: number | null;
    edge: number | null;
    score: number | null;
    conviction: "LOW" | "MEDIUM" | "HIGH" | null;
    agreement: "ALIGNED" | "MIXED" | "CONFLICT" | "NEUTRAL";
    shouldTrade: boolean;
    reasons: string[];
  } | null;
  updatedAt: string;
}

interface ExecutionQuote {
  tokenId: string;
  side: "BUY" | "SELL";
  amount: number;
  amountMode: "SPEND" | "SIZE";
  referencePrice: number | null;
  averagePrice: number | null;
  limitPrice: number | null;
  worstPrice: number | null;
  estimatedCost: number;
  filledSize: number;
  fullyFilled: boolean;
  levelsConsumed: number;
  slippageAbs: number | null;
  slippageBps: number | null;
  source: "depth" | "fallback" | "unavailable";
  updatedAt: string;
}

interface StreamTradeSnapshot {
  tokenId: string;
  price: number;
  size: number;
  side: "BUY" | "SELL" | "UNKNOWN";
  timestamp: number;
}

interface MarketDiscoverySummary {
  asset: string;
  currentSlug: string;
  nextSlug: string;
  currentMarketCount: number;
  nextMarketCount: number;
  activeMarketId: string | null;
  fetchedAt: string | null;
  ageMs: number | null;
  trackedTokenIds: string[];
  prewarmedTokenIds: string[];
}

interface BotInfraStatus {
  marketDiscovery: Record<string, MarketDiscoverySummary>;
  stream: {
    mode: "websocket" | "disabled";
    packageAvailable: boolean;
    connected: boolean;
    watchedTokenIds: string[];
    lastBookAt: string | null;
    lastTradeAt: string | null;
    reconnectCount: number;
    lastError: string | null;
    books: Record<string, {
      tokenId: string;
      bestBid: number | null;
      bestAsk: number | null;
      spread: number | null;
      imbalanceSignal: string;
      updatedAt: string;
      source: "rest" | "ws";
    }>;
    recentTrades: Record<string, StreamTradeSnapshot[]>;
  };
  prewarm: {
    readyTokenIds: string[];
    totalReady: number;
    totalTracked: number;
    lastError: string | null;
  };
  executionQuote: ExecutionQuote | null;
}

interface BotStatus {
  enabled: boolean;
  running: boolean;
  sessionStartBalance: number | null;
  sessionTradesCount: number;
  windowElapsedSeconds: number;
  analyzedThisWindow: number;
  entrySnapshot: EntrySnapshot | null;
  infra?: BotInfraStatus;
  enabledAssets: string[];
  config: {
    minConfidence: number;
    minEdge: number;
    kellyFraction: number;
    maxBetUsdc: number;
    fixedTradeUsdc?: number;
    sessionLossLimit: number;
    scanIntervalMs: number;
  };
}

interface BotLogEntry {
  timestamp: string;
  market: string;
  decision: string;
  direction: string;
  confidence: number;
  edge: number;
  riskLevel: string;
  reasoning: string;
  tradeExecuted: boolean;
  tradeAmount?: number;
  tradePrice?: number;
  orderId?: string | null;
  error?: string;
}

interface LearningState {
  consecutiveLosses: number;
  consecutiveWins: number;
  adaptiveConfidenceBoost: number;
  adaptiveLossPenaltyEnabled: boolean;
  effectiveMinConfidence: number;
  baseMinConfidence: number;
  lossMemoryCount: number;
  winMemoryCount?: number;
}

interface PerformanceSummary {
  totalMatchedTrades: number;
  closedTrades: number;
  winCount: number;
  lossCount: number;
  winRate: string;
  realizedPnl: string;
  openExposure: string;
}

interface OpenPosition {
  assetId: string;
  market: string;
  outcome: string;
  size: string;
  costBasis: string;
  averagePrice: string;
  currentValue?: string;
  cashPnl?: string;
  percentPnl?: string;
  curPrice?: string;
  redeemable?: boolean;
}

interface ClosedPosition {
  assetId: string;
  market: string;
  outcome: string;
  avgPrice: string;
  totalBought: string;
  realizedPnl: string;
  curPrice: string;
  timestamp: number;
  endDate: string;
  eventSlug: string;
}

interface Automation {
  assetId: string;
  market: string;
  outcome: string;
  armed: boolean;
  averagePrice: string;
  takeProfit: string;
  stopLoss: string;
  trailingStop: string;
  lastPrice?: string;
  status?: string;
}

interface TradeLogEntry {
  ts: string;
  market: string;
  direction: "UP" | "DOWN";
  confidence: number;
  edge: number;
  betAmount: number;
  entryPrice: number;
  pnl: number;
  result: "WIN" | "LOSS";
  divergenceDirection?: string;
  divergenceStrength?: string;
  btcDelta30s?: number;
  yesDelta30s?: number;
  windowElapsedSeconds: number;
}

interface TradeLogStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  divergence: {
    trades: number;
    wins: number;
    winRate: number | null;
  };
  entries: TradeLogEntry[];
}

interface FastLoopMomentumSnap {
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
  vw: number;
}

interface MomentumPoint {
  ts: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  strength: "STRONG" | "MODERATE" | "WEAK";
  vw: number;
  raw: number;
  accel: number;
}

interface BacktestData {
  totalWindows: number;
  signaledCount: number;
  correctCount: number;
  winRate: number | null;
  results: Array<{
    ts: number;
    fastMom: FastLoopMomentumSnap | null;
    rsi: number | null;
    emaCross: string | null;
    signalScore: number | null;
    signaled: boolean;
    signalDirection: string | null;
    actualDir: string | null;
    correct: boolean | null;
    entryClose: number;
    exitClose: number | null;
  }>;
}

interface AnalyticsData {
  total: number;
  byHour: Array<{ label: string; hour: number; wins: number; losses: number; total: number; winRate: number | null; pnl: number }>;
  byDivergence: Array<{ label: string; wins: number; losses: number; total: number; winRate: number | null; pnl: number }>;
  byDirection: Array<{ label: string; wins: number; losses: number; total: number; winRate: number | null; pnl: number }>;
}

interface TradeLogReplayData {
  generatedAt: string;
  scope: {
    asset: string;
    totalTrades: number;
    assumptions: string[];
  };
  config: {
    minConfidence: number;
    minEdge: number;
  };
  baseline: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnl: number;
  };
  replay: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnl: number;
    blockedTrades: number;
    blockedPnl: number;
    pnlDelta: number;
  };
  blockedByReason: Array<{
    reason: string;
    trades: number;
    wins: number;
    losses: number;
    totalPnl: number;
  }>;
  entries: Array<{
    ts: string;
    market: string;
    direction: "UP" | "DOWN";
    confidence: number;
    edge: number;
    entryPrice: number;
    pnl: number;
    result: "WIN" | "LOSS";
    replayAllowed: boolean;
    replayReasons: string[];
  }>;
}

interface BtcCutoffData {
  generatedAt: string;
  total: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    totalPnl: number;
  };
  byDirection: Array<{ label: string; trades: number; wins: number; losses: number; winRate: number | null; pnl: number }>;
  byConfidence: Array<{ label: string; trades: number; wins: number; losses: number; winRate: number | null; pnl: number }>;
  byEntryPrice: Array<{ label: string; trades: number; wins: number; losses: number; winRate: number | null; pnl: number }>;
  matrix: Array<{
    label: string;
    direction: string;
    confidenceBucket: string;
    entryPriceBucket: string;
    edgeBucket: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    pnl: number;
  }>;
  bestBuckets: Array<{
    label: string;
    direction: string;
    confidenceBucket: string;
    entryPriceBucket: string;
    edgeBucket: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    pnl: number;
  }>;
  worstBuckets: Array<{
    label: string;
    direction: string;
    confidenceBucket: string;
    entryPriceBucket: string;
    edgeBucket: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    pnl: number;
  }>;
}

interface AlphaResearchData {
  generatedAt: string;
  scope: {
    asset: string;
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
    heuristic: Array<{ label: string; trades: number; wins: number; losses: number; predictedRate: number | null; realizedRate: number | null; avgEdge: number | null; pnl: number }>;
    model: Array<{ label: string; trades: number; wins: number; losses: number; predictedRate: number | null; realizedRate: number | null; avgEdge: number | null; pnl: number }>;
  };
  markouts: {
    horizons: Array<{ label: string; count: number; favorableRate: number | null; avgSignedBps: number | null; medianSignedBps: number | null }>;
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
  recentDecisions: Array<{
    id: string;
    ts: string;
    action: string;
    direction: string;
    decision: string;
    confidence: number;
    edge: number;
    entryPrice: number | null;
    filterReasons: string[];
    tradeExecuted: boolean;
    model: EntrySnapshot["alphaModel"];
    market: string;
  }>;
  recentShadow: Array<{
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
  }>;
}

interface PingProbe {
  key: string;
  label: string;
  target: string;
  latencyMs: number | null;
  ok: boolean;
  status: number | null;
  error?: string;
  grade: "excellent" | "good" | "usable" | "slow" | "down";
}

interface PingState {
  testedAt: string;
  note: string;
  summary: {
    fastestMs: number | null;
    slowestMs: number | null;
    averageMs: number | null;
    grade: "excellent" | "good" | "usable" | "slow" | "down";
    criticalReady: boolean;
  };
  upstreams: PingProbe[];
  browserRttMs?: number;
}

export default function BotDashboard() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [log, setLog] = useState<BotLogEntry[]>([]);
  const [performance, setPerformance] = useState<{ summary: PerformanceSummary; openPositions: OpenPosition[]; closedPositions: ClosedPosition[] } | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [balance, setBalance] = useState<string>("—");
  const [controlLoading, setControlLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetConfLoading, setResetConfLoading] = useState(false);
  const [modeLoading, setModeLoading] = useState(false);
  const [tradeLog, setTradeLog] = useState<TradeLogStats | null>(null);
  const [sessionTradeLog, setSessionTradeLog] = useState<TradeLogStats | null>(null);
  const [pnlPeriod, setPnlPeriod] = useState<"7d" | "1d">("7d");
  const [confInput, setConfInput] = useState<string>("");
  const [edgeInput, setEdgeInput] = useState<string>("");
  const [fixedTradeInput, setFixedTradeInput] = useState<string>("");
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [momentumHistory, setMomentumHistory] = useState<MomentumPoint[]>([]);
  const [notifStatus, setNotifStatus] = useState<{ telegram: boolean; discord: boolean } | null>(null);
  const [backtestData, setBacktestData] = useState<BacktestData | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [tradeLogReplay, setTradeLogReplay] = useState<TradeLogReplayData | null>(null);
  const [btcCutoffData, setBtcCutoffData] = useState<BtcCutoffData | null>(null);
  const [alphaResearch, setAlphaResearch] = useState<AlphaResearchData | null>(null);
  const [activeTab, setActiveTab] = useState<"dashboard" | "backtest" | "analytics">("dashboard");
  const [calibration, setCalibration] = useState<{ enabled: boolean; state: any | null }>({ enabled: false, state: null });
  const [calibTogglingLoading, setCalibTogglingLoading] = useState(false);
  const [learning, setLearning] = useState<LearningState | null>(null);
  const [lossPenaltySaving, setLossPenaltySaving] = useState(false);
  const [ping, setPing] = useState<PingState | null>(null);
  const [pinging, setPinging] = useState(false);
  const tradeBellRef = useRef<HTMLAudioElement | null>(null);
  const seenTradeBellKeysRef = useRef<Set<string>>(new Set());
  const tradeBellPrimedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    try {
      await fetch("/api/polymarket/discovery").catch(() => null);
      const [statusRes, logRes, perfRes, autoRes, balRes, tradeLogRes, sessionTradeLogRes, momRes, notifRes, analyticsRes, replayRes, btcCutoffRes, alphaResearchRes, calibRes, learningRes] = await Promise.allSettled([
        fetch("/api/bot/status").then((r) => r.json()),
        fetch("/api/bot/log").then((r) => r.json()),
        fetch("/api/polymarket/performance").then((r) => r.json()),
        fetch("/api/polymarket/automation").then((r) => r.json()),
        fetch("/api/polymarket/balance").then((r) => r.json()),
        fetch("/api/bot/trade-log?limit=50").then((r) => r.json()),
        fetch("/api/bot/trade-log?days=7&limit=1000").then((r) => r.json()),
        fetch("/api/bot/momentum-history").then((r) => r.json()),
        fetch("/api/notifications/status").then((r) => r.json()),
        fetch("/api/analytics").then((r) => r.json()),
        fetch("/api/backtest/trade-log-replay").then((r) => r.json()),
        fetch("/api/analytics/btc-cutoffs").then((r) => r.json()),
        fetch("/api/alpha/research").then((r) => r.json()),
        fetch("/api/bot/calibration").then((r) => r.json()),
        fetch("/api/bot/learning").then((r) => r.json()),
      ]);

      if (statusRes.status === "fulfilled") {
        const s = statusRes.value as BotStatus;
        setStatus(s);
      }
      if (logRes.status === "fulfilled") setLog((logRes.value as any).log || []);
      if (perfRes.status === "fulfilled" && !(perfRes.value as any).error) {
        setPerformance(perfRes.value as any);
      }
      if (autoRes.status === "fulfilled") setAutomations((autoRes.value as any).automations || []);
      if (tradeLogRes.status === "fulfilled") setTradeLog(tradeLogRes.value as TradeLogStats);
      if (sessionTradeLogRes.status === "fulfilled") setSessionTradeLog(sessionTradeLogRes.value as TradeLogStats);
      if (balRes.status === "fulfilled" && !(balRes.value as any).error) {
        setBalance((balRes.value as any).balance || "—");
      }
      if (momRes.status === "fulfilled") setMomentumHistory((momRes.value as any).history || []);
      if (notifRes.status === "fulfilled") setNotifStatus(notifRes.value as any);
      if (analyticsRes.status === "fulfilled" && !(analyticsRes.value as any).error) {
        setAnalyticsData(analyticsRes.value as AnalyticsData);
      }
      if (replayRes.status === "fulfilled" && !(replayRes.value as any).error) {
        setTradeLogReplay(replayRes.value as TradeLogReplayData);
      }
      if (btcCutoffRes.status === "fulfilled" && !(btcCutoffRes.value as any).error) {
        setBtcCutoffData(btcCutoffRes.value as BtcCutoffData);
      }
      if (alphaResearchRes.status === "fulfilled" && !(alphaResearchRes.value as any).error) {
        setAlphaResearch(alphaResearchRes.value as AlphaResearchData);
      }
      if (calibRes.status === "fulfilled") setCalibration(calibRes.value as any);
      if (learningRes.status === "fulfilled") setLearning(learningRes.value as LearningState);
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();

    const es = new EventSource("/api/bot/events");
    es.addEventListener("cycle", () => fetchAll());
    es.addEventListener("infra", ((event: MessageEvent<string>) => {
      try {
        const infra = JSON.parse(event.data) as BotInfraStatus;
        setStatus((prev) => (prev ? { ...prev, infra } : prev));
      } catch {}
    }) as EventListener);
    // Reconnect silently on error — browser retries EventSource automatically
    return () => es.close();
  }, [fetchAll]);

  useEffect(() => {
    const audio = new Audio("/sounds/winner-ding-bell.mp3");
    audio.preload = "auto";
    tradeBellRef.current = audio;
    return () => {
      tradeBellRef.current = null;
    };
  }, []);

  useEffect(() => {
    const executedEntries = log.filter((entry) => entry.tradeExecuted && (entry.orderId || entry.timestamp));
    if (executedEntries.length === 0) return;

    const entryKeys = executedEntries.map(
      (entry) => entry.orderId || `${entry.timestamp}-${entry.market}`
    );

    if (!tradeBellPrimedRef.current) {
      tradeBellPrimedRef.current = true;
      entryKeys.forEach((key) => seenTradeBellKeysRef.current.add(key));
      return;
    }

    const newTradeKeys = entryKeys.filter((key) => !seenTradeBellKeysRef.current.has(key));
    if (newTradeKeys.length === 0) return;

    newTradeKeys.forEach((key) => seenTradeBellKeysRef.current.add(key));

    const audio = tradeBellRef.current;
    const src = audio?.src || "/sounds/winner-ding-bell.mp3";
    newTradeKeys.forEach((_, index) => {
      window.setTimeout(() => {
        const bell = new Audio(src);
        bell.currentTime = 0;
        void bell.play().catch(() => {
          // Browser may block autoplay until the user has interacted with the page.
        });
      }, index * 250);
    });
  }, [log]);

  const handleResetConfidence = async () => {
    setResetConfLoading(true);
    try {
      await fetch("/api/bot/reset-confidence", { method: "POST" });
      await fetchAll();
    } finally {
      setResetConfLoading(false);
    }
  };

  const handleToggleLossPenalty = async () => {
    if (!learning) return;
    setLossPenaltySaving(true);
    try {
      await fetch("/api/bot/learning/loss-penalty", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !learning.adaptiveLossPenaltyEnabled }),
      });
      await fetchAll();
    } finally {
      setLossPenaltySaving(false);
    }
  };

  const handleSaveConfig = async () => {
    const conf = confInput !== "" ? Number(confInput) : null;
    const edge = edgeInput !== "" ? Number(edgeInput) : null;
    const fixedTradeUsdc = fixedTradeInput !== "" ? Number(fixedTradeInput) : null;
    const maxFixedTradeUsdc = status?.config.maxBetUsdc ?? 250;
    if (conf !== null && (isNaN(conf) || conf < 50 || conf > 99)) return;
    if (edge !== null && (isNaN(edge) || edge < 0.01 || edge > 0.50)) return;
    if (fixedTradeUsdc !== null && (isNaN(fixedTradeUsdc) || fixedTradeUsdc < 0.1 || fixedTradeUsdc > maxFixedTradeUsdc)) return;
    setConfigSaving(true);
    try {
      await fetch("/api/bot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conf !== null && { minConfidence: conf }),
          ...(edge !== null && { minEdge: edge }),
          ...(fixedTradeUsdc !== null && { fixedTradeUsdc }),
        }),
      });
      setFixedTradeInput("");
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
      await fetchAll();
    } finally {
      setConfigSaving(false);
    }
  };

  const handleControl = async (enable: boolean) => {
    setControlLoading(true);
    try {
      await fetch("/api/bot/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enable }),
      });
      await fetchAll();
    } finally {
      setControlLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  const handleRunBacktest = async () => {
    setBacktestLoading(true);
    try {
      const res = await fetch("/api/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      setBacktestData(data);
    } catch {}
    setBacktestLoading(false);
  };

  const handleToggleCalibrator = async () => {
    setCalibTogglingLoading(true);
    try {
      const res = await fetch("/api/bot/calibration/toggle", { method: "POST" });
      const data = await res.json();
      setCalibration(prev => ({ ...prev, enabled: data.enabled }));
      await fetchAll(); // refresh calibration state
    } catch {}
    setCalibTogglingLoading(false);
  };

  const handlePingTest = async () => {
    setPinging(true);
    try {
      const startedAt = Date.now();
      const res = await fetch("/api/bot/ping");
      const data = await res.json() as PingState;
      const browserRttMs = Date.now() - startedAt;
      setPing({ ...data, browserRttMs });
    } finally {
      setPinging(false);
    }
  };

  const pnl = performance ? parseFloat(performance.summary.realizedPnl) : 0;
  const pnlPositive = pnl > 0;
  const winCount = performance?.summary.winCount ?? 0;
  const lossCount = performance?.summary.lossCount ?? 0;
  const winRate = performance?.summary.winRate ?? "0.00";
  const openExposure = performance ? parseFloat(performance.summary.openExposure) : 0;

  const windowSeconds = status?.windowElapsedSeconds ?? 0;
  const windowRemaining = 300 - windowSeconds;
  const windowColor = windowRemaining <= 30 ? "text-red-400" : windowRemaining <= 60 ? "text-yellow-400" : "text-green-400";
  const entryZone = windowSeconds >= 30 && windowSeconds <= 270;

  const sessionPnl =
    status?.sessionStartBalance != null
      ? parseFloat(balance) - status.sessionStartBalance
      : null;

  const armedCount = automations.filter((a) => a.armed).length;
  const parsedFixedTradeInput = fixedTradeInput !== "" ? Number(fixedTradeInput) : null;
  const fixedTradePreview = parsedFixedTradeInput != null && Number.isFinite(parsedFixedTradeInput)
    ? parsedFixedTradeInput
    : (status?.config.fixedTradeUsdc ?? 1);

  // Build cumulative PnL series from WIN/LOSS log entries
  const todayStats = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const entries = (sessionTradeLog?.entries ?? []).filter(
      (e) => new Date(e.ts) >= todayStart
    );
    const wins = entries.filter((e) => e.pnl > 0).length;
    const losses = entries.filter((e) => e.pnl < 0).length;
    const pnl = parseFloat(entries.reduce((s, e) => s + e.pnl, 0).toFixed(2));
    return { entries, wins, losses, pnl, total: entries.length };
  }, [sessionTradeLog]);

  const pnlHistory = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const allEntries = [...(sessionTradeLog?.entries ?? [])]
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    const results = pnlPeriod === "1d"
      ? allEntries.filter((e) => new Date(e.ts) >= todayStart)
      : allEntries;

    let cumulative = 0;
    return results.map((entry, i) => {
      const tradePnl = parseFloat(entry.pnl.toFixed(2));
      cumulative = parseFloat((cumulative + tradePnl).toFixed(2));
      return {
        label: `#${i + 1}`,
        time: new Date(entry.ts).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        trade: tradePnl,
        cumulative,
        decision: entry.result,
      };
    });
  }, [sessionTradeLog, pnlPeriod]);

  const lastCumulative = pnlHistory.length > 0 ? pnlHistory[pnlHistory.length - 1].cumulative : 0;
  const infra = status?.infra ?? null;
  const btcDiscovery = infra?.marketDiscovery?.BTC ?? null;
  const streamBooks = infra ? Object.values(infra.stream.books) : [];
  const streamRecentTrades = infra ? Object.values(infra.stream.recentTrades).flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, 4) : [];

  const formatAge = (iso: string | null | undefined, fallbackMs?: number | null) => {
    const diffMs = iso ? Date.now() - new Date(iso).getTime() : fallbackMs ?? null;
    if (diffMs == null || !Number.isFinite(diffMs)) return "—";
    if (diffMs < 1_000) return `${Math.max(0, Math.round(diffMs))}ms ago`;
    if (diffMs < 60_000) return `${Math.round(diffMs / 1_000)}s ago`;
    return `${Math.round(diffMs / 60_000)}m ago`;
  };

  return (
    <div className="space-y-6">
      {/* ── Header Row ── */}
      <div className="flex flex-wrap gap-4 items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-400" />
            Bot Control Center
          </h2>
          <p className="text-zinc-500 text-sm mt-0.5">Automated 5-minute BTC market trading engine</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePingTest}
            disabled={pinging}
            title="Test latency to Polymarket, Binance, Coinbase"
            className={cn(
              "glass-card flex items-center gap-1.5 px-3 py-2 text-xs font-bold transition-all",
              pinging ? "text-cyan-400" : "text-zinc-400 hover:text-white"
            )}
          >
            <Wifi className={cn("w-4 h-4", pinging && "animate-pulse")} />
            {pinging ? "Testing…" : "Test Ping"}
          </button>
          <button
            onClick={handleRefresh}
            className="glass-card p-2 text-zinc-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* ── Tab Navigation ── */}
      <div className="flex gap-1 border-b border-zinc-800 pb-0">
        {(["dashboard", "backtest", "analytics"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-t-lg transition-colors",
              activeTab === tab
                ? "bg-zinc-800 text-white border border-b-zinc-800 border-zinc-700"
                : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            {tab === "dashboard" && <><BarChart3 className="w-3 h-3 inline mr-1" />Dashboard</>}
            {tab === "backtest" && <><FlaskConical className="w-3 h-3 inline mr-1" />Backtest</>}
            {tab === "analytics" && <><BarChart2 className="w-3 h-3 inline mr-1" />Analytics</>}
          </button>
        ))}
      </div>

      {/* ── BACKTEST TAB ── */}
      {activeTab === "backtest" && (
        <div className="space-y-4">
          <div className="glass-card p-4">
            <div className="flex items-center justify-between mb-4 gap-3">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-amber-400" />
                  Trade Log Replay
                </h3>
                <p className="text-[10px] text-zinc-600 mt-0.5">
                  Replay current BTC rules against executed trades persisted in `trade_log.jsonl`
                </p>
              </div>
              {tradeLogReplay && (
                <span className="text-[10px] text-zinc-600">
                  {tradeLogReplay.scope.totalTrades} BTC trades
                </span>
              )}
            </div>

            {!tradeLogReplay ? (
              <div className="text-xs text-zinc-600">Replay report belum tersedia.</div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    {
                      label: "Baseline PnL",
                      value: `${tradeLogReplay.baseline.totalPnl >= 0 ? "+" : ""}$${tradeLogReplay.baseline.totalPnl.toFixed(2)}`,
                      sub: `${tradeLogReplay.baseline.wins}W / ${tradeLogReplay.baseline.losses}L`,
                      color: tradeLogReplay.baseline.totalPnl >= 0 ? "text-green-400" : "text-red-400",
                    },
                    {
                      label: "Replay PnL",
                      value: `${tradeLogReplay.replay.totalPnl >= 0 ? "+" : ""}$${tradeLogReplay.replay.totalPnl.toFixed(2)}`,
                      sub: `${tradeLogReplay.replay.wins}W / ${tradeLogReplay.replay.losses}L`,
                      color: tradeLogReplay.replay.totalPnl >= 0 ? "text-green-400" : "text-red-400",
                    },
                    {
                      label: "Blocked Trades",
                      value: String(tradeLogReplay.replay.blockedTrades),
                      sub: `${tradeLogReplay.replay.blockedPnl >= 0 ? "+" : ""}$${tradeLogReplay.replay.blockedPnl.toFixed(2)} filtered`,
                      color: "text-amber-400",
                    },
                    {
                      label: "PnL Delta",
                      value: `${tradeLogReplay.replay.pnlDelta >= 0 ? "+" : ""}$${tradeLogReplay.replay.pnlDelta.toFixed(2)}`,
                      sub: `conf >= ${tradeLogReplay.config.minConfidence}% | edge >= ${(tradeLogReplay.config.minEdge * 100).toFixed(0)}c`,
                      color: tradeLogReplay.replay.pnlDelta >= 0 ? "text-green-400" : "text-red-400",
                    },
                  ].map(({ label, value, sub, color }) => (
                    <div key={label} className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
                      <div className={cn("text-xl font-mono font-bold", color)}>{value}</div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">Blocked By Reason</div>
                    <div className="space-y-2">
                      {tradeLogReplay.blockedByReason.slice(0, 6).map((reason) => (
                        <div key={reason.reason} className="flex items-center justify-between gap-3 text-xs">
                          <span className="text-zinc-300">{reason.reason}</span>
                          <span className="font-mono text-zinc-500 shrink-0">
                            {reason.trades} tr · {reason.totalPnl >= 0 ? "+" : ""}${reason.totalPnl.toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">Replay Assumptions</div>
                    <div className="space-y-1.5">
                      {tradeLogReplay.scope.assumptions.map((assumption) => (
                        <div key={assumption} className="text-xs text-zinc-400">
                          {assumption}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="glass-card p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-purple-400" />
                Fast Loop Backtester
                <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">
                  Simulate momentum signals on historical candles — no AI needed
                </span>
              </h3>
              <button
                type="button"
                onClick={handleRunBacktest}
                disabled={backtestLoading}
                className="px-4 py-2 rounded-lg text-xs font-bold bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-40 transition-colors"
              >
                {backtestLoading ? "Running…" : "Run Backtest"}
              </button>
            </div>
            {!backtestData ? (
              <div className="text-center py-8 text-zinc-600 text-xs">
                Click "Run Backtest" to simulate FastLoop momentum signals on the last ~40 historical windows
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: "Total Windows", value: String(backtestData.totalWindows), sub: "simulated", color: "text-white" },
                    { label: "Signals Fired", value: String(backtestData.signaledCount), sub: `${backtestData.totalWindows > 0 ? ((backtestData.signaledCount / backtestData.totalWindows) * 100).toFixed(0) : 0}% of windows`, color: "text-cyan-400" },
                    { label: "Correct", value: String(backtestData.correctCount), sub: `${backtestData.signaledCount - backtestData.correctCount} wrong`, color: "text-green-400" },
                    { label: "Signal Win Rate", value: backtestData.winRate != null ? `${backtestData.winRate}%` : "—", sub: "FastLoop only (no AI)", color: backtestData.winRate != null ? backtestData.winRate >= 55 ? "text-green-400" : backtestData.winRate >= 45 ? "text-yellow-400" : "text-red-400" : "text-zinc-500" },
                  ].map(({ label, value, sub, color }) => (
                    <div key={label} className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
                      <div className={cn("text-xl font-mono font-bold", color)}>{value}</div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                        <th className="pb-2 pr-3">Time</th>
                        <th className="pb-2 pr-3">FastLoop</th>
                        <th className="pb-2 pr-3">VW%</th>
                        <th className="pb-2 pr-3">RSI</th>
                        <th className="pb-2 pr-3">EMA</th>
                        <th className="pb-2 pr-3">Signal</th>
                        <th className="pb-2 pr-3">Actual</th>
                        <th className="pb-2">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...backtestData.results].reverse().map((r, i) => (
                        <tr key={i} className="border-b border-zinc-800/40 hover:bg-zinc-800/30">
                          <td className="py-1.5 pr-3 font-mono text-zinc-500 text-[10px]">
                            {new Date(r.ts * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </td>
                          <td className="py-1.5 pr-3">
                            <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold",
                              r.fastMom?.strength === "STRONG" ? "bg-orange-500/20 text-orange-300" :
                              r.fastMom?.strength === "MODERATE" ? "bg-yellow-500/20 text-yellow-300" :
                              "bg-zinc-700 text-zinc-500"
                            )}>
                              {r.fastMom?.direction ?? "—"} {r.fastMom?.strength ?? ""}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-zinc-400 text-[10px]">
                            {r.fastMom ? `${r.fastMom.vw >= 0 ? "+" : ""}${r.fastMom.vw.toFixed(3)}%` : "—"}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-zinc-400 text-[10px]">
                            {r.rsi != null ? r.rsi.toFixed(0) : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-[10px]">
                            <span className={cn("font-bold", r.emaCross === "BULLISH" ? "text-green-400" : r.emaCross === "BEARISH" ? "text-red-400" : "text-zinc-500")}>
                              {r.emaCross ?? "—"}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-[10px]">
                            {r.signaled ? (
                              <span className={cn("font-bold", r.signalDirection === "UP" ? "text-green-400" : "text-red-400")}>
                                {r.signalDirection === "UP" ? "▲" : "▼"} {r.signalDirection}
                              </span>
                            ) : <span className="text-zinc-600">–</span>}
                          </td>
                          <td className="py-1.5 pr-3 text-[10px]">
                            <span className={cn("font-bold", r.actualDir === "UP" ? "text-green-400" : r.actualDir === "DOWN" ? "text-red-400" : "text-zinc-500")}>
                              {r.actualDir ?? "—"}
                            </span>
                          </td>
                          <td className="py-1.5 text-[10px] font-bold">
                            {r.signaled
                              ? r.correct === true ? <span className="text-green-400">✓ WIN</span>
                              : r.correct === false ? <span className="text-red-400">✗ LOSS</span>
                              : <span className="text-zinc-500">?</span>
                              : <span className="text-zinc-700">skip</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ANALYTICS TAB ── */}
      {activeTab === "analytics" && (
        <div className="space-y-4">
          {!analyticsData || analyticsData.total === 0 ? (
            <div className="glass-card p-8 text-center text-zinc-600 text-sm">
              No trades in log yet. Analytics appear after your first executed trade.
            </div>
          ) : (
            <>
              {alphaResearch && (
                <div className="glass-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <div>
                      <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                        <FlaskConical className="w-4 h-4 text-cyan-400" />
                        Alpha Research
                      </h3>
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        Decision log dataset, calibration, BTC markout, dan shadow replay model scorer
                      </p>
                    </div>
                    <span className="text-[10px] text-zinc-600">
                      {alphaResearch.scope.decisionCount} decisions · {alphaResearch.scope.tradeCount} resolved BTC trades
                    </span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    {[
                      {
                        label: "Decision Log",
                        value: String(alphaResearch.decisionSummary.total),
                        sub: `${alphaResearch.decisionSummary.executed} executed`,
                        color: "text-cyan-400",
                      },
                      {
                        label: "Model Brier",
                        value: alphaResearch.modelSummary.modelBrier != null ? alphaResearch.modelSummary.modelBrier.toFixed(4) : "—",
                        sub: `heuristic ${alphaResearch.modelSummary.heuristicBrier != null ? alphaResearch.modelSummary.heuristicBrier.toFixed(4) : "—"}`,
                        color: "text-amber-400",
                      },
                      {
                        label: "Avg Model Prob",
                        value: alphaResearch.modelSummary.avgProbability != null ? `${alphaResearch.modelSummary.avgProbability.toFixed(1)}%` : "—",
                        sub: `edge ${alphaResearch.modelSummary.avgModelEdge != null ? `${(alphaResearch.modelSummary.avgModelEdge * 100).toFixed(1)}c` : "—"}`,
                        color: "text-green-400",
                      },
                      {
                        label: "Shadow Delta",
                        value: `${alphaResearch.modelShadowReplay.pnlDelta >= 0 ? "+" : ""}$${alphaResearch.modelShadowReplay.pnlDelta.toFixed(2)}`,
                        sub: `${alphaResearch.modelShadowReplay.keptTrades}/${alphaResearch.modelShadowReplay.baselineTrades} kept`,
                        color: alphaResearch.modelShadowReplay.pnlDelta >= 0 ? "text-green-400" : "text-red-400",
                      },
                    ].map(({ label, value, sub, color }) => (
                      <div key={label} className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
                        <div className={cn("text-xl font-mono font-bold", color)}>{value}</div>
                        <div className="text-[10px] text-zinc-600 mt-1">{sub}</div>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-3">Calibration</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="text-[10px] text-zinc-500 uppercase mb-2">Heuristic</div>
                          <div className="space-y-2">
                            {alphaResearch.calibration.heuristic.slice(0, 5).map((row) => (
                              <div key={`heur-${row.label}`} className="flex items-center justify-between text-xs">
                                <span className="text-zinc-300">{row.label}</span>
                                <span className="font-mono text-zinc-500">
                                  {row.realizedRate != null ? `${row.realizedRate}%` : "—"} vs {row.predictedRate != null ? `${row.predictedRate}%` : "—"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-500 uppercase mb-2">Model</div>
                          <div className="space-y-2">
                            {alphaResearch.calibration.model.slice(0, 5).map((row) => (
                              <div key={`model-${row.label}`} className="flex items-center justify-between text-xs">
                                <span className="text-zinc-300">{row.label}</span>
                                <span className="font-mono text-zinc-500">
                                  {row.realizedRate != null ? `${row.realizedRate}%` : "—"} vs {row.predictedRate != null ? `${row.predictedRate}%` : "—"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-3">BTC Markout</div>
                      <div className="space-y-2 mb-3">
                        {alphaResearch.markouts.horizons.map((row) => (
                          <div key={row.label} className="flex items-center justify-between text-xs">
                            <span className="text-zinc-300">{row.label}</span>
                            <span className="font-mono text-zinc-500">
                              {row.avgSignedBps != null ? `${row.avgSignedBps >= 0 ? "+" : ""}${row.avgSignedBps.toFixed(1)} bps` : "—"}
                              {" · "}
                              {row.favorableRate != null ? `${row.favorableRate}% fav` : "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">Decision Mix</div>
                      <div className="flex flex-wrap gap-2">
                        {alphaResearch.decisionSummary.byAction.map((row) => (
                          <span key={row.label} className="px-2 py-0.5 rounded-full border border-zinc-700 text-[10px] font-mono text-zinc-400">
                            {row.label}: {row.count}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Recent Decisions</div>
                        <div className="text-[10px] text-zinc-600">new dataset</div>
                      </div>
                      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                        {alphaResearch.recentDecisions.length === 0 ? (
                          <div className="text-xs text-zinc-600">Decision log belum ada data baru.</div>
                        ) : alphaResearch.recentDecisions.map((entry) => (
                          <div key={entry.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                            <div className="flex items-center justify-between gap-2 text-[10px] mb-1">
                              <span className="text-zinc-500">{new Date(entry.ts).toLocaleTimeString()}</span>
                              <span className={cn(
                                "font-bold",
                                entry.tradeExecuted ? "text-green-400" : entry.action === "FILTERED" ? "text-yellow-400" : "text-zinc-500"
                              )}>
                                {entry.action}
                              </span>
                            </div>
                            <div className="text-xs text-zinc-200 truncate">{entry.market}</div>
                            <div className="flex flex-wrap gap-2 mt-2 text-[10px]">
                              <span className="text-zinc-500">{entry.direction}</span>
                              <span className="text-zinc-500">conf {entry.confidence}%</span>
                              {entry.entryPrice !== null && <span className="text-zinc-500">entry {(entry.entryPrice * 100).toFixed(1)}c</span>}
                              {entry.model?.probability != null && <span className="text-cyan-400">alpha {(entry.model.probability * 100).toFixed(1)}%</span>}
                            </div>
                            {entry.filterReasons[0] && (
                              <div className="text-[10px] text-zinc-600 mt-1 truncate">{entry.filterReasons[0]}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Model Shadow Replay</div>
                        <div className={cn(
                          "text-xs font-mono font-bold",
                          alphaResearch.modelShadowReplay.keptPnl >= 0 ? "text-green-400" : "text-red-400"
                        )}>
                          {alphaResearch.modelShadowReplay.keptPnl >= 0 ? "+" : ""}${alphaResearch.modelShadowReplay.keptPnl.toFixed(2)}
                        </div>
                      </div>
                      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                        {alphaResearch.recentShadow.map((row) => (
                          <div key={`${row.ts}-${row.market}`} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                            <div className="flex items-center justify-between gap-2 text-[10px] mb-1">
                              <span className="text-zinc-500">{new Date(row.ts).toLocaleString()}</span>
                              <span className={cn("font-bold", row.modelAllowed ? "text-green-400" : "text-red-400")}>
                                {row.modelAllowed ? "KEEP" : "BLOCK"}
                              </span>
                            </div>
                            <div className="text-xs text-zinc-200 truncate">{row.market}</div>
                            <div className="flex flex-wrap gap-2 mt-2 text-[10px] font-mono">
                              <span className={row.result === "WIN" ? "text-green-400" : "text-red-400"}>{row.result}</span>
                              <span className="text-zinc-500">{row.direction}</span>
                              <span className="text-zinc-500">conf {row.confidence}%</span>
                              {row.modelProbability !== null && <span className="text-cyan-400">{(row.modelProbability * 100).toFixed(1)}%</span>}
                              {row.modelEdge !== null && <span className="text-zinc-500">{(row.modelEdge * 100).toFixed(1)}c</span>}
                              <span className={row.pnl >= 0 ? "text-green-400" : "text-red-400"}>
                                {row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}
                              </span>
                            </div>
                            {row.reasons[0] && (
                              <div className="text-[10px] text-zinc-600 mt-1 truncate">{row.reasons[0]}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {btcCutoffData && (
                <div className="glass-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <div>
                      <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                        <Shield className="w-4 h-4 text-amber-400" />
                        BTC Cutoff Matrix
                      </h3>
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        BTC-only report by direction, confidence, entry price, and normalized edge
                      </p>
                    </div>
                    <span className={cn(
                      "text-sm font-mono font-bold",
                      btcCutoffData.total.totalPnl >= 0 ? "text-green-400" : "text-red-400"
                    )}>
                      {btcCutoffData.total.totalPnl >= 0 ? "+" : ""}${btcCutoffData.total.totalPnl.toFixed(2)}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">By Confidence</div>
                      <div className="space-y-2">
                        {btcCutoffData.byConfidence.map((row) => (
                          <div key={row.label} className="flex items-center justify-between text-xs">
                            <span className="text-zinc-300">{row.label}</span>
                            <span className="font-mono text-zinc-500">
                              {row.trades} tr · {row.winRate != null ? `${row.winRate}%` : "—"} · {row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">By Entry Price</div>
                      <div className="space-y-2">
                        {btcCutoffData.byEntryPrice.map((row) => (
                          <div key={row.label} className="flex items-center justify-between text-xs">
                            <span className="text-zinc-300">{row.label}</span>
                            <span className="font-mono text-zinc-500">
                              {row.trades} tr · {row.winRate != null ? `${row.winRate}%` : "—"} · {row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-2">Best vs Worst Buckets</div>
                      <div className="space-y-2">
                        {[
                          btcCutoffData.bestBuckets[0],
                          btcCutoffData.worstBuckets[0],
                        ].filter(Boolean).map((row, idx) => (
                          <div key={`${row.label}-${idx}`} className="text-xs">
                            <div className={cn("font-semibold", idx === 0 ? "text-green-400" : "text-red-400")}>
                              {idx === 0 ? "Best" : "Worst"}: {row.direction} | {row.confidenceBucket} | {row.entryPriceBucket} | {row.edgeBucket}
                            </div>
                            <div className="text-zinc-500 font-mono">
                              {row.trades} tr · {row.winRate != null ? `${row.winRate}%` : "—"} · {row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                          <th className="pb-2 pr-3">Direction</th>
                          <th className="pb-2 pr-3">Conf</th>
                          <th className="pb-2 pr-3">Entry</th>
                          <th className="pb-2 pr-3">Edge</th>
                          <th className="pb-2 pr-3">Trades</th>
                          <th className="pb-2 pr-3">WR</th>
                          <th className="pb-2">PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {btcCutoffData.matrix
                          .slice()
                          .sort((a, b) => b.pnl - a.pnl)
                          .slice(0, 12)
                          .map((row) => (
                            <tr key={row.label} className="border-b border-zinc-800/40 hover:bg-zinc-800/30">
                              <td className={cn("py-1.5 pr-3 font-bold", row.direction === "UP" ? "text-green-400" : "text-red-400")}>{row.direction}</td>
                              <td className="py-1.5 pr-3 text-zinc-300">{row.confidenceBucket}</td>
                              <td className="py-1.5 pr-3 text-zinc-300">{row.entryPriceBucket}</td>
                              <td className="py-1.5 pr-3 text-zinc-300">{row.edgeBucket}</td>
                              <td className="py-1.5 pr-3 font-mono text-zinc-500">{row.trades}</td>
                              <td className="py-1.5 pr-3 font-mono text-zinc-400">{row.winRate != null ? `${row.winRate}%` : "—"}</td>
                              <td className={cn("py-1.5 font-mono font-bold", row.pnl >= 0 ? "text-green-400" : "text-red-400")}>
                                {row.pnl >= 0 ? "+" : ""}${row.pnl.toFixed(2)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="glass-card p-4">
                <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-blue-400" />
                  Win Rate by Hour (UTC)
                  <span className="text-xs font-normal text-zinc-600 ml-1">{analyticsData.total} total trades</span>
                </h3>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={analyticsData.byHour} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: "#52525b", fontSize: 9, fontFamily: "monospace" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#52525b", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} domain={[0, 100]} width={32} />
                    <ReferenceLine y={50} stroke="#52525b" strokeDasharray="3 3" />
                    <Tooltip
                      contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 11 }}
                      formatter={(v: any) => [`${v}%`, "Win Rate"]}
                    />
                    <Area type="monotone" dataKey="winRate" stroke="#3b82f6" fill="#3b82f620" strokeWidth={2} dot={{ fill: "#3b82f6", r: 3 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-yellow-400" />
                    By Divergence Signal
                  </h3>
                  <div className="space-y-2.5">
                    {analyticsData.byDivergence.map((d) => (
                      <div key={d.label} className="flex items-center gap-3">
                        <span className="text-[10px] text-zinc-400 w-20 font-mono shrink-0">{d.label}</span>
                        <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                          <div
                            className={cn("h-full rounded-full transition-all", d.winRate != null && d.winRate >= 55 ? "bg-green-500" : d.winRate != null && d.winRate >= 45 ? "bg-yellow-500" : "bg-red-500")}
                            style={{ width: `${d.winRate ?? 0}%` }}
                          />
                        </div>
                        <span className={cn("text-xs font-mono font-bold w-12 text-right", d.winRate != null && d.winRate >= 55 ? "text-green-400" : d.winRate != null && d.winRate >= 45 ? "text-yellow-400" : "text-red-400")}>
                          {d.winRate != null ? `${d.winRate}%` : "—"}
                        </span>
                        <span className="text-[10px] text-zinc-600 w-10 text-right">{d.total}tr</span>
                        <span className={cn("text-[10px] font-mono w-14 text-right", d.pnl >= 0 ? "text-green-400" : "text-red-400")}>
                          {d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="glass-card p-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-green-400" />
                    By Direction
                  </h3>
                  <div className="space-y-2.5">
                    {analyticsData.byDirection.map((d) => (
                      <div key={d.label} className="flex items-center gap-3">
                        <span className={cn("text-[10px] font-mono font-bold w-14 shrink-0", d.label === "UP" ? "text-green-400" : "text-red-400")}>
                          {d.label === "UP" ? "▲" : "▼"} {d.label}
                        </span>
                        <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                          <div
                            className={cn("h-full rounded-full", d.winRate != null && d.winRate >= 55 ? "bg-green-500" : "bg-yellow-500")}
                            style={{ width: `${d.winRate ?? 0}%` }}
                          />
                        </div>
                        <span className={cn("text-xs font-mono font-bold w-12 text-right", d.winRate != null && d.winRate >= 55 ? "text-green-400" : "text-yellow-400")}>
                          {d.winRate != null ? `${d.winRate}%` : "—"}
                        </span>
                        <span className="text-[10px] text-zinc-600 w-10 text-right">{d.total}tr</span>
                        <span className={cn("text-[10px] font-mono w-14 text-right font-bold", d.pnl >= 0 ? "text-green-400" : "text-red-400")}>
                          {d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── DASHBOARD TAB ── */}
      {activeTab === "dashboard" && (
      <div className="space-y-6">

      {/* ── Session PnL Chart ── */}
      <div className="glass-card p-4 w-full">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <LineChartIcon className="w-4 h-4" />
            Session PnL
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">
              {pnlPeriod === "1d" ? "today" : "last 7 days"} · {pnlHistory.length} trade{pnlHistory.length !== 1 ? "s" : ""}
            </span>
          </h3>
          <div className="flex items-center gap-3">
            {/* Period toggle */}
            <div className="flex rounded-lg overflow-hidden border border-zinc-700 text-[10px] font-bold">
              {(["1d", "7d"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPnlPeriod(p)}
                  className={cn(
                    "px-3 py-1 transition-colors",
                    pnlPeriod === p
                      ? "bg-zinc-700 text-white"
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  {p === "1d" ? "Today" : "7 Days"}
                </button>
              ))}
            </div>
            {pnlHistory.length > 0 && (
              <span className={cn(
                "text-sm font-mono font-bold",
                lastCumulative > 0 ? "text-green-400" : lastCumulative < 0 ? "text-red-400" : "text-zinc-400"
              )}>
                {lastCumulative > 0 ? "+" : ""}{lastCumulative.toFixed(2)} USDC
              </span>
            )}
          </div>
        </div>

        {/* Today's quick stats (always visible when today filter active or as summary row) */}
        {pnlPeriod === "1d" && (
          <div className="flex flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Today PnL</span>
              <span className={cn(
                "text-sm font-mono font-bold",
                todayStats.pnl > 0 ? "text-green-400" : todayStats.pnl < 0 ? "text-red-400" : "text-zinc-400"
              )}>
                {todayStats.pnl >= 0 ? "+" : ""}{todayStats.pnl.toFixed(2)} USDC
              </span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">W/L</span>
              <span className="text-sm font-mono font-bold">
                <span className="text-green-400">{todayStats.wins}W</span>
                <span className="text-zinc-600 mx-1">/</span>
                <span className="text-red-400">{todayStats.losses}L</span>
              </span>
            </div>
            {todayStats.total > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Win Rate</span>
                <span className={cn(
                  "text-sm font-mono font-bold",
                  (todayStats.wins / todayStats.total) >= 0.55 ? "text-green-400"
                    : (todayStats.wins / todayStats.total) >= 0.45 ? "text-yellow-400"
                    : "text-red-400"
                )}>
                  {((todayStats.wins / todayStats.total) * 100).toFixed(0)}%
                </span>
              </div>
            )}
            {todayStats.total === 0 && (
              <div className="px-3 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-700/50 text-[10px] text-zinc-600">
                No trades yet today
              </div>
            )}
          </div>
        )}

        {pnlHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 gap-2 text-zinc-700">
            <BarChart3 className="w-8 h-8 opacity-30" />
            <p className="text-xs">{pnlPeriod === "1d" ? "No trades today yet" : "No resolved trades in the last 7 days"}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={pnlHistory} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGradientUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="pnlGradientDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.03} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0.25} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <ReferenceLine y={0} stroke="#52525b" strokeDasharray="4 4" strokeWidth={1} />

              <XAxis
                dataKey="time"
                tick={{ fill: "#52525b", fontSize: 9, fontFamily: "monospace" }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#52525b", fontSize: 9, fontFamily: "monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}`}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: 8,
                  fontSize: 11,
                  color: "#e4e4e7",
                }}
                labelStyle={{ color: "#71717a", marginBottom: 4 }}
                formatter={(value: any, name: string) => [
                  `${Number(value) >= 0 ? "+" : ""}$${Number(value).toFixed(2)}`,
                  name === "cumulative" ? "Cumulative PnL" : "This Trade",
                ]}
              />

              <Area
                type="monotone"
                dataKey="cumulative"
                stroke={lastCumulative >= 0 ? "#22c55e" : "#ef4444"}
                strokeWidth={2}
                fill={lastCumulative >= 0 ? "url(#pnlGradientUp)" : "url(#pnlGradientDown)"}
                dot={(props: any) => {
                  const { cx, cy, payload } = props;
                  const isWin = payload.decision === "WIN";
                  return (
                    <circle
                      key={`dot-${cx}-${cy}`}
                      cx={cx}
                      cy={cy}
                      r={4.5}
                      fill={isWin ? "#22c55e" : "#ef4444"}
                      stroke="#09090b"
                      strokeWidth={1.5}
                    />
                  );
                }}
                activeDot={{ r: 6, stroke: "#09090b", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Market Infra ── */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              <Activity className="w-4 h-4 text-orange-400" />
              Market Infra
            </h3>
            <p className="text-[10px] text-zinc-600 mt-0.5">
              pmxt-inspired discovery cache, websocket feed, prewarm, dan execution quote depth-aware
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className={cn(
              "px-2 py-0.5 rounded-full border font-bold uppercase",
              infra?.stream.connected
                ? "bg-green-500/10 text-green-400 border-green-500/30"
                : "bg-zinc-800 text-zinc-500 border-zinc-700"
            )}>
              {infra?.stream.connected ? "WS Live" : infra?.stream.mode === "disabled" ? "WS Off" : "WS Idle"}
            </span>
            <span className={cn(
              "px-2 py-0.5 rounded-full border font-bold uppercase",
              infra?.prewarm.totalReady
                ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                : "bg-zinc-800 text-zinc-500 border-zinc-700"
            )}>
              {infra ? `${infra.prewarm.totalReady}/${infra.prewarm.totalTracked} warm` : "prewarm —"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Tag className="w-4 h-4 text-amber-400" />
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Discovery</span>
            </div>
            {btcDiscovery ? (
              <div className="space-y-2">
                <div>
                  <div className="text-[10px] text-zinc-500">Current slug</div>
                  <div className="font-mono text-[11px] text-zinc-200 break-all">{btcDiscovery.currentSlug}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                    <div className="text-[10px] text-zinc-500 uppercase">Current</div>
                    <div className="font-mono text-white">{btcDiscovery.currentMarketCount}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                    <div className="text-[10px] text-zinc-500 uppercase">Next</div>
                    <div className="font-mono text-white">{btcDiscovery.nextMarketCount}</div>
                  </div>
                </div>
                <div className="text-[10px] text-zinc-600">
                  refreshed {formatAge(btcDiscovery.fetchedAt, btcDiscovery.ageMs)} · tracked {btcDiscovery.trackedTokenIds.length} tokens
                </div>
              </div>
            ) : (
              <div className="text-xs text-zinc-600">Discovery cache belum terisi.</div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Wifi className="w-4 h-4 text-cyan-400" />
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Stream Feed</span>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                  <div className="text-[10px] text-zinc-500 uppercase">Watched</div>
                  <div className="font-mono text-white">{infra?.stream.watchedTokenIds.length ?? 0}</div>
                </div>
                <div className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                  <div className="text-[10px] text-zinc-500 uppercase">Reconnect</div>
                  <div className="font-mono text-white">{infra?.stream.reconnectCount ?? 0}</div>
                </div>
              </div>
              <div className="text-[10px] text-zinc-600">
                book {formatAge(infra?.stream.lastBookAt)} · trade {formatAge(infra?.stream.lastTradeAt)}
              </div>
              {streamBooks.length > 0 ? (
                <div className="space-y-1.5">
                  {streamBooks.slice(0, 2).map((book) => (
                    <div key={book.tokenId} className="flex items-center justify-between rounded-lg bg-zinc-800/40 px-2.5 py-2 text-[10px]">
                      <span className="font-mono text-zinc-500">{book.tokenId.slice(0, 8)}…</span>
                      <span className="text-zinc-300">bid {book.bestBid != null ? `${(book.bestBid * 100).toFixed(1)}¢` : "—"}</span>
                      <span className="text-zinc-300">ask {book.bestAsk != null ? `${(book.bestAsk * 100).toFixed(1)}¢` : "—"}</span>
                      <span className="text-zinc-500">{book.source}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-600">Belum ada snapshot order book live.</div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-4 h-4 text-green-400" />
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Execution Quote</span>
            </div>
            {infra?.executionQuote ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                    <div className="text-[10px] text-zinc-500 uppercase">Avg Fill</div>
                    <div className="font-mono text-white">
                      {infra.executionQuote.averagePrice != null ? `${(infra.executionQuote.averagePrice * 100).toFixed(1)}¢` : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg bg-zinc-800/60 px-2.5 py-2">
                    <div className="text-[10px] text-zinc-500 uppercase">Limit</div>
                    <div className="font-mono text-white">
                      {infra.executionQuote.limitPrice != null ? `${(infra.executionQuote.limitPrice * 100).toFixed(1)}¢` : "—"}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[10px]">
                  <div className="rounded-lg bg-zinc-800/40 px-2.5 py-2">
                    <div className="text-zinc-500 uppercase">Spend</div>
                    <div className="font-mono text-zinc-200">{infra.executionQuote.amountMode === "SPEND" ? `$${infra.executionQuote.amount.toFixed(2)}` : infra.executionQuote.amount.toFixed(4)}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-800/40 px-2.5 py-2">
                    <div className="text-zinc-500 uppercase">Shares</div>
                    <div className="font-mono text-zinc-200">{infra.executionQuote.filledSize.toFixed(4)}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-800/40 px-2.5 py-2">
                    <div className="text-zinc-500 uppercase">Slip</div>
                    <div className={cn("font-mono", (infra.executionQuote.slippageBps ?? 0) <= 0 ? "text-green-400" : "text-yellow-400")}>
                      {infra.executionQuote.slippageBps != null ? `${infra.executionQuote.slippageBps.toFixed(1)} bps` : "—"}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between text-[10px] text-zinc-600">
                  <span>{infra.executionQuote.source} · {infra.executionQuote.levelsConsumed} levels</span>
                  <span>{infra.executionQuote.fullyFilled ? "fully filled" : "partial depth"}</span>
                </div>
                {streamRecentTrades.length > 0 && (
                  <div className="border-t border-zinc-800/70 pt-2 space-y-1">
                    {streamRecentTrades.slice(0, 2).map((trade) => (
                      <div key={`${trade.tokenId}-${trade.timestamp}-${trade.price}`} className="flex items-center justify-between text-[10px]">
                        <span className="font-mono text-zinc-500">{trade.tokenId.slice(0, 8)}…</span>
                        <span className={cn("font-semibold", trade.side === "BUY" ? "text-green-400" : trade.side === "SELL" ? "text-red-400" : "text-zinc-400")}>
                          {trade.side}
                        </span>
                        <span className="text-zinc-300">{(trade.price * 100).toFixed(1)}¢</span>
                        <span className="text-zinc-500">{trade.size.toFixed(2)} sh</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-600">Belum ada quote aktif. Quote akan muncul setelah discovery dan snapshot entry terisi.</div>
            )}
          </div>
        </div>
      </div>

      {/* ── Ping Dashboard ── */}
      <div className="glass-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              <Wifi className="w-4 h-4 text-cyan-400" />
              Latency — Polymarket &amp; CEX
            </h3>
            {ping ? (
              <p className="text-[10px] text-zinc-600 mt-0.5">
                Tested {new Date(ping.testedAt).toLocaleTimeString()} · {ping.note}
              </p>
            ) : (
              <p className="text-[10px] text-zinc-600 mt-0.5">
                Ukur latency bot-server ke Polymarket CLOB, Gamma API, Binance, dan Coinbase.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {ping && (
              <span className={cn(
                "px-2.5 py-1 rounded-full text-[10px] font-bold border",
                ping.summary.criticalReady
                  ? "bg-green-500/10 text-green-400 border-green-500/30"
                  : "bg-red-500/10 text-red-400 border-red-500/30"
              )}>
                {ping.summary.criticalReady ? "✓ Polymarket Ready" : "⚠ Latency High"}
              </span>
            )}
            {ping && (
              <span className={cn(
                "px-2.5 py-1 rounded-full text-[10px] font-bold border uppercase",
                ping.summary.grade === "excellent" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" :
                ping.summary.grade === "good"      ? "bg-sky-500/10 text-sky-400 border-sky-500/30" :
                ping.summary.grade === "usable"    ? "bg-amber-500/10 text-amber-400 border-amber-500/30" :
                ping.summary.grade === "slow"      ? "bg-orange-500/10 text-orange-400 border-orange-500/30" :
                                                     "bg-red-500/10 text-red-400 border-red-500/30"
              )}>
                {ping.summary.grade}
              </span>
            )}
            <button
              type="button"
              onClick={handlePingTest}
              disabled={pinging}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all",
                pinging
                  ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 cursor-default"
                  : "bg-zinc-800 text-zinc-300 border-zinc-700 hover:border-zinc-500 hover:text-white"
              )}
            >
              <Wifi className={cn("w-3.5 h-3.5", pinging && "animate-pulse")} />
              {pinging ? "Testing…" : "Test Ping"}
            </button>
          </div>
        </div>

        {!ping ? (
          <div className="flex flex-col items-center justify-center h-20 gap-2 text-zinc-700">
            <Wifi className="w-7 h-7 opacity-25" />
            <p className="text-xs">Klik "Test Ping" untuk cek latency ke semua upstream.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Summary stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { label: "Fastest", value: ping.summary.fastestMs != null ? `${ping.summary.fastestMs} ms` : "—" },
                { label: "Average", value: ping.summary.averageMs != null ? `${ping.summary.averageMs} ms` : "—" },
                { label: "Slowest", value: ping.summary.slowestMs != null ? `${ping.summary.slowestMs} ms` : "—" },
                { label: "Browser RTT", value: ping.browserRttMs != null ? `${ping.browserRttMs} ms` : "—" },
              ].map(({ label, value }) => (
                <div key={label} className="bg-zinc-800/50 rounded-lg p-2.5 border border-zinc-700/50">
                  <div className="text-[9px] text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
                  <div className="text-lg font-mono font-bold text-white">{value}</div>
                </div>
              ))}
            </div>

            {/* Per-upstream latency cards */}
            <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              {ping.upstreams.map((u) => {
                const tone =
                  !u.ok || u.grade === "down" ? { card: "border-red-500/30 bg-red-500/10", text: "text-red-300", sub: "text-red-400/60" } :
                  u.grade === "excellent"      ? { card: "border-emerald-500/30 bg-emerald-500/10", text: "text-emerald-300", sub: "text-emerald-400/60" } :
                  u.grade === "good"           ? { card: "border-sky-500/30 bg-sky-500/10", text: "text-sky-300", sub: "text-sky-400/60" } :
                  u.grade === "usable"         ? { card: "border-amber-500/30 bg-amber-500/10", text: "text-amber-300", sub: "text-amber-400/60" } :
                                                 { card: "border-orange-500/30 bg-orange-500/10", text: "text-orange-300", sub: "text-orange-400/60" };
                return (
                  <div key={u.key} className={cn("rounded-xl border px-4 py-3", tone.card)}>
                    <div className={cn("text-[10px] uppercase tracking-wider font-semibold mb-1", tone.sub)}>
                      {u.label}
                    </div>
                    <div className={cn("text-2xl font-mono font-bold", tone.text)}>
                      {u.latencyMs != null ? `${u.latencyMs}` : "DOWN"}
                      {u.latencyMs != null && <span className="text-sm font-normal ml-0.5 opacity-70">ms</span>}
                    </div>
                    <div className={cn("text-[9px] font-bold uppercase mt-0.5", tone.sub)}>
                      {u.grade}
                    </div>
                    <div className="text-[9px] opacity-50 mt-0.5 truncate">
                      {u.status != null ? `HTTP ${u.status}` : u.error || "No response"}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Grade legend */}
            <div className="flex flex-wrap gap-2 text-[9px]">
              {[
                { grade: "excellent", label: "≤80ms", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
                { grade: "good",      label: "≤150ms", color: "bg-sky-500/10 text-sky-400 border-sky-500/30" },
                { grade: "usable",    label: "≤250ms", color: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
                { grade: "slow",      label: ">250ms", color: "bg-orange-500/10 text-orange-400 border-orange-500/30" },
                { grade: "down",      label: "failed", color: "bg-red-500/10 text-red-400 border-red-500/30" },
              ].map(({ grade, label, color }) => (
                <span key={grade} className={cn("px-2 py-0.5 rounded-full border font-bold uppercase", color)}>
                  {grade} <span className="font-normal opacity-70">{label}</span>
                </span>
              ))}
              <span className="text-zinc-600 self-center ml-1">
                Strategy-critical: Polymarket CLOB &amp; Gamma ≤150ms
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── FastLoop Momentum Widget ── */}
      {(() => {
        const fm = status?.entrySnapshot?.fastLoopMomentum ?? (momentumHistory.length > 0 ? momentumHistory[momentumHistory.length - 1] : null);
        const chartData = momentumHistory.slice(-20).map((p, i) => ({
          i,
          time: new Date(p.ts * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
          vw: parseFloat(p.vw.toFixed(4)),
        }));
        return (
          <div className="glass-card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                <Gauge className="w-4 h-4 text-cyan-400" />
                Fast Loop Momentum
              </h3>
              {fm && (
                <span className={cn(
                  "px-2 py-0.5 rounded-full text-[10px] font-bold border",
                  fm.strength === "STRONG"   ? "bg-orange-500/20 text-orange-300 border-orange-500/40" :
                  fm.strength === "MODERATE" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
                                               "bg-zinc-800 text-zinc-500 border-zinc-700"
                )}>
                  {fm.strength}
                </span>
              )}
            </div>
            {!fm ? (
              <div className="text-zinc-600 text-xs text-center py-4">Waiting for first bot cycle…</div>
            ) : (
              <div className="space-y-3">
                <div className={cn("grid gap-2", "raw" in fm ? "grid-cols-4" : "grid-cols-2")}>
                  <div className="bg-zinc-800/60 rounded-lg p-2 text-center">
                    <div className="text-[9px] text-zinc-500 uppercase mb-1">Direction</div>
                    <div className={cn("text-base font-mono font-bold", fm.direction === "UP" ? "text-green-400" : fm.direction === "DOWN" ? "text-red-400" : "text-zinc-500")}>
                      {fm.direction === "UP" ? "▲" : fm.direction === "DOWN" ? "▼" : "—"} {fm.direction}
                    </div>
                  </div>
                  <div className="bg-zinc-800/60 rounded-lg p-2 text-center">
                    <div className="text-[9px] text-zinc-500 uppercase mb-1">Vol-Weighted</div>
                    <div className={cn("text-base font-mono font-bold", fm.vw > 0 ? "text-green-400" : fm.vw < 0 ? "text-red-400" : "text-zinc-500")}>
                      {fm.vw >= 0 ? "+" : ""}{fm.vw.toFixed(3)}%
                    </div>
                  </div>
                  {"raw" in fm && (
                    <div className="bg-zinc-800/60 rounded-lg p-2 text-center">
                      <div className="text-[9px] text-zinc-500 uppercase mb-1">Raw</div>
                      <div className={cn("text-base font-mono font-bold", (fm as MomentumPoint).raw > 0 ? "text-green-400" : (fm as MomentumPoint).raw < 0 ? "text-red-400" : "text-zinc-500")}>
                        {(fm as MomentumPoint).raw >= 0 ? "+" : ""}{(fm as MomentumPoint).raw.toFixed(3)}%
                      </div>
                    </div>
                  )}
                  {"accel" in fm && (
                    <div className="bg-zinc-800/60 rounded-lg p-2 text-center">
                      <div className="text-[9px] text-zinc-500 uppercase mb-1">Accel</div>
                      <div className={cn("text-base font-mono font-bold", (fm as MomentumPoint).accel > 0 ? "text-emerald-400" : (fm as MomentumPoint).accel < 0 ? "text-orange-400" : "text-zinc-500")}>
                        {(fm as MomentumPoint).accel >= 0 ? "+" : ""}{(fm as MomentumPoint).accel.toFixed(3)}%
                      </div>
                    </div>
                  )}
                </div>
                {chartData.length > 1 && (
                  <div>
                    <div className="text-[9px] text-zinc-600 mb-1">VW Momentum — last {chartData.length} cycles</div>
                    <ResponsiveContainer width="100%" height={70}>
                      <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="momGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#06b6d4" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
                        <Area type="monotone" dataKey="vw" stroke="#06b6d4" fill="url(#momGrad)" strokeWidth={1.5} dot={false} />
                        <Tooltip
                          contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 6, fontSize: 10 }}
                          formatter={(v: any) => [`${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(3)}%`, "VW Momentum"]}
                          labelFormatter={(l) => chartData[l as number]?.time ?? ""}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Notifications Status ── */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-2">
          <Bell className="w-4 h-4 text-indigo-400" />
          Push Notifications
        </h3>
        <div className="flex gap-3 flex-wrap items-center">
          {([
            { label: "Telegram", active: notifStatus?.telegram, hint: "set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID" },
            { label: "Discord",  active: notifStatus?.discord,  hint: "set DISCORD_WEBHOOK_URL" },
          ] as const).map(({ label, active, hint }) => (
            <div key={label} className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg border text-xs",
              active ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-zinc-800/50 border-zinc-700/50 text-zinc-500"
            )}>
              <span className={cn("w-1.5 h-1.5 rounded-full", active ? "bg-green-400 animate-pulse" : "bg-zinc-600")} />
              <span className="font-bold">{label}</span>
              <span className="text-[9px] opacity-60">{active ? "connected" : hint}</span>
            </div>
          ))}
          <span className="text-[10px] text-zinc-600">Alerts: trade execution + STRONG divergence</span>
        </div>
      </div>

      {/* ── Auto-Calibrator Widget ── */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-purple-400" />
            Auto-Calibrator
          </h3>
          <button
            type="button"
            aria-label={calibration.enabled ? "Disable auto-calibrator" : "Enable auto-calibrator"}
            onClick={handleToggleCalibrator}
            disabled={calibTogglingLoading}
            className={cn(
              "relative w-12 h-6 rounded-full transition-colors duration-200 disabled:opacity-50 focus:outline-none",
              calibration.enabled ? "bg-purple-600" : "bg-zinc-700"
            )}
          >
            <span className={cn(
              "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200",
              calibration.enabled ? "translate-x-6" : "translate-x-0"
            )} />
          </button>
        </div>

        {!calibration.enabled ? (
          <p className="text-[11px] text-zinc-600">
            When enabled, runs FastLoop backtest at the start of each 5-min window and automatically adjusts signal thresholds + confidence based on recent accuracy.
          </p>
        ) : calibration.state ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Win Rate</span>
                <span className={cn(
                  "font-bold text-base",
                  (calibration.state.winRate ?? 0) >= 65 ? "text-green-400"
                    : (calibration.state.winRate ?? 0) >= 50 ? "text-yellow-400"
                    : "text-red-400"
                )}>
                  {calibration.state.winRate != null ? `${calibration.state.winRate}%` : "—"}
                </span>
              </div>
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Min Strength</span>
                <span className={cn(
                  "font-bold text-sm",
                  calibration.state.fastLoopMinStrength === "STRONG" ? "text-red-400" : "text-blue-400"
                )}>
                  {calibration.state.fastLoopMinStrength}
                </span>
              </div>
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Conf Δ</span>
                <span className={cn(
                  "font-bold text-sm",
                  calibration.state.confidenceDelta > 0 ? "text-red-400"
                    : calibration.state.confidenceDelta < 0 ? "text-green-400"
                    : "text-zinc-400"
                )}>
                  {calibration.state.confidenceDelta > 0 ? `+${calibration.state.confidenceDelta}%` : calibration.state.confidenceDelta < 0 ? `${calibration.state.confidenceDelta}%` : "±0%"}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 italic">{calibration.state.note}</p>
            <p className="text-[9px] text-zinc-700">
              {calibration.state.correctCount}/{calibration.state.signaledCount} signals correct · {calibration.state.totalWindows} windows sampled
              {calibration.state.runAt ? ` · updated ${new Date(calibration.state.runAt * 1000).toLocaleTimeString()}` : ""}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500 animate-pulse">Running calibration…</p>
        )}
      </div>

      {/* ── Bot ON/OFF + Window + Session Row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Bot control */}
        <div className="glass-card p-4 col-span-2 md:col-span-1 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className={cn("w-2.5 h-2.5 rounded-full", status?.enabled ? "bg-green-400 animate-pulse" : "bg-zinc-600")} />
            <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">
              {status?.enabled ? (status.running ? "Running" : "Idle") : "Stopped"}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleControl(true)}
              disabled={controlLoading || status?.enabled === true}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all",
                status?.enabled
                  ? "bg-green-500/10 text-green-400 border border-green-500/30 cursor-default"
                  : "bg-green-500 text-black hover:bg-green-400"
              )}
            >
              <Play className="w-3.5 h-3.5" />
              Start
            </button>
            <button
              onClick={() => handleControl(false)}
              disabled={controlLoading || status?.enabled === false}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-bold transition-all",
                !status?.enabled
                  ? "bg-zinc-800 text-zinc-600 border border-zinc-700 cursor-default"
                  : "bg-red-500 text-white hover:bg-red-400"
              )}
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </button>
          </div>
          <div className="text-[10px] text-zinc-600 space-y-0.5">
            <div className="flex items-center gap-2">
              <span>Conf ≥{status?.config.minConfidence ?? 70}% | Edge ≥{status?.config.minEdge ?? 10}¢</span>
              <button
                type="button"
                onClick={handleResetConfidence}
                disabled={resetConfLoading}
                title="Reset adaptive confidence boost to default"
                className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-white transition-colors disabled:opacity-40"
              >
                {resetConfLoading ? "…" : "Reset"}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span>
                Loss penalty: {learning?.adaptiveLossPenaltyEnabled === false ? "OFF" : "ON"}
                {learning?.adaptiveConfidenceBoost ? ` | Boost +${learning.adaptiveConfidenceBoost}%` : ""}
              </span>
              <button
                type="button"
                onClick={handleToggleLossPenalty}
                disabled={lossPenaltySaving || !learning}
                title="Toggle raising confidence threshold by +5% after loss streaks"
                className={cn(
                  "px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide transition-colors disabled:opacity-40",
                  learning?.adaptiveLossPenaltyEnabled === false
                    ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    : "bg-orange-500/15 text-orange-300 hover:bg-orange-500/25"
                )}
              >
                {lossPenaltySaving ? "…" : learning?.adaptiveLossPenaltyEnabled === false ? "Enable +5%" : "Disable +5%"}
              </button>
            </div>
            <div>Fixed ${status?.config.fixedTradeUsdc ?? 1} per trade | Loss limit {((status?.config.sessionLossLimit ?? 0.1) * 100).toFixed(0)}%</div>
          </div>
        </div>

        {/* ── Threshold Tuner ── */}
        <div className="glass-card p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
            <Activity className="w-3.5 h-3.5" />
            Threshold Tuner
          </div>
          <div className="space-y-3">
            {/* Min Confidence */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Min Confidence</span>
                <span className="font-mono text-emerald-400">
                  {confInput !== "" ? `${confInput}%` : `${status?.config.minConfidence ?? 70}% (aktif)`}
                </span>
              </div>
              <input
                type="range"
                min={50} max={95} step={1}
                value={confInput !== "" ? Number(confInput) : (status?.config.minConfidence ?? 70)}
                onChange={(e) => setConfInput(e.target.value)}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-emerald-500 bg-zinc-700"
              />
              <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
                <span>50%</span><span>60%</span><span>70%</span><span>80%</span><span>95%</span>
              </div>
            </div>
            {/* Min Edge */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Min Edge</span>
                <span className="font-mono text-blue-400">
                  {edgeInput !== "" ? `${Number(edgeInput).toFixed(2)}¢` : `${(status?.config.minEdge ?? 0.10).toFixed(2)}¢ (aktif)`}
                </span>
              </div>
              <input
                type="range"
                min={0.01} max={0.30} step={0.01}
                value={edgeInput !== "" ? Number(edgeInput) : (status?.config.minEdge ?? 0.10)}
                onChange={(e) => setEdgeInput(e.target.value)}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-blue-500 bg-zinc-700"
              />
              <div className="flex justify-between text-[9px] text-zinc-600 font-mono">
                <span>0.01</span><span>0.10</span><span>0.20</span><span>0.30</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Fixed Trade Size</span>
                <span className="font-mono text-amber-400">
                  ${fixedTradePreview.toFixed(2)}
                  {fixedTradeInput !== "" ? " (manual)" : " (aktif)"}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {[1, 2, 3, 4, 5].map((amount) => {
                  const selected = fixedTradePreview === amount;
                  return (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => setFixedTradeInput(String(amount))}
                      className={cn(
                        "py-1.5 rounded-lg text-xs font-bold border transition-all",
                        selected
                          ? "bg-amber-500/20 text-amber-300 border-amber-500/50"
                          : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700 hover:text-white"
                      )}
                    >
                      ${amount}
                    </button>
                  );
                })}
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px]">
                  <label htmlFor="fixed-trade-input" className="text-zinc-400">Manual Entry Value</label>
                  <span className="font-mono text-zinc-600">0.10 - {(status?.config.maxBetUsdc ?? 250).toFixed(2)} USDC</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="fixed-trade-input"
                    type="number"
                    min={0.1}
                    max={status?.config.maxBetUsdc ?? 250}
                    step={0.1}
                    inputMode="decimal"
                    placeholder={`${(status?.config.fixedTradeUsdc ?? 1).toFixed(2)}`}
                    value={fixedTradeInput}
                    onChange={(e) => setFixedTradeInput(e.target.value)}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors focus:border-amber-500"
                  />
                  {fixedTradeInput !== "" && (
                    <button
                      type="button"
                      onClick={() => setFixedTradeInput("")}
                      className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider text-zinc-400 transition-colors hover:border-zinc-600 hover:text-white"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <div className="text-[9px] text-zinc-600">
                Nominal buy per trade. Preset cepat tetap ada, tapi Anda sekarang bisa override runtime dengan nominal manual yang lebih presisi.
              </div>
            </div>
            {/* EV preview */}
            {confInput !== "" && edgeInput !== "" && (() => {
              const conf = Number(confInput) / 100;
              const maxEntry = Math.min(0.75, (Number(confInput) - 10) / 100);
              const ev = conf * (1 - maxEntry) - (1 - conf) * maxEntry;
              return (
                <div className={`text-[10px] font-mono px-2 py-1 rounded ${ev > 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                  EV @ max entry {(maxEntry * 100).toFixed(0)}¢: {ev > 0 ? "+" : ""}{(ev * 100).toFixed(1)}¢/share {ev > 0 ? "✓" : "✗ negative"}
                </div>
              );
            })()}
            <button
              type="button"
              onClick={handleSaveConfig}
              disabled={configSaving || (confInput === "" && edgeInput === "" && fixedTradeInput === "")}
              className="w-full py-1.5 rounded-lg text-xs font-bold transition-all bg-zinc-700 text-zinc-300 hover:bg-emerald-600 hover:text-white disabled:opacity-40 disabled:cursor-default"
            >
              {configSaving ? "Saving…" : configSaved ? "✓ Saved" : "Apply"}
            </button>
          </div>
        </div>

        {/* ── Active Markets ── */}
        <div className="glass-card p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
            <Activity className="w-3.5 h-3.5" />
            Active Markets
          </div>
          <div className="w-full rounded-lg border border-orange-500/50 bg-orange-500/15 p-2.5">
            <div className="flex items-center gap-1.5 font-bold text-xs text-orange-300">
              <span className="font-mono">BTC</span>
              <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 font-bold">ON</span>
            </div>
          </div>
          <div className="text-[10px] text-zinc-600">
            Scanning BTC only
          </div>
        </div>

        {/* Window timer */}
        <div className="glass-card p-4 flex flex-col justify-between">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
            <Clock className="w-3.5 h-3.5" />
            Window
          </div>
          <div>
            <div className={cn("text-2xl font-mono font-bold", windowColor)}>
              {String(Math.floor(windowRemaining / 60)).padStart(2, "0")}:{String(windowRemaining % 60).padStart(2, "0")}
            </div>
            <div className={cn("text-[10px] font-bold mt-1", entryZone ? "text-green-400" : "text-zinc-600")}>
              {entryZone ? "✓ ENTRY ZONE" : windowSeconds < 30 ? "⏳ Too early" : "⛔ Too late"}
            </div>
          </div>
          <div className="text-[10px] text-zinc-600">{status?.analyzedThisWindow ?? 0} markets analyzed</div>
        </div>

        {/* Balance */}
        <div className="glass-card p-4 flex flex-col justify-between">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
            <DollarSign className="w-3.5 h-3.5" />
            Balance
          </div>
          <div>
            <div className="text-2xl font-mono font-bold text-white">${balance}</div>
            {sessionPnl !== null && (
              <div className={cn("text-xs font-bold mt-1", sessionPnl >= 0 ? "text-green-400" : "text-red-400")}>
                {sessionPnl >= 0 ? "+" : ""}${sessionPnl.toFixed(2)} session
              </div>
            )}
          </div>
          <div className="text-[10px] text-zinc-600">{status?.sessionTradesCount ?? 0} trades this session</div>
        </div>

        {/* Open exposure */}
        <div className="glass-card p-4 flex flex-col justify-between">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
            <Activity className="w-3.5 h-3.5" />
            Exposure
          </div>
          <div>
            <div className="text-2xl font-mono font-bold text-white">${openExposure.toFixed(2)}</div>
            <div className="text-xs text-zinc-500 mt-1">{performance?.openPositions.length ?? 0} open positions</div>
          </div>
          <div className="text-[10px] text-zinc-600">{armedCount} automations armed</div>
        </div>
      </div>

      {/* ── Current Entry Price Widget ── */}
      {(() => {
        const snap = status?.entrySnapshot;
        const entryPrice = snap?.direction === "UP" ? snap.yesPrice : snap?.direction === "DOWN" ? snap.noPrice : null;
        const oppPrice   = snap?.direction === "UP" ? snap.noPrice  : snap?.direction === "DOWN" ? snap.yesPrice : null;
        const isUp = snap?.direction === "UP";
        const isDown = snap?.direction === "DOWN";
        const updatedAgo = snap ? Math.floor((Date.now() - new Date(snap.updatedAt).getTime()) / 1000) : null;

        return (
          <div className="glass-card p-4 w-full">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                <Tag className="w-4 h-4" />
                Current Entry Price
              </h3>
              {updatedAgo !== null && (
                <span className="text-[10px] text-zinc-600 font-mono">{updatedAgo}s ago</span>
              )}
            </div>

            {!snap ? (
              <div className="flex items-center justify-center h-16 text-zinc-700 text-xs">
                Waiting for bot to scan a market…
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/* Market title + asset badge */}
                <div className="flex items-center gap-2">
                  {snap.asset && (
                    <span className={cn(
                      "text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0",
                      snap.asset === "BTC" ? "bg-orange-500/15 text-orange-400 border-orange-500/30"
                        : snap.asset === "ETH" ? "bg-blue-500/15 text-blue-400 border-blue-500/30"
                        : "bg-purple-500/15 text-purple-400 border-purple-500/30"
                    )}>{snap.asset}</span>
                  )}
                  <p className="text-[11px] text-zinc-500 truncate">{snap.market}</p>
                </div>

                {/* Prices row */}
                <div className="grid grid-cols-3 gap-3">
                  {/* YES price */}
                  <div className={cn(
                    "rounded-xl p-3 flex flex-col gap-1 border",
                    isUp ? "bg-green-500/10 border-green-500/30" : "bg-zinc-800/50 border-zinc-700/40"
                  )}>
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">YES (UP)</span>
                    <span className={cn("text-2xl font-mono font-bold", isUp ? "text-green-400" : "text-zinc-400")}>
                      {snap.yesPrice !== null ? `${(snap.yesPrice * 100).toFixed(1)}¢` : "—"}
                    </span>
                    {isUp && <span className="text-[9px] text-green-500 font-bold">← ENTRY</span>}
                  </div>

                  {/* Asset price center */}
                  <div className="bg-zinc-800/50 border border-zinc-700/40 rounded-xl p-3 flex flex-col gap-1 items-center justify-center">
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">{snap.asset ?? "BTC"} Price</span>
                    <span className="text-lg font-mono font-bold text-white">
                      {snap.btcPrice ? `$${snap.btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}
                    </span>
                    {snap.direction && (
                      <span className={cn(
                        "text-[9px] font-bold flex items-center gap-0.5",
                        isUp ? "text-green-400" : "text-red-400"
                      )}>
                        {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {snap.direction}
                      </span>
                    )}
                  </div>

                  {/* NO price */}
                  <div className={cn(
                    "rounded-xl p-3 flex flex-col gap-1 border",
                    isDown ? "bg-red-500/10 border-red-500/30" : "bg-zinc-800/50 border-zinc-700/40"
                  )}>
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">NO (DOWN)</span>
                    <span className={cn("text-2xl font-mono font-bold", isDown ? "text-red-400" : "text-zinc-400")}>
                      {snap.noPrice !== null ? `${(snap.noPrice * 100).toFixed(1)}¢` : "—"}
                    </span>
                    {isDown && <span className="text-[9px] text-red-500 font-bold">← ENTRY</span>}
                  </div>
                </div>

                {/* Signal row */}
                <div className="flex flex-wrap gap-2 text-[10px]">
                  {snap.confidence !== null && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border",
                      snap.confidence >= 80 ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : snap.confidence >= 75 ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                        : "bg-red-500/10 text-red-400 border-red-500/30"
                    )}>
                      Conf {snap.confidence}%{snap.confidence < 80 ? " ⚠" : ""}
                    </span>
                  )}
                  {snap.edge !== null && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">
                      Edge {snap.edge}¢
                    </span>
                  )}
                  {snap.riskLevel && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border",
                      snap.riskLevel === "LOW"    ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : snap.riskLevel === "MEDIUM" ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                        : "bg-red-500/10 text-red-400 border-red-500/30"
                    )}>
                      {snap.riskLevel}
                    </span>
                  )}
                  {entryPrice !== null && (() => {
                    const coinFlip = entryPrice >= 0.46 && entryPrice <= 0.54;
                    return (
                      <span className={cn(
                        "px-2 py-0.5 rounded-full font-bold border",
                        coinFlip
                          ? "bg-orange-500/10 text-orange-400 border-orange-500/30"
                          : "bg-blue-500/10 text-blue-400 border-blue-500/30"
                      )}>
                        {coinFlip ? "⚠ " : ""}Entry {(entryPrice * 100).toFixed(1)}¢{coinFlip ? " coin-flip" : ""}
                      </span>
                    );
                  })()}
                  {snap.estimatedBet !== null && snap.estimatedBet > 0 && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-purple-500/10 text-purple-400 border border-purple-500/30">
                      ${snap.estimatedBet.toFixed(2)} fixed
                    </span>
                  )}
                  {snap.priceToBeat && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border",
                      snap.priceToBeat.mode === "chainlink"
                        ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30"
                        : "bg-zinc-800 text-zinc-300 border-zinc-700"
                    )}>
                      {snap.priceToBeat.mode === "chainlink" ? "⛓ " : ""}Beat ${snap.priceToBeat.openingPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </span>
                  )}
                  {snap.priceToBeat && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border",
                      snap.priceToBeat.favoredOutcome === "UP"
                        ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : "bg-red-500/10 text-red-400 border-red-500/30"
                    )}>
                      Current {snap.priceToBeat.distanceUsd >= 0 ? "+" : ""}${snap.priceToBeat.distanceUsd.toFixed(0)} vs open · {snap.priceToBeat.favoredOutcome}
                    </span>
                  )}
                  {oppPrice !== null && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-zinc-800 text-zinc-500 border border-zinc-700">
                      Opp {(oppPrice * 100).toFixed(1)}¢
                    </span>
                  )}
                  {snap.divergence && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border flex items-center gap-1",
                      snap.divergence.strength === "STRONG"   ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40"
                        : snap.divergence.strength === "MODERATE" ? "bg-orange-500/15 text-orange-400 border-orange-500/30"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    )}>
                      <Zap className="w-2.5 h-2.5" />
                      LAG {snap.divergence.direction} {snap.divergence.strength}
                      <span className="opacity-60 ml-0.5">
                        {snap.asset ?? "BTC"} {snap.divergence.btcDelta30s >= 0 ? "+" : ""}{snap.divergence.btcDelta30s.toFixed(0)}$
                        / YES {snap.divergence.yesDelta30s >= 0 ? "+" : ""}{snap.divergence.yesDelta30s.toFixed(1)}¢
                      </span>
                    </span>
                  )}
                  {snap.alphaModel?.probability != null && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border",
                      snap.alphaModel.shouldTrade
                        ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    )}>
                      Alpha {(snap.alphaModel.probability * 100).toFixed(1)}%
                    </span>
                  )}
                  {snap.alphaModel?.edge != null && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">
                      Model edge {(snap.alphaModel.edge * 100).toFixed(1)}c
                    </span>
                  )}
                  {snap.alphaModel?.conviction && (
                    <span className={cn(
                      "px-2 py-0.5 rounded-full font-bold border",
                      snap.alphaModel.conviction === "HIGH"
                        ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : snap.alphaModel.conviction === "MEDIUM"
                          ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                          : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    )}>
                      {snap.alphaModel.conviction}
                    </span>
                  )}
                </div>

                {snap.alphaModel && snap.alphaModel.reasons.length > 0 && (
                  <div className="rounded-xl border border-zinc-700/40 bg-zinc-900/40 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                        Alpha Overlay
                      </span>
                      <span className={cn(
                        "text-[10px] font-bold",
                        snap.alphaModel.agreement === "ALIGNED"
                          ? "text-green-400"
                          : snap.alphaModel.agreement === "CONFLICT"
                            ? "text-red-400"
                            : "text-zinc-400"
                      )}>
                        {snap.alphaModel.agreement}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {snap.alphaModel.reasons.slice(0, 3).map((reason) => (
                        <div key={reason} className="text-[11px] text-zinc-500">
                          {reason}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {snap.priceToBeat && (
                  <div className={cn(
                    "rounded-xl border p-3",
                    snap.priceToBeat.mode === "chainlink"
                      ? "border-cyan-500/30 bg-cyan-950/20"
                      : "border-zinc-700/40 bg-zinc-900/40"
                  )}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                        Price To Beat
                      </span>
                      {snap.priceToBeat.mode === "chainlink" ? (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
                          ⛓ Chainlink
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono text-zinc-500 bg-zinc-800 border border-zinc-700">
                          ~proxy:{snap.priceToBeat.source}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-400">
                      <div>
                        <span className="text-zinc-600">Open (to beat)</span>{" "}
                        <span className="font-mono text-zinc-200">${snap.priceToBeat.openingPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                      </div>
                      <div>
                        <span className="text-zinc-600">Current Price</span>{" "}
                        <span className="font-mono text-zinc-200">${snap.priceToBeat.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
                      </div>
                      <div className={cn(
                        "font-mono font-bold",
                        snap.priceToBeat.distanceUsd > 0 ? "text-green-400"
                          : snap.priceToBeat.distanceUsd < 0 ? "text-red-400"
                          : "text-zinc-400"
                      )}>
                        {snap.priceToBeat.distanceUsd >= 0 ? "+" : ""}${snap.priceToBeat.distanceUsd.toFixed(2)}
                        <span className="text-zinc-600 font-normal ml-1">
                          ({snap.priceToBeat.distancePct >= 0 ? "+" : ""}{snap.priceToBeat.distancePct.toFixed(3)}%)
                        </span>
                      </div>
                      <div className={cn(
                        "font-bold",
                        snap.priceToBeat.favoredOutcome === "UP" ? "text-green-400" : "text-red-400"
                      )}>
                        {snap.priceToBeat.favoredOutcome === "UP" ? "▲" : "▼"} {snap.priceToBeat.favoredOutcome}
                        {snap.priceToBeat.direction === "FLAT" && <span className="text-zinc-500 font-normal ml-1">· tie→UP</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Win / Loss / PnL Row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="glass-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Realized PnL</span>
          <span className={cn("text-3xl font-mono font-bold", pnlPositive ? "text-green-400" : pnl < 0 ? "text-red-400" : "text-white")}>
            {pnlPositive ? "+" : ""}{pnl.toFixed(2)}
          </span>
          <span className="text-xs text-zinc-500">USDC lifetime</span>
        </div>

        <div className="glass-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Win Rate</span>
          <span className={cn("text-3xl font-mono font-bold", parseFloat(winRate) >= 55 ? "text-green-400" : parseFloat(winRate) >= 45 ? "text-yellow-400" : "text-red-400")}>
            {winRate}%
          </span>
          <span className="text-xs text-zinc-500">{performance?.summary.closedTrades ?? 0} closed trades</span>
        </div>

        <div className="glass-card p-4 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Wins</span>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-400" />
            <span className="text-3xl font-mono font-bold text-green-400">{winCount}</span>
          </div>
        </div>

        <div className="glass-card p-4 flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Losses</span>
          <div className="flex items-center gap-2">
            <XCircle className="w-5 h-5 text-red-400" />
            <span className="text-3xl font-mono font-bold text-red-400">{lossCount}</span>
          </div>
        </div>
      </div>

      {/* ── Open Positions ── */}
      {performance && performance.openPositions.length > 0 && (
        <div className="glass-card p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" />
            Open Positions
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">({performance.openPositions.length})</span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                  <th className="pb-2 pr-3">Market</th>
                  <th className="pb-2 pr-3">Side</th>
                  <th className="pb-2 pr-3">Size</th>
                  <th className="pb-2 pr-3">Avg Price</th>
                  <th className="pb-2 pr-3">Cur Price</th>
                  <th className="pb-2 pr-3">Cost</th>
                  <th className="pb-2 pr-3">Unrealized PnL</th>
                  <th className="pb-2">TP / SL</th>
                </tr>
              </thead>
            </table>
            <div className="overflow-y-auto max-h-48">
              <table className="w-full text-xs">
                <tbody>
                  {performance.openPositions.map((pos) => {
                    const auto = automations.find((a) => a.assetId === pos.assetId);
                    const cashPnl = parseFloat(pos.cashPnl ?? "0");
                    const pctPnl  = parseFloat(pos.percentPnl ?? "0");
                    const isUp    = pos.outcome?.toLowerCase().includes("up") || pos.outcome?.toLowerCase().includes("yes");
                    return (
                      <tr key={pos.assetId} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                        <td className="py-2 pr-3 text-zinc-300 max-w-[140px] truncate">{pos.market}</td>
                        <td className="py-2 pr-3">
                          <span className={cn("font-bold px-1.5 py-0.5 rounded",
                            isUp ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                          )}>
                            {pos.outcome}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-zinc-300">{parseFloat(pos.size).toFixed(2)}</td>
                        <td className="py-2 pr-3 font-mono text-zinc-300">{(parseFloat(pos.averagePrice) * 100).toFixed(1)}¢</td>
                        <td className="py-2 pr-3 font-mono text-zinc-300">{pos.curPrice ? `${(parseFloat(pos.curPrice) * 100).toFixed(1)}¢` : "—"}</td>
                        <td className="py-2 pr-3 font-mono text-zinc-300">${parseFloat(pos.costBasis).toFixed(2)}</td>
                        <td className="py-2 pr-3 font-mono">
                          <span className={cn("font-bold", cashPnl > 0 ? "text-green-400" : cashPnl < 0 ? "text-red-400" : "text-zinc-500")}>
                            {cashPnl >= 0 ? "+" : ""}${cashPnl.toFixed(2)}
                            <span className="ml-1 text-[10px] opacity-70">({pctPnl >= 0 ? "+" : ""}{pctPnl.toFixed(1)}%)</span>
                          </span>
                        </td>
                        <td className="py-2 font-mono text-zinc-500">
                          {auto ? (
                            <span className={cn(auto.armed ? "text-green-400" : "text-zinc-600")}>
                              TP:{(parseFloat(auto.takeProfit) * 100).toFixed(0)}¢ SL:{(parseFloat(auto.stopLoss) * 100).toFixed(0)}¢
                              {auto.armed && <span className="ml-1 text-green-400">●</span>}
                            </span>
                          ) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Closed Positions ── */}
      {performance && performance.closedPositions && performance.closedPositions.length > 0 && (
        <div className="glass-card p-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-zinc-500" />
            Closed Positions
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">({performance.closedPositions.length} recent)</span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                  <th className="pb-2 pr-3">Market</th>
                  <th className="pb-2 pr-3">Side</th>
                  <th className="pb-2 pr-3">Avg Price</th>
                  <th className="pb-2 pr-3">Close Price</th>
                  <th className="pb-2 pr-3">Total Bought</th>
                  <th className="pb-2 pr-3">Realized PnL</th>
                  <th className="pb-2">Closed At</th>
                </tr>
              </thead>
            </table>
            <div className="overflow-y-auto max-h-48">
              <table className="w-full text-xs">
                <tbody>
                  {performance.closedPositions.map((pos, i) => {
                    const rpnl = parseFloat(pos.realizedPnl);
                    const isWin = rpnl > 0;
                    const isUp  = pos.outcome?.toLowerCase().includes("up") || pos.outcome?.toLowerCase().includes("yes");
                    return (
                      <tr key={`${pos.assetId}-${i}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                        <td className="py-2 pr-3 text-zinc-300 max-w-[140px] truncate">{pos.market}</td>
                        <td className="py-2 pr-3">
                          <span className={cn("font-bold px-1.5 py-0.5 rounded",
                            isUp ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                          )}>
                            {pos.outcome}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-zinc-400">{(parseFloat(pos.avgPrice) * 100).toFixed(1)}¢</td>
                        <td className="py-2 pr-3 font-mono text-zinc-400">{(parseFloat(pos.curPrice) * 100).toFixed(1)}¢</td>
                        <td className="py-2 pr-3 font-mono text-zinc-400">{parseFloat(pos.totalBought).toFixed(2)}</td>
                        <td className="py-2 pr-3 font-mono">
                          <span className={cn("font-bold", isWin ? "text-green-400" : rpnl < 0 ? "text-red-400" : "text-zinc-500")}>
                            {rpnl >= 0 ? "+" : ""}${rpnl.toFixed(2)}
                          </span>
                        </td>
                        <td className="py-2 font-mono text-zinc-500 text-[10px]">
                          {pos.timestamp ? new Date(pos.timestamp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Divergence Stats ── */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
          <Zap className="w-4 h-4 text-yellow-400" />
          Divergence (Price Lag) Performance
          {tradeLog && (
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">
              {tradeLog.total} total trades tracked
            </span>
          )}
        </h3>

        {/* Top stat row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {[
            {
              label: "Overall Win Rate",
              value: tradeLog ? `${tradeLog.winRate}%` : "—",
              sub: tradeLog ? `${tradeLog.wins}W / ${tradeLog.losses}L` : "no data",
              color: tradeLog && tradeLog.winRate >= 55 ? "text-green-400" : tradeLog && tradeLog.winRate > 0 ? "text-yellow-400" : "text-zinc-500",
            },
            {
              label: "Divergence Win Rate",
              value: tradeLog?.divergence.winRate != null ? `${tradeLog.divergence.winRate}%` : "—",
              sub: tradeLog ? `${tradeLog.divergence.wins}W / ${tradeLog.divergence.trades - tradeLog.divergence.wins}L (${tradeLog.divergence.trades} trades)` : "no data",
              color: tradeLog?.divergence.winRate != null
                ? tradeLog.divergence.winRate >= 60 ? "text-green-400" : tradeLog.divergence.winRate >= 50 ? "text-yellow-400" : "text-red-400"
                : "text-zinc-500",
            },
            {
              label: "Total PnL",
              value: tradeLog ? `${tradeLog.totalPnl >= 0 ? "+" : ""}$${tradeLog.totalPnl.toFixed(2)}` : "—",
              sub: "realized",
              color: tradeLog ? (tradeLog.totalPnl > 0 ? "text-green-400" : tradeLog.totalPnl < 0 ? "text-red-400" : "text-zinc-500") : "text-zinc-500",
            },
            {
              label: "Edge Status",
              value: tradeLog?.divergence.winRate != null
                ? tradeLog.divergence.winRate >= 60 ? "ACTIVE" : tradeLog.divergence.winRate >= 50 ? "MARGINAL" : "GONE"
                : "MEASURING",
              sub: tradeLog?.divergence.trades ? `${tradeLog.divergence.trades} signals fired` : "need 20+ trades",
              color: tradeLog?.divergence.winRate != null
                ? tradeLog.divergence.winRate >= 60 ? "text-green-400" : tradeLog.divergence.winRate >= 50 ? "text-yellow-400" : "text-red-400"
                : "text-zinc-500",
            },
          ].map(({ label, value, sub, color }) => (
            <div key={label} className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{label}</div>
              <div className={cn("text-xl font-mono font-bold", color)}>{value}</div>
              <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>

        {/* Divergence signal threshold guide */}
        <div className="flex items-center gap-3 mb-4 text-[10px]">
          <span className="text-zinc-600">Signal threshold:</span>
          {[
            { label: "STRONG", desc: "BTC $100+ in 30s", color: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" },
            { label: "MODERATE", desc: "BTC $60+ in 30s", color: "bg-orange-500/20 text-orange-300 border-orange-500/40" },
            { label: "WEAK", desc: "BTC $30+ in 30s", color: "bg-zinc-700 text-zinc-400 border-zinc-600" },
          ].map(({ label, desc, color }) => (
            <span key={label} className={cn("px-2 py-0.5 rounded-full border font-bold flex items-center gap-1", color)}>
              {label} <span className="font-normal opacity-70">{desc}</span>
            </span>
          ))}
        </div>

        {/* Recent divergence trades */}
        {tradeLog && tradeLog.entries.filter((e) => e.divergenceStrength === "STRONG" || e.divergenceStrength === "MODERATE").length > 0 ? (
          <>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2">Recent Divergence Trades</div>
            <div className="overflow-y-auto max-h-48">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                    <th className="pb-1.5 pr-3">Time</th>
                    <th className="pb-1.5 pr-3">Dir</th>
                    <th className="pb-1.5 pr-3">Strength</th>
                    <th className="pb-1.5 pr-3">BTC Δ30s</th>
                    <th className="pb-1.5 pr-3">YES Δ30s</th>
                    <th className="pb-1.5 pr-3">Conf</th>
                    <th className="pb-1.5 pr-3">Bet</th>
                    <th className="pb-1.5">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeLog.entries
                    .filter((e) => e.divergenceStrength === "STRONG" || e.divergenceStrength === "MODERATE")
                    .map((e, i) => (
                      <tr key={i} className="border-b border-zinc-800/40 hover:bg-zinc-800/30 transition-colors">
                        <td className="py-1.5 pr-3 font-mono text-zinc-500 text-[10px]">
                          {new Date(e.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={cn("font-bold", e.direction === "UP" ? "text-green-400" : "text-red-400")}>
                            {e.direction === "UP" ? "▲" : "▼"} {e.direction}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={cn(
                            "px-1.5 py-0.5 rounded-full text-[9px] font-bold border",
                            e.divergenceStrength === "STRONG"
                              ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40"
                              : "bg-orange-500/20 text-orange-300 border-orange-500/40"
                          )}>
                            {e.divergenceStrength}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-zinc-300">
                          {e.btcDelta30s != null ? `${e.btcDelta30s >= 0 ? "+" : ""}$${e.btcDelta30s.toFixed(0)}` : "—"}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-zinc-300">
                          {e.yesDelta30s != null ? `${e.yesDelta30s >= 0 ? "+" : ""}${e.yesDelta30s.toFixed(2)}¢` : "—"}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-zinc-400">{e.confidence}%</td>
                        <td className="py-1.5 pr-3 font-mono text-zinc-400">${e.betAmount.toFixed(2)}</td>
                        <td className="py-1.5 font-mono font-bold">
                          <span className={e.result === "WIN" ? "text-green-400" : "text-red-400"}>
                            {e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(2)}
                            <span className="ml-1 text-[9px] opacity-70">{e.result}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="text-center py-6 text-zinc-600 text-xs">
            {tradeLog
              ? "No divergence trades yet — bot will log STRONG/MODERATE signals automatically"
              : "Loading trade history…"}
          </div>
        )}
      </div>

      {/* ── Bot Decision Log ── */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4" />
          Bot Decision Log
          <span className="text-xs font-normal text-zinc-600 ml-1">({log.length} entries)</span>
        </h3>

        {log.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-6">No decisions yet. Start the bot to begin trading.</p>
        ) : (
          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            <AnimatePresence mode="popLayout">
              {log.map((entry, i) => (
                <motion.div
                  key={`${entry.timestamp}-${i}`}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "rounded-lg p-3 border text-xs",
                    entry.tradeExecuted
                      ? "bg-green-500/10 border-green-500/30"
                      : entry.error
                        ? "bg-red-500/10 border-red-500/20"
                        : "bg-zinc-800/60 border-zinc-700/40"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="text-zinc-500 font-mono text-[10px]">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>

                    {entry.decision === "TRADE" ? (
                      <span className={cn(
                        "font-bold px-1.5 py-0.5 rounded text-[10px]",
                        entry.direction === "UP" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                      )}>
                        {entry.direction === "UP" ? <TrendingUp className="w-3 h-3 inline mr-0.5" /> : <TrendingDown className="w-3 h-3 inline mr-0.5" />}
                        {entry.direction}
                      </span>
                    ) : (
                      <span className="bg-zinc-700 text-zinc-400 font-bold px-1.5 py-0.5 rounded text-[10px]">NO TRADE</span>
                    )}

                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-bold",
                      entry.riskLevel === "LOW" ? "bg-green-500/20 text-green-400" :
                      entry.riskLevel === "MEDIUM" ? "bg-yellow-500/20 text-yellow-400" :
                      "bg-red-500/20 text-red-400"
                    )}>
                      {entry.riskLevel}
                    </span>

                    {entry.confidence > 0 && (
                      <span className="text-zinc-400 font-mono">{entry.confidence}%</span>
                    )}
                    {entry.edge > 0 && (
                      <span className="text-zinc-500 font-mono">{entry.edge}¢ edge</span>
                    )}

                    {entry.tradeExecuted && (
                      <span className="text-green-400 font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        Traded ${entry.tradeAmount?.toFixed(2)} @ {entry.tradePrice ? (entry.tradePrice * 100).toFixed(1) : "?"}¢
                      </span>
                    )}
                    {entry.error && (
                      <span className="text-red-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {entry.error}
                      </span>
                    )}
                  </div>

                  <div className="text-zinc-500 text-[10px] truncate">{entry.market}</div>
                  <div className="text-zinc-600 text-[10px] mt-0.5 line-clamp-2">{entry.reasoning}</div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      </div>
      )}
    </div>
  );
}
