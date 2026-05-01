import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Activity, DollarSign, Clock, Smile } from "lucide-react";
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

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      {/* ── Header ── */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center gap-3">
            <Activity className="text-blue-500 w-10 h-10" />
            Trading Bot
          </h1>
          <p className="text-zinc-400 max-w-md italic">
            BTC 5-minute prediction market trading engine
          </p>
        </div>

        <div className="flex flex-wrap gap-4">
          {/* Countdown */}
          <div className="glass-card p-4 flex items-center gap-3">
            <Clock className="w-4 h-4 text-zinc-500" />
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Window closes in</span>
              <span className={cn("text-xl font-mono font-bold", countdownColor)}>
                {String(Math.floor(countdown / 60)).padStart(2, "0")}:{String(countdown % 60).padStart(2, "0")}
              </span>
            </div>
          </div>

          {balance && (
            <div className="glass-card p-4 flex flex-col justify-center">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-1">Trading Balance</span>
              <span className="text-sm font-mono text-green-400 font-bold">${balance.polymarketBalance} USDC</span>
              <span className="text-[10px] text-zinc-500">Trade via {balance.funderAddress ? "Polymarket Profile" : "Wallet Signer"}</span>
              <span className="text-xs font-mono text-zinc-500 truncate w-40">{balance.tradingAddress}</span>
              <span className="text-[10px] text-zinc-600 mt-1">Wallet: {balance.onChainBalance} {balance.tokenSymbolUsed}</span>
            </div>
          )}

          {sentiment && (
            <div className="glass-card p-4 flex items-center gap-4">
              <div className="bg-zinc-800 p-2 rounded-lg">
                <Smile className={cn("w-5 h-5", sentiment.value > 60 ? "text-green-500" : sentiment.value < 40 ? "text-red-500" : "text-yellow-500")} />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Sentiment</span>
                <span className="text-sm font-bold">{sentiment.value_classification} ({sentiment.value})</span>
              </div>
            </div>
          )}

          <div className="glass-card p-4 flex items-center gap-6">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-1">Live BTC</span>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-green-500" />
                <span className="text-xl font-mono font-bold">
                  {btcPrice ? parseFloat(btcPrice.price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : "---"}
                </span>
              </div>
            </div>
            <button type="button" title="Refresh" onClick={fetchData} disabled={loading} className="btn-secondary p-2 rounded-full">
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </header>

      <BotDashboard />

      {/* Paper Trade Widget - injected below dashboard */}
      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-1">
          <PaperTradeWidget />
        </div>
      </div>

      <footer className="mt-20 pt-8 border-t border-zinc-900 text-center text-zinc-600 text-sm">
        <p>© 2026 PolyBTC AI Trader • Personal use only • Not financial advice</p>
      </footer>

      <BotLogSidebar />
    </div>
  );
}
