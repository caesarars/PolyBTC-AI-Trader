import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}

interface BotStatus {
  enabled: boolean;
  running: boolean;
  sessionStartBalance: number | null;
  sessionTradesCount: number;
  windowElapsedSeconds: number;
  analyzedThisWindow: number;
  config: {
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

export default function BotDashboard() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [log, setLog] = useState<BotLogEntry[]>([]);
  const [performance, setPerformance] = useState<{ summary: PerformanceSummary; openPositions: OpenPosition[] } | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [balance, setBalance] = useState<string>("—");
  const [controlLoading, setControlLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, logRes, perfRes, autoRes, balRes] = await Promise.allSettled([
        fetch("/api/bot/status").then((r) => r.json()),
        fetch("/api/bot/log").then((r) => r.json()),
        fetch("/api/polymarket/performance").then((r) => r.json()),
        fetch("/api/polymarket/automation").then((r) => r.json()),
        fetch("/api/polymarket/balance").then((r) => r.json()),
      ]);

      if (statusRes.status === "fulfilled") setStatus(statusRes.value as BotStatus);
      if (logRes.status === "fulfilled") setLog((logRes.value as any).log || []);
      if (perfRes.status === "fulfilled" && !(perfRes.value as any).error) {
        setPerformance(perfRes.value as any);
      }
      if (autoRes.status === "fulfilled") setAutomations((autoRes.value as any).automations || []);
      if (balRes.status === "fulfilled" && !(balRes.value as any).error) {
        setBalance((balRes.value as any).balance || "—");
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [fetchAll]);

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
            <div>Conf ≥{status?.config.minConfidence ?? 68}% | Edge ≥{status?.config.minEdge ?? 8}¢</div>
            <div>Max ${status?.config.maxBetUsdc ?? 50} | Loss limit {((status?.config.sessionLossLimit ?? 0.1) * 100).toFixed(0)}%</div>
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
            <BarChart3 className="w-4 h-4" />
            Open Positions ({performance.openPositions.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                  <th className="pb-2 pr-4">Market</th>
                  <th className="pb-2 pr-4">Outcome</th>
                  <th className="pb-2 pr-4">Size</th>
                  <th className="pb-2 pr-4">Avg Price</th>
                  <th className="pb-2 pr-4">Cost</th>
                  <th className="pb-2">TP / SL</th>
                </tr>
              </thead>
              <tbody>
                {performance.openPositions.map((pos) => {
                  const auto = automations.find((a) => a.assetId === pos.assetId);
                  return (
                    <tr key={pos.assetId} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="py-2 pr-4 text-zinc-300 max-w-[160px] truncate text-xs">{pos.market}</td>
                      <td className="py-2 pr-4">
                        <span className={cn("text-xs font-bold px-2 py-0.5 rounded",
                          pos.outcome === "UP" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                        )}>
                          {pos.outcome}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-300">{parseFloat(pos.size).toFixed(2)}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-300">{(parseFloat(pos.averagePrice) * 100).toFixed(1)}¢</td>
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-300">${parseFloat(pos.costBasis).toFixed(2)}</td>
                      <td className="py-2 text-[10px] font-mono text-zinc-500">
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
      )}

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
