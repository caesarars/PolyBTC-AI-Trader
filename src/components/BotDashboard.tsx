import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, LineChart as LineChartIcon, Play, Radar } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function cn(...inputs: Array<string | false | null | undefined>) {
  return inputs.filter(Boolean).join(" ");
}

interface BotStatus {
  enabled: boolean;
  running: boolean;
  config: {
    fixedTradeUsdc?: number;
  };
}

interface BotLogEntry {
  timestamp: string;
  decision: string;
  tradeAmount?: number;
  tradePrice?: number;
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

function latencyTone(grade: PingProbe["grade"] | PingState["summary"]["grade"], ok = true) {
  if (!ok || grade === "down") return "border-rose-500/30 bg-rose-500/10 text-rose-300";
  if (grade === "excellent") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (grade === "good") return "border-sky-500/30 bg-sky-500/10 text-sky-300";
  if (grade === "usable") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-orange-500/30 bg-orange-500/10 text-orange-300";
}

export default function BotDashboard() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [log, setLog] = useState<BotLogEntry[]>([]);
  const [starting, setStarting] = useState(false);
  const [savingSize, setSavingSize] = useState<number | null>(null);
  const [ping, setPing] = useState<PingState | null>(null);
  const [pinging, setPinging] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, logRes] = await Promise.all([
        fetch("/api/bot/status").then((r) => r.json()),
        fetch("/api/bot/log").then((r) => r.json()),
      ]);
      setStatus(statusRes as BotStatus);
      setLog((logRes?.log || []) as BotLogEntry[]);
    } catch {
      // keep last known state
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const es = new EventSource("/api/bot/events");
    es.addEventListener("cycle", fetchAll);
    return () => es.close();
  }, [fetchAll]);

  const handleStart = async () => {
    if (status?.enabled) return;
    setStarting(true);
    try {
      await fetch("/api/bot/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      await fetchAll();
    } finally {
      setStarting(false);
    }
  };

  const handleFixedEntrySize = async (value: number) => {
    setSavingSize(value);
    try {
      await fetch("/api/bot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixedTradeUsdc: value }),
      });
      await fetchAll();
    } finally {
      setSavingSize(null);
    }
  };

  const handlePingTest = async () => {
    setPinging(true);
    try {
      const startedAt = performance.now();
      const response = await fetch("/api/bot/ping");
      const data = (await response.json()) as PingState;
      const browserRttMs = Math.round(performance.now() - startedAt);
      setPing({ ...data, browserRttMs });
    } finally {
      setPinging(false);
    }
  };

  const pnlHistory = useMemo(() => {
    const resolved = [...log]
      .filter((entry) => entry.decision === "WIN" || entry.decision === "LOSS")
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let cumulative = 0;
    return resolved.map((entry, index) => {
      const betAmount = entry.tradeAmount ?? 0;
      const entryPrice = entry.tradePrice ?? 0.5;
      const tradePnl =
        entry.decision === "WIN"
          ? parseFloat(((betAmount / entryPrice) - betAmount).toFixed(2))
          : parseFloat((-betAmount).toFixed(2));

      cumulative = parseFloat((cumulative + tradePnl).toFixed(2));

      return {
        id: index + 1,
        time: new Date(entry.timestamp).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        cumulative,
        trade: tradePnl,
        decision: entry.decision,
      };
    });
  }, [log]);

  const lastPnl = pnlHistory.length > 0 ? pnlHistory[pnlHistory.length - 1].cumulative : 0;
  const activeFixedSize = status?.config.fixedTradeUsdc ?? 2;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[32px] border border-zinc-800 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_28%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.10),transparent_24%),linear-gradient(180deg,rgba(24,24,27,0.98),rgba(9,9,11,0.98))] p-6 shadow-[0_22px_80px_rgba(0,0,0,0.45)]">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/70 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.24em] text-zinc-400">
              <Activity className="h-3.5 w-3.5" />
              Minimal Bot Controller
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-white">Run the bot. Track the curve.</h2>
            <p className="mt-1 text-sm text-zinc-500">Hanya tombol start, fixed entry size, dan grafik PnL.</p>
          </div>

          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs font-medium text-zinc-400">
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  status?.enabled ? "bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.8)]" : "bg-zinc-600"
                )}
              />
              {status?.enabled ? (status.running ? "Bot Running" : "Bot Enabled") : "Bot Stopped"}
            </span>

            <button
              type="button"
              onClick={handlePingTest}
              disabled={pinging}
              className={cn(
                "inline-flex min-w-[150px] items-center justify-center gap-2 rounded-2xl border border-zinc-700 bg-zinc-950/80 px-5 py-3 text-sm font-bold text-zinc-200 transition-all hover:border-zinc-500 hover:bg-zinc-900",
                pinging && "opacity-70"
              )}
            >
              <Radar className="h-4 w-4" />
              {pinging ? "Testing..." : "Test Ping"}
            </button>

            <button
              type="button"
              onClick={handleStart}
              disabled={starting || status?.enabled}
              className={cn(
                "inline-flex min-w-[180px] items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold transition-all",
                status?.enabled
                  ? "cursor-default border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "bg-emerald-500 text-black hover:bg-emerald-400"
              )}
            >
              <Play className="h-4 w-4" />
              {starting ? "Starting..." : status?.enabled ? "Bot Running" : "Start Bot"}
            </button>
          </div>
        </div>

        <div className="mb-6 rounded-[28px] border border-zinc-800/80 bg-zinc-950/50 p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Price Lag Ping Test</div>
              <div className="mt-1 text-lg font-semibold text-white">
                {ping ? `${ping.summary.averageMs ?? "-"} ms average upstream latency` : "Belum ada hasil ping"}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Yang relevan untuk strategy ini adalah ping server bot ke upstream Polymarket dan feed harga.
              </p>
            </div>

            {ping && (
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("rounded-full border px-3 py-1 text-xs font-semibold", latencyTone(ping.summary.grade, true))}>
                  {ping.summary.grade.toUpperCase()}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-semibold",
                    ping.summary.criticalReady
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                  )}
                >
                  {ping.summary.criticalReady ? "Polymarket Ready" : "Latency Too High"}
                </span>
              </div>
            )}
          </div>

          {ping ? (
            <>
              <div className="mb-4 grid gap-2 md:grid-cols-4">
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Fastest</div>
                  <div className="mt-1 text-lg font-semibold text-white">{ping.summary.fastestMs ?? "-"} ms</div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Average</div>
                  <div className="mt-1 text-lg font-semibold text-white">{ping.summary.averageMs ?? "-"} ms</div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Slowest</div>
                  <div className="mt-1 text-lg font-semibold text-white">{ping.summary.slowestMs ?? "-"} ms</div>
                </div>
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Browser RTT</div>
                  <div className="mt-1 text-lg font-semibold text-white">{ping.browserRttMs ?? "-"} ms</div>
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                {ping.upstreams.map((entry) => (
                  <div
                    key={entry.key}
                    className={cn("rounded-2xl border px-4 py-3", latencyTone(entry.grade, entry.ok))}
                  >
                    <div className="text-[11px] uppercase tracking-[0.22em] opacity-70">{entry.label}</div>
                    <div className="mt-1 text-xl font-semibold">
                      {entry.latencyMs != null ? `${entry.latencyMs} ms` : "DOWN"}
                    </div>
                    <div className="mt-1 text-xs opacity-80">
                      {entry.status != null ? `HTTP ${entry.status}` : entry.error || "No response"}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-5 text-sm text-zinc-600">
              Klik `Test Ping` untuk cek latency server bot ke Polymarket, Binance, dan Coinbase.
            </div>
          )}
        </div>

        <div className="mb-6 rounded-[28px] border border-zinc-800/80 bg-zinc-950/50 p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Fixed Entry Size</div>
              <div className="mt-1 text-lg font-semibold text-white">${activeFixedSize.toFixed(2)} per trade</div>
            </div>
            <div className="text-right text-[11px] text-zinc-500">Klik nominal untuk langsung apply ke backend bot</div>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {[1, 2, 3, 4, 5].map((value) => {
              const active = activeFixedSize === value;
              const loading = savingSize === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleFixedEntrySize(value)}
                  disabled={savingSize !== null}
                  className={cn(
                    "rounded-2xl border px-3 py-3 text-sm font-bold transition-all",
                    active
                      ? "border-amber-400/50 bg-amber-400/10 text-amber-300"
                      : "border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-600 hover:text-white",
                    loading && "opacity-60"
                  )}
                >
                  {loading ? "..." : `$${value}`}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-[28px] border border-zinc-800/80 bg-zinc-950/45 p-5">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.24em] text-emerald-300">
                <LineChartIcon className="h-3.5 w-3.5" />
                PnL Line Graph
              </div>
              <h3 className="text-xl font-semibold text-white">Cumulative bot PnL</h3>
              <p className="mt-1 text-xs text-zinc-500">
                {pnlHistory.length} resolved trade{pnlHistory.length !== 1 ? "s" : ""}
              </p>
            </div>

            <div className="text-right">
              <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Net PnL</div>
              <div
                className={cn(
                  "mt-1 text-3xl font-semibold tracking-tight",
                  lastPnl > 0 ? "text-emerald-400" : lastPnl < 0 ? "text-rose-400" : "text-zinc-100"
                )}
              >
                {lastPnl > 0 ? "+" : ""}${lastPnl.toFixed(2)}
              </div>
            </div>
          </div>

          {pnlHistory.length === 0 ? (
            <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-[24px] border border-dashed border-zinc-800 bg-zinc-950/40 text-zinc-700">
              <LineChartIcon className="h-12 w-12 opacity-40" />
              <p className="text-sm">Belum ada trade yang resolve. Grafik muncul setelah WIN atau LOSS pertama.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={pnlHistory} margin={{ top: 20, right: 16, left: 4, bottom: 8 }}>
                <defs>
                  <linearGradient id="pnlGlow" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={lastPnl >= 0 ? "#34d399" : "#fb7185"} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={lastPnl >= 0 ? "#60a5fa" : "#f87171"} stopOpacity={0.9} />
                  </linearGradient>
                </defs>

                <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
                <ReferenceLine y={0} stroke="#71717a" strokeDasharray="5 5" strokeWidth={1} />
                <XAxis
                  dataKey="time"
                  tick={{ fill: "#71717a", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: "#71717a", fontSize: 10, fontFamily: "monospace" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                  width={52}
                />
                <Tooltip
                  cursor={{ stroke: "#3f3f46", strokeWidth: 1, strokeDasharray: "4 4" }}
                  contentStyle={{
                    background: "rgba(9, 9, 11, 0.92)",
                    border: "1px solid #3f3f46",
                    borderRadius: 16,
                    boxShadow: "0 18px 44px rgba(0,0,0,0.45)",
                    fontSize: 11,
                    color: "#e4e4e7",
                  }}
                  labelStyle={{ color: "#a1a1aa", marginBottom: 6 }}
                  formatter={(value: any) => [`${Number(value) >= 0 ? "+" : ""}$${Number(value).toFixed(2)}`, "Cumulative PnL"]}
                />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke="url(#pnlGlow)"
                  strokeWidth={4}
                  dot={(props: any) => {
                    const { cx, cy, payload } = props;
                    const isWin = payload.decision === "WIN";
                    return (
                      <circle
                        key={`dot-${cx}-${cy}`}
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill={isWin ? "#34d399" : "#fb7185"}
                        stroke="#09090b"
                        strokeWidth={2}
                      />
                    );
                  }}
                  activeDot={{ r: 7, stroke: "#09090b", strokeWidth: 2.5, fill: lastPnl >= 0 ? "#34d399" : "#fb7185" }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>
    </div>
  );
}
