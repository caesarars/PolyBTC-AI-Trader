import { useState, useEffect, useCallback } from "react";
import { Bot, TrendingUp, TrendingDown, Activity, Minus, Trophy, BarChart3, Zap } from "lucide-react";

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

export default function SwarmDashboard({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; botCount: number; stats: any } | null>(null);
  const [ensembles, setEnsembles] = useState<SwarmEnsemble[]>([]);
  const [leaderboard, setLeaderboard] = useState<BotProfile[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBot, setSelectedBot] = useState<BotProfile | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, ensemblesRes, leaderboardRes, analyticsRes] = await Promise.all([
        fetch("/api/swarm/status").then((r) => r.json()),
        fetch("/api/swarm/ensembles").then((r) => r.json()),
        fetch("/api/swarm/leaderboard").then((r) => r.json()),
        fetch("/api/swarm/analytics").then((r) => r.json()),
      ]);
      setStatus(statusRes);
      setEnsembles(ensemblesRes.ensembles || []);
      setLeaderboard(leaderboardRes.leaderboard || []);
      setAnalytics(analyticsRes);
    } catch (err) {
      console.error("Swarm fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 10000);

    const es = new EventSource("/api/bot/events");
    es.addEventListener("swarm", () => fetchAll());
    return () => {
      clearInterval(id);
      es.close();
    };
  }, [fetchAll]);

  const triggerSwarm = async () => {
    try {
      const res = await fetch("/api/swarm/trigger", { method: "POST" });
      if (res.ok) fetchAll();
    } catch {}
  };

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

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs hover:bg-zinc-800">← Back</button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="text-amber-400 w-6 h-6" />
            100-Bot AI Swarm
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-1 rounded-full font-bold ${status?.enabled ? "bg-green-500/20 text-green-400" : "bg-zinc-800 text-zinc-500"}`}>
            {status?.enabled ? "● ACTIVE" : "○ INACTIVE"}
          </span>
          <button onClick={triggerSwarm} disabled={!status?.enabled} className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-500 disabled:opacity-40">
            Trigger Now
          </button>
        </div>
      </div>

      {!status?.enabled && (
        <div className="mb-6 p-4 rounded-lg bg-amber-950/30 border border-amber-700/40 text-amber-300 text-sm">
          Swarm is not enabled. Set <code className="bg-amber-900/50 px-1 rounded">SWARM_ENABLED=true</code> in your .env file and restart the server.
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
          <div className="text-xs text-emerald-400 font-mono">{(leaderboard[0]?.accuracy * 100).toFixed(1)}%</div>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Current Ensemble */}
        <div className="md:col-span-2 space-y-6">
          {latest && (
            <div className="glass-card p-5">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Current Window Consensus
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
              <div className="flex items-center gap-4">
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
                  {latest.topBots.map((bot) => (
                    <button
                      key={bot.id}
                      onClick={() => setSelectedBot(leaderboard.find((b) => b.id === bot.id) || null)}
                      className={`p-2 rounded-lg border text-center transition-all hover:scale-105 ${bot.direction === "UP" ? "bg-green-950/30 border-green-800/50" : bot.direction === "DOWN" ? "bg-red-950/30 border-red-800/50" : "bg-zinc-900 border-zinc-800"}`}
                    >
                      <div className="text-[9px] text-zinc-500 truncate">{bot.name.slice(0, 8)}</div>
                      <div className={`text-xs font-bold ${bot.direction === "UP" ? "text-green-400" : bot.direction === "DOWN" ? "text-red-400" : "text-zinc-400"}`}>{bot.confidence}%</div>
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
                    <th className="text-right py-2 px-2">NEUTRAL</th>
                    <th className="text-right py-2 px-2">Conf</th>
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
                        {e.correct === true && <span className="text-emerald-400 font-bold">✓</span>}
                        {e.correct === false && <span className="text-red-400 font-bold">✗</span>}
                        {e.correct === null && <span className="text-zinc-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Sidebar: Leaderboard */}
        <div className="space-y-6">
          <div className="glass-card p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-4 flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              Leaderboard
            </h2>
            <div className="space-y-2">
              {leaderboard.slice(0, 15).map((bot, i) => (
                <button
                  key={bot.id}
                  onClick={() => setSelectedBot(bot)}
                  className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-zinc-800/50 transition-colors text-left"
                >
                  <span className={`text-xs font-mono w-5 ${i < 3 ? "text-amber-400 font-bold" : "text-zinc-600"}`}>{i + 1}</span>
                  <Bot className="w-3 h-3 text-zinc-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold truncate">{bot.name}</div>
                    <div className="text-[9px] text-zinc-600">{bot.totalPredictions} trades · streak {bot.streak > 0 ? "+" : ""}{bot.streak}</div>
                  </div>
                  <div className={`text-xs font-mono font-bold ${bot.accuracy >= 0.55 ? "text-green-400" : "text-red-400"}`}>
                    {(bot.accuracy * 100).toFixed(1)}%
                  </div>
                </button>
              ))}
            </div>
          </div>
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
              <div className="text-zinc-400 text-xs leading-relaxed">{selectedBot.strategy}</div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-zinc-900 p-2 rounded">Accuracy: <span className="font-mono font-bold text-white">{(selectedBot.accuracy * 100).toFixed(1)}%</span></div>
                <div className="bg-zinc-900 p-2 rounded">Trades: <span className="font-mono font-bold text-white">{selectedBot.totalPredictions}</span></div>
                <div className="bg-zinc-900 p-2 rounded">Wins: <span className="font-mono font-bold text-green-400">{selectedBot.correctPredictions}</span></div>
                <div className="bg-zinc-900 p-2 rounded">Streak: <span className={`font-mono font-bold ${selectedBot.streak >= 0 ? "text-green-400" : "text-red-400"}`}>{selectedBot.streak > 0 ? "+" : ""}{selectedBot.streak}</span></div>
              </div>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider font-bold mt-2">Parameters</div>
              <div className="grid grid-cols-2 gap-1 text-xs text-zinc-500">
                <div>FastLoop: {selectedBot.parameters.fastLoopWeight}x</div>
                <div>Divergence: {selectedBot.parameters.divergenceWeight}x</div>
                <div>Heat: {selectedBot.parameters.heatWeight}x</div>
                <div>Technical: {selectedBot.parameters.technicalWeight}x</div>
                <div>Risk: {(selectedBot.parameters.riskTolerance * 100).toFixed(0)}%</div>
                <div>Style: {selectedBot.confidenceStyle}</div>
              </div>
            </div>
          </div>
        </div>
      )}
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
