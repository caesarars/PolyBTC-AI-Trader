# PolyBTC AI Trader

> Bot trading otomatis berbasis AI untuk pasar prediksi BTC 5-menit di Polymarket — dengan analisa teknikal, eksekusi order CLOB, adaptive learning, dan dashboard real-time.

---

## Fitur Utama

| Fitur | Deskripsi |
|---|---|
| **AI Analysis** | Google Gemini menganalisa order book, indikator teknikal, dan sentimen pasar sebelum tiap keputusan trade |
| **Auto Trading** | Eksekusi order otomatis ke Polymarket CLOB dengan position sizing Kelly Criterion |
| **Technical Indicators** | RSI(14), EMA(9/21), MACD, Bollinger Bands, volume spike, signal score alignment |
| **Adaptive Learning** | Bot menyimpan pola loss **dan win**, menyesuaikan confidence, dan memberi Gemini konteks setup yang berhasil/gagal |
| **Volatility-Adjusted Kelly** | Bet size dikurangi otomatis saat BTC choppy (ATR > baseline) — max 50% Kelly saat pasar sangat volatile |
| **Near-Expiry Exit** | Posisi profitable dipaksa keluar ≤60 detik sebelum window tutup — mencegah binary price collapse membalikkan profit |
| **Entry Price Gate** | Hard gate: skip trade jika bestAsk > 80¢ — token near-resolved tidak punya edge yang layak |
| **Live Kelly Pricing** | Kelly Criterion pakai harga live orderbook (bestAsk), bukan outcomePrices stale dari API |
| **Calibrated AI Confidence** | Gemini diwajibkan ≥70% confidence (AGGRESSIVE) / ≥75% (CONSERVATIVE) — base rate 50% tertulis eksplisit di prompt, minimum 3/4 sinyal harus align |
| **TP/SL Automation** | Take profit, stop loss, dan trailing stop per posisi dari UI |
| **Bot Mode** | Mode AGGRESSIVE (default) dan CONSERVATIVE — beda threshold confidence, Kelly, max bet, dan session loss limit |
| **Performance Tracking** | Realized PnL, win rate, trade history lengkap dengan divergence stats |
| **SSE Real-time** | Log sidebar dan dashboard update live via Server-Sent Events — tidak ada polling |
| **Live Dashboard** | Candlestick chart real-time, order book, log bot, dan session stats |
| **MongoDB Cache** | Cache BTC price & candle history untuk resiliensi saat provider eksternal rate-limit |

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

Bot berjalan dalam siklus 5 detik:

1. **Scan** — Ambil daftar pasar BTC 5-menit aktif di Polymarket
2. **Analisa** — Hitung indikator teknikal (60 candle), baca order book, kirim ke Gemini AI
3. **Keputusan** — AI return `TRADE / NO_TRADE` + direction, confidence, estimated edge, risk level
4. **Gate Check** — Validasi timing window (10–285 detik), likuiditas order book ($500+), entry price ≤80¢, signal alignment (min 3 dari 4)
5. **Eksekusi** — Submit order ke Polymarket CLOB dengan size dari Kelly Criterion berbasis harga live orderbook (bestAsk), disesuaikan volatilitas BTC (ATR)
6. **Tracking** — Monitor fill status, hitung PnL saat window tutup, paksa exit jika ≤60 detik tersisa dan posisi profitable
7. **Learning** — Simpan pola loss DAN win, sesuaikan confidence threshold berdasarkan streak

---

## Prasyarat

- Node.js 18+
- Akun Polymarket dengan wallet Polygon dan saldo USDC
- [Google AI Studio API Key](https://aistudio.google.com/) untuk Gemini
- (Opsional) MongoDB Atlas untuk caching

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

Buka `http://localhost:5173` di browser.

---

## Konfigurasi `.env`

> **PENTING:** Jangan pernah commit file `.env` ke GitHub. File ini sudah ada di `.gitignore`.

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

# RPC Polygon (sudah ada fallback otomatis, tidak perlu diubah)
POLYGON_RPC_URLS=https://1rpc.io/matic,https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org

# API key Google Gemini untuk analisa AI
GEMINI_API_KEY=AIza...
```

### Opsional (MongoDB Cache)

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
MONGODB_DB_NAME=polybtc
MONGODB_CACHE_COLLECTION=market_cache
MONGODB_PRICE_SNAPSHOTS_COLLECTION=btc_price_snapshots
MONGODB_CHART_COLLECTION=chart
MONGODB_POSITION_AUTOMATION_COLLECTION=position_automation

# Interval sync background (milliseconds)
BTC_BACKGROUND_SYNC_MS=20000
POSITION_AUTOMATION_SYNC_MS=15000

# TTL data cache (seconds)
BTC_PRICE_SNAPSHOT_TTL_SECONDS=1209600   # 14 hari
BTC_CANDLE_TTL_SECONDS=2592000           # 30 hari
```

---

## API Endpoints

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/api/bot/status` | Status bot, session stats, konfigurasi |
| POST | `/api/bot/control` | Enable/disable bot `{ enabled: boolean }` |
| GET | `/api/bot/log` | Log keputusan trade |
| GET | `/api/bot/learning` | State adaptive learning (pola loss, confidence) |
| GET | `/api/polymarket/markets` | Daftar pasar BTC aktif |
| GET | `/api/polymarket/orderbook/:tokenID` | Order book + imbalance signal |
| POST | `/api/polymarket/trade` | Eksekusi trade manual |
| GET | `/api/polymarket/performance` | PnL, win rate, trade history |
| GET | `/api/polymarket/balance` | Saldo USDC |
| GET | `/api/btc-price` | Harga BTC terkini |
| GET | `/api/btc-history` | 60 candle 1-menit terakhir |
| GET | `/api/btc-indicators` | RSI, MACD, Bollinger Bands, dll |
| GET | `/api/sentiment` | Fear & Greed index |
| GET | `/api/debug/btc-cache` | Status MongoDB cache |
| GET/POST | `/api/polymarket/automation` | Kelola TP/SL automation per posisi |

---

## Keamanan

- Private key adalah data paling sensitif — siapa pun yang punya ini bisa kontrol wallet
- Gunakan wallet khusus trading bot, **bukan** wallet utama
- Jika private key pernah bocor (screenshot, chat, GitHub): segera pindahkan dana ke wallet baru
- Jika MongoDB URI bocor: rotate password database segera
- Jangan pernah share, screenshot, atau upload `.env` ke mana pun

---

## Troubleshooting

### Balance tidak muncul atau salah
- Cek `POLYMARKET_SIGNATURE_TYPE` (coba `0` atau `1`)
- Cek `POLYMARKET_FUNDER_ADDRESS` (harus address profile Polymarket, bukan wallet signer)

### Order `OPEN` tidak fill
- Order sudah masuk ke exchange tapi belum ada lawan di harga tersebut — tunggu atau cancel manual

### Error "trade terlalu kecil"
- Market punya minimum share size — amount USDC di bawah minimum untuk limit price itu

### AI fallback mode
- Feed BTC eksternal gagal, bot pakai data Polymarket saja
- Anggap confidence lebih konservatif saat ini aktif

### Data BTC sering error 500
- Isi `MONGODB_URI` di `.env` untuk aktifkan cache internal
- Restart server, biarkan backend sync data ke MongoDB
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
│   ├── App.tsx                  # Main app + logika trading utama
│   ├── types.ts                 # TypeScript interfaces
│   ├── components/
│   │   ├── BotDashboard.tsx     # Dashboard kontrol bot
│   │   ├── BotLogSidebar.tsx    # Live log sidebar
│   │   └── CandlestickChart.tsx # Chart candlestick BTC
│   ├── services/
│   │   └── gemini.ts            # AI analysis service
│   └── lib/
│       └── utils.ts             # Helper utilities
├── server.ts                    # Express backend (REST API + bot engine)
├── vite.config.ts               # Konfigurasi Vite
└── .env.example                 # Template environment variables
```

---

## Kalibrasi & Edge Philosophy

Bot ini dirancang untuk **presisi, bukan frekuensi**. Berikut prinsip yang diterapkan:

### Base Rate Problem
Pasar binary BTC 5-menit pada dasarnya adalah coin flip (50/50). Sinyal teknikal seperti RSI, EMA, dan MACD mengukur apa yang **sudah terjadi** pada BTC — bukan arah 5 menit ke depan. Satu-satunya edge yang benar-benar valid adalah **price lag divergence**: ketika BTC sudah bergerak signifikan tapi Polymarket belum meng-update harganya.

### Threshold Aktif

| Parameter | AGGRESSIVE | CONSERVATIVE |
|---|---|---|
| Min Confidence | 70% | 75% |
| Min Edge | 0.10 | 0.12 |
| Kelly Fraction | 40% | 20% |
| Max Bet | $250 | $50 |
| Session Loss Limit | 25% | 15% |
| Max Entry Price | 80¢ | 80¢ |

### Signal Alignment
Minimal **3 dari 4 sinyal** harus sepakat sebelum trade dieksekusi (kecuali divergence STRONG/MODERATE, cukup 2/4):
- 60m bias (arah trend jangka menengah)
- 5m confirmation (konfirmasi swing)
- 1m trigger (entry trigger)
- Technical signal score (RSI + MACD + EMA combined)

### Edge Formula
```
real_edge = your_probability - 0.50 (base rate)
```
Confidence 70% = +20% edge di atas coin flip. Di bawah 70% = tidak cukup untuk menutup spread dan slippage.

---

## Disclaimer

Project ini dibuat untuk tujuan edukasi dan eksperimen trading. Perdagangan aset kripto dan prediction market mengandung risiko tinggi. Tidak ada jaminan profit. Gunakan dengan risiko sendiri.
