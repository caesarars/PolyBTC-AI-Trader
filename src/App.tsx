import { useState, useEffect } from "react";
import { Market, BTCPrice, AIRecommendation, BTCHistory, SentimentData, OrderBook } from "./types";
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
  Smile
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from "recharts";
import ReactMarkdown from "react-markdown";

export default function App() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [btcPrice, setBtcPrice] = useState<BTCPrice | null>(null);
  const [btcHistory, setBtcHistory] = useState<BTCHistory[]>([]);
  const [sentiment, setSentiment] = useState<SentimentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<Record<string, AIRecommendation>>({});
  const [orderBooks, setOrderBooks] = useState<Record<string, OrderBook>>({});
  const [marketHistories, setMarketHistories] = useState<Record<string, any[]>>({});
  const [tradingId, setTradingId] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ address: string; balance: string } | null>(null);
  const [tradeAmount, setTradeAmount] = useState<string>("10");
  const [limitPrices, setLimitPrices] = useState<Record<string, string>>({});
  const [confirmTradeData, setConfirmTradeData] = useState<{ market: Market; outcomeIndex: number } | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [marketsRes, priceRes, historyRes, sentimentRes, balanceRes] = await Promise.all([
        fetch("/api/polymarket/markets"),
        fetch("/api/btc-price"),
        fetch("/api/btc-history"),
        fetch("/api/sentiment"),
        fetch("/api/polymarket/balance")
      ]);
      const marketsData = await marketsRes.json();
      console.log("Raw Markets Data:", marketsData);
      
      const priceData = await priceRes.json();
      const historyData = await historyRes.json();
      const sentimentData = await sentimentRes.json();
      const balanceData = await balanceRes.json();
      
      setMarkets(marketsData);
      setBtcPrice(priceData);
      setBtcHistory(historyData);
      setSentiment(sentimentData);
      setBalance(balanceData);
    } catch (error) {
      console.error("Fetch Error:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // Refresh every 1m
    return () => clearInterval(interval);
  }, []);

  const handleAnalyze = async (market: Market) => {
    if (!btcPrice) return;
    setAnalyzingId(market.id);
    
    // Fetch order books and history for all tokens in this market before analysis
    const books: Record<string, OrderBook> = {};
    if (market.clobTokenIds) {
      await Promise.all([
        ...market.clobTokenIds.map(async (tokenId) => {
          try {
            const res = await fetch(`/api/polymarket/orderbook/${tokenId}`);
            const data = await res.json();
            books[tokenId] = data;
          } catch (e) {
            console.error(`Error fetching book for ${tokenId}:`, e);
          }
        }),
        (async () => {
          try {
            const res = await fetch(`/api/polymarket/history/${market.id}`);
            const data = await res.json();
            setMarketHistories(prev => ({ ...prev, [market.id]: data }));
          } catch (e) {
            console.error(`Error fetching history for ${market.id}:`, e);
          }
        })()
      ]);
      setOrderBooks(prev => ({ ...prev, ...books }));
    }

    const rec = await analyzeMarket(market, btcPrice.price, btcHistory, sentiment);
    setRecommendations(prev => ({ ...prev, [market.id]: rec }));
    setAnalyzingId(null);
  };

  const handleTrade = (market: Market, outcomeIndex: number) => {
    setConfirmTradeData({ market, outcomeIndex });
  };

  const executeTrade = async () => {
    if (!confirmTradeData) return;
    const { market, outcomeIndex } = confirmTradeData;
    const tokenId = market.clobTokenIds?.[outcomeIndex];
    if (!tokenId) return;

    const price = limitPrices[`${market.id}-${outcomeIndex}`] || market.outcomePrices[outcomeIndex];

    setConfirmTradeData(null);
    setTradingId(`${market.id}-${outcomeIndex}`);
    try {
      const response = await fetch("/api/polymarket/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenID: tokenId,
          amount: tradeAmount,
          side: "BUY",
          price: price
        })
      });
      
      const result = await response.json();
      if (response.ok) {
        alert(`Trade executed successfully! Order ID: ${result.orderID || "Pending"}`);
      } else {
        alert(`Trade failed: ${result.error}`);
      }
    } catch (error) {
      console.error("Trade Error:", error);
      alert("An error occurred while executing the trade.");
    } finally {
      setTradingId(null);
      fetchData(); // Refresh balance
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
        <div>
          <h1 className="text-4xl font-bold tracking-tight mb-2 flex items-center gap-3">
            <Activity className="text-blue-500 w-10 h-10" />
            PolyBTC AI Trader
          </h1>
          <p className="text-zinc-400 max-w-md italic">
            Scanning Polymarket for BTC price action. Managed by Gemini AI with historical & sentiment context.
          </p>
        </div>
        
        <div className="flex flex-wrap gap-4">
          {balance && (
            <div className="glass-card p-4 flex flex-col justify-center">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-1">Wallet Address</span>
              <span className="text-xs font-mono text-zinc-300 truncate w-32">{balance.address}</span>
            </div>
          )}

          {sentiment && (
            <div className="glass-card p-4 flex items-center gap-4">
              <div className="bg-zinc-800 p-2 rounded-lg">
                <Smile className={cn(
                  "w-5 h-5",
                  sentiment.value > 60 ? "text-green-500" : sentiment.value < 40 ? "text-red-500" : "text-yellow-500"
                )} />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Sentiment</span>
                <span className="text-sm font-bold">{sentiment.value_classification} ({sentiment.value})</span>
              </div>
            </div>
          )}

          <div className="glass-card p-4 flex items-center gap-6">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mb-1">Live BTC Price</span>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-green-500" />
                <span className="text-xl font-mono font-bold">
                  {btcPrice ? parseFloat(btcPrice.price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : "---"}
                </span>
              </div>
            </div>
            <button 
              onClick={fetchData} 
              disabled={loading}
              className="btn-secondary p-2 rounded-full flex items-center justify-center"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </header>

      <main className="grid grid-cols-1 gap-8">
        {btcHistory.length > 0 && (
          <section className="glass-card p-6 mb-8">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-5 h-5 text-blue-500" />
              <h2 className="text-lg font-semibold">24h Price Trend</h2>
            </div>
            <div className="flex items-end gap-1 h-20">
              {btcHistory.map((h, i) => {
                const min = Math.min(...btcHistory.map(x => x.price));
                const max = Math.max(...btcHistory.map(x => x.price));
                const height = ((h.price - min) / (max - min)) * 100;
                return (
                  <div 
                    key={i} 
                    className="flex-1 bg-blue-500/20 hover:bg-blue-500/40 transition-colors rounded-t-sm relative group"
                    style={{ height: `${Math.max(height, 5)}%` }}
                  >
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-zinc-800 text-[10px] px-2 py-1 rounded whitespace-nowrap z-50">
                      ${h.price.toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        <section>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5 text-blue-500" />
              Active BTC Markets
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
              <span className="text-sm text-zinc-500 font-mono">{markets.length} Markets Found</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {loading ? (
              <div className="col-span-full flex flex-col items-center justify-center p-20 glass-card">
                <RefreshCw className="w-12 h-12 text-blue-500 animate-spin mb-4" />
                <p className="text-zinc-400 font-medium">Scanning Polymarket for Bitcoin opportunities...</p>
              </div>
            ) : (
              <AnimatePresence mode="popLayout">
                {markets.map((market) => (
                  <motion.div
                    key={market.id}
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="glass-card flex flex-col"
                  >
                    <div className="p-6 flex-1">
                      <div className="flex justify-between items-start mb-4">
                        <span className="px-2 py-1 bg-zinc-800 text-zinc-400 text-[10px] font-bold uppercase tracking-wider rounded">
                          {market.category || "Crypto"}
                        </span>
                        <div className="flex items-center gap-3 text-xs text-zinc-500 font-mono">
                          <span>Vol: ${parseFloat(market.volume || "0").toLocaleString()}</span>
                        </div>
                      </div>
                      
                      <h3 className="text-lg font-bold mb-4 leading-tight">
                        {market.question}
                      </h3>

                      {marketHistories[market.id] && (
                        <div className="h-40 mb-6 bg-zinc-950/50 rounded-xl border border-zinc-800/50 p-2">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={marketHistories[market.id]}>
                              <defs>
                                <linearGradient id={`gradient-${market.id}`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                              <XAxis 
                                dataKey="t" 
                                hide 
                              />
                              <YAxis 
                                domain={['auto', 'auto']} 
                                hide 
                              />
                              <Tooltip 
                                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                                labelStyle={{ display: 'none' }}
                                formatter={(value: any) => [`${(parseFloat(value) * 100).toFixed(1)}¢`, 'Price']}
                              />
                              <Area 
                                type="monotone" 
                                dataKey="p" 
                                stroke="#3b82f6" 
                                fillOpacity={1} 
                                fill={`url(#gradient-${market.id})`} 
                                strokeWidth={2}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-4 mb-6">
                        {market.outcomes.map((outcome, idx) => {
                          const tokenId = market.clobTokenIds?.[idx];
                          const book = tokenId ? orderBooks[tokenId] : null;
                          
                          return (
                            <div key={idx} className="bg-zinc-950/50 p-4 rounded-xl border border-zinc-800/50 flex flex-col justify-between">
                              <div>
                                <div className="text-xs text-zinc-500 mb-1 font-medium">{outcome}</div>
                                <div className="text-2xl font-bold font-mono mb-4">
                                  {(parseFloat(market.outcomePrices[idx]) * 100).toFixed(1)}¢
                                </div>
                                
                                <div className="flex flex-col gap-2 mb-4">
                                  <div className="flex items-center justify-between bg-zinc-900 px-2 py-1.5 rounded border border-zinc-800">
                                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Limit:</span>
                                    <input 
                                      type="number" 
                                      step="0.01"
                                      min="0.01"
                                      max="0.99"
                                      value={limitPrices[`${market.id}-${idx}`] || market.outcomePrices[idx]}
                                      onChange={(e) => setLimitPrices(prev => ({ ...prev, [`${market.id}-${idx}`]: e.target.value }))}
                                      className="bg-transparent text-xs font-mono w-12 text-right focus:outline-none text-zinc-300"
                                    />
                                    <span className="text-[10px] text-zinc-500 ml-1">USDC</span>
                                  </div>
                                </div>
                                
                                {book && (
                                  <div className="text-[10px] font-mono space-y-1 mb-4">
                                    <div className="flex justify-between text-green-500/70">
                                      <span>Best Bid:</span>
                                      <span>{(parseFloat(book.bids[0]?.price || "0") * 100).toFixed(1)}¢</span>
                                    </div>
                                    <div className="flex justify-between text-red-500/70">
                                      <span>Best Ask:</span>
                                      <span>{(parseFloat(book.asks[0]?.price || "0") * 100).toFixed(1)}¢</span>
                                    </div>
                                  </div>
                                )}
                              </div>

                              <button
                                onClick={() => handleTrade(market, idx)}
                                disabled={tradingId === `${market.id}-${idx}`}
                                className={cn(
                                  "w-full py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all",
                                  idx === 0 ? "bg-green-500/10 text-green-500 hover:bg-green-500 hover:text-white" : "bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white"
                                )}
                              >
                                {tradingId === `${market.id}-${idx}` ? "Executing..." : `Buy ${outcome}`}
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      {recommendations[market.id] && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          className="mb-6 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20"
                        >
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Brain className="w-4 h-4 text-blue-400" />
                              <span className="text-sm font-bold text-blue-400 uppercase tracking-wide">AI Recommendation</span>
                            </div>
                            <div className={cn(
                              "px-2 py-0.5 rounded text-[10px] font-bold uppercase",
                              recommendations[market.id].riskLevel === "LOW" ? "bg-green-500/20 text-green-400" :
                              recommendations[market.id].riskLevel === "MEDIUM" ? "bg-yellow-500/20 text-yellow-400" :
                              "bg-red-500/20 text-red-400"
                            )}>
                              {recommendations[market.id].riskLevel} RISK
                            </div>
                          </div>

                          <div className="flex items-center gap-4 mb-4">
                            <div className={cn(
                              "flex items-center gap-2 px-3 py-1 rounded-lg font-bold",
                              recommendations[market.id].decision === "TRADE" ? "bg-green-500 text-white" : "bg-zinc-700 text-zinc-300"
                            )}>
                              {recommendations[market.id].decision === "TRADE" ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                              {recommendations[market.id].decision}
                            </div>
                            
                            {recommendations[market.id].direction !== "NONE" && (
                              <div className={cn(
                                "flex items-center gap-2 font-bold",
                                recommendations[market.id].direction === "UP" ? "text-green-400" : "text-red-400"
                              )}>
                                {recommendations[market.id].direction === "UP" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                {recommendations[market.id].direction}
                              </div>
                            )}
                            
                            <div className="text-sm font-mono text-zinc-400">
                              Conf: {recommendations[market.id].confidence}%
                            </div>
                          </div>

                          <div className="text-sm text-zinc-300 leading-relaxed prose prose-invert max-w-none prose-sm">
                            <ReactMarkdown>{recommendations[market.id].reasoning}</ReactMarkdown>
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
                        {analyzingId === market.id ? "Analyzing..." : "AI Analysis"}
                      </button>
                      <a 
                        href={`https://polymarket.com/event/${market.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-primary flex items-center gap-2"
                      >
                        Trade <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>

          {markets.length === 0 && !loading && (
            <div className="glass-card p-12 text-center">
              <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
              <h3 className="text-xl font-bold mb-2">No Active BTC Markets Found</h3>
              <p className="text-zinc-400 mb-6">Try refreshing or check back later for new 5-minute markets.</p>
              <button 
                onClick={fetchData}
                className="btn-primary px-6 py-2 rounded-lg flex items-center gap-2 mx-auto"
              >
                <RefreshCw className="w-4 h-4" />
                Retry Scan
              </button>
            </div>
          )}
        </section>
      </main>

      <footer className="mt-20 pt-8 border-t border-zinc-900 text-center text-zinc-600 text-sm">
        <p>© 2026 PolyBTC AI Trader • For personal use only • Not financial advice</p>
      </footer>

      <AnimatePresence>
        {confirmTradeData && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="glass-card max-w-md w-full p-8 border-blue-500/30"
            >
              <div className="flex items-center gap-3 mb-6 text-blue-400">
                <AlertTriangle className="w-8 h-8" />
                <h3 className="text-2xl font-bold">Confirm Trade</h3>
              </div>
              
              <div className="space-y-4 mb-8">
                <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Market</div>
                  <div className="text-sm font-medium leading-tight">{confirmTradeData.market.question}</div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Outcome</div>
                    <div className={cn(
                      "text-lg font-bold",
                      confirmTradeData.outcomeIndex === 0 ? "text-green-500" : "text-red-500"
                    )}>
                      {confirmTradeData.market.outcomes[confirmTradeData.outcomeIndex]}
                    </div>
                  </div>
                  <div className="p-4 bg-zinc-900 rounded-xl border border-zinc-800">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">Amount</div>
                    <div className="text-lg font-bold font-mono">{tradeAmount} USDC</div>
                  </div>
                </div>

                <div className="p-4 bg-blue-500/10 rounded-xl border border-blue-500/20">
                  <div className="text-[10px] uppercase tracking-widest text-blue-400 font-bold mb-1">Limit Price</div>
                  <div className="text-xl font-bold font-mono">
                    {(parseFloat(limitPrices[`${confirmTradeData.market.id}-${confirmTradeData.outcomeIndex}`] || confirmTradeData.market.outcomePrices[confirmTradeData.outcomeIndex]) * 100).toFixed(1)}¢
                  </div>
                </div>
              </div>

              <div className="flex gap-4">
                <button 
                  onClick={() => setConfirmTradeData(null)}
                  className="btn-secondary flex-1 py-3 rounded-xl font-bold uppercase tracking-wider"
                >
                  Cancel
                </button>
                <button 
                  onClick={executeTrade}
                  className="bg-blue-600 hover:bg-blue-500 text-white flex-1 py-3 rounded-xl font-bold uppercase tracking-wider transition-colors shadow-lg shadow-blue-500/20"
                >
                  Confirm Buy
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(" ");
}
