import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Bot,
  X,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Minus,
  Wifi,
  WifiOff,
} from "lucide-react";

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
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

interface BotStatus {
  enabled: boolean;
  running: boolean;
  sessionTradesCount: number;
  windowElapsedSeconds: number;
}

export default function BotLogSidebar() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<BotLogEntry[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLogLen = useRef(0);

  const fetchLog = useCallback(async () => {
    try {
      const [logRes, statusRes] = await Promise.all([
        fetch("/api/bot/log"),
        fetch("/api/bot/status"),
      ]);
      const logData = await logRes.json();
      const statusData = await statusRes.json();
      const entries: BotLogEntry[] = logData.log || [];

      setLog(entries);
      setStatus(statusData);
      setConnected(true);

      // Count new entries since last fetch
      if (entries.length > prevLogLen.current) {
        const newCount = entries.length - prevLogLen.current;
        if (!open) setUnread((u) => u + newCount);
      }
      prevLogLen.current = entries.length;
    } catch {
      setConnected(false);
    }
  }, [open]);

  useEffect(() => {
    fetchLog();
    const interval = setInterval(fetchLog, 3000);
    return () => clearInterval(interval);
  }, [fetchLog]);

  // Auto-scroll to bottom when new entries arrive and sidebar is open
  useEffect(() => {
    if (open) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }, [log.length, open]);

  const handleOpen = () => {
    setOpen(true);
    setUnread(0);
  };

  const windowRemaining = status ? 300 - status.windowElapsedSeconds : 0;
  const entryZone = status
    ? status.windowElapsedSeconds >= 30 && status.windowElapsedSeconds <= 270
    : false;

  return (
    <>
      {/* ── Floating trigger button ── */}
      <AnimatePresence>
        {!open && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onClick={handleOpen}
            className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-zinc-900 border border-zinc-700 shadow-2xl flex items-center justify-center hover:border-blue-500/60 hover:bg-zinc-800 transition-all group"
          >
            <Bot className="w-6 h-6 text-zinc-400 group-hover:text-blue-400 transition-colors" />

            {/* Status dot */}
            <span className={cn(
              "absolute top-1 right-1 w-3 h-3 rounded-full border-2 border-zinc-900",
              status?.enabled
                ? status.running
                  ? "bg-blue-400 animate-pulse"
                  : "bg-green-400"
                : "bg-zinc-600"
            )} />

            {/* Unread badge */}
            {unread > 0 && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="absolute -top-1 -left-1 w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center"
              >
                {unread > 9 ? "9+" : unread}
              </motion.span>
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── Sidebar panel ── */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop (mobile) */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/40 md:hidden"
            />

            <motion.div
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed right-0 top-0 bottom-0 z-50 w-[360px] flex flex-col bg-zinc-950 border-l border-zinc-800 shadow-2xl"
            >
              {/* ── Header ── */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900">
                <div className="flex items-center gap-2.5">
                  <div className="relative">
                    <Bot className="w-5 h-5 text-blue-400" />
                    <span className={cn(
                      "absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-zinc-900",
                      status?.enabled
                        ? status.running ? "bg-blue-400 animate-pulse" : "bg-green-400"
                        : "bg-zinc-600"
                    )} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white leading-none">Bot Log</p>
                    <p className="text-[10px] text-zinc-500 mt-0.5">
                      {status?.enabled ? (status.running ? "Running..." : "Idle") : "Stopped"} · {log.length} entries
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Connection indicator */}
                  {connected
                    ? <Wifi className="w-3.5 h-3.5 text-green-400" />
                    : <WifiOff className="w-3.5 h-3.5 text-red-400" />
                  }

                  {/* Window timer pill */}
                  {status && (
                    <span className={cn(
                      "text-[10px] font-mono font-bold px-2 py-0.5 rounded-full",
                      entryZone
                        ? "bg-green-500/20 text-green-400"
                        : windowRemaining <= 30
                          ? "bg-red-500/20 text-red-400"
                          : "bg-zinc-800 text-zinc-500"
                    )}>
                      {String(Math.floor(windowRemaining / 60)).padStart(2, "0")}:{String(windowRemaining % 60).padStart(2, "0")}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="text-zinc-500 hover:text-white transition-colors p-1"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* ── Session stats bar ── */}
              {status?.enabled && (
                <div className="flex items-center gap-4 px-4 py-2 bg-zinc-900/60 border-b border-zinc-800/60 text-[10px] text-zinc-500">
                  <span>Trades: <span className="text-white font-bold">{status.sessionTradesCount}</span></span>
                  <span className={cn("font-bold", entryZone ? "text-green-400" : "text-zinc-600")}>
                    {entryZone ? "● ENTRY ZONE" : "○ Out of zone"}
                  </span>
                </div>
              )}

              {/* ── Log messages ── */}
              <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 scroll-smooth">
                {log.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-600">
                    <Bot className="w-10 h-10 opacity-20" />
                    <p className="text-sm">No log entries yet.</p>
                    <p className="text-xs text-center">Start the bot from the Bot tab<br />to see live decisions here.</p>
                  </div>
                ) : (
                  // Reverse so newest is at bottom (chat style)
                  [...log].reverse().map((entry, i) => (
                    <BotMessage key={`${entry.timestamp}-${i}`} entry={entry} />
                  ))
                )}
                <div ref={bottomRef} />
              </div>

              {/* ── Footer ── */}
              <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-900/60">
                <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                  Live · refreshes every 3s
                  {status && (
                    <span className="ml-auto">
                      {connected ? "Connected" : "Reconnecting..."}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function BotMessage({ entry }: { entry: BotLogEntry }) {
  const isTraded = entry.tradeExecuted;
  const isError = Boolean(entry.error);
  const isNoTrade = entry.decision === "NO_TRADE";

  const time = new Date(entry.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn(
        "rounded-xl px-3 py-2.5 text-xs border",
        isTraded
          ? "bg-green-500/10 border-green-500/25"
          : isError
            ? "bg-red-500/10 border-red-500/20"
            : isNoTrade
              ? "bg-zinc-800/50 border-zinc-700/40"
              : "bg-blue-500/5 border-blue-500/15"
      )}
    >
      {/* Row 1: timestamp + decision badge */}
      <div className="flex items-center justify-between mb-1.5 gap-2">
        <span className="text-zinc-600 font-mono text-[10px]">{time}</span>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {/* Decision badge */}
          {isTraded ? (
            <span className="flex items-center gap-1 bg-green-500/20 text-green-400 font-bold px-1.5 py-0.5 rounded text-[10px]">
              <CheckCircle2 className="w-3 h-3" />
              TRADED
            </span>
          ) : isError ? (
            <span className="flex items-center gap-1 bg-red-500/20 text-red-400 font-bold px-1.5 py-0.5 rounded text-[10px]">
              <XCircle className="w-3 h-3" />
              ERROR
            </span>
          ) : isNoTrade ? (
            <span className="flex items-center gap-1 bg-zinc-700 text-zinc-400 font-bold px-1.5 py-0.5 rounded text-[10px]">
              <Minus className="w-3 h-3" />
              SKIP
            </span>
          ) : null}

          {/* Direction badge */}
          {entry.direction !== "NONE" && (
            <span className={cn(
              "flex items-center gap-0.5 font-bold px-1.5 py-0.5 rounded text-[10px]",
              entry.direction === "UP"
                ? "bg-green-500/20 text-green-400"
                : "bg-red-500/20 text-red-400"
            )}>
              {entry.direction === "UP"
                ? <TrendingUp className="w-3 h-3" />
                : <TrendingDown className="w-3 h-3" />
              }
              {entry.direction}
            </span>
          )}

          {/* Risk badge */}
          {entry.confidence > 0 && (
            <span className={cn(
              "font-bold px-1.5 py-0.5 rounded text-[10px]",
              entry.riskLevel === "LOW"
                ? "bg-green-500/15 text-green-500"
                : entry.riskLevel === "MEDIUM"
                  ? "bg-yellow-500/15 text-yellow-400"
                  : "bg-red-500/15 text-red-400"
            )}>
              {entry.riskLevel}
            </span>
          )}
        </div>
      </div>

      {/* Row 2: confidence + edge stats */}
      {entry.confidence > 0 && (
        <div className="flex items-center gap-3 mb-1.5 text-[10px]">
          <span className="text-zinc-500">Conf: <span className="text-zinc-200 font-bold">{entry.confidence}%</span></span>
          <span className="text-zinc-500">Edge: <span className="text-zinc-200 font-bold">{entry.edge}¢</span></span>
        </div>
      )}

      {/* Row 3: trade details */}
      {isTraded && entry.tradeAmount && (
        <div className="mb-1.5 bg-green-500/10 rounded-lg px-2 py-1.5 text-[10px]">
          <div className="flex items-center gap-2 text-green-400 font-bold mb-0.5">
            <CheckCircle2 className="w-3 h-3" />
            Order placed
          </div>
          <div className="text-zinc-400 space-y-0.5">
            <div>Amount: <span className="text-white font-bold">${entry.tradeAmount.toFixed(2)}</span></div>
            <div>Price: <span className="text-white font-bold">{entry.tradePrice ? (entry.tradePrice * 100).toFixed(1) : "?"}¢</span></div>
            {entry.orderId && (
              <div className="font-mono text-zinc-600 truncate">ID: {entry.orderId}</div>
            )}
          </div>
        </div>
      )}

      {/* Row 4: error */}
      {isError && (
        <div className="mb-1.5 flex items-start gap-1.5 text-red-400 text-[10px]">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{entry.error}</span>
        </div>
      )}

      {/* Row 5: market label */}
      <div className="text-zinc-600 text-[10px] truncate">{entry.market}</div>

      {/* Row 6: reasoning (collapsed, show always) */}
      <div className="mt-1 text-zinc-500 text-[10px] leading-relaxed line-clamp-3">
        {entry.reasoning}
      </div>
    </motion.div>
  );
}
