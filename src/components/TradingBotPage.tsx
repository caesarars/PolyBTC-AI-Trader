import { useState, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import BotDashboard from "./BotDashboard";
import PaperTradeWidget from "./PaperTradeWidget";
import BotLogSidebar from "./BotLogSidebar";

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}

function useWindowCountdown(): number {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      setSecs(300 - (now % 300));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return secs;
}

export default function TradingBotPage() {
  type BalanceState = {
    balance: string;
    polymarketBalance: string;
    onChainBalance: string;
    funderAddress: string | null;
    tradingAddress: string;
    tokenSymbolUsed: string;
  };

  const [btcPrice, setBtcPrice] = useState<{ price: string } | null>(null);
  const [sentiment, setSentiment] = useState<{ value: number; value_classification: string } | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [loading, setLoading] = useState(false);

  const countdown = useWindowCountdown();
  const countdownColor = countdown <= 30 ? "text-red-400" : countdown <= 60 ? "text-yellow-400" : "text-green-400";

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [priceRes, sentimentRes, balanceRes] = await Promise.all([
        fetch("/api/btc-price"),
        fetch("/api/sentiment"),
        fetch("/api/polymarket/balance"),
      ]);
      const [priceData, sentimentData, balanceData] = await Promise.all([
        priceRes.json(),
        sentimentRes.json(),
        balanceRes.json(),
      ]);
      setBtcPrice(priceData);
      setSentiment(sentimentData);
      setBalance(balanceData.error ? null : balanceData);
    } catch (error) {
      console.error("Fetch Error:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const sentimentColor = sentiment
    ? sentiment.value > 60
      ? "text-emerald-400"
      : sentiment.value < 40
      ? "text-red-400"
      : "text-amber-400"
    : "text-zinc-500";

  return (
    <div className="px-4 md:px-8 py-6 max-w-6xl mx-auto">
      {/* ── Minimal status strip ── */}
      <div className="flex items-center flex-wrap gap-x-8 gap-y-3 mb-8 text-sm">
        <Stat label="Window" mono>
          <span className={cn("font-medium", countdownColor)}>
            {String(Math.floor(countdown / 60)).padStart(2, "0")}:{String(countdown % 60).padStart(2, "0")}
          </span>
        </Stat>

        <Stat label="BTC" mono>
          {btcPrice ? (
            <span className="font-medium text-zinc-100">
              ${parseFloat(btcPrice.price).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          ) : (
            <span className="text-zinc-600">---</span>
          )}
        </Stat>

        {balance && (
          <Stat label="Balance" mono>
            <span className="font-medium text-emerald-400">${balance.polymarketBalance}</span>
          </Stat>
        )}

        {sentiment && (
          <Stat label="Sentiment">
            <span className={cn("font-medium", sentimentColor)}>
              {sentiment.value_classification} · {sentiment.value}
            </span>
          </Stat>
        )}

        <button
          type="button"
          title="Refresh"
          onClick={fetchData}
          disabled={loading}
          className="ml-auto text-zinc-500 hover:text-zinc-200 transition-colors p-1"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
        </button>
      </div>

      <BotDashboard />

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-1">
          <PaperTradeWidget />
        </div>
      </div>

      <footer className="mt-20 pt-6 border-t border-zinc-900 text-center text-zinc-700 text-[11px]">
        © 2026 PolyBTC AI Trader · Personal use · Not financial advice
      </footer>

      <BotLogSidebar />
    </div>
  );
}

function Stat({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">{label}</span>
      <span className={mono ? "font-mono text-sm" : "text-sm"}>{children}</span>
    </div>
  );
}
