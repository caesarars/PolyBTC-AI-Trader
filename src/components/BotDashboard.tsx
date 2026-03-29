import { useState, useEffect, useCallback, useMemo } from "react";
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
  divergence: { direction: string; strength: string; btcDelta30s: number; yesDelta30s: number; } | null;
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
    mode: "AGGRESSIVE" | "CONSERVATIVE";
    minConfidence: number;
    minEdge: number;
    kellyFraction: number;
    maxBetUsdc: number;
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

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, logRes, perfRes, autoRes, balRes, tradeLogRes] = await Promise.allSettled([
        fetch("/api/bot/status").then((r) => r.json()),
        fetch("/api/bot/log").then((r) => r.json()),
        fetch("/api/polymarket/performance").then((r) => r.json()),
        fetch("/api/polymarket/automation").then((r) => r.json()),
        fetch("/api/polymarket/balance").then((r) => r.json()),
        fetch("/api/bot/trade-log?limit=50").then((r) => r.json()),
      ]);

      if (statusRes.status === "fulfilled") setStatus(statusRes.value as BotStatus);
      if (logRes.status === "fulfilled") setLog((logRes.value as any).log || []);
      if (perfRes.status === "fulfilled" && !(perfRes.value as any).error) {
        setPerformance(perfRes.value as any);
      }
      if (autoRes.status === "fulfilled") setAutomations((autoRes.value as any).automations || []);
      if (tradeLogRes.status === "fulfilled") setTradeLog(tradeLogRes.value as TradeLogStats);
      if (balRes.status === "fulfilled" && !(balRes.value as any).error) {
        setBalance((balRes.value as any).balance || "—");
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();

    const es = new EventSource("/api/bot/events");
    es.addEventListener("cycle", () => fetchAll());
    // Reconnect silently on error — browser retries EventSource automatically
    return () => es.close();
  }, [fetchAll]);

  const handleToggleMode = async () => {
    const currentMode = status?.config.mode ?? "AGGRESSIVE";
    const nextMode = currentMode === "AGGRESSIVE" ? "CONSERVATIVE" : "AGGRESSIVE";
    setModeLoading(true);
    try {
      await fetch("/api/bot/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });
      await fetchAll();
    } finally {
      setModeLoading(false);
    }
  };

  const handleResetConfidence = async () => {
    setResetConfLoading(true);
    try {
      await fetch("/api/bot/reset-confidence", { method: "POST" });
      await fetchAll();
    } finally {
      setResetConfLoading(false);
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

  // Build cumulative PnL series from WIN/LOSS log entries
  const pnlHistory = useMemo(() => {
    const results = [...log]
      .filter((e) => e.decision === "WIN" || e.decision === "LOSS")
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let cumulative = 0;
    return results.map((entry, i) => {
      // Compute PnL directly from entry data — avoids string parsing bugs
      const betAmount  = entry.tradeAmount  ?? 0;
      const entryPrice = entry.tradePrice   ?? 0.5;
      // WIN: bought (betAmount / entryPrice) shares, each pays $1 → net = payout - cost
      // LOSS: shares settle at $0 → net = -betAmount
      const tradePnl = entry.decision === "WIN"
        ? parseFloat(((betAmount / entryPrice) - betAmount).toFixed(2))
        : parseFloat((-betAmount).toFixed(2));
      cumulative = parseFloat((cumulative + tradePnl).toFixed(2));
      return {
        label: `#${i + 1}`,
        time: new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
        trade: tradePnl,
        cumulative,
        decision: entry.decision,
      };
    });
  }, [log]);

  const lastCumulative = pnlHistory.length > 0 ? pnlHistory[pnlHistory.length - 1].cumulative : 0;

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
        <button
          onClick={handleRefresh}
          className="glass-card p-2 text-zinc-400 hover:text-white transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
        </button>
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
            <div>Max ${status?.config.maxBetUsdc ?? 50} | Loss limit {((status?.config.sessionLossLimit ?? 0.1) * 100).toFixed(0)}%</div>
          </div>
        </div>

        {/* ── Bot Mode Selector ── */}
        <div className="glass-card p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
            <Shield className="w-3.5 h-3.5" />
            Bot Mode
          </div>
          <div className="flex flex-col gap-2">
            {[
              {
                mode: "AGGRESSIVE" as const,
                label: "Aggressive",
                icon: <Flame className="w-4 h-4" />,
                color: "orange",
                stats: ["Conf ≥70%", "Entry ≤60¢", "Kelly 40%", "Max $250", "10–285s"],
              },
              {
                mode: "CONSERVATIVE" as const,
                label: "Conservative",
                icon: <Shield className="w-4 h-4" />,
                color: "blue",
                stats: ["Conf ≥75%", "Entry ≤65¢", "Kelly 20%", "Max $50", "30–240s"],
              },
            ].map(({ mode, label, icon, color, stats }) => {
              const active = (status?.config.mode ?? "AGGRESSIVE") === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => !active && handleToggleMode()}
                  disabled={modeLoading || active}
                  className={cn(
                    "w-full text-left rounded-lg border p-2.5 transition-all",
                    active
                      ? color === "orange"
                        ? "bg-orange-500/15 border-orange-500/50 cursor-default"
                        : "bg-blue-500/15 border-blue-500/50 cursor-default"
                      : "bg-zinc-800/50 border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800 cursor-pointer disabled:opacity-40"
                  )}
                >
                  <div className={cn(
                    "flex items-center gap-1.5 font-bold text-xs mb-1.5",
                    active
                      ? color === "orange" ? "text-orange-300" : "text-blue-300"
                      : "text-zinc-400"
                  )}>
                    {icon}
                    {label}
                    {active && <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 font-bold">ACTIVE</span>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {stats.map((s) => (
                      <span key={s} className={cn(
                        "text-[9px] px-1 py-0.5 rounded font-mono",
                        active
                          ? color === "orange" ? "bg-orange-500/10 text-orange-400" : "bg-blue-500/10 text-blue-400"
                          : "bg-zinc-700 text-zinc-500"
                      )}>
                        {s}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
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
                {/* Market title */}
                <p className="text-[11px] text-zinc-500 truncate">{snap.market}</p>

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

                  {/* BTC price center */}
                  <div className="bg-zinc-800/50 border border-zinc-700/40 rounded-xl p-3 flex flex-col gap-1 items-center justify-center">
                    <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">BTC Price</span>
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
                      snap.confidence >= 70 ? "bg-green-500/10 text-green-400 border-green-500/30"
                        : snap.confidence >= 55 ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/30"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    )}>
                      Conf {snap.confidence}%
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
                  {entryPrice !== null && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-blue-500/10 text-blue-400 border border-blue-500/30">
                      Entry {(entryPrice * 100).toFixed(1)}¢
                    </span>
                  )}
                  {snap.estimatedBet !== null && snap.estimatedBet > 0 && (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-purple-500/10 text-purple-400 border border-purple-500/30">
                      ~${snap.estimatedBet.toFixed(2)} Kelly
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
                        BTC {snap.divergence.btcDelta30s >= 0 ? "+" : ""}{snap.divergence.btcDelta30s.toFixed(0)}$
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

      {/* ── Session PnL Chart ── */}
      <div className="glass-card p-4 w-full">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <LineChartIcon className="w-4 h-4" />
            Session PnL
            <span className="text-xs font-normal text-zinc-600 normal-case tracking-normal ml-1">
              {pnlHistory.length} resolved trade{pnlHistory.length !== 1 ? "s" : ""}
            </span>
          </h3>
          {pnlHistory.length > 0 && (
            <span className={cn(
              "text-sm font-mono font-bold",
              lastCumulative > 0 ? "text-green-400" : lastCumulative < 0 ? "text-red-400" : "text-zinc-400"
            )}>
              {lastCumulative > 0 ? "+" : ""}{lastCumulative.toFixed(2)} USDC
            </span>
          )}
        </div>

        {pnlHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 gap-2 text-zinc-700">
            <BarChart3 className="w-8 h-8 opacity-30" />
            <p className="text-xs">No resolved trades yet — chart appears after first WIN or LOSS</p>
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
  );
}
