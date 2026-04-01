# PolyBTC AI Trader

> Bot trading otomatis berbasis AI untuk pasar prediksi BTC · ETH · SOL 5-menit di Polymarket — dengan FastLoop momentum, analisa multi-aset, eksekusi order CLOB, adaptive learning, pressure alignment filter, dan dashboard real-time.

---

## Fitur Utama

| Fitur | Deskripsi |
|---|---|
| **Multi-Asset** | Scan BTC, ETH, dan SOL secara paralel setiap 5 menit — masing-masing dengan indikator, divergence threshold, dan analisa AI sendiri |
| **FastLoop Momentum** | Volume-weighted momentum dari 5 candle 1-menit terakhir (terinspirasi Simmer SDK) — arah, kekuatan (STRONG/MODERATE/WEAK), dan akselerasi |
| **Divergence Fast Path ⚡** | Bypass Gemini AI sepenuhnya saat STRONG divergence terdeteksi — eksekusi dalam <1s vs ~3s |
| **Correlated Multi-Asset Entry** | Saat BTC diverge STRONG, bot otomatis masuk ETH+SOL di arah yang sama (70% Kelly) — manfaatkan price lag lintas aset |
| **AI Analysis** | Google Gemini menganalisa order book, indikator teknikal, FastLoop momentum, dan sentimen pasar sebelum tiap keputusan trade |
| **Pressure Alignment Filter** | Hanya trade saat arah order book (BUY/SELL pressure) searah dengan sinyal — dari data: BUY_PRESSURE 67% WR vs SELL_PRESSURE 20% WR |
| **Dynamic Kelly Fraction** | Kelly fraction naik otomatis seiring confidence: 65-74%→25%, 75-84%→50%, 85-89%→55%, ≥90%→65% |
| **Profit Lock** | Saat posisi mencapai 70% dari jarak TP, trailing stop otomatis dikencangkan ke 3¢ — kunci profit sebelum reversal |
| **Spike Capture** | Jika dalam 90 detik pertama posisi sudah naik +8¢, langsung exit — ambil spike sebelum mean-revert |
| **TP/SL Monitor 3s** | Monitor posisi setiap 3 detik (bukan 10s) — tidak ada lagi spike TP yang terlewat |
| **Instant TP Execution** | TP tidak lagi "waiting for bid" — execute langsung saat trigger, fallback ke ask×0.97 jika tidak ada bid |
| **Heartbeat** | Kirim heartbeat ke Polymarket setiap 5s — mencegah open orders di-cancel otomatis (docs: timeout 10s) |
| **AMM Price Fix** | Pakai `outcomePrices` (AMM implied) sebagai harga referensi entry — bukan CLOB ask yang hampir selalu 99¢ di market illiquid |
| **Auto-Calibrator** | Jalankan FastLoop backtest otomatis di awal tiap window — sesuaikan `minStrength` dan confidence delta berdasarkan win rate terkini |
| **Auto Trading** | Eksekusi order otomatis ke Polymarket CLOB dengan position sizing Kelly Criterion |
| **Divergence Tracker** | Deteksi price lag antara CEX (BTC/ETH/SOL) dan Polymarket setiap 5 detik — threshold berbeda per aset |
| **Window AI Cache** | Gemini hanya dipanggil sekali per window; price-gate retry hanya re-fetch order book (~0.5s) |
| **Technical Indicators** | RSI(14), EMA(9/21), MACD, Bollinger Bands, volume spike, signal score alignment |
| **Adaptive Learning** | Bot menyimpan pola loss **dan win**, menyesuaikan confidence per aset, dan memberi Gemini konteks setup yang berhasil/gagal |
| **Volatility-Adjusted Kelly** | Bet size dikurangi otomatis saat pasar choppy (ATR > baseline) |
| **Near-Expiry Exit** | Posisi profitable dipaksa keluar ≤60 detik sebelum window tutup |
| **Bot Mode** | Mode AGGRESSIVE (default) dan CONSERVATIVE — beda threshold confidence, Kelly, max bet, dan session loss limit |
| **Push Notifications** | Alert Telegram dan Discord saat trade dieksekusi atau divergence STRONG terdeteksi |
| **Analytics** | Win rate per jam (UTC), per kekuatan divergence, per arah (UP/DOWN) |
| **TP/SL Automation** | Take profit, stop loss, dan trailing stop per posisi dari UI — dengan profit lock dan spike capture |
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
2. **Pressure Check** — Cek order book imbalance signal (BUY/SELL/NEUTRAL pressure)
3. **FastLoop** — Hitung volume-weighted momentum (5 candle 1m) → STRONG/MODERATE/WEAK
4. **Pre-filter** — Jika FastLoop WEAK + tidak ada divergence → skip AI, lanjut ke aset berikutnya
5. **Early Guard** — Blok trade <60 detik jika tidak ada divergence dan BTC flat (coin-flip guard)
6. **AI Analysis** — Kirim data ke Gemini dengan konteks FastLoop, divergence, dan learning patterns
7. **Pressure Alignment Filter** — Tolak trade jika arah bertentangan dengan order book pressure
8. **Gate Check** — Validasi timing, likuiditas, AMM entry price, dynamic Kelly fraction
9. **Eksekusi** — Submit order ke Polymarket CLOB, arm TP/SL/trailing automation
10. **Correlated Entry** — Jika BTC diverge STRONG, otomatis enter ETH+SOL di arah sama
11. **Monitor** — TP/SL/trailing stop dicek setiap 3s; profit lock + spike capture aktif
12. **Learning** — Simpan pola loss dan win per aset, sesuaikan threshold

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

---

## Pressure Alignment Filter

Berdasarkan analisa 23 live trades:

| Order Book Signal | Win Rate | PnL Total | Keputusan |
|---|---|---|---|
| BUY_PRESSURE | **67%** | +$8.84 | ✅ Trade |
| NEUTRAL | 40% | -$1.55 | ✅ Trade |
| SELL_PRESSURE | 20% | -$7.64 | ❌ Block |

**Rule:**
- Trade UP (beli YES) → block jika YES book = `SELL_PRESSURE`
- Trade DOWN (beli NO) → block jika YES book = `BUY_PRESSURE`
- Kalau pressure berubah di cycle berikutnya → bot re-evaluasi otomatis

---

## Dynamic Kelly Fraction

Kelly fraction menyesuaikan diri dengan tingkat keyakinan AI (AGGRESSIVE mode):

| Confidence | Kelly Fraction | Keterangan |
|---|---|---|
| 65–74% | **25%** | Borderline signal, bet kecil |
| 75–84% | **50%** | Normal |
| 85–89% | **55%** | Signal kuat |
| ≥ 90% | **65%** | Sangat yakin |

CONSERVATIVE mode: flat 20%.

---

## TP/SL Strategy

### Target levels (per entry price zone)
| Entry | Take Profit | Stop Loss | Trailing |
|---|---|---|---|
| < 35¢ | entry +18¢ (max 68¢) | entry −10¢ | 7¢ |
| 35–49¢ | entry +14¢ (max 68¢) | entry −9¢ | 6¢ |
| 50–64¢ | entry +11¢ (max 74¢) | entry −9¢ | 5¢ |
| ≥ 65¢ | entry +8¢ (max 84¢) | entry −7¢ | 4¢ |

### Profit Lock
Saat unrealized gain ≥ 70% dari jarak TP → trailing stop dikencangkan ke **3¢** otomatis.
Contoh: entry 48¢, TP 62¢ (jarak 14¢) → saat harga 58¢+ → trailing 3¢ aktif.

### Spike Capture
Jika dalam **90 detik pertama** posisi naik **+8¢ atau lebih** → exit langsung.
Early spike di binary market hampir selalu mean-revert.

### Execution
- Monitor setiap **3 detik** (bukan 10s)
- TP terpicu → execute **langsung** (tidak tunggu bid)
- Tidak ada bid → fallback ke `ask × 0.97` (3¢ slippage tolerance)

---

## Correlated Multi-Asset Entry

Saat BTC STRONG divergence terpicu via Fast Path:

1. BTC trade dieksekusi normal
2. Bot langsung cek ETH dan SOL (parallel)
3. Jika market tersedia dan belum traded di window ini → enter di arah yang sama
4. Kelly fraction: 70% dari normal (signal adalah BTC-derived, bukan independent)
5. Confidence: 72% (sedikit lebih rendah dari BTC's 78)

---

## Auto-Calibrator

Toggle dari dashboard. Saat aktif, menjalankan backtest FastLoop di awal tiap window 5 menit:

| Win Rate | Tindakan |
|---|---|
| ≥ 65% | Signal bagus → minStrength=MODERATE, confDelta=−2% |
| 50–65% | Signal rata-rata → minStrength=MODERATE, confDelta=0% |
| < 50% | Signal lemah → minStrength=STRONG only, confDelta=+5% |

---

## Multi-Asset Support

| Aset | Slug Polymarket | Divergence STRONG | Divergence WEAK |
|---|---|---|---|
| BTC | `btc-updown-5m-*` | $100 dalam 30s | $30 |
| ETH | `eth-updown-5m-*` | $6 dalam 30s | $1.5 |
| SOL | `sol-updown-5m-*` | $2 dalam 30s | $0.4 |

```env
ENABLED_ASSETS=BTC,ETH,SOL   # default semua
ENABLED_ASSETS=BTC            # hanya BTC
```

---

## Heartbeat

Polymarket membatalkan semua open orders jika tidak menerima heartbeat dalam 10 detik.

Bot mengirim heartbeat setiap **5 detik** selama aktif. Chain ID di-track per request — jika 400 diterima, bot mengambil correct ID dari response dan melanjutkan chain tanpa reset.

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
POLYGON_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_FUNDER_ADDRESS=0x...
GEMINI_API_KEY=AIza...
```

### Bot Behavior

```env
ENABLED_ASSETS=BTC,ETH,SOL
BOT_MIN_CONFIDENCE=65
BOT_MIN_EDGE=0.10
BOT_KELLY_FRACTION=0.40
BOT_MAX_BET_USDC=250
BOT_SESSION_LOSS_LIMIT=0.30
BOT_AUTO_START=false
```

### Push Notifications (Opsional)

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
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

## Threshold Aktif

| Parameter | AGGRESSIVE | CONSERVATIVE |
|---|---|---|
| Min Confidence | 65% | 75% |
| Min Edge | 0.10¢ | 0.12¢ |
| Kelly Fraction | Dynamic (25–65%) | 20% flat |
| Max Bet | $250 | $50 |
| Session Loss Limit | 30% | 15% |
| TP/SL Monitor | 3 detik | 3 detik |

---

## Struktur Project

```
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── BotDashboard.tsx     # Dashboard kontrol bot
│   │   ├── BotLogSidebar.tsx    # Live log sidebar
│   │   └── CandlestickChart.tsx # Chart candlestick
│   ├── services/
│   │   └── gemini.ts            # AI analysis service
│   └── lib/
│       └── utils.ts
├── server.ts                    # Express backend — bot engine
├── data/
│   ├── loss_memory.json         # Adaptive learning state (persisted)
│   └── trade_log.jsonl          # Trade history log
├── vite.config.ts
└── .env.example
```

---

## Keamanan

- Private key adalah data paling sensitif — siapa pun yang punya ini bisa kontrol wallet
- Gunakan wallet **khusus trading bot**, bukan wallet utama
- Jika private key pernah bocor: segera pindahkan dana ke wallet baru
- Jangan pernah share, screenshot, atau upload `.env` ke mana pun

---

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Balance tidak muncul | Cek `POLYMARKET_SIGNATURE_TYPE` (0 atau 1) dan `POLYMARKET_FUNDER_ADDRESS` |
| Bot skip "No ask liquidity" | Sudah diperbaiki — bot pakai `outcomePrices` (AMM) |
| ETH/SOL candles kosong | Binance rate-limit — ter-cache otomatis di siklus berikutnya |
| AI fallback mode | Feed eksternal gagal — bot pakai data Polymarket saja |
| Error 500 sering | Isi `MONGODB_URI` untuk aktifkan cache internal |
| Heartbeat failed | Cek koneksi dan POLYGON_PRIVATE_KEY — L2 auth diperlukan |

---

## Scripts

```bash
npm run dev      # Jalankan server + frontend (development)
npm run build    # Build frontend untuk production
npm run preview  # Preview build production
npm run lint     # Type check TypeScript
```

---

## Disclaimer

Project ini dibuat untuk tujuan edukasi dan eksperimen trading. Perdagangan aset kripto dan prediction market mengandung risiko tinggi. Tidak ada jaminan profit. Gunakan dengan risiko sendiri.
