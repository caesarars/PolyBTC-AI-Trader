# PolyBTC AI Trader

> Bot trading otomatis berbasis AI untuk pasar prediksi BTC · ETH · SOL 5-menit di Polymarket — dengan FastLoop momentum, analisa multi-aset, eksekusi order CLOB, adaptive learning, dan dashboard real-time.

---

## Fitur Utama

| Fitur | Deskripsi |
|---|---|
| **Multi-Asset** | Scan BTC, ETH, dan SOL secara paralel setiap 5 menit — masing-masing dengan indikator, divergence threshold, dan analisa AI sendiri |
| **FastLoop Momentum** | Volume-weighted momentum dari 5 candle 1-menit terakhir (terinspirasi Simmer SDK) — arah, kekuatan (STRONG/MODERATE/WEAK), dan akselerasi |
| **Fast Path ⚡** | Bypass Gemini AI sepenuhnya saat FastLoop STRONG + 4/5 sinyal aligned — eksekusi dalam ~0ms vs ~3s |
| **AI Analysis** | Google Gemini menganalisa order book, indikator teknikal, FastLoop momentum, dan sentimen pasar sebelum tiap keputusan trade |
| **AMM Price Fix** | Pakai `outcomePrices` (AMM implied) sebagai harga referensi entry — bukan CLOB ask yang hampir selalu 99¢ di market illiquid |
| **Auto-Calibrator** | Jalankan FastLoop backtest otomatis di awal tiap window — sesuaikan `minStrength` dan confidence delta berdasarkan win rate terkini |
| **Auto Trading** | Eksekusi order otomatis ke Polymarket CLOB dengan position sizing Kelly Criterion |
| **5-Signal Alignment** | Minimum 3/5 sinyal harus sepakat: 60m bias, 5m confirmation, 1m trigger, technical score, FastLoop momentum |
| **Divergence Tracker** | Deteksi price lag antara CEX (BTC/ETH/SOL) dan Polymarket setiap 5 detik — threshold berbeda per aset |
| **Pre-filter** | Skip Gemini jika FastLoop NEUTRAL+WEAK dan tidak ada divergence — hemat ~3s latency per cycle |
| **Window AI Cache** | Gemini hanya dipanggil sekali per window; price-gate retry hanya re-fetch order book (~0.5s) |
| **Technical Indicators** | RSI(14), EMA(9/21), MACD, Bollinger Bands, volume spike, signal score alignment |
| **Adaptive Learning** | Bot menyimpan pola loss **dan win**, menyesuaikan confidence, dan memberi Gemini konteks setup yang berhasil/gagal |
| **Volatility-Adjusted Kelly** | Bet size dikurangi otomatis saat pasar choppy (ATR > baseline) |
| **Near-Expiry Exit** | Posisi profitable dipaksa keluar ≤60 detik sebelum window tutup |
| **Bot Mode** | Mode AGGRESSIVE (default) dan CONSERVATIVE — beda threshold confidence, Kelly, max bet, dan session loss limit |
| **Push Notifications** | Alert Telegram dan Discord saat trade dieksekusi atau divergence STRONG terdeteksi |
| **Analytics** | Win rate per jam (UTC), per kekuatan divergence, per arah (UP/DOWN) |
| **TP/SL Automation** | Take profit, stop loss, dan trailing stop per posisi dari UI |
| **SSE Real-time** | Log sidebar dan dashboard update live via Server-Sent Events |
| **MongoDB Cache** | Cache price & candle history untuk resiliensi saat provider eksternal rate-limit |

---

## Tech Stack

**Frontend**
- React 19 + Vite + TypeScript
- Tailwind CSS + Framer Motion
- Lightweight Charts (candlestick) + Recharts (analytics)
- Lucide React (icons)

**Backend**
- Node.js + Express (TypeScript via `tsx`)
- Polymarket CLOB Client (`@polymarket/clob-client`)
- Ethers.js 5 (wallet signing, blockchain interaction)
- Google Gemini AI (`@google/genai`)
- MongoDB (optional caching)

---

## Cara Kerja

Bot berjalan dalam siklus 5 detik, memproses BTC → ETH → SOL secara berurutan:

1. **Scan** — Ambil market aktif untuk tiap aset dari Polymarket Gamma API
2. **FastLoop** — Hitung volume-weighted momentum (5 candle 1m) → STRONG/MODERATE/WEAK
3. **Pre-filter** — Jika FastLoop WEAK + tidak ada divergence → skip AI, lanjut ke aset berikutnya
4. **Fast Path** — Jika FastLoop STRONG + 4/5 sinyal aligned → bypass Gemini, synthesize keputusan langsung
5. **Kalibrasi** — Jika auto-calibrator aktif, hasil backtest 40 window menentukan minStrength dan confidence delta
6. **AI Analysis** — Kirim data ke Gemini (jika tidak fast path) dengan konteks FastLoop, divergence, dan learning patterns
7. **Gate Check** — Validasi timing, likuiditas, AMM entry price, signal alignment (min 3/5)
8. **Eksekusi** — Submit order ke Polymarket CLOB dengan size dari Kelly Criterion
9. **Tracking** — Monitor fill, hitung PnL saat window tutup, paksa exit jika ≤60 detik tersisa dan profitable
10. **Learning** — Simpan pola loss dan win, sesuaikan threshold

---

## FastLoop Momentum

Terinspirasi dari Simmer SDK (`polymarket-fast-loop`) — menambahkan sinyal berbasis momentum CEX ke dalam keputusan bot.

### Cara hitung
```
Raw %         = (close[4] - close[0]) / close[0] * 100   (5 candle terakhir)
Volume-weighted = Σ ( candle_change% × volume_share )     (tiap candle dibobot volumenya)
Acceleration  = momentum(candle 3-4) - momentum(candle 1-2)
```

### Klasifikasi
| Strength | Volume-weighted % |
|---|---|
| STRONG | ≥ 0.15% |
| MODERATE | ≥ 0.05% |
| WEAK | < 0.05% |

### Peran dalam bot
- **Signal ke-5** dalam 5-signal alignment (MODERATE atau STRONG dihitung)
- **Pre-filter trigger**: WEAK + no divergence → skip AI
- **Fast Path trigger**: STRONG + 4/5 aligned → bypass Gemini
- **Auto-calibrator**: backtest akurasi FastLoop per window, sesuaikan threshold otomatis

---

## Auto-Calibrator

Toggle dari dashboard. Saat aktif, menjalankan backtest FastLoop di awal tiap window 5 menit:

| Win Rate | Tindakan |
|---|---|
| ≥ 65% | Signal bagus → minStrength=MODERATE, confDelta=−2% |
| 50–65% | Signal rata-rata → minStrength=MODERATE, confDelta=0% |
| < 50% | Signal lemah → minStrength=STRONG only, confDelta=+5% |

Bot otomatis lebih ketat saat pasar choppy, lebih agresif saat momentum bersih.

---

## Multi-Asset Support

| Aset | Slug Polymarket | Divergence STRONG | Divergence WEAK |
|---|---|---|---|
| BTC | `btc-updown-5m-*` | $100 dalam 30s | $30 |
| ETH | `eth-updown-5m-*` | $6 dalam 30s | $1.5 |
| SOL | `sol-updown-5m-*` | $2 dalam 30s | $0.4 |

Setiap aset dianalisa secara independen dengan threshold divergence, indikator, dan sinyal masing-masing. Atur aset yang diinginkan via env:

```env
ENABLED_ASSETS=BTC,ETH,SOL   # default semua
ENABLED_ASSETS=BTC            # hanya BTC
```

---

## Prasyarat

- Node.js 18+
- Akun Polymarket dengan wallet Polygon dan saldo USDC
- [Google AI Studio API Key](https://aistudio.google.com/) untuk Gemini
- (Opsional) MongoDB Atlas untuk caching
- (Opsional) Telegram Bot Token + Chat ID untuk notifikasi
- (Opsional) Discord Webhook URL untuk notifikasi

---

## Instalasi

```bash
# 1. Install dependencies
npm install

# 2. Copy file env
cp .env.example .env   # Linux/Mac
copy .env.example .env # Windows

# 3. Isi .env (lihat panduan di bawah)

# 4. Jalankan app
npm run dev
```

Buka `http://localhost:3000` di browser.

---

## Konfigurasi `.env`

> **PENTING:** Jangan pernah commit file `.env` ke GitHub.

### Wajib

```env
# Wallet Polygon yang terhubung ke akun Polymarket
POLYGON_PRIVATE_KEY=0x...

# Credentials API Polymarket (bisa di-derive otomatis dari wallet jika tidak ada)
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...

# Tipe signature: 0 = wallet EOA biasa, 1 = profile/proxy wallet Polymarket
POLYMARKET_SIGNATURE_TYPE=1

# Profile address Polymarket (sering beda dengan address wallet signer)
POLYMARKET_FUNDER_ADDRESS=0x...

# API key Google Gemini
GEMINI_API_KEY=AIza...
```

### Bot Behavior

```env
# Aset yang di-scan (default semua)
ENABLED_ASSETS=BTC,ETH,SOL

# Threshold bot (semua bisa di-override dari dashboard UI juga)
BOT_MIN_CONFIDENCE=65
BOT_MIN_EDGE=0.10
BOT_KELLY_FRACTION=0.40
BOT_MAX_BET_USDC=250
BOT_SESSION_LOSS_LIMIT=0.30

# Auto-start bot saat server menyala
BOT_AUTO_START=false
```

### Push Notifications (Opsional)

```env
# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### MongoDB Cache (Opsional)

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
MONGODB_DB_NAME=polybtc
MONGODB_CACHE_COLLECTION=market_cache
MONGODB_PRICE_SNAPSHOTS_COLLECTION=btc_price_snapshots
MONGODB_CHART_COLLECTION=chart
MONGODB_POSITION_AUTOMATION_COLLECTION=position_automation
```

---

## API Endpoints

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/api/bot/status` | Status bot, session stats, konfigurasi |
| POST | `/api/bot/control` | Enable/disable bot `{ enabled: boolean }` |
| GET | `/api/bot/log` | Log keputusan trade |
| GET | `/api/bot/learning` | State adaptive learning |
| GET | `/api/bot/momentum-history` | Ring buffer 60 titik FastLoop momentum |
| GET | `/api/bot/calibration` | Status auto-calibrator + hasil terakhir |
| POST | `/api/bot/calibration/toggle` | Toggle auto-calibrator ON/OFF |
| POST | `/api/backtest` | Jalankan FastLoop backtest manual |
| GET | `/api/analytics` | Win rate per jam, per divergence, per arah |
| GET | `/api/notifications/status` | Status koneksi Telegram & Discord |
| GET | `/api/polymarket/markets` | Daftar pasar BTC+ETH+SOL aktif |
| GET | `/api/polymarket/orderbook/:tokenID` | Order book + imbalance signal |
| POST | `/api/polymarket/trade` | Eksekusi trade manual |
| GET | `/api/polymarket/performance` | PnL, win rate, trade history |
| GET | `/api/polymarket/balance` | Saldo USDC |
| GET | `/api/btc-price` | Harga BTC terkini |
| GET | `/api/btc-history` | 60 candle 1-menit terakhir |
| GET | `/api/btc-indicators` | RSI, MACD, Bollinger Bands, dll |

---

## Kalibrasi & Edge Philosophy

Bot ini dirancang untuk **presisi, bukan frekuensi**.

### Base Rate Problem
Pasar binary BTC/ETH/SOL 5-menit pada dasarnya adalah coin flip (50/50). Sinyal teknikal mengukur apa yang **sudah terjadi** — bukan 5 menit ke depan. Edge yang valid berasal dari dua sumber:
1. **Price lag divergence** — aset sudah bergerak di CEX tapi Polymarket belum update
2. **Multi-signal consensus** — 4–5 sinyal independent menunjuk arah yang sama

### Threshold Aktif

| Parameter | AGGRESSIVE | CONSERVATIVE |
|---|---|---|
| Min Confidence | 65% | 75% |
| Min Edge | 0.10¢ | 0.12¢ |
| Kelly Fraction | 40% | 20% |
| Max Bet | $250 | $50 |
| Session Loss Limit | 30% | 15% |
| Max Entry Price | AMM-based: (conf−10)¢, max 75¢ | sama |

### 5-Signal Alignment

Minimal **3/5 sinyal** harus sepakat sebelum trade:

| Sinyal | Sumber |
|---|---|
| 60m bias | EMA cross + price move arah 60 menit terakhir |
| 5m confirmation | Swing direction dari 4 candle 5-menit |
| 1m trigger | Candle terakhir bullish/bearish |
| Technical score | RSI + MACD + EMA combined score ≥2 atau ≤−2 |
| FastLoop momentum | Volume-weighted momentum MODERATE atau STRONG |

### Fast Path Conditions
Bot bypass Gemini (~3s) dan synthesize keputusan langsung (~0ms) jika semua terpenuhi:
- FastLoop **STRONG** dan directional
- Alignment **≥ 4/5** dalam arah yang sama
- Divergence **tidak bertentangan** dengan arah
- **Tidak ada pola loss** yang cocok dalam 3 loss terakhir

---

## Keamanan

- Private key adalah data paling sensitif — siapa pun yang punya ini bisa kontrol wallet
- Gunakan wallet **khusus trading bot**, bukan wallet utama
- Jika private key pernah bocor: segera pindahkan dana ke wallet baru
- Jangan pernah share, screenshot, atau upload `.env` ke mana pun

---

## Troubleshooting

### Balance tidak muncul atau salah
- Cek `POLYMARKET_SIGNATURE_TYPE` (coba `0` atau `1`)
- Cek `POLYMARKET_FUNDER_ADDRESS` (harus address profile Polymarket, bukan wallet signer)

### Bot selalu skip dengan "No ask liquidity"
- Sudah diperbaiki — bot kini pakai `outcomePrices` (AMM) bukan CLOB ask

### ETH/SOL candles kosong
- Provider Binance mungkin rate-limit — akan ter-cache di siklus berikutnya secara otomatis

### AI fallback mode
- Feed BTC/ETH/SOL eksternal gagal, bot pakai data Polymarket saja
- Anggap confidence lebih konservatif saat ini aktif

### Data sering error 500
- Isi `MONGODB_URI` untuk aktifkan cache internal
- Debug cache: `GET /api/debug/btc-cache`

---

## Scripts

```bash
npm run dev      # Jalankan server + frontend (development)
npm run build    # Build frontend untuk production
npm run preview  # Preview build production
npm run lint     # Type check TypeScript
```

---

## Struktur Project

```
├── src/
│   ├── App.tsx                  # Main app
│   ├── components/
│   │   ├── BotDashboard.tsx     # Dashboard kontrol bot (multi-asset, calibrator, momentum)
│   │   ├── BotLogSidebar.tsx    # Live log sidebar
│   │   └── CandlestickChart.tsx # Chart candlestick
│   ├── services/
│   │   └── gemini.ts            # AI analysis service (multi-asset prompt)
│   └── lib/
│       └── utils.ts             # Helper utilities
├── server.ts                    # Express backend (bot engine, FastLoop, multi-asset)
├── data/
│   ├── loss_memory.json         # Adaptive learning state (persisted)
│   └── trade_log.jsonl          # Trade history log
├── vite.config.ts               # Konfigurasi Vite
└── .env.example                 # Template environment variables
```

---

## Disclaimer

Project ini dibuat untuk tujuan edukasi dan eksperimen trading. Perdagangan aset kripto dan prediction market mengandung risiko tinggi. Tidak ada jaminan profit. Gunakan dengan risiko sendiri.
