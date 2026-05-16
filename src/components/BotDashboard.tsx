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

const FIXED_TRADE_OPTIONS = [1, 2, 3, 4, 5, 10, 12, 15] as const;
const MIN_FIXED_TRADE_USDC = FIXED_TRADE_OPTIONS[0];
const MAX_FIXED_TRADE_USDC = FIXED_TRADE_OPTIONS[FIXED_TRADE_OPTIONS.length - 1];

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
  asset?: string; // always "BTC"
  divergence: { direction: string; strength: string; btcDelta30s: number; yesDelta30s: number; } | null;
  fastLoopMomentum: { direction: string; strength: string; vw: number; } | null;
  updatedAt: string;
}

interface BotStatus {
  enabled: boolean;
  running: boolean;
  sessionStartBalance: number | null;
  sessionTradesCount: number;
  windowElapsedSeconds: number;
  analyzedThisWindow: number;
  entrySnapshot: EntrySnapshot | null;

  config: {
    minConfidence: number;
    minEdge: number;
    maxBetUsdc: number;
    fixedTradeUsdc?: number;
    sessionLossLimit: number;
    entryWindowStart?: number;
    entryWindowEnd?: number;
    scanIntervalMs: number;
  };
  riskHalt?: {
    halted: boolean;
    reason: string;
    haltedAt: number;
  };
}

interface ManualAdviceSide {
  direction: "UP" | "DOWN";
  confidence: number;
  entryPrice: number | null;
  pWin: number | null;
  ev: number | null;
  evPctOfStake: number | null;
  passesPWinGate: boolean;
  passesEvGate: boolean;
  passesBothGates: boolean;
  imbalanceSignal: string | null;
}

interface ManualAdvice {
  ok: boolean;
  asset?: string;
  market?: string;
  windowElapsedSeconds?: number;
  windowRemainingSeconds?: number;
  calibratorReady?: boolean;
  gates?: { minPWin: number; minEdge: number };
  up?: ManualAdviceSide;
  down?: ManualAdviceSide;
  recommendation?: "UP" | "DOWN" | "NEITHER";
  recommendationReason?: string;
  updatedAt?: string;
  error?: string;
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
  orderId?: string | null;
  orderIds?: string[];
  matched?: boolean;
  matchedTradeTs?: string | null;
  matchedBy?: "asset" | "market_outcome" | null;
}

interface SessionHistoryPoint {
  index: number;
  timestamp: number;
  market: string;
  outcome: string;
  trade: number;
  cumulative: number;
  decision: "WIN" | "LOSS" | "FLAT";
  orderId?: string | null;
  orderIds?: string[];
  matched?: boolean;
  matchedTradeTs?: string | null;
}

interface PerformanceData {
  summary: PerformanceSummary;
  openPositions: OpenPosition[];
  closedPositions: ClosedPosition[];
  history?: SessionHistoryPoint[];
  sessionHistory?: SessionHistoryPoint[];
  sessionWindowDays?: number;
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

interface MarketHeatData {
  asset: string;
  fundingRate: number;
  fundingAnnualized: number;
  nextFundingTime: number;
  takerBuySellRatio: number;
  takerBuyVol: number;
  takerSellVol: number;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
  heatSignal: "EXTREME_LONG" | "LONG_HEAVY" | "NEUTRAL" | "SHORT_HEAVY" | "EXTREME_SHORT";
  squeezeRisk: "LONG_SQUEEZE" | "SHORT_SQUEEZE" | "NONE";
  updatedAt: number;
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
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [balance, setBalance] = useState<string>("—");
  const [controlLoading, setControlLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetConfLoading, setResetConfLoading] = useState(false);
  const [resetRiskLoading, setResetRiskLoading] = useState(false);
  const [manualAmountInput, setManualAmountInput] = useState<string>("");
  const [manualTradeLoading, setManualTradeLoading] = useState<"UP" | "DOWN" | null>(null);
  const [manualTradeMsg, setManualTradeMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [manualAdvice, setManualAdvice] = useState<ManualAdvice | null>(null);
  const [modeLoading, setModeLoading] = useState(false);
  const [tradeLog, setTradeLog] = useState<TradeLogStats | null>(null);
  const [sessionTradeLog, setSessionTradeLog] = useState<TradeLogStats | null>(null);
  const [confInput, setConfInput] = useState<string>("");
  const [edgeInput, setEdgeInput] = useState<string>("");
  const [fixedTradeInput, setFixedTradeInput] = useState<number | null>(null);
  const [winStartInput, setWinStartInput] = useState<string>("");
  const [winEndInput, setWinEndInput] = useState<string>("");
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [momentumHistory, setMomentumHistory] = useState<MomentumPoint[]>([]);
  const [notifStatus, setNotifStatus] = useState<{ telegram: boolean; discord: boolean } | null>(null);
  const [backtestData, setBacktestData] = useState<BacktestData | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [activeTab, setActiveTab] = useState<"dashboard" | "backtest" | "analytics">("dashboard");
  const [calibration, setCalibration] = useState<{
    ready: boolean;
    reason: string;
    nSamples: number;
    minTrades: number;
    buckets: Array<{ range: string; predicted: number; realized: number; n: number }>;
    model: {
      trainedAt: number;
      trainBrier: number;
      trainLogLoss: number;
      cvBrier: number | null;
      cvLogLoss: number | null;
      features?: string[];
      hyper?: any;
    } | null;
    thresholds: { minPWin: number; minEdge: number; requireCalibrator: boolean };
  } | null>(null);
  const [calibRetrainLoading, setCalibRetrainLoading] = useState(false);
  const [calibRetrainMsg, setCalibRetrainMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [learning, setLearning] = useState<LearningState | null>(null);
  const [assetsLoading] = useState(false);
  const [lossPenaltySaving, setLossPenaltySaving] = useState(false);
  const [ping, setPing] = useState<PingState | null>(null);
  const [pinging, setPinging] = useState(false);
  const [heatData, setHeatData] = useState<MarketHeatData | null>(null);
  const tradeBellRef = useRef<HTMLAudioElement | null>(null);
  const seenTradeBellKeysRef = useRef<Set<string>>(new Set());
  const tradeBellPrimedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, logRes, perfRes, autoRes, balRes, tradeLogRes, sessionTradeLogRes, momRes, notifRes, analyticsRes, calibRes, learningRes, heatRes] = await Promise.allSettled([
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
        fetch("/api/calibrator/status").then((r) => r.json()),
        fetch("/api/bot/learning").then((r) => r.json()),
        fetch("/api/market-heat/BTC").then((r) => r.ok ? r.json() : null).catch(() => null),
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
      if (calibRes.status === "fulfilled") setCalibration(calibRes.value as any);
      if (learningRes.status === "fulfilled") setLearning(learningRes.value as LearningState);
      if (heatRes.status === "fulfilled" && heatRes.value) setHeatData(heatRes.value as MarketHeatData);
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();

    const es = new EventSource("/api/bot/events");
    es.addEventListener("cycle", () => fetchAll());
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

  // Poll manual-trade advice every 5s while the dashboard is mounted.
  useEffect(() => {
    let cancelled = false;
    const fetchAdvice = async () => {
      try {
        const res = await fetch("/api/bot/manual-advice");
        const data = await res.json();
        if (!cancelled) setManualAdvice(data);
      } catch {
        if (!cancelled) setManualAdvice({ ok: false, error: "Advice fetch failed" });
      }
    };
    fetchAdvice();
    const id = window.setInterval(fetchAdvice, 5_000);
    return () => { cancelled = true; window.clearInterval(id); };
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

  const handleResetRisk = async () => {
    setResetRiskLoading(true);
    try {
      await fetch("/api/risk/reset", { method: "POST" });
      await fetchAll();
    } finally {
      setResetRiskLoading(false);
    }
  };

  const handleManualTrade = async (direction: "UP" | "DOWN") => {
    setManualTradeLoading(direction);
    setManualTradeMsg(null);
    try {
      const amountRaw = manualAmountInput.trim();
      const body: { direction: "UP" | "DOWN"; amount?: number } = { direction };
      if (amountRaw !== "") {
        const n = Number(amountRaw);
        if (Number.isFinite(n) && n > 0) body.amount = n;
      }
      const res = await fetch("/api/bot/manual-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setManualTradeMsg({ type: "err", text: data.error || `HTTP ${res.status}` });
      } else {
        setManualTradeMsg({
          type: "ok",
          text: `Order ${data.orderId} | ${direction === "UP" ? "▲ UP" : "▼ DOWN"} @ ${(data.entryPrice * 100).toFixed(1)}¢ | $${data.spent.toFixed(2)}`,
        });
      }
      await fetchAll();
    } catch (err: any) {
      setManualTradeMsg({ type: "err", text: err?.message || "Manual trade failed" });
    } finally {
      setManualTradeLoading(null);
      setTimeout(() => setManualTradeMsg(null), 6000);
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
    const fixedTradeUsdc = fixedTradeInput;
    const winStart = winStartInput !== "" ? Number(winStartInput) : null;
    const winEnd = winEndInput !== "" ? Number(winEndInput) : null;
    if (conf !== null && (isNaN(conf) || conf < 50 || conf > 99)) return;
    if (edge !== null && (isNaN(edge) || edge < 0.01 || edge > 0.50)) return;
    if (
      fixedTradeUsdc !== null &&
      (!Number.isInteger(fixedTradeUsdc) ||
        fixedTradeUsdc < MIN_FIXED_TRADE_USDC ||
        fixedTradeUsdc > MAX_FIXED_TRADE_USDC)
    ) {
      return;
    }
    if (winStart !== null && (isNaN(winStart) || winStart < 0 || winStart > 120)) return;
    if (winEnd !== null && (isNaN(winEnd) || winEnd < 180 || winEnd > 295)) return;
    setConfigError(null);
    setConfigSaved(false);
    setConfigSaving(true);
    try {
      const response = await fetch("/api/bot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conf !== null && { minConfidence: conf }),
          ...(edge !== null && { minEdge: edge }),
          ...(fixedTradeUsdc !== null && { fixedTradeUsdc }),
          ...(winStart !== null && { entryWindowStart: winStart }),
          ...(winEnd !== null && { entryWindowEnd: winEnd }),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || "Failed to update bot config.");
      }
      if (
        fixedTradeUsdc !== null &&
        Number(payload?.config?.fixedTradeUsdc) !== fixedTradeUsdc
      ) {
        throw new Error(
          `Config mismatch: expected $${fixedTradeUsdc.toFixed(2)}, got $${Number(payload?.config?.fixedTradeUsdc || 0).toFixed(2)}.`
        );
      }
      if (payload?.config) {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                config: {
                  ...prev.config,
                  ...payload.config,
                },
              }
            : prev
        );
      }
      setFixedTradeInput(null);
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 2000);
      await fetchAll();
    } catch (error: any) {
      setConfigError(error?.message || "Failed to update bot config.");
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

  const handleRetrainCalibrator = async (source: "live" | "synthetic" | "both") => {
    setCalibRetrainLoading(true);
    setCalibRetrainMsg(null);
    try {
      const res = await fetch("/api/calibrator/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setCalibRetrainMsg({ type: "err", text: data.error || `HTTP ${res.status}` });
      } else if (!data.ok) {
        setCalibRetrainMsg({ type: "err", text: data.state?.reason || "Model not ready" });
      } else {
        const cv = data.state?.model?.cvBrier;
        setCalibRetrainMsg({
          type: "ok",
          text: `Trained on ${data.labeledSamples} samples (${source}) · CV Brier ${cv != null ? cv.toFixed(4) : "n/a"}`,
        });
      }
      await fetchAll();
    } catch (err: any) {
      setCalibRetrainMsg({ type: "err", text: err?.message || "Retrain failed" });
    } finally {
      setCalibRetrainLoading(false);
      setTimeout(() => setCalibRetrainMsg(null), 8000);
    }
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
  const entryZone = windowSeconds >= (status?.config.entryWindowStart ?? 10) && windowSeconds <= (status?.config.entryWindowEnd ?? 280);

  const sessionPnl =
    status?.sessionStartBalance != null
      ? parseFloat(balance) - status.sessionStartBalance
      : null;

  const armedCount = automations.filter((a) => a.armed).length;

  // Prefer the server-side history synced to Closed Positions; fall back to trade log when unavailable.
  const [pnlDateFrom, setPnlDateFrom] = useState<string>("");
  const [pnlDateTo, setPnlDateTo] = useState<string>("");

  const pnlHistory = useMemo(() => {
    const syncedHistory = performance?.sessionHistory?.length
      ? performance.sessionHistory
      : performance?.history?.length
        ? performance.history
        : null;

    if (syncedHistory?.length) {
      return syncedHistory.map((entry, i) => {
        const labelTime = entry.matchedTradeTs
          ? new Date(entry.matchedTradeTs)
          : entry.timestamp
            ? new Date(entry.timestamp * 1000)
            : null;
        return {
          label: `#${i + 1}`,
          time: labelTime
            ? labelTime.toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })
            : `#${i + 1}`,
          tsMs: labelTime ? labelTime.getTime() : null,
          trade: entry.trade,
          cumulative: entry.cumulative,
          decision: entry.decision,
        };
      });
    }

    const results = [...(sessionTradeLog?.entries ?? [])]
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

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
        tsMs: new Date(entry.ts).getTime(),
        trade: tradePnl,
        cumulative,
        decision: entry.result,
      };
    });
  }, [performance?.history, performance?.sessionHistory, sessionTradeLog]);

  const filteredPnlHistory = useMemo(() => {
    const fromMs = pnlDateFrom ? new Date(pnlDateFrom).getTime() : null;
    const toMs   = pnlDateTo   ? new Date(pnlDateTo).getTime() + 86400_000 - 1 : null; // inclusive end of day
    if (!fromMs && !toMs) return pnlHistory;
    const filtered = pnlHistory.filter((e) => {
      if (e.tsMs == null) return true;
      if (fromMs && e.tsMs < fromMs) return false;
      if (toMs   && e.tsMs > toMs)   return false;
      return true;
    });
    // recompute cumulative for the filtered window
    let cum = 0;
    return filtered.map((e, i) => {
      cum = parseFloat((cum + e.trade).toFixed(2));
      return { ...e, label: `#${i + 1}`, cumulative: cum };
    });
  }, [pnlHistory, pnlDateFrom, pnlDateTo]);

  const lastCumulative = filteredPnlHistory.length > 0 ? filteredPnlHistory[filteredPnlHistory.length - 1].cumulative : 0;
  const sessionWindowDays = performance?.sessionWindowDays ?? 7;
  const isDateFiltered = pnlDateFrom || pnlDateTo;
  const sessionPnlSubtitle = isDateFiltered
    ? `${filteredPnlHistory.length} trade${filteredPnlHistory.length !== 1 ? "s" : ""} in range`
    : performance?.sessionHistory?.length || performance?.history?.length
      ? `last ${sessionWindowDays} days · synced with Closed Positions · ${pnlHistory.length} resolved trade${pnlHistory.length !== 1 ? "s" : ""}`
      : `last ${sessionWindowDays} days · ${pnlHistory.length} resolved trade${pnlHistory.length !== 1 ? "s" : ""}`;

  return (
    <div className="space-y-6">
      {/* ── Header Row ── */}
      <div className="flex flex-wrap gap-4 items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-400" />
            Bot Control Center
          </h2>
          <p className="text-zinc-500 text-sm mt-0.5">Automated 5-minute BTC prediction market trading engine</p>
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

      {/* ── Market Heat ── */}
      {heatData && (
        <div className="glass-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              <Flame className="w-4 h-4 text-orange-400" />
              Market Heat — BTC
            </h3>
            <div className="flex items-center gap-2">
              <span className={cn(
                "px-2 py-0.5 rounded text-[10px] font-bold border",
                heatData.heatSignal === "EXTREME_LONG" ? "bg-red-500/10 text-red-400 border-red-500/30" :
                heatData.heatSignal === "LONG_HEAVY" ? "bg-orange-500/10 text-orange-400 border-orange-500/30" :
                heatData.heatSignal === "SHORT_HEAVY" ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30" :
                heatData.heatSignal === "EXTREME_SHORT" ? "bg-blue-500/10 text-blue-400 border-blue-500/30" :
                "bg-zinc-700/50 text-zinc-400 border-zinc-600/30"
              )}>
                {heatData.heatSignal.replace("_", " ")}
              </span>
              {heatData.squeezeRisk !== "NONE" && (
                <span className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-bold border animate-pulse",
                  heatData.squeezeRisk === "LONG_SQUEEZE" ? "bg-green-500/10 text-green-400 border-green-500/30" :
                  "bg-red-500/10 text-red-400 border-red-500/30"
                )}>
                  {heatData.squeezeRisk.replace("_", " ")}
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Funding Rate</div>
              <div className={cn("text-lg font-mono font-bold", heatData.fundingRate > 0.0003 ? "text-red-400" : heatData.fundingRate < -0.0003 ? "text-cyan-400" : "text-zinc-300")}>
                {(heatData.fundingRate * 100).toFixed(4)}%
              </div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {(heatData.fundingAnnualized * 100).toFixed(1)}% ann.
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Taker Buy/Sell</div>
              <div className={cn("text-lg font-mono font-bold", heatData.takerBuySellRatio > 1.2 ? "text-green-400" : heatData.takerBuySellRatio < 0.8 ? "text-red-400" : "text-zinc-300")}>
                {heatData.takerBuySellRatio.toFixed(2)}
              </div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {(heatData.takerBuyVol / 1000).toFixed(0)}K / {(heatData.takerSellVol / 1000).toFixed(0)}K
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Long/Short Ratio</div>
              <div className={cn("text-lg font-mono font-bold", heatData.longShortRatio > 1.5 ? "text-red-400" : heatData.longShortRatio < 0.67 ? "text-cyan-400" : "text-zinc-300")}>
                {heatData.longShortRatio.toFixed(2)}
              </div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {(heatData.longAccount * 100).toFixed(1)}% long
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Signal Impact</div>
              <div className="text-xs text-zinc-300 leading-relaxed">
                {heatData.heatSignal === "EXTREME_LONG" ? "Crowd heavily long. Contrarian fade UP." :
                 heatData.heatSignal === "LONG_HEAVY" ? "More longs than shorts. Capped upside." :
                 heatData.heatSignal === "EXTREME_SHORT" ? "Crowd heavily short. Contrarian fade DOWN." :
                 heatData.heatSignal === "SHORT_HEAVY" ? "More shorts than longs. Capped downside." :
                 "Balanced positioning. No crowd bias."}
              </div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700/50">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Squeeze Risk</div>
              <div className={cn("text-lg font-mono font-bold", heatData.squeezeRisk !== "NONE" ? "text-yellow-400" : "text-zinc-500")}>
                {heatData.squeezeRisk === "NONE" ? "None" : heatData.squeezeRisk.replace("_", " ")}
              </div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {heatData.squeezeRisk === "LONG_SQUEEZE" ? "Shorts may squeeze longs UP" :
                 heatData.squeezeRisk === "SHORT_SQUEEZE" ? "Longs may squeeze shorts DOWN" :
                 "No extreme funding detected"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Session PnL Chart ── */}
      <div className="glass-card p-4 w-full">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <LineChartIcon className="w-4 h-4" />
            Session PnL
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">
              {sessionPnlSubtitle}
            </span>
          </h3>
          <div className="flex items-center gap-2">
            {filteredPnlHistory.length > 0 && (
              <span className={cn(
                "text-sm font-mono font-bold",
                lastCumulative > 0 ? "text-green-400" : lastCumulative < 0 ? "text-red-400" : "text-zinc-400"
              )}>
                {lastCumulative > 0 ? "+" : ""}{lastCumulative.toFixed(2)} USDC
              </span>
            )}
          </div>
        </div>

        {/* ── Date range filter ── */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Filter:</span>
          <input
            type="date"
            title="From date"
            value={pnlDateFrom}
            onChange={(e) => setPnlDateFrom(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500"
          />
          <span className="text-zinc-600 text-xs">→</span>
          <input
            type="date"
            title="To date"
            value={pnlDateTo}
            onChange={(e) => setPnlDateTo(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500"
          />
          {isDateFiltered && (
            <button
              type="button"
              onClick={() => { setPnlDateFrom(""); setPnlDateTo(""); }}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 underline transition-colors"
            >
              reset
            </button>
          )}
        </div>

        {filteredPnlHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 gap-2 text-zinc-700">
            <BarChart3 className="w-8 h-8 opacity-30" />
            <p className="text-xs">{isDateFiltered ? "No trades in selected range" : "No resolved trades available yet"}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={filteredPnlHistory} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                  const isFlat = payload.decision === "FLAT";
                  return (
                    <circle
                      key={`dot-${cx}-${cy}`}
                      cx={cx}
                      cy={cy}
                      r={4.5}
                      fill={isFlat ? "#a1a1aa" : isWin ? "#22c55e" : "#ef4444"}
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
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-purple-400" />
            Auto-Calibrator
            {calibration ? (
              <span className={cn(
                "ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full border uppercase tracking-wider",
                calibration.ready
                  ? "bg-green-500/10 text-green-300 border-green-500/40"
                  : "bg-amber-500/10 text-amber-300 border-amber-500/40"
              )}>
                {calibration.ready ? "Ready" : "Not Ready"}
              </span>
            ) : (
              <span className="ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full border bg-zinc-800 text-zinc-500 border-zinc-700 uppercase tracking-wider animate-pulse">Loading…</span>
            )}
          </h3>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleRetrainCalibrator("both")}
              disabled={calibRetrainLoading}
              title="Retrain on live trades + synthetic candle samples"
              className={cn(
                "px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors",
                "bg-purple-600 text-white hover:bg-purple-500",
                calibRetrainLoading && "opacity-50 cursor-wait"
              )}
            >
              {calibRetrainLoading ? "Training…" : "Retrain"}
            </button>
            <button
              type="button"
              onClick={() => handleRetrainCalibrator("live")}
              disabled={calibRetrainLoading}
              title="Retrain on live trades only (skip synthetic)"
              className={cn(
                "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors",
                "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700",
                calibRetrainLoading && "opacity-50 cursor-wait"
              )}
            >
              Live
            </button>
            <button
              type="button"
              onClick={() => handleRetrainCalibrator("synthetic")}
              disabled={calibRetrainLoading}
              title="Retrain on synthetic candle samples only"
              className={cn(
                "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors",
                "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700",
                calibRetrainLoading && "opacity-50 cursor-wait"
              )}
            >
              Synth
            </button>
          </div>
        </div>

        {!calibration ? (
          <p className="text-[11px] text-zinc-600 animate-pulse">Fetching calibrator status…</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Samples</span>
                <span className={cn(
                  "font-bold text-base",
                  calibration.nSamples >= calibration.minTrades ? "text-green-400" : "text-amber-400"
                )}>
                  {calibration.nSamples}
                  <span className="text-zinc-600 text-[10px] font-normal"> / {calibration.minTrades} min</span>
                </span>
              </div>
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">CV Brier</span>
                <span className={cn(
                  "font-bold text-base font-mono",
                  calibration.model?.cvBrier == null ? "text-zinc-500"
                    : calibration.model.cvBrier <= 0.20 ? "text-green-400"
                    : calibration.model.cvBrier <= 0.25 ? "text-yellow-400"
                    : "text-red-400"
                )}>
                  {calibration.model?.cvBrier != null ? calibration.model.cvBrier.toFixed(4) : "—"}
                </span>
              </div>
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Min pWin Gate</span>
                <span className="font-bold text-base font-mono text-blue-400">
                  {(calibration.thresholds.minPWin * 100).toFixed(0)}%
                </span>
              </div>
              <div className="bg-zinc-800/60 rounded-lg p-2 flex flex-col gap-0.5">
                <span className="text-zinc-500 text-[9px] uppercase tracking-wider">Min EV Gate</span>
                <span className="font-bold text-base font-mono text-blue-400">
                  {(calibration.thresholds.minEdge * 100).toFixed(1)}¢
                </span>
              </div>
            </div>

            {calibration.buckets && calibration.buckets.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">Buckets — declared vs realized win rate</span>
                <div className="grid grid-cols-4 gap-1">
                  {calibration.buckets.map((b) => {
                    const drift = Math.abs(b.predicted - b.realized);
                    const driftColor = b.n < 5 ? "text-zinc-500 border-zinc-700"
                      : drift <= 8 ? "text-green-300 border-green-500/30"
                      : drift <= 15 ? "text-yellow-300 border-yellow-500/30"
                      : "text-red-300 border-red-500/30";
                    return (
                      <div key={b.range} className={cn("rounded p-1.5 border bg-zinc-900/50 flex flex-col gap-0.5", driftColor)}>
                        <span className="text-[9px] uppercase tracking-wider opacity-60">{b.range}</span>
                        <span className="text-[10px] font-mono">
                          {b.predicted.toFixed(0)}% → <span className="font-bold">{b.realized.toFixed(0)}%</span>
                        </span>
                        <span className="text-[9px] opacity-60">n={b.n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="text-[10px] text-zinc-500 italic">
              {calibration.reason || (calibration.ready ? "Calibrator gating trades." : "Calibrator not ready — bot using fallback gate.")}
            </p>
            {calibration.model?.trainedAt && (
              <p className="text-[9px] text-zinc-700">
                Trained {new Date(calibration.model.trainedAt).toLocaleString()}
                {calibration.thresholds.requireCalibrator && " · BOT_REQUIRE_CALIBRATOR=true (hard gate)"}
              </p>
            )}
            {calibRetrainMsg && (
              <div className={cn(
                "text-[11px] font-mono px-2 py-1.5 rounded border",
                calibRetrainMsg.type === "ok"
                  ? "bg-green-500/10 text-green-300 border-green-500/30"
                  : "bg-red-500/10 text-red-300 border-red-500/30"
              )}>
                {calibRetrainMsg.type === "ok" ? "✓ " : "✗ "}{calibRetrainMsg.text}
              </div>
            )}
          </div>
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
          {status?.riskHalt?.halted && (
            <div className="text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded p-1.5 leading-tight">
              <span className="font-bold">🛑 RISK HALT:</span> {status.riskHalt.reason}
            </div>
          )}
          <button
            type="button"
            onClick={handleResetRisk}
            disabled={resetRiskLoading}
            title="Clear risk halt state and re-enable trading"
            className={cn(
              "w-full py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all",
              status?.riskHalt?.halted
                ? "bg-amber-500 text-black hover:bg-amber-400"
                : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700 hover:text-white",
              resetRiskLoading && "opacity-50 cursor-wait"
            )}
          >
            {resetRiskLoading ? "Resetting…" : "Reset Risk State"}
          </button>
          <div className="text-[10px] text-zinc-600 space-y-0.5">
            <div className="flex items-center gap-2">
              <span>Conf ≥{status?.config.minConfidence ?? 70}% | Headroom ≥{((status?.config.minEdge ?? 0.10) * 100).toFixed(0)}¢ | Window {status?.config.entryWindowStart ?? 10}s–{status?.config.entryWindowEnd ?? 280}s</span>
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
            {/* Min Headroom */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Min Headroom</span>
                <span className="font-mono text-blue-400">
                  {edgeInput !== "" ? `${(Number(edgeInput) * 100).toFixed(0)}¢` : `${((status?.config.minEdge ?? 0.10) * 100).toFixed(0)}¢ (aktif)`}
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
                <span>1¢</span><span>10¢</span><span>20¢</span><span>30¢</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Fixed Trade Size</span>
                <span className="font-mono text-amber-400">
                  ${(fixedTradeInput ?? status?.config.fixedTradeUsdc ?? 1).toFixed(2)}
                  {fixedTradeInput !== null ? " (dipilih)" : " (aktif)"}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {FIXED_TRADE_OPTIONS.map((amount) => {
                  const selected = (fixedTradeInput ?? status?.config.fixedTradeUsdc ?? 1) === amount;
                  return (
                    <button
                      key={amount}
                      type="button"
                      onClick={() => setFixedTradeInput(amount)}
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
              <div className="text-[9px] text-zinc-600">
                Nominal buy per trade. Default awal tetap diambil dari `.env`, tapi pilihan ini override runtime.
                {fixedTradeInput !== null && fixedTradeInput !== (status?.config.fixedTradeUsdc ?? 1)
                  ? ` Klik Apply untuk aktifkan $${fixedTradeInput.toFixed(2)}.`
                  : ""}
              </div>
            </div>
            {/* Entry Window */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-400">Entry Window</span>
                <span className="font-mono text-purple-400">
                  {winStartInput !== "" || winEndInput !== ""
                    ? `${winStartInput !== "" ? winStartInput : status?.config.entryWindowStart ?? 10}s–${winEndInput !== "" ? winEndInput : status?.config.entryWindowEnd ?? 280}s`
                    : `${status?.config.entryWindowStart ?? 10}s–${status?.config.entryWindowEnd ?? 280}s (aktif)`}
                </span>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-[9px] text-zinc-600 block mb-1">Start</label>
                  <input
                    type="range"
                    min={0} max={120} step={5}
                    value={winStartInput !== "" ? Number(winStartInput) : (status?.config.entryWindowStart ?? 10)}
                    onChange={(e) => setWinStartInput(e.target.value)}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-purple-500 bg-zinc-700"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-600 font-mono mt-1">
                    <span>0s</span><span>60s</span><span>120s</span>
                  </div>
                </div>
                <div className="flex-1">
                  <label className="text-[9px] text-zinc-600 block mb-1">End</label>
                  <input
                    type="range"
                    min={180} max={295} step={5}
                    value={winEndInput !== "" ? Number(winEndInput) : (status?.config.entryWindowEnd ?? 280)}
                    onChange={(e) => setWinEndInput(e.target.value)}
                    className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-purple-500 bg-zinc-700"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-600 font-mono mt-1">
                    <span>180s</span><span>240s</span><span>295s</span>
                  </div>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSaveConfig}
              disabled={configSaving || (confInput === "" && edgeInput === "" && fixedTradeInput === null && winStartInput === "" && winEndInput === "")}
              className="w-full py-1.5 rounded-lg text-xs font-bold transition-all bg-zinc-700 text-zinc-300 hover:bg-emerald-600 hover:text-white disabled:opacity-40 disabled:cursor-default"
            >
              {configSaving ? "Saving…" : configSaved ? "✓ Saved" : "Apply"}
            </button>
            {configError && (
              <div className="text-[10px] text-red-400">{configError}</div>
            )}
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
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 bg-orange-500/15 text-orange-400 border-orange-500/30">{snap.asset}</span>
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
                      snap.confidence >= 65 ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : snap.confidence >= 55 ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    )}>
                      Conf {snap.confidence}%
                    </span>
                  )}
                  {snap.edge !== null && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">
                      Headroom {(snap.edge * 100).toFixed(1)}¢
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
                  {entryPrice !== null && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-blue-500/10 text-blue-400 border border-blue-500/30">
                      Entry {(entryPrice * 100).toFixed(1)}¢
                    </span>
                  )}
                  {snap.estimatedBet !== null && snap.estimatedBet > 0 && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-purple-500/10 text-purple-400 border border-purple-500/30">
                      ${snap.estimatedBet.toFixed(2)} fixed
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
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Manual Entry (FastLoop Momentum) ── */}
      {(() => {
        const snap = status?.entrySnapshot;
        // Prefer live advice (always-on, self-discovers market). Fall back to snapshot.
        const yesPrice = manualAdvice?.up?.entryPrice   ?? snap?.yesPrice ?? null;
        const noPrice  = manualAdvice?.down?.entryPrice ?? snap?.noPrice  ?? null;
        const fm = snap?.fastLoopMomentum ?? null;
        const fmDir = fm?.direction;
        const fmStr = fm?.strength;
        const fmColor =
          fmDir === "UP"   ? "text-green-400 border-green-500/30 bg-green-500/10" :
          fmDir === "DOWN" ? "text-red-400 border-red-500/30 bg-red-500/10" :
                             "text-zinc-400 border-zinc-700 bg-zinc-800/40";
        const defaultBet = status?.config.fixedTradeUsdc ?? 1;
        const marketName = manualAdvice?.market ?? snap?.market ?? null;
        const assetTag = manualAdvice?.asset ?? snap?.asset ?? null;
        // Buttons are ready when EITHER advice has a market OR the bot snapshot exists.
        const ready = !!(manualAdvice?.ok && manualAdvice.market) || !!snap;
        return (
          <div className="glass-card p-4 w-full border border-amber-500/20">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold uppercase tracking-wider text-amber-300 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                Manual Entry — FastLoop Momentum
              </h3>
              {fm && (
                <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider", fmColor)}>
                  {fmDir} · {fmStr} · vw={fm.vw.toFixed(3)}%
                </span>
              )}
            </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-zinc-500 truncate">{marketName ?? "Discovering current 5m market…"}</span>
                  {assetTag && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-orange-500/15 text-orange-400 border-orange-500/30">{assetTag}</span>
                  )}
                  {!status?.enabled && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-zinc-800 text-zinc-500 border-zinc-700">BOT OFF — manual still works</span>
                  )}
                  {manualAdvice?.ok && manualAdvice.windowRemainingSeconds !== undefined && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-zinc-800 text-zinc-400 border-zinc-700 font-mono">
                      Window {Math.max(0, manualAdvice.windowRemainingSeconds)}s left
                    </span>
                  )}
                </div>

                {/* ── Probability advice (calibrated pWin) ── */}
                {(() => {
                  if (!manualAdvice) {
                    return <div className="text-[10px] text-zinc-600">Loading advice…</div>;
                  }
                  if (!manualAdvice.ok) {
                    return (
                      <div className="text-[10px] text-zinc-500 bg-zinc-900/50 border border-zinc-800 rounded px-2 py-1.5">
                        Advice unavailable: {manualAdvice.error || "unknown"}
                      </div>
                    );
                  }
                  if (manualAdvice.calibratorReady === false) {
                    return (
                      <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5">
                        ⚠ Calibrator not trained yet — pWin advice unavailable. Train via <span className="font-mono">POST /api/calibrator/train</span>.
                      </div>
                    );
                  }
                  const up = manualAdvice.up;
                  const down = manualAdvice.down;
                  const rec = manualAdvice.recommendation;
                  const pWinColor = (p: number | null | undefined) =>
                    p == null ? "text-zinc-500 border-zinc-700 bg-zinc-800/40"
                    : p >= 0.60 ? "text-green-300 border-green-500/40 bg-green-500/10"
                    : p >= (manualAdvice.gates?.minPWin ?? 0.55) ? "text-lime-300 border-lime-500/40 bg-lime-500/10"
                    : p >= 0.45 ? "text-yellow-300 border-yellow-500/40 bg-yellow-500/10"
                    : "text-red-300 border-red-500/40 bg-red-500/10";
                  const evColor = (ev: number | null | undefined) =>
                    ev == null ? "text-zinc-500"
                    : ev >= (manualAdvice.gates?.minEdge ?? 0.05) ? "text-green-300"
                    : ev >= 0 ? "text-yellow-300"
                    : "text-red-300";
                  const renderSide = (side: ManualAdviceSide | undefined, label: string, accent: string) => {
                    if (!side) return null;
                    const isRec = rec === side.direction;
                    return (
                      <div className={cn(
                        "rounded-xl p-3 border flex flex-col gap-1.5",
                        isRec ? "border-amber-500/50 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/40"
                      )}>
                        <div className="flex items-center justify-between">
                          <span className={cn("text-[10px] uppercase tracking-widest font-bold", accent)}>{label}</span>
                          {isRec && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500 text-black uppercase tracking-wider">Rec</span>
                          )}
                          {!isRec && side.passesBothGates && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-300 border border-green-500/40">+EV</span>
                          )}
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-[9px] uppercase text-zinc-500">pWin</span>
                          <span className={cn(
                            "text-2xl font-mono font-bold px-1.5 py-0 rounded border",
                            pWinColor(side.pWin)
                          )}>
                            {side.pWin !== null ? `${(side.pWin * 100).toFixed(1)}%` : "—"}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono">
                          <span className="text-zinc-500">Entry <span className="text-zinc-300">{side.entryPrice !== null ? `${(side.entryPrice * 100).toFixed(1)}¢` : "—"}</span></span>
                          <span className="text-zinc-500">EV <span className={evColor(side.ev)}>{side.ev !== null ? `${side.ev >= 0 ? "+" : ""}${(side.ev * 100).toFixed(1)}¢` : "—"}</span></span>
                          {side.evPctOfStake !== null && (
                            <span className="text-zinc-500">ROI <span className={evColor(side.ev)}>{side.evPctOfStake >= 0 ? "+" : ""}{side.evPctOfStake.toFixed(0)}%</span></span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1 text-[9px]">
                          <span className={cn(
                            "px-1.5 py-0.5 rounded border font-bold uppercase tracking-wide",
                            side.passesPWinGate ? "bg-green-500/10 text-green-300 border-green-500/40" : "bg-zinc-800 text-zinc-500 border-zinc-700"
                          )}>
                            pWin gate {side.passesPWinGate ? "✓" : "✗"}
                          </span>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded border font-bold uppercase tracking-wide",
                            side.passesEvGate ? "bg-green-500/10 text-green-300 border-green-500/40" : "bg-zinc-800 text-zinc-500 border-zinc-700"
                          )}>
                            EV gate {side.passesEvGate ? "✓" : "✗"}
                          </span>
                          {side.imbalanceSignal && (
                            <span className={cn(
                              "px-1.5 py-0.5 rounded border font-bold uppercase tracking-wide",
                              side.imbalanceSignal === "BUY_PRESSURE" ? "bg-green-500/10 text-green-300 border-green-500/40"
                              : side.imbalanceSignal === "SELL_PRESSURE" ? "bg-red-500/10 text-red-300 border-red-500/40"
                              : "bg-zinc-800 text-zinc-400 border-zinc-700"
                            )}>
                              {side.imbalanceSignal.replace("_", " ")}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  };
                  return (
                    <div className="flex flex-col gap-2">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {renderSide(up,   "BUY UP (YES)",  "text-green-400")}
                        {renderSide(down, "BUY DOWN (NO)", "text-red-400")}
                      </div>
                      {manualAdvice.recommendationReason && (
                        <div className={cn(
                          "text-[10px] px-2 py-1 rounded border",
                          rec === "NEITHER" ? "bg-zinc-900/50 text-zinc-400 border-zinc-800"
                          : "bg-amber-500/10 text-amber-200 border-amber-500/30"
                        )}>
                          <span className="font-bold uppercase tracking-wider mr-1">Rec:</span>
                          {rec === "NEITHER" ? "Skip" : rec} — {manualAdvice.recommendationReason}
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="flex items-end gap-3 flex-wrap">
                  <label className="flex flex-col gap-1">
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">Amount (USDC)</span>
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      inputMode="decimal"
                      value={manualAmountInput}
                      onChange={(e) => setManualAmountInput(e.target.value)}
                      placeholder={`default $${defaultBet.toFixed(2)}`}
                      className="w-32 bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-amber-500/60"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => handleManualTrade("UP")}
                    disabled={!ready || manualTradeLoading !== null}
                    title="BUY YES (UP) on current market"
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all",
                      "bg-green-500 text-black hover:bg-green-400",
                      (!ready || manualTradeLoading !== null) && "opacity-40 cursor-not-allowed hover:bg-green-500"
                    )}
                  >
                    <TrendingUp className="w-4 h-4" />
                    {manualTradeLoading === "UP" ? "Sending…" : "BUY UP"}
                    {yesPrice !== null && (
                      <span className="font-mono text-xs opacity-80">@{(yesPrice * 100).toFixed(1)}¢</span>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleManualTrade("DOWN")}
                    disabled={!ready || manualTradeLoading !== null}
                    title="BUY NO (DOWN) on current market"
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all",
                      "bg-red-500 text-white hover:bg-red-400",
                      (!ready || manualTradeLoading !== null) && "opacity-40 cursor-not-allowed hover:bg-red-500"
                    )}
                  >
                    <TrendingDown className="w-4 h-4" />
                    {manualTradeLoading === "DOWN" ? "Sending…" : "BUY DOWN"}
                    {noPrice !== null && (
                      <span className="font-mono text-xs opacity-80">@{(noPrice * 100).toFixed(1)}¢</span>
                    )}
                  </button>
                </div>

                <div className="text-[10px] text-zinc-600">
                  Direction kamu yang pilih — FastLoop hanya advisory. Order dieksekusi AGGRESSIVE @ best ask, TP/SL/TS otomatis ter-arm.
                </div>

                {manualTradeMsg && (
                  <div className={cn(
                    "text-[11px] font-mono px-2 py-1.5 rounded border",
                    manualTradeMsg.type === "ok"
                      ? "bg-green-500/10 text-green-300 border-green-500/30"
                      : "bg-red-500/10 text-red-300 border-red-500/30"
                  )}>
                    {manualTradeMsg.type === "ok" ? "✓ " : "✗ "}{manualTradeMsg.text}
                  </div>
                )}
              </div>
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
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">
              ({performance.closedPositions.length} in last {sessionWindowDays}d)
            </span>
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
              label: "Signal Status",
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
