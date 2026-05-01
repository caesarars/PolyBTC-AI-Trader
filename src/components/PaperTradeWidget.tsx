import { useState, useEffect, useRef } from "react";
import { TrendingUp, TrendingDown, Activity, FileText, X } from "lucide-react";

interface PaperTradeEntry {
  ts: string;
  market: string;
  direction: "UP" | "DOWN";
  confidence: number;
  edge: number;
  betAmount: number;
  entryPrice: number;
  pnl: number;
  result: "WIN" | "LOSS";
  isPaperTrade?: boolean;
}

interface PaperStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

export default function PaperTradeWidget() {
  const [entries, setEntries] = useState<PaperTradeEntry[]>([]);
  const [stats, setStats] = useState<PaperStats | null>(null);
  const [lastTrade, setLastTrade] = useState<PaperTradeEntry | null>(null);
  const [flash, setFlash] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const lastCountRef = useRef(0);

  const fetchPaperTrades = async () => {
    try {
      const [statsRes, logRes] = await Promise.all([
        fetch("/api/bot/paper-trade-stats").then((r) => r.json()),
        fetch("/api/bot/trade-log?paperOnly=true&limit=10").then((r) => r.json()),
      ]);
      setStats(statsRes);
      if (logRes.entries) {
        setEntries(logRes.entries);
        if (logRes.entries.length > 0) {
          const newest = logRes.entries[0];
          if (lastCountRef.current !== logRes.total) {
            lastCountRef.current = logRes.total;
            setLastTrade(newest);
            setFlash(true);
            setTimeout(() => setFlash(false), 2000);
          }
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchPaperTrades();
    const id = setInterval(fetchPaperTrades, 5000);

    const es = new EventSource("/api/bot/events");
    esRef.current = es;
    es.addEventListener("log", (e) => {
      try {
        const entry = JSON.parse(e.data);
        if (entry.message?.includes("[PAPER]") || entry.message?.includes("EXECUTING ORDER")) {
          setTimeout(fetchPaperTrades, 1500); // small delay for backend to persist
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("cycle", () => {
      fetchPaperTrades();
    });

    return () => {
      clearInterval(id);
      es.close();
    };
  }, []);

  if (!stats || stats.total === 0) {
    return (
      <div className="glass-card p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
          <FileText className="w-3.5 h-3.5" />
          Paper Trades
        </div>
        <div className="text-[10px] text-zinc-600">No paper trades yet. Enable paper mode to start tracking.</div>
      </div>
    );
  }

  return (
    <div className={`glass-card p-4 flex flex-col gap-3 transition-all duration-500 ${flash ? "ring-1 ring-amber-500/50 shadow-[0_0_20px_rgba(245,158,11,0.15)]" : ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-zinc-500 text-xs font-semibold uppercase tracking-wider">
          <FileText className="w-3.5 h-3.5" />
          Paper Trades
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-bold">{stats.total}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`font-mono font-bold ${stats.winRate >= 55 ? "text-green-400" : "text-red-400"}`}>
            {stats.winRate}% WR
          </span>
          <span className="text-zinc-600">|</span>
          <span className={`font-mono font-bold ${stats.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
            {stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Last Trade Flash Card */}
      {lastTrade && (
        <div className={`relative overflow-hidden rounded-lg border p-3 transition-all duration-500 ${lastTrade.result === "WIN" ? "bg-emerald-950/30 border-emerald-700/40" : "bg-red-950/30 border-red-700/40"}`}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              {lastTrade.direction === "UP" ? (
                <TrendingUp className="w-4 h-4 text-green-400" />
              ) : (
                <TrendingDown className="w-4 h-4 text-red-400" />
              )}
              <div>
                <div className="text-xs font-bold text-zinc-200">
                  {lastTrade.direction} @ {(lastTrade.entryPrice * 100).toFixed(1)}¢
                </div>
                <div className="text-[10px] text-zinc-500">
                  {new Date(lastTrade.ts).toLocaleTimeString()} · Conf {lastTrade.confidence}%
                </div>
              </div>
            </div>
            <div className={`text-xs font-mono font-bold ${lastTrade.result === "WIN" ? "text-emerald-400" : "text-red-400"}`}>
              {lastTrade.result === "WIN" ? "+" : ""}${lastTrade.pnl.toFixed(2)}
            </div>
          </div>
          {flash && (
            <div className="absolute inset-0 bg-amber-500/10 animate-pulse pointer-events-none" />
          )}
        </div>
      )}

      {/* Mini history */}
      {entries.length > 1 && (
        <div className="space-y-1.5">
          <div className="text-[9px] text-zinc-600 uppercase tracking-wider font-semibold">Recent</div>
          {entries.slice(1, 6).map((entry, i) => (
            <div key={`${entry.ts}-${i}`} className="flex items-center justify-between text-[10px] py-1 border-b border-zinc-800/50 last:border-0">
              <div className="flex items-center gap-2">
                <span className={entry.direction === "UP" ? "text-green-400" : "text-red-400"}>
                  {entry.direction === "UP" ? "▲" : "▼"}
                </span>
                <span className="text-zinc-400">{(entry.entryPrice * 100).toFixed(0)}¢</span>
                <span className="text-zinc-600">{entry.confidence}%</span>
              </div>
              <span className={`font-mono font-bold ${entry.result === "WIN" ? "text-emerald-400" : "text-red-400"}`}>
                {entry.result === "WIN" ? "+" : ""}${entry.pnl.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Progress bar to 50 trades */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[9px] text-zinc-600">
          <span>Sample size</span>
          <span>{stats.total} / 50</span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${stats.total >= 50 ? "bg-green-500" : "bg-amber-500"}`}
            style={{ width: `${Math.min((stats.total / 50) * 100, 100)}%` }}
          />
        </div>
        <div className="text-[9px] text-zinc-600">
          {stats.total >= 50
            ? "✓ Sample size sufficient for validation"
            : `⏳ Need ${50 - stats.total} more trades for statistical significance`}
        </div>
      </div>
    </div>
  );
}
