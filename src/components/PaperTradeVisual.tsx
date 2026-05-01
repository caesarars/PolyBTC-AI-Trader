import { useState, useEffect, useRef, useCallback } from "react";
import { Bot, Globe, Zap, Activity, ArrowLeft } from "lucide-react";

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface TradeEntry {
  ts: string;
  market: string;
  direction: "UP" | "DOWN";
  confidence: number;
  betAmount: number;
  entryPrice: number;
  pnl: number;
  result: "WIN" | "LOSS";
  isPaperTrade?: boolean;
}

interface VisualEvent {
  id: string;
  type: "scan" | "analyze" | "execute" | "result";
  message: string;
  timestamp: number;
  direction?: "UP" | "DOWN";
  result?: "WIN" | "LOSS";
}

export default function PaperTradeVisual({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<VisualEvent[]>([]);
  const [latestEvent, setLatestEvent] = useState<VisualEvent | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [tradeCount, setTradeCount] = useState(0);
  const [winCount, setWinCount] = useState(0);
  const [lastTrade, setLastTrade] = useState<TradeEntry | null>(null);
  const [connectionGlow, setConnectionGlow] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const eventsRef = useRef<VisualEvent[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const addEvent = useCallback((event: VisualEvent) => {
    const newEvents = [event, ...eventsRef.current].slice(0, 50);
    eventsRef.current = newEvents;
    setEvents(newEvents);
    setLatestEvent(event);

    if (event.type === "execute") {
      setIsExecuting(true);
      setConnectionGlow(true);
      setTimeout(() => {
        setIsExecuting(false);
        setConnectionGlow(false);
      }, 2000);
    }
    if (event.type === "scan") {
      setIsScanning(true);
      setTimeout(() => setIsScanning(false), 800);
    }
  }, []);

  // Poll trade log for paper trades
  const fetchTradeLog = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/trade-log?days=1&limit=20");
      const data = await res.json();
      if (data.entries && data.entries.length > 0) {
        const latest: TradeEntry = data.entries[0];
        if (latest && (!lastTrade || latest.ts !== lastTrade.ts)) {
          setLastTrade(latest);
          setTradeCount(data.wins + data.losses);
          setWinCount(data.wins);

          addEvent({
            id: `trade-${Date.now()}`,
            type: "result",
            message: `${latest.direction} $${latest.betAmount.toFixed(2)} → ${latest.result} ${latest.pnl >= 0 ? "+" : ""}$${latest.pnl.toFixed(2)}`,
            timestamp: Date.now(),
            direction: latest.direction,
            result: latest.result,
          });
        }
      }
    } catch {
      // ignore
    }
  }, [lastTrade, addEvent]);

  // SSE for real-time bot log
  useEffect(() => {
    const es = new EventSource("/api/bot/events");
    esRef.current = es;

    es.addEventListener("log", (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data);
        const msg = entry.message || "";

        if (msg.includes("FAST PATH") || msg.includes("SYNTH TRADE")) {
          const dir = msg.includes("UP") ? "UP" : msg.includes("DOWN") ? "DOWN" : undefined;
          addEvent({
            id: `log-${Date.now()}-${Math.random()}`,
            type: "execute",
            message: msg.slice(0, 80),
            timestamp: Date.now(),
            direction: dir,
          });
        } else if (msg.includes("SKIP")) {
          addEvent({
            id: `log-${Date.now()}-${Math.random()}`,
            type: "analyze",
            message: msg.slice(0, 60),
            timestamp: Date.now(),
          });
        } else if (msg.includes("FastLoop") || msg.includes("scanning")) {
          addEvent({
            id: `log-${Date.now()}-${Math.random()}`,
            type: "scan",
            message: msg.slice(0, 60),
            timestamp: Date.now(),
          });
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener("cycle", () => {
      addEvent({
        id: `cycle-${Date.now()}`,
        type: "scan",
        message: "Bot cycle completed",
        timestamp: Date.now(),
      });
    });

    return () => es.close();
  }, [addEvent]);

  // Poll trade log every 5s
  useEffect(() => {
    fetchTradeLog();
    const id = setInterval(fetchTradeLog, 5000);
    return () => clearInterval(id);
  }, [fetchTradeLog]);

  const winRate = tradeCount > 0 ? ((winCount / tradeCount) * 100).toFixed(1) : "0.0";

  return (
    <div className="min-h-screen bg-black text-white overflow-hidden relative">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-50 p-4 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-900/80 border border-zinc-800 hover:bg-zinc-800 transition-colors text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </button>
        <div className="flex items-center gap-4">
          <div className="glass-card px-4 py-2 flex items-center gap-2">
            <Activity className="w-4 h-4 text-green-400" />
            <span className="text-xs font-mono text-zinc-400">Trades: <span className="text-white font-bold">{tradeCount}</span></span>
          </div>
          <div className="glass-card px-4 py-2 flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-400" />
            <span className="text-xs font-mono text-zinc-400">WR: <span className={`font-bold ${winRate >= "55" ? "text-green-400" : "text-red-400"}`}>{winRate}%</span></span>
          </div>
        </div>
      </div>

      {/* Main visualization area */}
      <div ref={containerRef} className="relative w-full h-screen flex items-center justify-center">
        {/* Background grid */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
          backgroundSize: '40px 40px'
        }} />

        {/* SVG Connection Lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
          <defs>
            <linearGradient id="lineGradLeft" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity={isScanning ? 0.8 : 0.2} />
              <stop offset="100%" stopColor="#22c55e" stopOpacity={isScanning ? 0.8 : 0.2} />
            </linearGradient>
            <linearGradient id="lineGradRight" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#22c55e" stopOpacity={connectionGlow ? 1 : 0.2} />
              <stop offset="100%" stopColor="#a855f7" stopOpacity={connectionGlow ? 1 : 0.2} />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="4" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="glowStrong">
              <feGaussianBlur stdDeviation="8" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Bot → Green Dot connection */}
          <line
            x1="25%" y1="50%" x2="50%" y2="50%"
            stroke="url(#lineGradLeft)"
            strokeWidth={isScanning ? 3 : 1.5}
            filter={isScanning ? "url(#glow)" : undefined}
            className="transition-all duration-500"
          />

          {/* Green Dot → Polymarket connection */}
          <line
            x1="50%" y1="50%" x2="75%" y2="50%"
            stroke="url(#lineGradRight)"
            strokeWidth={connectionGlow ? 4 : 1.5}
            filter={connectionGlow ? "url(#glowStrong)" : undefined}
            className="transition-all duration-500"
          />

          {/* Animated pulse dots along the lines when active */}
          {isScanning && (
            <circle r="4" fill="#06b6d4" filter="url(#glow)">
              <animateMotion dur="1s" repeatCount="indefinite" path="M 25% 50% L 50% 50%" />
            </circle>
          )}
          {connectionGlow && (
            <circle r="5" fill="#22c55e" filter="url(#glowStrong)">
              <animateMotion dur="0.8s" repeatCount="2" path="M 50% 50% L 75% 50%" />
            </circle>
          )}
        </svg>

        {/* BOT Node (Left) */}
        <div className="absolute left-[20%] top-1/2 -translate-y-1/2 flex flex-col items-center gap-3" style={{ zIndex: 10 }}>
          <div className={`relative w-16 h-16 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${isScanning ? 'border-cyan-400 bg-cyan-500/20 shadow-[0_0_30px_rgba(6,182,212,0.4)]' : 'border-cyan-800 bg-cyan-950/30'}`}>
            <Bot className={`w-7 h-7 transition-colors duration-300 ${isScanning ? 'text-cyan-300' : 'text-cyan-700'}`} />
            {isScanning && (
              <div className="absolute inset-0 rounded-full border border-cyan-400 animate-ping opacity-30" />
            )}
          </div>
          <span className="text-[10px] uppercase tracking-widest text-cyan-600 font-bold">Bot Engine</span>
        </div>

        {/* GREEN DOT Node (Center) */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-4" style={{ zIndex: 10 }}>
          <div className={`relative w-28 h-28 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${isExecuting ? 'border-green-400 bg-green-500/25 shadow-[0_0_60px_rgba(34,197,94,0.6)]' : connectionGlow ? 'border-green-400 bg-green-500/15 shadow-[0_0_40px_rgba(34,197,94,0.4)]' : 'border-green-700 bg-green-950/20'}`}>
            <div className={`w-4 h-4 rounded-full transition-all duration-300 ${isExecuting ? 'bg-green-300 scale-150' : 'bg-green-600'}`}>
              {isExecuting && <div className="absolute inset-0 rounded-full bg-green-400 animate-ping" />}
            </div>
            {isExecuting && (
              <>
                <div className="absolute inset-[-8px] rounded-full border border-green-500/50 animate-ping" style={{ animationDuration: '1.5s' }} />
                <div className="absolute inset-[-16px] rounded-full border border-green-500/30 animate-ping" style={{ animationDuration: '2s' }} />
              </>
            )}
          </div>

          {/* Text that appears on the green dot */}
          <div className="w-64 text-center">
            {latestEvent ? (
              <div className={`inline-block px-4 py-2 rounded-lg border text-xs font-mono animate-fade-in-up ${latestEvent.type === 'execute' ? 'bg-green-950/60 border-green-600/50 text-green-300' : latestEvent.type === 'result' && latestEvent.result === 'WIN' ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300' : latestEvent.type === 'result' && latestEvent.result === 'LOSS' ? 'bg-red-950/60 border-red-500/50 text-red-300' : 'bg-zinc-900/60 border-zinc-700 text-zinc-300'}`}>
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  {latestEvent.type === 'execute' && <Zap className="w-3 h-3 text-yellow-400" />}
                  {latestEvent.type === 'result' && latestEvent.result === 'WIN' && <span className="text-emerald-400 font-bold">🏆 WIN</span>}
                  {latestEvent.type === 'result' && latestEvent.result === 'LOSS' && <span className="text-red-400 font-bold">✗ LOSS</span>}
                  {latestEvent.type === 'scan' && <Activity className="w-3 h-3 text-cyan-400" />}
                  {latestEvent.type === 'analyze' && <span className="text-zinc-400">⊘</span>}
                  <span className="text-[10px] text-zinc-500">{new Date(latestEvent.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="leading-relaxed">{latestEvent.message}</div>
                {latestEvent.direction && (
                  <div className={`mt-1 text-[10px] font-bold ${latestEvent.direction === 'UP' ? 'text-green-400' : 'text-red-400'}`}>
                    {latestEvent.direction === 'UP' ? '▲ LONG' : '▼ SHORT'}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-zinc-600 font-mono">Waiting for signals...</div>
            )}
          </div>
        </div>

        {/* POLYMARKET Node (Right) */}
        <div className="absolute right-[20%] top-1/2 -translate-y-1/2 flex flex-col items-center gap-3" style={{ zIndex: 10 }}>
          <div className={`relative w-20 h-20 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${connectionGlow ? 'border-purple-400 bg-purple-500/20 shadow-[0_0_40px_rgba(168,85,247,0.5)]' : 'border-purple-800 bg-purple-950/30'}`}>
            <Globe className={`w-8 h-8 transition-colors duration-300 ${connectionGlow ? 'text-purple-300' : 'text-purple-700'}`} />
            {connectionGlow && (
              <div className="absolute inset-0 rounded-full border border-purple-400 animate-ping opacity-40" />
            )}
          </div>
          <span className="text-[10px] uppercase tracking-widest text-purple-600 font-bold">Polymarket</span>
        </div>

        {/* Bottom event stream */}
        <div className="absolute bottom-0 left-0 right-0 p-4">
          <div className="max-w-4xl mx-auto">
            <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-2 font-bold">Event Stream</div>
            <div className="h-32 overflow-hidden relative">
              <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black to-transparent pointer-events-none" />
              <div className="space-y-1.5">
                {events.slice(0, 12).map((ev) => (
                  <div
                    key={ev.id}
                    className={`flex items-center gap-3 text-xs font-mono px-2 py-1 rounded ${
                      ev.type === 'execute' ? 'text-green-400' :
                      ev.type === 'result' && ev.result === 'WIN' ? 'text-emerald-400' :
                      ev.type === 'result' && ev.result === 'LOSS' ? 'text-red-400' :
                      ev.type === 'scan' ? 'text-cyan-600' :
                      'text-zinc-500'
                    }`}
                  >
                    <span className="text-zinc-700 text-[10px] shrink-0 w-16">{new Date(ev.timestamp).toLocaleTimeString()}</span>
                    <span className="shrink-0 w-16 text-[10px] font-bold uppercase">
                      {ev.type === 'execute' && <span className="text-green-500">EXECUTE</span>}
                      {ev.type === 'result' && <span className={ev.result === 'WIN' ? 'text-emerald-500' : 'text-red-500'}>{ev.result}</span>}
                      {ev.type === 'scan' && <span className="text-cyan-600">SCAN</span>}
                      {ev.type === 'analyze' && <span className="text-zinc-600">SKIP</span>}
                    </span>
                    <span className="truncate">{ev.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up {
          animation: fade-in-up 0.4s ease-out;
        }
      `}</style>
    </div>
  );
}
