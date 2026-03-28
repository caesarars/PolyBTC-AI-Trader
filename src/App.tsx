import { useState, useEffect, useCallback, useRef } from "react";
import { Market, BTCPrice, AIRecommendation, BTCHistory, SentimentData, OrderBook, BTCIndicators } from "./types";
import { analyzeMarket } from "./services/gemini";
import {
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Brain,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
  DollarSign,
  BarChart3,
  Smile,
  Clock,
  Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import ReactMarkdown from "react-markdown";
import CandlestickChart from "./components/CandlestickChart";
import BotDashboard from "./components/BotDashboard";
import BotLogSidebar from "./components/BotLogSidebar";

// ── Kelly Criterion (15% Kelly, hard-capped at 3% of bankroll) ──────────────
function kellyBet(bankroll: number, confidence: number, impliedPrice: number): number {
  const p = confidence / 100;
  const q = 1 - p;
  const b = (1 - impliedPrice) / impliedPrice; // net odds
  const kelly = (p * b - q) / b;
  if (kelly <= 0) return 0;
  const bet = bankroll * kelly * 0.15; // 15% Kelly
  const maxBet = bankroll * 0.03;      // hard cap: 3% of bankroll
  return parseFloat(Math.min(bet, maxBet).toFixed(2));
}

// ── Window countdown (seconds left in current 5-min session) ────────────────
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

export default function App() {
  type BalanceState = {
    address: string;
    balance: string;
    polymarketBalance: string;
    onChainBalance: string;
    walletAddress: string;
    funderAddress: string | null;
    tradingAddress: string;
    tokenSymbolUsed: string;
  };
  type OrderTrackerState = {
    orderID: string;
    status: string;
    positionState: string;
    outcome: string;
    side: string;
    market: string;
    assetId: string;
    price: string;
    originalSize: string;
    matchedSize: string;
    remainingSize: string;
    fillPercent: string;
    createdAt: number;
    expiration: string;
  };
  type PerformanceState = {
    summary: {
      totalMatchedTrades: number;
      closedTrades: number;
      winCount: number;
      lossCount: number;
      winRate: string;
      realizedPnl: string;
      openExposure: string;
    };
    history: Array<{
      id: string;
      market: string;
      outcome: string;
      side: string;
      traderSide: string;
      status: string;
      size: string;
      price: string;
      notional: string;
      pnl: string;
      matchTime: string;
      transactionHash: string;
      assetId: string;
    }>;
    openPositions: Array<{
      assetId: string;
      market: string;
      outcome: string;
      size: string;
      costBasis: string;
      averagePrice: string;
    }>;
  };
  type PositionAutomation = {
    takeProfit: string;
    stopLoss: string;
    trailingStop: string;
    armed: boolean;
    status?: string;
    lastPrice?: string;
    highestPrice?: string;
    trailingStopPrice?: string;
    lastExitOrderId?: string | null;
  };

  const [markets, setMarkets] = useState<Market[]>([]);
  const [btcPrice, setBtcPrice] = useState<BTCPrice | null>(null);
  const [btcHistory, setBtcHistory] = useState<BTCHistory[]>([]);
  const [indicators, setIndicators] = useState<BTCIndicators | null>(null);
  const [sentiment, setSentiment] = useState<SentimentData | null>(null);
  const [page, setPage] = useState<"markets" | "bot">("markets");
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Record<string, AIRecommendation>>({});
  const [orderBooks, setOrderBooks] = useState<Record<string, OrderBook>>({});
  const [marketHistories, setMarketHistories] = useState<Record<string, any[]>>({});
  const [tradingId, setTradingId] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [tradeAmount, setTradeAmount] = useState<string>("10");
  const [confirmTradeAmount, setConfirmTradeAmount] = useState<string>("");
  const [confirmTradeData, setConfirmTradeData] = useState<{ market: Market; outcomeIndex: number } | null>(null);
  const [executionMode, setExecutionMode] = useState<"PASSIVE" | "AGGRESSIVE">("AGGRESSIVE");
  const [autoRepriceEnabled, setAutoRepriceEnabled] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [orderLookupId, setOrderLookupId] = useState<string>("");
  const [orderLookupLoading, setOrderLookupLoading] = useState(false);
  const [trackedOrder, setTrackedOrder] = useState<OrderTrackerState | null>(null);
  const [performance, setPerformance] = useState<PerformanceState | null>(null);
  const [positionAutomation, setPositionAutomation] = useState<Record<string, PositionAutomation>>({});
  const [automationBusy, setAutomationBusy] = useState<Record<string, boolean>>({});
  const [openPositionFilter, setOpenPositionFilter] = useState<"active" | "all">("active");
  const [openPositionsRefreshing, setOpenPositionsRefreshing] = useState(false);
  const autoAnalyzedRef = useRef<Set<string>>(new Set());
  const lastWindowRefreshRef = useRef<number | null>(null);

  const countdown = useWindowCountdown();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [marketsRes, priceRes, historyRes, indicatorsRes, sentimentRes, balanceRes, performanceRes, automationRes] = await Promise.all([
        fetch("/api/polymarket/markets"),
        fetch("/api/btc-price"),
        fetch("/api/btc-history"),
        fetch("/api/btc-indicators"),
        fetch("/api/sentiment"),
        fetch("/api/polymarket/balance"),
        fetch("/api/polymarket/performance"),
        fetch("/api/polymarket/automation"),
      ]);

      const [marketsData, priceData, historyData, indicatorsData, sentimentData, balanceData, performanceData, automationData] = await Promise.all([
        marketsRes.json(),
        priceRes.json(),
        historyRes.json(),
        indicatorsRes.json(),
        sentimentRes.json(),
        balanceRes.json(),
        performanceRes.json(),
        automationRes.json(),
      ]);

      setMarkets(Array.isArray(marketsData) ? marketsData : []);
      setBtcPrice(priceData);
      setBtcHistory(Array.isArray(historyData) ? historyData : []);
      setIndicators(indicatorsData.error ? null : indicatorsData);
      setSentiment(sentimentData);
      setBalance(balanceData.error ? null : balanceData);
      setPerformance(performanceData.error ? null : performanceData);
      setPositionAutomation(
        Object.fromEntries(
          ((automationData?.automations || []) as any[]).map((item) => [
            item.assetId,
            {
              takeProfit: item.takeProfit || "",
              stopLoss: item.stopLoss || "",
              trailingStop: item.trailingStop || "",
              armed: Boolean(item.armed),
              status: item.status,
              lastPrice: item.lastPrice,
              highestPrice: item.highestPrice,
              trailingStopPrice: item.trailingStopPrice,
              lastExitOrderId: item.lastExitOrderId || null,
            },
          ])
        )
      );
    } catch (error) {
      console.error("Fetch Error:", error);
    } finally {
      setLoading(false);
      setInitialLoad(false);
    }
  }, []);

  // Reset auto-analyzed set when the 5-min window rolls over
  useEffect(() => {
    if (countdown === 299) autoAnalyzedRef.current.clear();
  }, [countdown]);

  // Auto-analyze new markets when they load
  useEffect(() => {
    if (!autoAnalyze || loading || markets.length === 0) return;
    markets.forEach((market) => {
      if (!autoAnalyzedRef.current.has(market.id)) {
        autoAnalyzedRef.current.add(market.id);
        handleAnalyze(market);
      }
    });
  }, [markets, loading, autoAnalyze, btcPrice, btcHistory, indicators, sentiment]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const currentWindow = Math.floor(Date.now() / 1000 / 300);
    if (countdown >= 299 && lastWindowRefreshRef.current !== currentWindow) {
      lastWindowRefreshRef.current = currentWindow;
      fetchData();
    }
  }, [countdown, fetchData]);

  const handleAnalyze = async (market: Market) => {
    setAnalyzingId(market.id);

    // Fetch order books for all tokens in parallel
    const books: Record<string, OrderBook> = {};
    if (market.clobTokenIds?.length) {
      await Promise.all([
        ...market.clobTokenIds.map(async (tokenId) => {
          try {
            const res = await fetch(`/api/polymarket/orderbook/${tokenId}`);
            books[tokenId] = await res.json();
          } catch (e) {
            console.error(`Order book error for ${tokenId}:`, e);
          }
        }),
        (async () => {
          try {
            // Fetch price history for both outcome tokens (Yes=idx0, No=idx1)
            const [yesId, noId] = market.clobTokenIds ?? [];
            if (!yesId) return;

            const [yesRes, noRes] = await Promise.all([
              fetch(`/api/polymarket/history/${yesId}`),
              noId ? fetch(`/api/polymarket/history/${noId}`) : Promise.resolve(null),
            ]);

            const yesData: { t: number; p: number }[] = yesRes.ok ? await yesRes.json() : [];
            const noData: { t: number; p: number }[] = (noRes && noRes.ok) ? await noRes.json() : [];

            // Merge by timestamp into { t, yes, no }
            const noMap = new Map(noData.map((d) => [d.t, d.p]));
            const merged = (Array.isArray(yesData) ? yesData : []).map((d) => ({
              t: d.t,
              yes: d.p,
              no: noMap.get(d.t) ?? 1 - d.p,
            }));

            setMarketHistories((prev) => ({ ...prev, [market.id]: merged }));
          } catch (e) {
            console.error(`History error for ${market.id}:`, e);
          }
        })(),
      ]);
      setOrderBooks((prev) => ({ ...prev, ...books }));
    }

    const rec = await analyzeMarket(
      market,
      btcPrice?.price ?? null,
      btcHistory,
      sentiment,
      indicators,
      { ...orderBooks, ...books },
      marketHistories[market.id] || [],
      300 - countdown
    );
    setRecommendations((prev) => ({ ...prev, [market.id]: rec }));
    setAnalyzingId(null);
  };

  const handleTrade = (market: Market, outcomeIndex: number) => {
    setConfirmTradeAmount(kellyAmount(market, outcomeIndex));
    setExecutionMode("AGGRESSIVE");
    setAutoRepriceEnabled(false);
    setConfirmTradeData({ market, outcomeIndex });
  };

  const executeTrade = async () => {
    if (!confirmTradeData) return;
    const { market, outcomeIndex } = confirmTradeData;
    const tokenId = market.clobTokenIds?.[outcomeIndex];
    if (!tokenId) return;

    const book = orderBooks[tokenId];
    const bestBid = Number(book?.bids?.[0]?.price || "0");
    const bestAsk = Number(book?.asks?.[0]?.price || "0");
    const price =
      executionMode === "AGGRESSIVE"
        ? String(bestAsk || market.outcomePrices[outcomeIndex])
        : String(bestBid || market.outcomePrices[outcomeIndex]);
    const amountToTrade = confirmTradeAmount || kellyAmount(market, outcomeIndex);
    const numericPrice = Number(price);
    const numericAmount = Number(amountToTrade);
    const minimumUsdc = Number.isFinite(numericPrice) && numericPrice > 0 ? 5 * numericPrice : 0;
    if (Number.isFinite(numericAmount) && minimumUsdc > 0 && numericAmount < minimumUsdc) {
      alert(`Trade terlalu kecil. Minimum sekitar ${minimumUsdc.toFixed(2)} USDC untuk limit price ini.`);
      return;
    }
    setConfirmTradeData(null);
    setConfirmTradeAmount("");
    setTradingId(`${market.id}-${outcomeIndex}`);
    try {
      const response = await fetch("/api/polymarket/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenID: tokenId,
          amount: amountToTrade,
          side: "BUY",
          executionMode,
        }),
      });
      const result = await response.json();
      if (response.ok) {
        if (result.orderID) {
          setOrderLookupId(result.orderID);
          lookupOrder(result.orderID);
          if (autoRepriceEnabled) {
            setTimeout(async () => {
              try {
                const orderRes = await fetch(`/api/polymarket/order/${result.orderID}`);
                const orderData = await orderRes.json();
                if (orderRes.ok && orderData.positionState === "OPEN" && Number(orderData.fillPercent) === 0) {
                  const repriceRes = await fetch("/api/polymarket/order/reprice", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ orderID: result.orderID, executionMode: "AGGRESSIVE" }),
                  });
                  const repriceData = await repriceRes.json();
                  if (repriceRes.ok && repriceData.replacement?.orderID) {
                    setOrderLookupId(repriceData.replacement.orderID);
                    lookupOrder(repriceData.replacement.orderID);
                  }
                }
              } catch (error) {
                console.error("Auto reprice error:", error);
              }
            }, 12000);
          }
        }
        alert(
          `Trade submitted. Order ID: ${result.orderID || "Pending"}${result.status ? ` (${result.status})` : ""}` +
          `${result.marketSnapshot?.bestAsk ? ` | Best ask ${(Number(result.marketSnapshot.bestAsk) * 100).toFixed(1)}c` : ""}`
        );
      } else {
        alert(`Trade failed: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("Trade Error:", error);
      alert("Error executing trade.");
    } finally {
      setTradingId(null);
      fetchData();
    }
  };

  // Kelly bet for a given market outcome
  const kellyAmount = (market: Market, outcomeIndex: number): string => {
    const rec = recommendations[market.id];
    if (!rec || rec.decision === "NO_TRADE") return tradeAmount;
    const bankroll = parseFloat(balance?.balance || "100");
    const impliedPrice = parseFloat(market.outcomePrices[outcomeIndex] || "0.5");
    const bet = kellyBet(bankroll, rec.confidence, impliedPrice);
    return bet > 0 ? bet.toString() : tradeAmount;
  };

  // Edge filter: only show trade button as active when there is real edge
  const hasEdge = (market: Market): boolean => {
    const rec = recommendations[market.id];
    if (!rec || rec.decision === "NO_TRADE") return false;
    return rec.estimatedEdge >= 8 && rec.riskLevel === "LOW"; // at least 8¢ edge, LOW risk only
  };

  const getTradePreview = (market: Market, outcomeIndex: number, amount: string) => {
    const tokenId = market.clobTokenIds?.[outcomeIndex];
    const book = tokenId ? orderBooks[tokenId] : null;
    const bestBid = Number(book?.bids?.[0]?.price || "0");
    const bestAsk = Number(book?.asks?.[0]?.price || "0");
    const price =
      executionMode === "AGGRESSIVE"
        ? bestAsk || Number(market.outcomePrices[outcomeIndex])
        : bestBid || Number(market.outcomePrices[outcomeIndex]);
    const spend = Number(amount);
    const minimumUsdc = Number.isFinite(price) && price > 0 ? 5 * price : 0;
    const estimatedShares = Number.isFinite(price) && price > 0 && Number.isFinite(spend) ? spend / price : 0;
    const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;
    const distanceToFill = bestAsk > 0 ? bestAsk - price : 0;
    return { price, spend, minimumUsdc, estimatedShares, bestBid, bestAsk, spread, distanceToFill };
  };

  const lookupOrder = useCallback(async (orderID?: string) => {
    const target = (orderID ?? orderLookupId).trim();
    if (!target) return;

    setOrderLookupLoading(true);
    try {
      const response = await fetch(`/api/polymarket/order/${target}`);
      const result = await response.json();
      if (!response.ok) {
        alert(`Order lookup failed: ${result.error || "Unknown error"}`);
        return;
      }
      setTrackedOrder(result);
      setOrderLookupId(target);
    } catch (error) {
      console.error("Order Lookup Error:", error);
      alert("Error looking up order.");
    } finally {
      setOrderLookupLoading(false);
    }
  }, [orderLookupId]);

  const updateAutomation = (assetId: string, patch: Partial<PositionAutomation>) => {
    setPositionAutomation((prev) => ({
      ...prev,
      [assetId]: {
        takeProfit: prev[assetId]?.takeProfit || "",
        stopLoss: prev[assetId]?.stopLoss || "",
        trailingStop: prev[assetId]?.trailingStop || "",
        armed: prev[assetId]?.armed || false,
        status: prev[assetId]?.status,
        lastPrice: prev[assetId]?.lastPrice,
        highestPrice: prev[assetId]?.highestPrice,
        trailingStopPrice: prev[assetId]?.trailingStopPrice,
        lastExitOrderId: prev[assetId]?.lastExitOrderId,
        ...patch,
      },
    }));
  };

  const saveAutomation = useCallback(async (
    position: PerformanceState["openPositions"][number],
    patch?: Partial<PositionAutomation>
  ) => {
    setAutomationBusy((prev) => ({ ...prev, [position.assetId]: true }));
    try {
      const current = positionAutomation[position.assetId] || {
        takeProfit: "",
        stopLoss: "",
        trailingStop: "",
        armed: false,
      };
      const next = { ...current, ...patch };
      const response = await fetch("/api/polymarket/automation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: position.assetId,
          market: position.market,
          outcome: position.outcome,
          averagePrice: position.averagePrice,
          size: position.size,
          takeProfit: next.takeProfit,
          stopLoss: next.stopLoss,
          trailingStop: next.trailingStop,
          armed: next.armed,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        updateAutomation(position.assetId, { status: result.error || "Failed to save automation" });
        return;
      }
      updateAutomation(position.assetId, {
        takeProfit: result.automation.takeProfit || "",
        stopLoss: result.automation.stopLoss || "",
        trailingStop: result.automation.trailingStop || "",
        armed: Boolean(result.automation.armed),
        status: result.automation.status,
        lastPrice: result.automation.lastPrice,
        highestPrice: result.automation.highestPrice,
        trailingStopPrice: result.automation.trailingStopPrice,
        lastExitOrderId: result.automation.lastExitOrderId || null,
      });
    } catch (error) {
      console.error("Automation save error:", error);
      updateAutomation(position.assetId, { status: "Failed to save automation" });
    } finally {
      setAutomationBusy((prev) => ({ ...prev, [position.assetId]: false }));
    }
  }, [positionAutomation]);

  const recommendAutomation = useCallback(async (
    position: PerformanceState["openPositions"][number]
  ) => {
    setAutomationBusy((prev) => ({ ...prev, [position.assetId]: true }));
    try {
      const response = await fetch("/api/polymarket/automation/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ averagePrice: position.averagePrice }),
      });
      const result = await response.json();
      if (!response.ok) {
        updateAutomation(position.assetId, { status: result.error || "Failed to recommend TP/SL" });
        return;
      }
      updateAutomation(position.assetId, {
        takeProfit: result.takeProfit,
        stopLoss: result.stopLoss,
        trailingStop: result.trailingStop,
        status: "Recommended levels applied",
      });
    } catch (error) {
      console.error("Automation recommend error:", error);
      updateAutomation(position.assetId, { status: "Failed to recommend TP/SL" });
    } finally {
      setAutomationBusy((prev) => ({ ...prev, [position.assetId]: false }));
    }
  }, []);

  const refreshPositionPrice = useCallback(async (
    position: PerformanceState["openPositions"][number]
  ) => {
    try {
      const res = await fetch(`/api/polymarket/orderbook/${position.assetId}`);
      const book = await res.json();
      const bestBid = Number(book?.bids?.[0]?.price || "0");
      if (bestBid > 0) {
        updateAutomation(position.assetId, {
          lastPrice: bestBid.toFixed(4),
          status: "Live ROI updated",
        });
      } else {
        updateAutomation(position.assetId, {
          status: "No live bid available",
        });
      }
    } catch (error) {
      console.error("Open position refresh error:", error);
      updateAutomation(position.assetId, { status: "Refresh failed" });
    }
  }, []);

  const refreshOpenPositionRoi = useCallback(async () => {
    const assetIds = new Set(markets.flatMap((market) => market.clobTokenIds || []));
    const positions = (performance?.openPositions || [])
      .sort((a, b) => Number(b.costBasis) - Number(a.costBasis))
      .filter((position) =>
        openPositionFilter === "all" ? true : assetIds.has(position.assetId)
      );

    if (!positions.length) return;

    setOpenPositionsRefreshing(true);
    try {
      await Promise.all(positions.map((position) => refreshPositionPrice(position)));
    } finally {
      setOpenPositionsRefreshing(false);
    }
  }, [performance, openPositionFilter, markets, refreshPositionPrice]);

  const exitPosition = useCallback(async (
    position: PerformanceState["openPositions"][number],
    trigger?: string,
    exitPrice?: string
  ) => {
    setAutomationBusy((prev) => ({ ...prev, [position.assetId]: true }));
    try {
      const response = await fetch("/api/polymarket/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenID: position.assetId,
          amount: position.size,
          side: "SELL",
          price: exitPrice || position.averagePrice,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        updateAutomation(position.assetId, { status: `Exit failed: ${result.error || "Unknown error"}` });
        return;
      }
      updateAutomation(position.assetId, {
        armed: false,
        status: trigger ? `Exit submitted by ${trigger}` : "Manual exit submitted",
      });
      fetchData();
    } catch (error) {
      console.error("Exit Position Error:", error);
      updateAutomation(position.assetId, { status: "Exit request failed" });
    } finally {
      setAutomationBusy((prev) => ({ ...prev, [position.assetId]: false }));
    }
  }, [fetchData]);

  const countdownColor = countdown <= 30 ? "text-red-400" : countdown <= 60 ? "text-yellow-400" : "text-green-400";

  const sortedOpenPositions = performance
    ? [...performance.openPositions].sort((a, b) => Number(b.costBasis) - Number(a.costBasis))
    : [];
  const activeAssetIds = new Set(markets.flatMap((market) => market.clobTokenIds || []));
  const filteredOpenPositions = sortedOpenPositions.filter((position) =>
    openPositionFilter === "all" ? true : activeAssetIds.has(position.assetId)
  );

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      {/* ── Header ── */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center gap-3">
            <Activity className="text-blue-500 w-10 h-10" />
            PolyBTC AI Trader
          </h1>
          <p className="text-zinc-400 max-w-md italic">
            AI-powered BTC 5-minute market scanner with edge detection.
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

          {/* Auto-analyze toggle */}
          <button
            onClick={() => setAutoAnalyze((v) => !v)}
            className={cn(
              "glass-card p-4 flex items-center gap-2 text-sm font-bold transition-colors",
              autoAnalyze ? "text-blue-400 border-blue-500/30" : "text-zinc-500"
            )}
          >
            <Zap className="w-4 h-4" />
            Auto-Analyze {autoAnalyze ? "ON" : "OFF"}
          </button>

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
            <button onClick={fetchData} disabled={loading} className="btn-secondary p-2 rounded-full">
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </header>

      {/* ── Page tabs ── */}
      <div className="flex gap-1 mb-8 bg-zinc-900 rounded-xl p-1 w-fit">
        <button
          type="button"
          onClick={() => setPage("markets")}
          className={cn(
            "flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold transition-all",
            page === "markets" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"
          )}
        >
          <Activity className="w-4 h-4" />
          Markets
        </button>
        <button
          type="button"
          onClick={() => setPage("bot")}
          className={cn(
            "flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold transition-all",
            page === "bot" ? "bg-blue-600 text-white" : "text-zinc-500 hover:text-zinc-300"
          )}
        >
          <Zap className="w-4 h-4" />
          Bot
        </button>
      </div>

      {page === "bot" && <BotDashboard />}

      <main className={cn("grid grid-cols-1 gap-8", page !== "markets" && "hidden")}>
        {/* ── Indicators bar ── */}
        {indicators && (
          <section className="glass-card p-4 flex flex-wrap gap-6 items-center">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              <span className="text-xs text-zinc-500 uppercase tracking-wider font-bold">Indicators (1m)</span>
            </div>
            <Pill label="RSI(14)" value={indicators.rsi.toFixed(1)}
              color={indicators.rsi > 70 ? "red" : indicators.rsi < 30 ? "green" : "zinc"} />
            <Pill label="EMA Cross" value={indicators.emaCross}
              color={indicators.emaCross === "BULLISH" ? "green" : "red"} />
            <Pill label="Trend" value={indicators.trend}
              color={indicators.trend === "STRONG_UP" ? "green" : indicators.trend === "STRONG_DOWN" ? "red" : "zinc"} />
            <Pill label="Vol Spike" value={`${indicators.volumeSpike}x`}
              color={indicators.volumeSpike > 2 ? "yellow" : "zinc"} />
            <div className="flex gap-1 items-center ml-auto">
              {indicators.last3Candles.map((c, i) => (
                <span key={i} className={cn("text-lg", c.direction === "UP" ? "text-green-400" : "text-red-400")}>
                  {c.direction === "UP" ? "▲" : "▼"}
                </span>
              ))}
              <span className="text-xs text-zinc-500 ml-1">last 3 candles</span>
            </div>
          </section>
        )}

        {/* ── BTC Candlestick Chart (1m) ── */}
        {btcHistory.length > 0 && (
          <section className="glass-card p-6">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-5 h-5 text-blue-500" />
              <h2 className="text-lg font-semibold">BTC/USDT — Last 60 Minutes (1m candles)</h2>
            </div>
            <CandlestickChart data={btcHistory} height={220} />
          </section>
        )}

        {/* ── Markets ── */}
        <section>
          {performance && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
              <div className="glass-card p-4">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Realized PnL</div>
                <div className={cn("text-lg font-bold font-mono", Number(performance.summary.realizedPnl) >= 0 ? "text-green-400" : "text-red-400")}>
                  ${Number(performance.summary.realizedPnl).toFixed(2)}
                </div>
              </div>
              <div className="glass-card p-4">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Win Rate</div>
                <div className="text-lg font-bold font-mono">{performance.summary.winRate}%</div>
              </div>
              <div className="glass-card p-4">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Wins / Losses</div>
                <div className="text-lg font-bold font-mono">{performance.summary.winCount} / {performance.summary.lossCount}</div>
              </div>
              <div className="glass-card p-4">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Matched Trades</div>
                <div className="text-lg font-bold font-mono">{performance.summary.totalMatchedTrades}</div>
              </div>
              <div className="glass-card p-4">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Open Exposure</div>
                <div className="text-lg font-bold font-mono">${Number(performance.summary.openExposure).toFixed(2)}</div>
              </div>
            </div>
          )}

          <div className="glass-card p-4 mb-6">
            <div className="flex flex-col md:flex-row md:items-center gap-4">
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Order Tracker</div>
                <input
                  type="text"
                  value={orderLookupId}
                  onChange={(e) => setOrderLookupId(e.target.value)}
                  placeholder="Paste trade/order id"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none"
                />
              </div>
              <button
                onClick={() => lookupOrder()}
                disabled={orderLookupLoading || !orderLookupId.trim()}
                className="btn-primary px-5 py-3 rounded-xl disabled:opacity-50"
              >
                {orderLookupLoading ? "Checking..." : "Track Order"}
              </button>
            </div>

            {trackedOrder && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Status</div>
                  <div className={cn(
                    "text-sm font-bold",
                    trackedOrder.positionState === "FILLED" ? "text-green-400" :
                    trackedOrder.positionState === "PARTIALLY_FILLED" ? "text-yellow-400" :
                    trackedOrder.positionState === "OPEN" ? "text-blue-400" : "text-zinc-300"
                  )}>
                    {trackedOrder.positionState}
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-1">Exchange: {trackedOrder.status}</div>
                </div>
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Fill</div>
                  <div className="text-sm font-bold font-mono">{trackedOrder.fillPercent}%</div>
                  <div className="text-[10px] text-zinc-500 mt-1">{trackedOrder.matchedSize} / {trackedOrder.originalSize} shares</div>
                </div>
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Side</div>
                  <div className="text-sm font-bold">{trackedOrder.side} {trackedOrder.outcome}</div>
                  <div className="text-[10px] text-zinc-500 mt-1">@ {(Number(trackedOrder.price) * 100).toFixed(1)}¢</div>
                </div>
                <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Remaining</div>
                  <div className="text-sm font-bold font-mono">{trackedOrder.remainingSize}</div>
                  <div className="text-[10px] text-zinc-500 mt-1 truncate">{trackedOrder.orderID}</div>
                  {trackedOrder.positionState === "OPEN" && (
                    <button
                      onClick={async () => {
                        try {
                          setOrderLookupLoading(true);
                          const response = await fetch("/api/polymarket/order/reprice", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ orderID: trackedOrder.orderID, executionMode: "AGGRESSIVE" }),
                          });
                          const result = await response.json();
                          if (!response.ok) {
                            alert(`Reprice failed: ${result.error || "Unknown error"}`);
                            return;
                          }
                          if (result.replacement?.orderID) {
                            setOrderLookupId(result.replacement.orderID);
                            await lookupOrder(result.replacement.orderID);
                          }
                        } catch (error) {
                          console.error("Reprice order error:", error);
                          alert("Failed to reprice order.");
                        } finally {
                          setOrderLookupLoading(false);
                        }
                      }}
                      className="mt-3 text-[10px] uppercase font-bold rounded px-2 py-1 border text-amber-300 border-amber-500/30"
                    >
                      Reprice To Market
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {performance && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
              <div className="glass-card p-4 max-h-[32rem] overflow-auto">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-bold">Trade History</div>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500">Past and active fills</div>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="text-left pb-2">Side</th>
                      <th className="text-left pb-2">Outcome</th>
                      <th className="text-left pb-2">Price</th>
                      <th className="text-left pb-2">Size</th>
                      <th className="text-left pb-2">PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performance.history.slice(0, 12).map((trade) => {
                      const isOpenTrade = performance.openPositions.some((position) => position.assetId === trade.assetId);
                      return (
                      <tr
                        key={trade.id}
                        className={cn(
                          "border-t border-zinc-900",
                          isOpenTrade ? "bg-blue-500/5" : "opacity-75"
                        )}
                      >
                        <td className="py-2">{trade.side}</td>
                        <td className="py-2">
                          <div className="flex items-center gap-2">
                            <span>{trade.outcome}</span>
                            {isOpenTrade && (
                              <span className="text-[10px] uppercase font-bold text-blue-300 bg-blue-500/15 border border-blue-500/20 rounded px-1.5 py-0.5">
                                Open
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 font-mono">{(Number(trade.price) * 100).toFixed(1)}c</td>
                        <td className="py-2 font-mono">{trade.size}</td>
                        <td className={cn("py-2 font-mono", Number(trade.pnl) > 0 ? "text-green-400" : Number(trade.pnl) < 0 ? "text-red-400" : "text-zinc-400")}>
                          ${Number(trade.pnl).toFixed(2)}
                        </td>
                      </tr>
                    )})}
                  </tbody>
                </table>
              </div>

              <div className="glass-card p-4 max-h-[32rem] overflow-auto">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-bold">Open Positions</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={refreshOpenPositionRoi}
                      disabled={openPositionsRefreshing || filteredOpenPositions.length === 0}
                      className="text-[10px] uppercase font-bold rounded px-2 py-1 border text-amber-300 border-amber-500/30 disabled:opacity-50 flex items-center gap-1"
                    >
                      <RefreshCw className={cn("w-3 h-3", openPositionsRefreshing && "animate-spin")} />
                      Refresh ROI
                    </button>
                    <button
                      onClick={() => setOpenPositionFilter("active")}
                      className={cn(
                        "text-[10px] uppercase font-bold rounded px-2 py-1 border",
                        openPositionFilter === "active"
                          ? "text-emerald-300 bg-emerald-500/15 border-emerald-500/20"
                          : "text-zinc-500 border-zinc-800"
                      )}
                    >
                      Current Active
                    </button>
                    <button
                      onClick={() => setOpenPositionFilter("all")}
                      className={cn(
                        "text-[10px] uppercase font-bold rounded px-2 py-1 border",
                        openPositionFilter === "all"
                          ? "text-blue-300 bg-blue-500/15 border-blue-500/20"
                          : "text-zinc-500 border-zinc-800"
                      )}
                    >
                      All
                    </button>
                  </div>
                </div>
                <div className="sticky top-0 z-10 -mx-4 px-4 py-2 mb-2 bg-zinc-950/95 border-b border-zinc-900">
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-400">
                    {openPositionFilter === "active" ? "Current Active Market Positions" : "All Live Positions"}
                  </div>
                </div>
                {filteredOpenPositions.length === 0 ? (
                  <div className="text-sm text-zinc-500">No open positions.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-zinc-500">
                      <tr>
                        <th className="text-left pb-2">Outcome</th>
                        <th className="text-left pb-2">Size</th>
                        <th className="text-left pb-2">Avg Price</th>
                        <th className="text-left pb-2">Cost Basis</th>
                        <th className="text-left pb-2">ROI</th>
                        <th className="text-left pb-2">TP / SL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOpenPositions.map((position) => (
                        <tr
                          key={position.assetId}
                          className={cn(
                            "border-t border-zinc-900",
                            position.outcome === "Up" ? "bg-emerald-500/8" : "bg-red-500/8"
                          )}
                        >
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <span>{position.outcome}</span>
                              <span
                                className={cn(
                                  "text-[10px] uppercase font-bold rounded px-1.5 py-0.5 border",
                                  position.outcome === "Up"
                                    ? "text-emerald-300 bg-emerald-500/15 border-emerald-500/20"
                                    : "text-red-300 bg-red-500/15 border-red-500/20"
                                )}
                              >
                                {position.outcome === "Up" ? "Bullish" : "Bearish"}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 font-mono">{position.size}</td>
                          <td className="py-2 font-mono">{(Number(position.averagePrice) * 100).toFixed(1)}c</td>
                          <td className="py-2 font-mono">
                            <div className="flex items-center gap-2">
                              <span>${Number(position.costBasis).toFixed(2)}</span>
                              <span className="text-[10px] uppercase font-bold text-emerald-300 bg-emerald-500/15 border border-emerald-500/20 rounded px-1.5 py-0.5">
                                Live
                              </span>
                            </div>
                          </td>
                          <td className="py-2 font-mono">
                            {(() => {
                              const lastPrice = Number(positionAutomation[position.assetId]?.lastPrice || 0);
                              const avgPrice = Number(position.averagePrice || 0);
                              if (!(lastPrice > 0 && avgPrice > 0)) return <span className="text-zinc-500">--</span>;
                              const roi = ((lastPrice - avgPrice) / avgPrice) * 100;
                              return (
                                <span className={cn(
                                  roi > 0 ? "text-green-400" : roi < 0 ? "text-red-400" : "text-zinc-400"
                                )}>
                                  {roi >= 0 ? "+" : ""}{roi.toFixed(2)}%
                                </span>
                              );
                            })()}
                          </td>
                          <td className="py-2">
                            <div className="flex flex-col gap-2 min-w-[220px]">
                              <div className="flex gap-2">
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0.01"
                                  max="0.99"
                                  placeholder="TP"
                                  value={positionAutomation[position.assetId]?.takeProfit || ""}
                                  onChange={(e) => updateAutomation(position.assetId, { takeProfit: e.target.value })}
                                  className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs font-mono"
                                />
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0.01"
                                  max="0.99"
                                  placeholder="SL"
                                  value={positionAutomation[position.assetId]?.stopLoss || ""}
                                  onChange={(e) => updateAutomation(position.assetId, { stopLoss: e.target.value })}
                                  className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs font-mono"
                                />
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0.00"
                                  max="0.25"
                                  placeholder="Trail"
                                  value={positionAutomation[position.assetId]?.trailingStop || ""}
                                  onChange={(e) => updateAutomation(position.assetId, { trailingStop: e.target.value })}
                                  className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs font-mono"
                                />
                                <button
                                  onClick={() => recommendAutomation(position)}
                                  disabled={automationBusy[position.assetId]}
                                  className="text-[10px] uppercase font-bold rounded px-2 py-1 border text-emerald-300 border-emerald-500/30 disabled:opacity-50"
                                >
                                  Auto
                                </button>
                                <button
                                  onClick={() => saveAutomation(position, {
                                    armed: !positionAutomation[position.assetId]?.armed,
                                  })}
                                  disabled={automationBusy[position.assetId]}
                                  className={cn(
                                    "text-[10px] uppercase font-bold rounded px-2 py-1 border",
                                    positionAutomation[position.assetId]?.armed
                                      ? "text-yellow-300 border-yellow-500/30"
                                      : "text-blue-300 border-blue-500/30"
                                  )}
                                >
                                  {positionAutomation[position.assetId]?.armed ? "Disarm" : "Arm"}
                                </button>
                                <button
                                  onClick={() => refreshPositionPrice(position)}
                                  disabled={automationBusy[position.assetId]}
                                  className="text-[10px] uppercase font-bold rounded px-2 py-1 border text-amber-300 border-amber-500/30 disabled:opacity-50"
                                >
                                  Refresh
                                </button>
                                <button
                                  onClick={() => exitPosition(position, "manual", positionAutomation[position.assetId]?.lastPrice || position.averagePrice)}
                                  disabled={automationBusy[position.assetId]}
                                  className="text-[10px] uppercase font-bold rounded px-2 py-1 border text-red-300 border-red-500/30 disabled:opacity-50"
                                >
                                  Exit
                                </button>
                              </div>
                              <div className="text-[10px] text-zinc-500">
                                Last bid: {positionAutomation[position.assetId]?.lastPrice ? `${(Number(positionAutomation[position.assetId]?.lastPrice) * 100).toFixed(1)}c` : "--"}
                                {positionAutomation[position.assetId]?.highestPrice ? ` | High: ${(Number(positionAutomation[position.assetId]?.highestPrice) * 100).toFixed(1)}c` : ""}
                                {positionAutomation[position.assetId]?.trailingStopPrice ? ` | Trail stop: ${(Number(positionAutomation[position.assetId]?.trailingStopPrice) * 100).toFixed(1)}c` : ""}
                                {positionAutomation[position.assetId]?.status ? ` | ${positionAutomation[position.assetId]?.status}` : ""}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5 text-blue-500" />
              Active BTC 5-Min Markets
            </h2>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800">
                <span className="text-xs text-zinc-500 font-bold uppercase tracking-wider">Amount:</span>
                <input
                  type="number"
                  value={tradeAmount}
                  onChange={(e) => setTradeAmount(e.target.value)}
                  className="bg-transparent text-sm font-mono w-16 focus:outline-none"
                />
                <span className="text-xs text-zinc-500">USDC</span>
              </div>
              <span className="text-sm text-zinc-500 font-mono">{markets.length} markets</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {initialLoad ? (
              <div className="col-span-full flex flex-col items-center justify-center p-20 glass-card">
                <RefreshCw className="w-12 h-12 text-blue-500 animate-spin mb-4" />
                <p className="text-zinc-400 font-medium">Scanning markets...</p>
              </div>
            ) : (
              <AnimatePresence mode="popLayout">
                {markets.map((market) => {
                  const rec = recommendations[market.id];
                  const edge = hasEdge(market);

                  return (
                    <motion.div
                      key={market.id}
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className={cn("glass-card flex flex-col", edge && "ring-1 ring-blue-500/40")}
                    >
                      <div className="p-6 flex-1">
                        <div className="flex justify-between items-start mb-4">
                          <span className="px-2 py-1 bg-zinc-800 text-zinc-400 text-[10px] font-bold uppercase tracking-wider rounded">
                            {market.eventSlug || "BTC 5m"}
                          </span>
                          <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono">
                            <span>Vol: ${parseFloat(market.volume || "0").toLocaleString()}</span>
                          </div>
                        </div>

                        <h3 className="text-lg font-bold mb-4 leading-tight">{market.question}</h3>

                        {marketHistories[market.id]?.length > 0 && (
                          <div className="h-32 mb-6 bg-zinc-950/50 rounded-xl border border-zinc-800/50 p-2">
                            <div className="flex gap-3 mb-1 px-1">
                              <span className="text-[10px] text-green-400 font-bold flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Yes
                              </span>
                              <span className="text-[10px] text-red-400 font-bold flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> No
                              </span>
                            </div>
                            <ResponsiveContainer width="100%" height="85%">
                              <AreaChart data={marketHistories[market.id]}>
                                <defs>
                                  <linearGradient id={`gy-${market.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.25} />
                                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                                  </linearGradient>
                                  <linearGradient id={`gn-${market.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2} />
                                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                                <XAxis dataKey="t" hide />
                                <YAxis domain={[0, 1]} hide />
                                <Tooltip
                                  contentStyle={{ backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: "8px" }}
                                  labelStyle={{ display: "none" }}
                                  formatter={(v: any, name: string) => [
                                    `${(parseFloat(v) * 100).toFixed(1)}¢`,
                                    name === "yes" ? "Yes" : "No",
                                  ]}
                                />
                                <Area type="monotone" dataKey="yes" stroke="#22c55e" fill={`url(#gy-${market.id})`} strokeWidth={2} dot={false} />
                                <Area type="monotone" dataKey="no" stroke="#ef4444" fill={`url(#gn-${market.id})`} strokeWidth={2} dot={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        )}

                        {/* ── Outcome cards ── */}
                        <div className="grid grid-cols-2 gap-4 mb-6">
                          {market.outcomes.map((outcome, idx) => {
                            const tokenId = market.clobTokenIds?.[idx];
                            const book = tokenId ? orderBooks[tokenId] : null;
                            const implied = parseFloat(market.outcomePrices[idx] || "0.5");
                            const kelly = kellyAmount(market, idx);
                            const isRecommended =
                              rec?.decision === "TRADE" &&
                              ((rec.direction === "UP" && idx === 0) || (rec.direction === "DOWN" && idx === 1));

                            return (
                              <div
                                key={idx}
                                className={cn(
                                  "bg-zinc-950/50 p-4 rounded-xl border flex flex-col justify-between",
                                  isRecommended ? "border-blue-500/50 bg-blue-500/5" : "border-zinc-800/50"
                                )}
                              >
                                <div>
                                  <div className="text-xs text-zinc-500 mb-1 font-medium flex items-center justify-between">
                                    {outcome}
                                    {isRecommended && <span className="text-[10px] text-blue-400 font-bold">AI PICK</span>}
                                  </div>
                                  <div className="text-2xl font-bold font-mono mb-2">
                                    {(implied * 100).toFixed(1)}¢
                                  </div>

                                  {book && (
                                    <div className="mb-3">
                                      <div className={cn(
                                        "text-[10px] font-bold px-2 py-0.5 rounded inline-block mb-2",
                                        book.imbalanceSignal === "BUY_PRESSURE" ? "bg-green-500/20 text-green-400" :
                                        book.imbalanceSignal === "SELL_PRESSURE" ? "bg-red-500/20 text-red-400" :
                                        "bg-zinc-800 text-zinc-500"
                                      )}>
                                        {book.imbalanceSignal} ({((book.imbalance ?? 0.5) * 100).toFixed(0)}% bid)
                                      </div>
                                      <div className="text-[10px] font-mono space-y-1">
                                        <div className="flex justify-between text-green-500/70">
                                          <span>Best Bid:</span>
                                          <span>{(parseFloat(book.bids[0]?.price || "0") * 100).toFixed(1)}¢</span>
                                        </div>
                                        <div className="flex justify-between text-red-500/70">
                                          <span>Best Ask:</span>
                                          <span>{(parseFloat(book.asks[0]?.price || "0") * 100).toFixed(1)}¢</span>
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                  {/* Kelly + execution */}
                                  <div className="flex flex-col gap-1.5">
                                    {rec?.decision === "TRADE" && isRecommended && (
                                      <div className="flex items-center justify-between bg-blue-500/10 px-2 py-1 rounded border border-blue-500/20">
                                        <span className="text-[10px] text-blue-400 font-bold uppercase">Kelly Bet:</span>
                                        <span className="text-xs font-mono text-blue-400 font-bold">${kelly} USDC</span>
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between bg-zinc-900 px-2 py-1.5 rounded border border-zinc-800">
                                      <span className="text-[10px] text-zinc-500 font-bold uppercase">Market Price:</span>
                                      <span className="text-xs font-mono text-zinc-300">
                                        {book?.asks?.[0]?.price
                                          ? `${(parseFloat(book.asks[0].price) * 100).toFixed(1)}¢ ask`
                                          : `${(implied * 100).toFixed(1)}¢`}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <button
                                  onClick={() => handleTrade(market, idx)}
                                  disabled={tradingId === `${market.id}-${idx}`}
                                  className={cn(
                                    "w-full py-2 mt-3 rounded-lg text-xs font-bold uppercase tracking-wider transition-all",
                                    isRecommended && edge
                                      ? idx === 0 ? "bg-green-500 text-white hover:bg-green-400" : "bg-red-500 text-white hover:bg-red-400"
                                      : idx === 0 ? "bg-green-500/10 text-green-500 hover:bg-green-500 hover:text-white" : "bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white"
                                  )}
                                >
                                  {tradingId === `${market.id}-${idx}` ? "Executing..." : `Buy ${outcome}`}
                                </button>
                              </div>
                            );
                          })}
                        </div>

                        {/* ── AI Recommendation ── */}
                        {rec && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            className={cn(
                              "mb-4 p-4 rounded-xl border",
                              rec.decision === "TRADE" && edge
                                ? "bg-blue-500/10 border-blue-500/30"
                                : "bg-zinc-900/50 border-zinc-800"
                            )}
                          >
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2">
                                <Brain className="w-4 h-4 text-blue-400" />
                                <span className="text-sm font-bold text-blue-400 uppercase tracking-wide">AI Recommendation</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {rec.dataMode === "POLYMARKET_ONLY" && (
                                  <div className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-orange-500/20 text-orange-300">
                                    Fallback Mode
                                  </div>
                                )}
                                <div className={cn(
                                  "px-2 py-0.5 rounded text-[10px] font-bold uppercase",
                                  rec.riskLevel === "LOW" ? "bg-green-500/20 text-green-400" :
                                  rec.riskLevel === "MEDIUM" ? "bg-yellow-500/20 text-yellow-400" :
                                  "bg-red-500/20 text-red-400"
                                )}>
                                  {rec.riskLevel} RISK
                                </div>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-3 mb-3">
                              <div className={cn(
                                "flex items-center gap-2 px-3 py-1 rounded-lg font-bold text-sm",
                                rec.decision === "TRADE" ? "bg-green-500 text-white" : "bg-zinc-700 text-zinc-300"
                              )}>
                                {rec.decision === "TRADE" ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                                {rec.decision}
                              </div>

                              {rec.direction !== "NONE" && (
                                <div className={cn(
                                  "flex items-center gap-1 font-bold text-sm",
                                  rec.direction === "UP" ? "text-green-400" : "text-red-400"
                                )}>
                                  {rec.direction === "UP" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                  {rec.direction}
                                </div>
                              )}

                              <span className="text-sm font-mono text-zinc-400">
                                Conf: <span className="text-white font-bold">{rec.confidence}%</span>
                              </span>

                              {rec.estimatedEdge > 0 && (
                                <span className={cn(
                                  "text-sm font-mono font-bold",
                                  rec.estimatedEdge >= 10 ? "text-green-400" :
                                  rec.estimatedEdge >= 5 ? "text-yellow-400" : "text-zinc-500"
                                )}>
                                  Edge: +{rec.estimatedEdge.toFixed(1)}¢
                                </span>
                              )}
                            </div>

                            <div className="mb-3 p-3 rounded-xl border border-yellow-500/20 bg-yellow-500/5">
                              <div className="flex items-center justify-between mb-2">
                                <div className="text-[10px] uppercase tracking-widest font-bold text-yellow-300">
                                  Reversal Risk
                                </div>
                                <div className="text-[10px] text-zinc-400 uppercase font-bold">
                                  {rec.direction === "DOWN"
                                    ? "Chance of sudden BUY squeeze"
                                    : rec.direction === "UP"
                                      ? "Chance of sudden SELL flush"
                                      : "Two-way reversal risk"}
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-3 mb-2">
                                <div className="bg-zinc-950/60 rounded-lg border border-zinc-800 px-3 py-2">
                                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Reversal</div>
                                  <div className="text-lg font-bold font-mono text-yellow-300">
                                    {rec.reversalProbability ?? 0}%
                                  </div>
                                </div>
                                <div className="bg-zinc-950/60 rounded-lg border border-zinc-800 px-3 py-2">
                                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">
                                    {rec.direction === "DOWN"
                                      ? "Opposite Buy Pressure"
                                      : rec.direction === "UP"
                                        ? "Opposite Sell Pressure"
                                        : "Opposite Pressure"}
                                  </div>
                                  <div className="text-lg font-bold font-mono text-orange-300">
                                    {rec.oppositePressureProbability ?? 0}%
                                  </div>
                                </div>
                              </div>
                              <div className="text-xs text-zinc-400 leading-relaxed">
                                {rec.reversalReasoning || "Reversal layer unavailable."}
                              </div>
                            </div>

                            {/* Detected candle patterns */}
                            {rec.candlePatterns?.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mb-3">
                                {rec.candlePatterns.map((pattern, i) => {
                                  const bull = /bull|hammer|soldier|white|inverted/i.test(pattern);
                                  const bear = /bear|shooting|crow|black|hanging/i.test(pattern);
                                  return (
                                    <span key={i} className={cn(
                                      "text-[10px] font-bold px-2 py-0.5 rounded-full border",
                                      bull ? "bg-green-500/10 text-green-400 border-green-500/20" :
                                      bear ? "bg-red-500/10 text-red-400 border-red-500/20" :
                                      "bg-zinc-800 text-zinc-400 border-zinc-700"
                                    )}>
                                      {pattern}
                                    </span>
                                  );
                                })}
                              </div>
                            )}

                            {rec.dataMode === "POLYMARKET_ONLY" && (
                              <div className="mb-3 text-xs text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
                                External BTC feed unavailable. Analysis uses Polymarket order book, probabilities, and market history only.
                              </div>
                            )}

                            <div className="text-sm text-zinc-300 leading-relaxed prose prose-invert max-w-none prose-sm">
                              <ReactMarkdown>{rec.reasoning}</ReactMarkdown>
                            </div>
                          </motion.div>
                        )}
                      </div>

                      <div className="p-4 bg-zinc-900/80 border-t border-zinc-800 flex gap-3">
                        <button
                          onClick={() => handleAnalyze(market)}
                          disabled={analyzingId === market.id}
                          className="btn-secondary flex-1 flex items-center justify-center gap-2"
                        >
                          {analyzingId === market.id ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Brain className="w-4 h-4" />
                          )}
                          {analyzingId === market.id ? "Analyzing..." : "Re-Analyze"}
                        </button>
                        <a
                          href={`https://polymarket.com/event/${market.eventSlug || `btc-updown-5m-${Math.floor(Math.floor(Date.now() / 1000) / 300) * 300}`}/${market.eventSlug || `btc-updown-5m-${Math.floor(Math.floor(Date.now() / 1000) / 300) * 300}`}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-primary flex items-center gap-2"
                        >
                          Trade <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>

          {markets.length === 0 && !initialLoad && (
            <div className="glass-card p-12 text-center">
              <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">No Active BTC Markets Found</h3>
              <p className="text-zinc-400 mb-6">The current 5-minute window may not have an active market yet.</p>
              <button onClick={fetchData} className="btn-primary px-6 py-2 rounded-lg flex items-center gap-2 mx-auto">
                <RefreshCw className="w-4 h-4" /> Retry
              </button>
            </div>
          )}
        </section>
      </main>

      <footer className="mt-20 pt-8 border-t border-zinc-900 text-center text-zinc-600 text-sm">
        <p>© 2026 PolyBTC AI Trader • Personal use only • Not financial advice</p>
      </footer>

      {/* ── Confirm Trade Modal ── */}
      <AnimatePresence>
        {confirmTradeData && (
          (() => {
            const preview = getTradePreview(
              confirmTradeData.market,
              confirmTradeData.outcomeIndex,
              confirmTradeAmount || kellyAmount(confirmTradeData.market, confirmTradeData.outcomeIndex)
            );
            return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="glass-card max-w-md w-full max-h-[90vh] overflow-hidden border-blue-500/30 flex flex-col"
            >
              <div className="flex items-center gap-3 p-6 pb-4 text-blue-400 shrink-0">
                <AlertTriangle className="w-8 h-8" />
                <h3 className="text-2xl font-bold">Confirm Trade</h3>
              </div>

              <div className="space-y-4 px-6 pb-6 overflow-y-auto flex-1 min-h-0">
                <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Market</div>
                  <div className="text-sm font-medium leading-tight">{confirmTradeData.market.question}</div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800 col-span-2">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-3">Execution Mode</div>
                    <div className="grid grid-cols-3 gap-2">
                      {(["PASSIVE", "AGGRESSIVE"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setExecutionMode(mode)}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors",
                            executionMode === mode
                              ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
                              : "border-zinc-800 text-zinc-400"
                          )}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 text-[10px] text-zinc-500">
                      {executionMode === "PASSIVE" && "Passive: place near current best bid, better price but slower fill."}
                      {executionMode === "AGGRESSIVE" && "Aggressive: cross to current best ask, faster fill but more expensive."}
                    </div>
                  </div>
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Outcome</div>
                    <div className={cn("text-lg font-bold", confirmTradeData.outcomeIndex === 0 ? "text-green-500" : "text-red-500")}>
                      {confirmTradeData.market.outcomes[confirmTradeData.outcomeIndex]}
                    </div>
                  </div>
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Amount</div>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={confirmTradeAmount}
                      onChange={(e) => setConfirmTradeAmount(e.target.value)}
                      className="bg-transparent text-lg font-bold font-mono w-full focus:outline-none"
                    />
                    <div className="text-[10px] text-zinc-500 mt-1">USDC to spend</div>
                    <button
                      type="button"
                      onClick={() => setConfirmTradeAmount(preview.minimumUsdc.toFixed(2))}
                      className="mt-3 text-[10px] uppercase tracking-widest text-blue-400 font-bold border border-blue-500/30 rounded-lg px-2 py-1 hover:bg-blue-500/10 transition-colors"
                    >
                      Use Minimum Buy
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmTradeAmount(kellyAmount(confirmTradeData.market, confirmTradeData.outcomeIndex))}
                      className="mt-2 text-[10px] uppercase tracking-widest text-emerald-400 font-bold border border-emerald-500/30 rounded-lg px-2 py-1 hover:bg-emerald-500/10 transition-colors"
                    >
                      Use Kelly
                    </button>
                    <label className="mt-3 flex items-center gap-2 text-[10px] text-zinc-400 font-bold uppercase tracking-widest">
                      <input
                        type="checkbox"
                        checked={autoRepriceEnabled}
                        onChange={(e) => setAutoRepriceEnabled(e.target.checked)}
                        className="rounded border-zinc-700 bg-zinc-900"
                      />
                      Auto Reprice Once
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Est. Shares</div>
                    <div className="text-lg font-bold font-mono">{preview.estimatedShares.toFixed(2)}</div>
                  </div>
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Minimum</div>
                    <div className={cn("text-lg font-bold font-mono", preview.spend >= preview.minimumUsdc ? "text-green-400" : "text-yellow-400")}>
                      ${preview.minimumUsdc.toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Best Bid / Ask</div>
                    <div className="text-sm font-bold font-mono">
                      {preview.bestBid > 0 ? `${(preview.bestBid * 100).toFixed(1)}c` : "--"} / {preview.bestAsk > 0 ? `${(preview.bestAsk * 100).toFixed(1)}c` : "--"}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-1">Spread: {(preview.spread * 100).toFixed(1)}c</div>
                  </div>
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Distance To Fill</div>
                    <div className={cn(
                      "text-lg font-bold font-mono",
                      preview.distanceToFill <= 0.0001 ? "text-green-400" : "text-yellow-400"
                    )}>
                      {preview.distanceToFill <= 0.0001 ? "At Market" : `${(preview.distanceToFill * 100).toFixed(1)}c`}
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-1">
                      {preview.distanceToFill <= 0.0001 ? "Should fill faster if liquidity stays." : "Your order is resting below ask."}
                    </div>
                  </div>
                </div>

                {(() => {
                  const rec = recommendations[confirmTradeData.market.id];
                  if (!rec || rec.estimatedEdge <= 0) return null;
                  return (
                    <div className={cn(
                      "p-4 rounded-xl border",
                      rec.estimatedEdge >= 5 ? "bg-green-500/10 border-green-500/20" : "bg-yellow-500/10 border-yellow-500/20"
                    )}>
                      <div className="text-[10px] uppercase tracking-widest font-bold mb-1 text-zinc-400">Estimated Edge</div>
                      <div className={cn("text-xl font-bold font-mono", rec.estimatedEdge >= 5 ? "text-green-400" : "text-yellow-400")}>
                        +{rec.estimatedEdge.toFixed(1)}¢
                      </div>
                      {rec.estimatedEdge < 5 && (
                        <p className="text-xs text-yellow-400 mt-1">⚠ Edge below 5¢ threshold — trade at your own risk</p>
                      )}
                    </div>
                  );
                })()}

                <div className="p-4 bg-blue-500/10 rounded-xl border border-blue-500/20">
                  <div className="text-[10px] uppercase tracking-widest text-blue-400 font-bold mb-1">Market Execution Price</div>
                  <div className="text-xl font-bold font-mono">
                    {(preview.price * 100).toFixed(1)}¢
                  </div>
                  <div className="text-[10px] text-blue-200/80 mt-1">Mode: {executionMode}</div>
                </div>
              </div>

              <div className="flex gap-4 p-6 pt-4 border-t border-zinc-800/80 shrink-0">
                <button onClick={() => { setConfirmTradeData(null); setConfirmTradeAmount(""); }} className="btn-secondary flex-1 py-3 rounded-xl font-bold uppercase tracking-wider">
                  Cancel
                </button>
                <button onClick={executeTrade} className="bg-blue-600 hover:bg-blue-500 text-white flex-1 py-3 rounded-xl font-bold uppercase tracking-wider transition-colors shadow-lg shadow-blue-500/20">
                  Confirm Buy
                </button>
              </div>
            </motion.div>
          </div>
            );
          })()
        )}
      </AnimatePresence>

      {/* ── Bot Log Sidebar ── */}
      <BotLogSidebar />
    </div>
  );
}

// ── Pill badge component ─────────────────────────────────────────────────────
function Pill({ label, value, color }: { label: string; value: string; color: "green" | "red" | "yellow" | "zinc" }) {
  const colors = {
    green:  "bg-green-500/20 text-green-400",
    red:    "bg-red-500/20 text-red-400",
    yellow: "bg-yellow-500/20 text-yellow-400",
    zinc:   "bg-zinc-800 text-zinc-400",
  };
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-zinc-600 uppercase tracking-wider">{label}</span>
      <span className={cn("text-xs font-bold px-2 py-0.5 rounded", colors[color])}>{value}</span>
    </div>
  );
}

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}
