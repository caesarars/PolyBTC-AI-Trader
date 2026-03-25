import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize CLOB Client and Wallet lazily
let clobClient: ClobClient | null = null;
let clobWallet: ethers.Wallet | null = null;

function getClobClient() {
  if (clobClient) return clobClient;

  const privateKey = process.env.POLYGON_PRIVATE_KEY;
  if (!privateKey) {
    console.warn("POLYGON_PRIVATE_KEY not found in environment. CLOB trading features will be disabled.");
    return null;
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
    clobWallet = new ethers.Wallet(privateKey, provider);

    // For public data, we can use a basic client. For trading, we need full credentials.
    clobClient = new ClobClient(
      "https://clob.polymarket.com",
      137, // Polygon Mainnet
      clobWallet,
      {
        key: process.env.POLYMARKET_API_KEY || "",
        secret: process.env.POLYMARKET_API_SECRET || "",
        passphrase: process.env.POLYMARKET_API_PASSPHRASE || "",
      }
    );
    return clobClient;
  } catch (error) {
    console.error("Failed to initialize CLOB client:", error);
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Proxy for Polymarket Gamma API (Markets)
  app.get("/api/polymarket/markets", async (req, res) => {
    try {
      // Fetch all active markets and filter them for Bitcoin/BTC
      const response = await axios.get("https://gamma-api.polymarket.com/markets", {
        params: {
          limit: 100, // Fetch more markets to ensure we find BTC ones
          active: true,
          closed: false,
          tag_id: 1, // Official Bitcoin tag ID on Polymarket
          ascending: false,
          order: "createdAt"
        }
      });
      
      // Filter for Bitcoin/BTC in the question or description
      const btcMarkets = response.data.filter((m: any) => 
        m.question.toLowerCase().includes("bitcoin") || 
        m.question.toLowerCase().includes("btc") ||
        (m.description && m.description.toLowerCase().includes("bitcoin"))
      );
      
      console.log(`Found ${btcMarkets.length} Bitcoin markets out of ${response.data.length} active markets`);
      
      res.json(btcMarkets);
    } catch (error: any) {
      console.error("Polymarket Gamma API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch markets" });
    }
  });

  // API for Polymarket CLOB Order Book
  app.get("/api/polymarket/orderbook/:tokenID", async (req, res) => {
    try {
      const { tokenID } = req.params;
      const client = getClobClient();
      
      // If we don't have a client, we can still try to fetch public data via axios
      if (!client) {
        const response = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenID}`);
        return res.json(response.data);
      }

      const orderbook = await client.getOrderBook(tokenID);
      res.json(orderbook);
    } catch (error: any) {
      console.error("Polymarket CLOB API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch order book" });
    }
  });

  // API for Placing Trades
  app.post("/api/polymarket/trade", async (req, res) => {
    try {
      const { tokenID, amount, side, price } = req.body;
      const client = getClobClient();

      if (!client) {
        return res.status(400).json({ error: "CLOB client not initialized. Check credentials." });
      }

      // Check if full credentials exist
      if (!process.env.POLYMARKET_API_KEY || !process.env.POLYMARKET_API_SECRET || !process.env.POLYMARKET_API_PASSPHRASE) {
        return res.status(400).json({ error: "Missing API Key, Secret, or Passphrase for trading." });
      }

      if (!price) {
        return res.status(400).json({ error: "Limit price is required." });
      }

      // Place a limit order
      const order = await client.createOrder({
        tokenID,
        size: parseFloat(amount),
        side: side.toUpperCase() as any, // "BUY" or "SELL"
        price: parseFloat(price), // Use the provided limit price
      });

      res.json(order);
    } catch (error: any) {
      console.error("Trade Execution Error:", error.message);
      res.status(500).json({ error: error.message || "Failed to execute trade" });
    }
  });

  // API for Fetching Balance
  app.get("/api/polymarket/balance", async (req, res) => {
    try {
      getClobClient(); // Ensure wallet is initialized
      if (!clobWallet) return res.status(400).json({ error: "Wallet not initialized" });

      const address = clobWallet.address;
      res.json({ address, balance: "---" });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch balance" });
    }
  });

  // API for Polymarket Market Price History
  app.get("/api/polymarket/history/:marketID", async (req, res) => {
    try {
      const { marketID } = req.params;
      // Fetch price history from Polymarket Gamma API
      const response = await axios.get(`https://gamma-api.polymarket.com/prices-history`, {
        params: {
          market: marketID,
          interval: "1h"
        }
      });
      res.json(response.data);
    } catch (error: any) {
      console.error("Polymarket Price History API Error:", error.message);
      res.status(500).json({ error: "Failed to fetch market price history" });
    }
  });

  // Proxy for BTC Price (Binance)
  app.get("/api/btc-price", async (req, res) => {
    try {
      const response = await axios.get("https://api.binance.com/api/v3/ticker/price", {
        params: { symbol: "BTCUSDT" }
      });
      res.json(response.data);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch BTC price" });
    }
  });

  // Proxy for BTC Historical Data (Binance)
  app.get("/api/btc-history", async (req, res) => {
    try {
      const response = await axios.get("https://api.binance.com/api/v3/klines", {
        params: {
          symbol: "BTCUSDT",
          interval: "1h",
          limit: 24
        }
      });
      const history = response.data.map((k: any) => ({
        time: k[0],
        price: parseFloat(k[4])
      }));
      res.json(history);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch BTC history" });
    }
  });

  // Proxy for Crypto Sentiment (Fear & Greed Index)
  app.get("/api/sentiment", async (req, res) => {
    try {
      const response = await axios.get("https://api.alternative.me/fng/");
      res.json(response.data.data[0]);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch sentiment data" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
