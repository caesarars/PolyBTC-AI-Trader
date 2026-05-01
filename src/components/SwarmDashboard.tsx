import { useState, useEffect, useCallback, useRef } from "react";
import {
  Bot,
  TrendingUp,
  TrendingDown,
  Activity,
  Minus,
  Trophy,
  BarChart3,
  Zap,
  Clock,
  Target,
  Flame,
  Thermometer,
  Scan,
  ChevronRight,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Terminal,
  Wifi,
  WifiOff,
  Filter,
} from "lucide-react";

interface SwarmEnsemble {
  windowStart: number;
  consensusDirection: "UP" | "DOWN" | "NEUTRAL";
  consensusConfidence: number;
  upVotes: number;
  downVotes: number;
  neutralVotes: number;
  upConfidence: number;
  downConfidence: number;
  weightedConfidence: number;
  avgConfidence: number;
  topBots: { id: number; name: string; confidence: number; direction: string }[];
  actual?: "UP" | "DOWN" | null;
  correct?: boolean | null;
}

interface BotProfile {
  id: number;
  name: string;
  strategy: string;
  confidenceStyle: "conservative" | "moderate" | "aggressive";
  accuracy: number;
  totalPredictions: number;
  correctPredictions: number;
  currentWeight: number;
  streak: number;
  parameters: {
    fastLoopWeight: number;
    divergenceWeight: number;
    heatWeight: number;
    technicalWeight: number;
    riskTolerance: number;
  };
}

interface WindowSnapshot {
  windowStart: number;
  windowEnd: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  progressPct: number;
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
  squeezeRisk?: string;
  sentiment?: string;
  swarmPredicted: boolean;
  swarmPrediction?: {
    consensusDirection: string;
    consensusConfidence: number;
    upVotes: number;
    downVotes: number;
    neutralVotes: number;
    predictionsCount: number;
  };
  isStale?: boolean;
  updatedAt: number;
}

interface RawLogEntry {
  ts: string;
  level: string;
  msg: string;
}

export default function SwarmDashboard({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; botCount: number; stats: any; apiKeyConfigured?: boolean; botRunning?: boolean; botEnabled?: boolean } | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [ensembles, setEnsembles] = useState<SwarmEnsemble[]>([]);
  const [leaderboard, setLeaderboard] = useState<BotProfile[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [currentWindow, setCurrentWindow] = useState<WindowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBot, setSelectedBot] = useState<BotProfile | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [rawLog, setRawLog] = useState<RawLogEntry[]>([]);
  const [logConnected, setLogConnected] = useState(false);
  const [logFilter, setLogFilter] = useState<string>("ALL");
  const logBottomRef = useRef<HTMLDivElement>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, ensemblesRes, leaderboardRes, analyticsRes, windowRes] = await Promise.all([
        fetch("/api/swarm/status").then((r) => r.json()),
        fetch("/api/swarm/ensembles").then((r) => r.json()),
        fetch("/api/swarm/leaderboard").then((r) => r.json()),
        fetch("/api/swarm/analytics").then((r) => r.json()),
        fetch("/api/swarm/current-window").then((r) => r.json()),
      ]);
      setStatus(statusRes);
      setEnsembles(ensemblesRes.ensembles || []);
      setLeaderboard(leaderboardRes.leaderboard || []);
      setAnalytics(analyticsRes);
      setCurrentWindow(windowRes);
    } catch (err) {
      console.error("Swarm fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 5000);

    // Live countdown ticker
    timerRef.current = setInterval(() => setNowTick((t) => t + 1), 1000);

    const es = new EventSource("/api/bot/events");
    es.addEventListener("swarm", () => fetchAll());
    es.addEventListener("snapshot", (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      setRawLog(data.log || []);
      setLogConnected(true);
    });
    es.addEventListener("log", (e: MessageEvent) => {
      const entry: RawLogEntry = JSON.parse(e.data);
      setRawLog((prev) => [entry, ...prev].slice(0, 500));
      setLogConnected(true);
    });
    es.onerror = () => setLogConnected(false);

    return () => {
      clearInterval(id);
      if (timerRef.current) clearInterval(timerRef.current);
      es.close();
    };
  }, [fetchAll]);

  const triggerSwarm = async () => {
    try {
      const res = await fetch("/api/swarm/trigger", { method: "POST" });
      if (res.ok) fetchAll();
    } catch {}
  };

  const toggleSwarm = async () => {
    if (toggling) return;
    const next = !status?.enabled;
    setToggling(true);
    setToggleError(null);
    try {
      const res = await fetch("/api/swarm/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToggleError(data?.error || `Toggle failed (HTTP ${res.status})`);
        // Pull authoritative state from server in case it differs
        fetchAll();
        return;
      }
      const serverEnabled = typeof data?.enabled === "boolean" ? data.enabled : next;
      setStatus((s) => (s ? { ...s, enabled: serverEnabled } : null));
    } catch (err: any) {
      setToggleError(err?.message || "Network error toggling swarm");
    } finally {
      setToggling(false);
    }
  };

  // Compute live remaining time from snapshot base
  const liveWindow = useCallback((): WindowSnapshot | null => {
    if (!currentWindow) return null;
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - currentWindow.windowStart;
    const remaining = Math.max(0, 300 - elapsed);
    return {
      ...currentWindow,
      elapsedSeconds: elapsed,
      remainingSeconds: remaining,
      progressPct: parseFloat(((elapsed / 300) * 100).toFixed(1)),
    };
  }, [currentWindow, nowTick]);

  const w = liveWindow();

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-zinc-500 text-sm animate-pulse">Loading swarm data…</div>
      </div>
    );
  }

  const latest = ensembles[0];
  const resolvedEnsembles = ensembles.filter((e) => e.correct !== null);
  const consensusAccuracy = resolvedEnsembles.length > 0
    ? parseFloat(((resolvedEnsembles.filter((e) => e.correct).length / resolvedEnsembles.length) * 100).toFixed(1))
    : 0;

  const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtMmSs = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const fmtPrice = (p: number) => p > 0 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";
  const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs hover:bg-zinc-800">← Back</button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="text-amber-400 w-6 h-6" />
            100-Bot AI Swarm
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSwarm}
            disabled={toggling}
            title={status?.enabled ? "Click to disable swarm" : "Click to enable 100-bot swarm"}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all border disabled:opacity-60 disabled:cursor-not-allowed ${
              status?.enabled
                ? "bg-green-500/15 border-green-500/30 text-green-400 hover:bg-green-500/25"
                : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-zinc-700 hover:text-white"
            }`}
          >
            {toggling ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <span className={`w-2 h-2 rounded-full ${status?.enabled ? "bg-green-400 animate-pulse" : "bg-zinc-600"}`} />
            )}
            {toggling ? "TOGGLING…" : status?.enabled ? "SWARM ON" : "SWARM OFF"}
          </button>
          <button type="button" onClick={triggerSwarm} disabled={!status?.enabled} className="px-3 py-2 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed">
            Trigger Now
          </button>
        </div>
      </div>

      {toggleError && (
        <div className="mb-4 p-3 rounded-lg bg-red-950/40 border border-red-700/50 text-red-300 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 flex-shrink-0" />
            <span>{toggleError}</span>
          </div>
          <button type="button" onClick={() => setToggleError(null)} className="text-red-400 hover:text-red-200">✕</button>
        </div>
      )}

      {status && status.apiKeyConfigured === false && (
        <div className="mb-4 p-3 rounded-lg bg-amber-950/30 border border-amber-700/40 text-amber-300 text-xs flex items-center gap-2">
          <span className="text-base">⚠</span>
          <span><strong>DEEPSEEK_API_KEY</strong> belum di-set di .env — swarm tidak bisa di-enable sampai key tersedia.</span>
        </div>
      )}

      {status?.enabled && status.botEnabled === false && (
        <div className="mb-4 p-3 rounded-lg bg-blue-950/30 border border-blue-700/40 text-blue-300 text-xs flex items-center gap-2">
          <span className="text-base">ℹ</span>
          <span>Swarm aktif, tapi <strong>bot trading masih OFF</strong>. Auto-prediksi tiap window butuh bot running. Klik <em>Trigger Now</em> untuk jalanin manual.</span>
        </div>
      )}

      {!status?.enabled && (
        <div className="mb-6 p-4 rounded-lg bg-amber-950/30 border border-amber-700/40 text-amber-300 text-sm flex items-center gap-3">
          <span className="text-xl">💡</span>
          <div>
            Swarm is currently <strong>disabled</strong>. Toggle the button above to activate the 100-bot prediction engine.
            <div className="text-amber-500/70 text-xs mt-1">DeepSeek API key required. Each window triggers 100 predictions.</div>
          </div>
        </div>
      )}

      {/* ── CURRENT WINDOW PANEL ───────────────────────────────────────────── */}
      {w && (
        <div className="glass-card p-5 mb-6 border border-zinc-800/60">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                <Clock className="w-5 h-5 text-zinc-400" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Current Window</div>
                <div className="text-sm font-mono text-zinc-300">
                  {fmtTime(w.windowStart)} <ChevronRight className="inline w-3 h-3 text-zinc-600" /> {fmtTime(w.windowEnd)}
                </div>
              </div>
            </div>

            {/* Countdown */}
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">Remaining</div>
                <div className={`text-xl font-mono font-bold ${w.remainingSeconds < 60 ? "text-red-400" : w.remainingSeconds < 120 ? "text-amber-400" : "text-zinc-200"}`}>
                  {fmtMmSs(w.remainingSeconds)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">BTC Price</div>
                <div className="text-xl font-mono font-bold text-white">{fmtPrice(w.btcPrice)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold">5m Change</div>
                <div className={`text-sm font-mono font-bold flex items-center justify-end gap-1 ${w.priceChange5m >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {w.priceChange5m >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {fmtPct(w.priceChange5m)}
                </div>
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-4">
            <div className="flex justify-between text-[10px] text-zinc-600 mb-1">
              <span>Elapsed: {w.elapsedSeconds}s</span>
              <span>Total: 300s</span>
            </div>
            <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${
                  w.progressPct < 33 ? "bg-green-500" : w.progressPct < 66 ? "bg-amber-500" : "bg-red-500"
                }`}
                style={{ width: `${Math.min(100, w.progressPct)}%` }}
              />
            </div>
          </div>

          {/* Scanning Status */}
          <div className="flex flex-wrap items-center gap-3">
            {w.isStale ? (
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                <Scan className="w-3.5 h-3.5" /> Waiting for bot cycle to scan market data…
              </span>
            ) : w.swarmPredicted && w.swarmPrediction ? (
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs text-green-400 bg-green-950/40 border border-green-800/50 px-2.5 py-1 rounded-md">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Swarm scanned
                </span>
                <span className="text-xs text-zinc-500">
                  {w.swarmPrediction.predictionsCount}/100 bots →
                </span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                  w.swarmPrediction.consensusDirection === "UP" ? "bg-green-950 text-green-400" :
                  w.swarmPrediction.consensusDirection === "DOWN" ? "bg-red-950 text-red-400" :
                  "bg-zinc-800 text-zinc-400"
                }`}>
                  {w.swarmPrediction.consensusDirection}
                </span>
                <span className="text-xs font-mono text-zinc-400">{w.swarmPrediction.consensusConfidence}% conf</span>
              </span>
            ) : status?.enabled ? (
              <span className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 px-2.5 py-1 rounded-md">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning window… bots analyzing
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-zinc-500 bg-zinc-900 border border-zinc-800 px-2.5 py-1 rounded-md">
                <Scan className="w-3.5 h-3.5" /> Swarm offline — no active scan
              </span>
            )}
          </div>
        </div>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="glass-card p-4">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Total Windows</div>
          <div className="text-2xl font-mono font-bold">{ensembles.length}</div>
        </div>
        <div className="glass-card p-4">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Consensus WR</div>
          <div className={`text-2xl font-mono font-bold ${consensusAccuracy >= 55 ? "text-green-400" : "text-red-400"}`}>{consensusAccuracy}%</div>
        </div>
        <div className="glass-card p-4">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Avg Bots/Window</div>
          <div className="text-2xl font-mono font-bold">{analytics?.avgBotsPerWindow ?? "—"}</div>
        </div>
        <div className="glass-card p-4">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Top Bot</div>
          <div className="text-sm font-bold truncate">{leaderboard[0]?.name ?? "—"}</div>
          <div className="text-xs text-emerald-400 font-mono">
            {leaderboard[0]?.accuracy != null ? `${(leaderboard[0].accuracy * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Consensus + History */}
        <div className="md:col-span-2 space-y-6">
          {/* Current Ensemble */}
          {latest && (
            <div className="glass-card p-5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Latest Consensus
                <span className="text-[10px] text-zinc-600 font-mono">
                  {new Date(latest.windowStart * 1000).toLocaleTimeString()}
                </span>
              </h2>

              {/* Vote Bars */}
              <div className="space-y-3 mb-4">
                <VoteBar label="UP" count={latest.upVotes} total={latest.upVotes + latest.downVotes + latest.neutralVotes} color="bg-green-500" icon={<TrendingUp className="w-3 h-3" />} confidence={latest.upConfidence} />
                <VoteBar label="DOWN" count={latest.downVotes} total={latest.upVotes + latest.downVotes + latest.neutralVotes} color="bg-red-500" icon={<TrendingDown className="w-3 h-3" />} confidence={latest.downConfidence} />
                <VoteBar label="NEUTRAL" count={latest.neutralVotes} total={latest.upVotes + latest.downVotes + latest.neutralVotes} color="bg-zinc-500" icon={<Minus className="w-3 h-3" />} confidence={0} />
              </div>

              {/* Consensus Badge */}
              <div className="flex flex-wrap items-center gap-4">
                <div className={`px-4 py-2 rounded-lg border text-sm font-bold ${latest.consensusDirection === "UP" ? "bg-green-950/50 border-green-700 text-green-400" : latest.consensusDirection === "DOWN" ? "bg-red-950/50 border-red-700 text-red-400" : "bg-zinc-900 border-zinc-700 text-zinc-400"}`}>
                  {latest.consensusDirection === "UP" ? "▲" : latest.consensusDirection === "DOWN" ? "▼" : "—"} {latest.consensusDirection}
                </div>
                <div className="text-sm text-zinc-400">
                  Confidence: <span className="font-mono font-bold text-white">{latest.consensusConfidence}%</span>
                </div>
                <div className="text-sm text-zinc-400">
                  Avg: <span className="font-mono font-bold text-white">{latest.avgConfidence}%</span>
                </div>
                {latest.correct !== null && (
                  <div className={`text-sm font-bold ${latest.correct ? "text-emerald-400" : "text-red-400"}`}>
                    {latest.correct ? "✓ CORRECT" : "✗ WRONG"}
                  </div>
                )}
              </div>

              {/* Top 5 Bots */}
              <div className="mt-4 pt-4 border-t border-zinc-800">
                <div className="text-[10px] uppercase tracking-wider text-zinc-600 font-bold mb-2">Top 5 Confident Bots</div>
                <div className="grid grid-cols-5 gap-2">
                  {(latest.topBots ?? []).map((bot) => (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => setSelectedBot(leaderboard.find((b) => b.id === bot.id) || null)}
                      className={`p-2 rounded-lg border text-center transition-all hover:scale-105 ${bot.direction === "UP" ? "bg-green-950/30 border-green-800/50" : bot.direction === "DOWN" ? "bg-red-950/30 border-red-800/50" : "bg-zinc-900 border-zinc-800"}`}
                    >
                      <div className="text-[9px] text-zinc-500 truncate">{(bot.name ?? "?").slice(0, 8)}</div>
                      <div className={`text-xs font-bold ${bot.direction === "UP" ? "text-green-400" : bot.direction === "DOWN" ? "text-red-400" : "text-zinc-400"}`}>{bot.confidence ?? 0}%</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* History Table */}
          <div className="glass-card p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              Window History
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-600 border-b border-zinc-800">
                    <th className="text-left py-2 px-2">Window</th>
                    <th className="text-left py-2 px-2">Consensus</th>
                    <th className="text-right py-2 px-2">UP</th>
                    <th className="text-right py-2 px-2">DOWN</th>
                    <th className="text-right py-2 px-2">NEU</th>
                    <th className="text-right py-2 px-2">Conf</th>
                    <th className="text-center py-2 px-2">Actual</th>
                    <th className="text-center py-2 px-2">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {ensembles.slice(0, 20).map((e) => (
                    <tr key={e.windowStart} className="border-b border-zinc-800/50 hover:bg-zinc-900/50">
                      <td className="py-2 px-2 font-mono text-zinc-400">{new Date(e.windowStart * 1000).toLocaleTimeString()}</td>
                      <td className="py-2 px-2">
                        <span className={e.consensusDirection === "UP" ? "text-green-400 font-bold" : e.consensusDirection === "DOWN" ? "text-red-400 font-bold" : "text-zinc-500"}>
                          {e.consensusDirection}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right text-green-600">{e.upVotes}</td>
                      <td className="py-2 px-2 text-right text-red-600">{e.downVotes}</td>
                      <td className="py-2 px-2 text-right text-zinc-600">{e.neutralVotes}</td>
                      <td className="py-2 px-2 text-right font-mono">{e.consensusConfidence}%</td>
                      <td className="py-2 px-2 text-center">
                        {e.actual ? (
                          <span className={e.actual === "UP" ? "text-green-400" : "text-red-400"}>{e.actual}</span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {e.correct === true && <span className="text-emerald-400 font-bold">✓</span>}
                        {e.correct === false && <span className="text-red-400 font-bold">✗</span>}
                        {e.correct === null && <span className="text-zinc-600">⏳</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Leaderboard + Market Snapshot */}
        <div className="space-y-6">
          {/* Market Snapshot */}
          {w && !w.isStale && (
            <div className="glass-card p-5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
                <Target className="w-4 h-4 text-cyan-400" />
                Market Snapshot
              </h2>
              <div className="space-y-3">
                {/* FastLoop */}
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <Activity className="w-3.5 h-3.5" /> FastLoop
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold ${w.fastLoopDirection === "UP" ? "text-green-400" : w.fastLoopDirection === "DOWN" ? "text-red-400" : "text-zinc-400"}`}>
                      {w.fastLoopDirection}
                    </span>
                    <span className="text-[10px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">{w.fastLoopStrength}</span>
                  </div>
                </div>

                {/* Heat Signal */}
                {w.heatSignal && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Flame className="w-3.5 h-3.5" /> Heat
                    </div>
                    <span className={`text-xs font-bold ${
                      w.heatSignal.includes("LONG") ? "text-red-400" :
                      w.heatSignal.includes("SHORT") ? "text-green-400" :
                      "text-zinc-400"
                    }`}>
                      {w.heatSignal}
                    </span>
                  </div>
                )}

                {/* Funding Rate */}
                {typeof w.fundingRate === "number" && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <Thermometer className="w-3.5 h-3.5" /> Funding
                    </div>
                    <span className={`text-xs font-mono font-bold ${w.fundingRate > 0.0005 ? "text-red-400" : w.fundingRate < -0.0005 ? "text-green-400" : "text-zinc-300"}`}>
                      {(w.fundingRate * 100).toFixed(4)}%
                    </span>
                  </div>
                )}

                {/* Long/Short */}
                {w.longShortRatio && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <BarChart3 className="w-3.5 h-3.5" /> L/S Ratio
                    </div>
                    <span className="text-xs font-mono font-bold text-zinc-300">{w.longShortRatio.toFixed(2)}</span>
                  </div>
                )}

                {/* RSI */}
                {typeof w.rsi === "number" && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">RSI</div>
                    <span className={`text-xs font-mono font-bold ${w.rsi > 70 ? "text-red-400" : w.rsi < 30 ? "text-green-400" : "text-zinc-300"}`}>
                      {w.rsi.toFixed(1)}
                    </span>
                  </div>
                )}

                {/* EMA Cross */}
                {w.emaCross && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">EMA</div>
                    <span className={`text-xs font-bold ${w.emaCross === "BULLISH" ? "text-green-400" : "text-red-400"}`}>
                      {w.emaCross}
                    </span>
                  </div>
                )}

                {/* 1h Change */}
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/50">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">1h Change</div>
                  <span className={`text-xs font-mono font-bold ${w.priceChange1h >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPct(w.priceChange1h)}
                  </span>
                </div>

                {/* Squeeze Risk */}
                {w.squeezeRisk && w.squeezeRisk !== "NONE" && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-red-950/20 border border-red-800/40">
                    <div className="flex items-center gap-2 text-xs text-red-400">
                      <Zap className="w-3.5 h-3.5" /> Squeeze Risk
                    </div>
                    <span className="text-xs font-bold text-red-400">{w.squeezeRisk}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Leaderboard */}
          <div className="glass-card p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              Leaderboard
            </h2>
            <div className="space-y-2">
              {leaderboard.slice(0, 15).map((bot, i) => {
                const acc = typeof bot.accuracy === "number" ? bot.accuracy : 0;
                return (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => setSelectedBot(bot)}
                    className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-zinc-800/50 transition-colors text-left"
                  >
                    <span className={`text-xs font-mono w-5 ${i < 3 ? "text-amber-400 font-bold" : "text-zinc-600"}`}>{i + 1}</span>
                    <Bot className="w-3 h-3 text-zinc-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold truncate">{bot.name ?? "?"}</div>
                      <div className="text-[9px] text-zinc-600">{bot.totalPredictions ?? 0} trades · streak {(bot.streak ?? 0) > 0 ? "+" : ""}{bot.streak ?? 0}</div>
                    </div>
                    <div className={`text-xs font-mono font-bold ${acc >= 0.55 ? "text-green-400" : "text-red-400"}`}>
                      {(acc * 100).toFixed(1)}%
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── BOT ACTIVITY LOG ──────────────────────────────────────────────── */}
      <div className="glass-card p-5 mt-6 border border-zinc-800/60">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-400" />
            Bot Activity Log
            <span className="text-[10px] text-zinc-600 font-mono normal-case">
              {rawLog.length} entries
            </span>
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[10px]">
              {logConnected ? (
                <>
                  <Wifi className="w-3 h-3 text-green-400" />
                  <span className="text-green-400 font-bold">LIVE</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 text-red-400" />
                  <span className="text-red-400 font-bold">OFFLINE</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Filter className="w-3 h-3 text-zinc-500" />
              <select
                aria-label="Filter log entries by level"
                title="Filter log entries by level"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 rounded px-2 py-1 focus:outline-none focus:border-blue-500/50"
              >
                <option value="ALL">All Levels</option>
                <option value="TRADE">Trade</option>
                <option value="OK">OK</option>
                <option value="WARN">Warn</option>
                <option value="ERR">Error</option>
                <option value="SKIP">Skip</option>
                <option value="INFO">Info</option>
              </select>
            </div>
          </div>
        </div>

        <div className="bg-black/40 rounded-lg border border-zinc-900 max-h-[420px] overflow-y-auto px-2 py-2 font-mono">
          {(() => {
            const filtered = logFilter === "ALL"
              ? rawLog
              : rawLog.filter((e) => e.level === logFilter);
            if (filtered.length === 0) {
              return (
                <div className="flex flex-col items-center justify-center h-32 gap-2 text-zinc-600">
                  <Terminal className="w-6 h-6 opacity-20" />
                  <p className="text-xs">
                    {rawLog.length === 0 ? "Waiting for bot activity…" : `No ${logFilter} entries.`}
                  </p>
                </div>
              );
            }
            return (
              <div ref={logBottomRef} className="space-y-0.5">
                {filtered.map((entry, i) => (
                  <SwarmLogLine key={`${entry.ts}-${i}`} entry={entry} />
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Bot Detail Modal */}
      {selectedBot && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={() => setSelectedBot(null)}>
          <div className="glass-card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <Bot className="w-5 h-5 text-amber-400" />
                {selectedBot.name}
              </h3>
              <button onClick={() => setSelectedBot(null)} className="text-zinc-500 hover:text-white">✕</button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="text-zinc-400 text-xs leading-relaxed">{selectedBot.strategy ?? "—"}</div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-zinc-900 p-2 rounded">Accuracy: <span className="font-mono font-bold text-white">{((selectedBot.accuracy ?? 0) * 100).toFixed(1)}%</span></div>
                <div className="bg-zinc-900 p-2 rounded">Trades: <span className="font-mono font-bold text-white">{selectedBot.totalPredictions ?? 0}</span></div>
                <div className="bg-zinc-900 p-2 rounded">Wins: <span className="font-mono font-bold text-green-400">{selectedBot.correctPredictions ?? 0}</span></div>
                <div className="bg-zinc-900 p-2 rounded">Streak: <span className={`font-mono font-bold ${(selectedBot.streak ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{(selectedBot.streak ?? 0) > 0 ? "+" : ""}{selectedBot.streak ?? 0}</span></div>
              </div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-bold mt-2">Parameters</div>
              <div className="grid grid-cols-2 gap-1 text-xs text-zinc-500">
                <div>FastLoop: {selectedBot.parameters?.fastLoopWeight ?? "—"}x</div>
                <div>Divergence: {selectedBot.parameters?.divergenceWeight ?? "—"}x</div>
                <div>Heat: {selectedBot.parameters?.heatWeight ?? "—"}x</div>
                <div>Technical: {selectedBot.parameters?.technicalWeight ?? "—"}x</div>
                <div>Risk: {selectedBot.parameters?.riskTolerance != null ? `${(selectedBot.parameters.riskTolerance * 100).toFixed(0)}%` : "—"}</div>
                <div>Style: {selectedBot.confidenceStyle ?? "—"}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const LOG_LEVEL_STYLES: Record<string, { bar: string; text: string; label: string }> = {
  TRADE: { bar: "bg-yellow-400", text: "text-yellow-300", label: "bg-yellow-400/20 text-yellow-300" },
  OK:    { bar: "bg-green-500",  text: "text-green-400",  label: "bg-green-500/20 text-green-400"   },
  WARN:  { bar: "bg-orange-400", text: "text-orange-300", label: "bg-orange-400/20 text-orange-300" },
  ERR:   { bar: "bg-red-500",    text: "text-red-400",    label: "bg-red-500/20 text-red-400"       },
  SKIP:  { bar: "bg-zinc-600",   text: "text-zinc-500",   label: "bg-zinc-700 text-zinc-500"        },
  INFO:  { bar: "bg-blue-600",   text: "text-zinc-300",   label: "bg-blue-900/40 text-blue-400"     },
};

function SwarmLogLine({ entry }: { entry: RawLogEntry }) {
  const style = LOG_LEVEL_STYLES[entry.level] ?? LOG_LEVEL_STYLES.INFO;
  return (
    <div className="flex items-start gap-2 px-1 py-[3px] rounded hover:bg-zinc-900/60 group">
      <div className={`w-0.5 self-stretch rounded-full mt-0.5 flex-shrink-0 ${style.bar}`} />
      <span className="text-zinc-600 text-[9px] font-mono flex-shrink-0 mt-[1px] w-[52px]">{entry.ts}</span>
      <span className={`text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 leading-none ${style.label}`}>
        {entry.level}
      </span>
      <span className={`text-[10px] leading-relaxed break-all ${style.text}`}>{entry.msg}</span>
    </div>
  );
}

function VoteBar({ label, count, total, color, icon, confidence }: { label: string; count: number; total: number; color: string; icon: React.ReactNode; confidence: number }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-16 flex items-center gap-1 text-xs text-zinc-400">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex-1 h-6 bg-zinc-900 rounded-md overflow-hidden relative">
        <div className={`h-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
        <div className="absolute inset-0 flex items-center justify-between px-2 text-xs">
          <span className="font-bold text-white drop-shadow">{count}</span>
          {confidence > 0 && <span className="text-white/70 font-mono text-[10px]">{confidence}%</span>}
        </div>
      </div>
    </div>
  );
}
