# PolyBTC AI Trader

> BTC-only bot untuk market prediksi Polymarket 5 menit, dengan eksekusi depth-aware, divergence fast path, alpha research tooling, dan dashboard operasional real-time.

---

## Current Scope

- Fokus runtime saat ini adalah **BTC only**
- Loop live berjalan setiap beberapa detik dan hanya entry di zona waktu aktif dalam window 5 menit
- Engine live sekarang memakai **price-lag + momentum synthesis**, bukan Gemini sebagai decision engine utama
- Data riset disimpan ke **JSONL lokal** dan bisa di-mirror ke **MongoDB**
- Dashboard menampilkan status bot, current entry, market infra, replay analytics, dan alpha research

---

## Highlights

| Area | Ringkasan |
|---|---|
| **BTC-only live trading** | Runtime dikunci ke market BTC 5 menit agar tuning lebih fokus dan tidak tercampur ETH/SOL |
| **FastLoop + divergence** | Sinyal utama berasal dari momentum BTC, alignment teknikal, dan lag Polymarket vs CEX |
| **Fast path execution** | Setup divergence yang sangat kuat bisa langsung dieksekusi tanpa menunggu jalur normal |
| **pmxt-inspired infra** | Discovery cache, websocket order book/trade stream, token prewarm, dan execution quote berbasis depth |
| **Depth-aware entry** | Bot tidak hanya lihat top ask, tapi menghitung average fill dan limit price dari order book depth |
| **BTC premium guards** | Entry mahal diblok kalau confidence/edge tidak cukup kuat |
| **Alpha overlay** | Model `btc-alpha-v1` dipakai untuk research overlay dan live veto ringan pada setup BTC confidence 75-79% |
| **Replay analytics** | Trade log replay, BTC cutoff matrix, calibration summary, dan markout research tersedia dari dashboard |
| **Decision logging** | Semua keputusan bot bisa disimpan ke `decision_log.jsonl`, bukan hanya trade yang dieksekusi |
| **Execution automation** | Posisi yang sudah masuk bisa di-manage dengan TP, SL, trailing stop, dan result tracking |
| **SSE dashboard** | Log dan infra status dikirim live ke UI lewat Server-Sent Events |

---

## Live Execution Workflow

Flow live saat ini secara ringkas:

1. Bot loop jalan tiap `BOT_SCAN_INTERVAL_MS`
2. Bot cek window BTC 5 menit aktif dan memastikan masih berada di entry zone
3. Bot discover market current + next window dari Polymarket
4. Token outcome di-prewarm dan di-subscribe ke websocket order book/trade feed
5. Bot ambil candle BTC, indikator, snapshot order book, dan history market
6. Engine membentuk signal dari FastLoop momentum, divergence, alignment, dan price-lag synthesis
7. Jika divergence sangat kuat, bot bisa masuk fast path
8. Semua signal tetap harus lolos guard:
   - minimum confidence
   - minimum edge
   - pressure filter
   - dynamic entry guard
   - BTC premium gate
   - alpha veto untuk bucket confidence tertentu
9. Bot hitung execution quote dari depth order book
10. Order dikirim ke Polymarket CLOB
11. Posisi masuk ke automation tracker untuk TP/SL/trailing dan result resolution
12. Trade dan decision snapshot disimpan ke log untuk analytics berikutnya

---

## BTC Entry Guards

Selain `minConfidence` dan `minEdge`, runtime sekarang punya guard BTC yang lebih spesifik:

- `ask > 50.0c` membutuhkan `confidence >= 82%`
- `ask >= 49.5c` membutuhkan `edge >= 21.0c`
- `confidence 75-79%` dengan `ask >= 49.0c` membutuhkan `edge >= 28.0c`
- setup `BTC 75-79%` juga bisa diblok oleh alpha overlay jika model menganggap trade tidak layak

Catatan unit:

- `BOT_MIN_EDGE=0.15` berarti **15c edge**, bukan `0.15c`
- di bot ini, `edge = estimated_probability - entry_price`

---

## Alpha Research Stack

Bot sekarang punya layer riset yang terpisah dari engine live:

- **Trade log replay**
  - replay rule saat ini terhadap `trade_log.jsonl`
  - membandingkan baseline vs trade yang lolos guard terbaru
- **BTC cutoff matrix**
  - analisis per direction, confidence bucket, entry bucket, dan edge bucket
- **Decision log dataset**
  - menyimpan keputusan `NO_TRADE`, `FILTERED`, dan `EXECUTED`
  - dipakai untuk calibration dan markout analysis
- **Alpha model overlay**
  - `btc-alpha-v1`
  - menghasilkan probability, model edge, conviction, agreement, dan reasons
- **Shadow replay**
  - mengevaluasi apakah model overlay akan memperbaiki PnL historis sebelum dijadikan live gate lebih agresif

File riset utama:

- [trade_log.jsonl](/Users/caesararssetya/PolyBTC-AI-Trader/data/trade_log.jsonl)
- [decision_log.jsonl](/Users/caesararssetya/PolyBTC-AI-Trader/data/decision_log.jsonl)

---

## Dashboard

Dashboard utama sekarang mencakup:

- **Session PnL**
  - resolved trades 7 hari terakhir
- **Bot Log**
  - tab `Trades` hanya menampilkan trade yang benar-benar dieksekusi
- **Market Infra**
  - discovery cache
  - websocket health
  - prewarm status
  - execution quote depth-aware
- **Backtest**
  - replay trade log dan summary signal backtest
- **Analytics**
  - BTC cutoff matrix
  - alpha research panel
- **Current Entry**
  - current signal snapshot
  - alpha overlay summary

---

## Tech Stack

**Frontend**

- React 19
- Vite
- TypeScript
- Tailwind CSS
- Framer Motion
- Recharts
- Lightweight Charts

**Backend**

- Node.js + Express
- TypeScript via `tsx`
- `@polymarket/clob-client`
- `@nevuamarkets/poly-websockets`
- `ethers`
- `mongodb`
- `axios`

**Research / Persistence**

- local JSONL logs
- optional MongoDB collections

---

## Getting Started

### Prerequisites

- Node.js 18+
- Wallet Polygon dengan saldo USDC
- Kredensial Polymarket CLOB
- Optional MongoDB untuk persistence tambahan
- Optional Telegram / Discord untuk notifikasi

`GEMINI_API_KEY` masih ada di `.env.example`, tetapi **tidak menjadi syarat utama** untuk workflow live saat ini.

### Install

```bash
npm install
cp .env.example .env
npm run dev
```

Lalu buka `http://localhost:3000`.

---

## Environment Variables

### Required

```env
POLYGON_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_FUNDER_ADDRESS=0x...
```

### Core bot config

```env
BOT_SCAN_INTERVAL_MS=5000
BOT_MIN_CONFIDENCE=75
BOT_MIN_EDGE=0.15
BOT_FIXED_TRADE_USDC=1
BOT_AUTO_START=false
ENABLED_ASSETS=BTC
```

Catatan:

- build runtime sekarang tetap mengunci asset ke `BTC`
- `BOT_MIN_EDGE=0.15` berarti `15c`
- `BOT_FIXED_TRADE_USDC` saat ini divalidasi sebagai integer `1-5`

### Optional MongoDB

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
MONGODB_DB_NAME=polybtc
MONGODB_CACHE_COLLECTION=market_cache
MONGODB_PRICE_SNAPSHOTS_COLLECTION=btc_price_snapshots
MONGODB_CHART_COLLECTION=chart
MONGODB_POSITION_AUTOMATION_COLLECTION=position_automation
```

### Optional notifications

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

---

## Key API Endpoints

### Bot and runtime

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/bot/status` | status bot, config aktif, current entry, infra snapshot |
| POST | `/api/bot/control` | start / stop bot |
| GET | `/api/bot/log` | bot log, bisa `executedOnly=true` |
| GET | `/api/bot/rawlog` | raw log stream snapshot |
| GET | `/api/bot/events` | SSE event stream untuk dashboard |
| GET | `/api/bot/trade-log` | trade log teragregasi |
| POST | `/api/bot/config` | update `minConfidence`, `minEdge`, `fixedTradeUsdc` |
| GET | `/api/bot/assets` | asset aktif, runtime saat ini BTC-only |

### Analytics and research

| Method | Endpoint | Keterangan |
|---|---|---|
| POST | `/api/backtest` | backtest signal dari candle history |
| GET | `/api/backtest/trade-log-replay` | replay trade log dengan rule runtime sekarang |
| GET | `/api/analytics` | agregasi by hour, divergence, direction |
| GET | `/api/analytics/btc-cutoffs` | cutoff matrix BTC |
| GET | `/api/alpha/decision-log` | dataset decision snapshot |
| GET | `/api/alpha/research` | calibration, markout, recent decisions, shadow replay |

### Polymarket market infra

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/polymarket/markets` | market current + next yang berhasil didiscover |
| GET | `/api/polymarket/discovery` | discovery snapshot per asset |
| GET | `/api/polymarket/orderbook/:tokenID` | normalized order book + optional quote |
| GET | `/api/polymarket/execution-quote/:tokenID` | quote depth-aware untuk amount tertentu |
| GET | `/api/polymarket/stream` | status websocket feed |
| GET | `/api/polymarket/positions` | posisi terbuka |
| GET | `/api/polymarket/closed-positions` | posisi tertutup |
| GET | `/api/polymarket/performance` | performance summary |
| GET | `/api/polymarket/balance` | saldo wallet / USDC |

### BTC data helpers

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/btc-price` | harga BTC terkini |
| GET | `/api/btc-history` | candle history BTC |
| GET | `/api/btc-indicators` | indikator teknikal BTC |
| GET | `/api/bot/ping` | latency probe ke upstream utama |

---

## Project Structure

```text
.
├── data/
│   ├── decision_log.jsonl
│   ├── loss_memory.json
│   └── trade_log.jsonl
├── src/
│   ├── components/
│   │   ├── BotDashboard.tsx
│   │   ├── BotLogSidebar.tsx
│   │   └── CandlestickChart.tsx
│   ├── server/
│   │   └── alpha/
│   │       ├── analytics.ts
│   │       ├── model.ts
│   │       ├── persistence.ts
│   │       └── types.ts
│   ├── services/
│   └── lib/
├── server.ts
├── .env.example
├── package.json
└── README.md
```

---

## Scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
```

Keterangan:

- `npm run dev` menjalankan Express + Vite lewat `tsx server.ts`
- `npm run lint` saat ini hanyalah TypeScript no-emit check

---

## Operational Notes

- bot ini lebih cocok dipakai dengan size kecil sambil terus dievaluasi
- replay dan alpha research membantu tuning, tetapi tidak menggantikan validasi live
- jangan masukkan `trade_log.jsonl` atau `.env` ke commit Git
- gunakan wallet khusus bot, bukan wallet utama

---

## Disclaimer

Project ini dibuat untuk riset dan eksperimen trading. Prediction market dan crypto trading punya risiko tinggi. Tidak ada jaminan profit. Gunakan dengan risiko sendiri.
