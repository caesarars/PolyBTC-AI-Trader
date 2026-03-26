# PolyBTC AI Trader

Bot dashboard untuk:
- scan market BTC 5 menit di Polymarket
- kasih analisa AI
- place trade
- track order
- lihat open positions, PnL, winrate
- set take profit / stop loss dari UI

## Yang Perlu Disiapkan

Sebelum jalanin project ini, kamu butuh:
- `Node.js`
- akun `Polymarket`
- wallet Polygon yang dipakai untuk akun Polymarket
- `Gemini API key`

## Install

1. Install dependency

```bash
npm install
```

2. Copy file env example

```bash
copy .env.example .env
```

3. Isi `.env`

4. Jalankan app

```bash
npm run dev
```

## Tutorial Isi `.env` Untuk Orang Awam

File `.env` itu tempat nyimpen data rahasia dan konfigurasi.

Jangan pernah share file `.env` ke orang lain.
Jangan commit file `.env` ke GitHub.

Format dasarnya seperti ini:

```env
POLYGON_PRIVATE_KEY=...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_FUNDER_ADDRESS=...
POLYGON_RPC_URLS=https://1rpc.io/matic,https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org
GEMINI_API_KEY=...
```

Di bawah ini penjelasan satu-satu.

### 1. `POLYGON_PRIVATE_KEY`

Ini private key wallet Polygon yang dipakai untuk sign request ke Polymarket.

Contoh:

```env
POLYGON_PRIVATE_KEY=0xabc123...
```

Cara ambil:
- buka wallet kamu yang dipakai untuk Polymarket
- cari menu `Export Private Key`
- copy private key itu ke `.env`

Penting:
- ini data paling sensitif
- siapa pun yang punya ini bisa ambil alih wallet kamu
- jangan screenshot
- jangan kirim ke chat
- jangan upload ke GitHub

### 2. `POLYMARKET_API_KEY`
### 3. `POLYMARKET_API_SECRET`
### 4. `POLYMARKET_API_PASSPHRASE`

Tiga nilai ini adalah credential API dari akun Polymarket kamu.

Kalau project gagal pakai nilai lama, backend project ini akan coba derive key lagi otomatis dari wallet signer. Tapi tetap lebih bagus kalau kamu isi dengan benar.

Cara ambil untuk orang awam:
- login ke akun Polymarket kamu
- buka bagian API / developer credentials kalau tersedia
- kalau kamu tidak punya key manual, biasanya app ini tetap bisa derive dari wallet yang benar

Kalau kamu sudah punya:

```env
POLYMARKET_API_KEY=your_key
POLYMARKET_API_SECRET=your_secret
POLYMARKET_API_PASSPHRASE=your_passphrase
```

### 5. `POLYMARKET_SIGNATURE_TYPE`

Ini penanda tipe akun Polymarket kamu.

Nilai yang umum:
- `0` = wallet EOA biasa
- `1` = profile / proxy wallet Polymarket

Kalau kamu pakai profile address Polymarket dan balance yang benar baru kebaca saat signature type `1`, isi:

```env
POLYMARKET_SIGNATURE_TYPE=1
```

Kalau salah isi:
- balance bisa kebaca salah
- order bisa gagal
- funder address bisa tidak sinkron

### 6. `POLYMARKET_FUNDER_ADDRESS`

Ini address profile Polymarket kamu.

Sering beda dengan address wallet signer.

Contoh:

```env
POLYMARKET_FUNDER_ADDRESS=0x1234...
```

Cara lihat:
- login ke `polymarket.com`
- buka settings / profile
- cari profile address atau funder address

Kalau balance di profile Polymarket kamu beda dengan balance wallet, biasanya kamu wajib isi field ini.

### 7. `POLYGON_RPC_URLS`

Ini daftar RPC Polygon yang dipakai backend untuk baca blockchain.

Default aman:

```env
POLYGON_RPC_URLS=https://1rpc.io/matic,https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org
```

Kalau satu RPC mati, app akan coba fallback ke yang lain.

Biasanya tidak perlu diubah kalau kamu tidak tahu ini apa.

### 8. `GEMINI_API_KEY`

Ini API key untuk fitur analisa AI.

Cara ambil:
- buka Google AI Studio
- buat API key
- copy hasilnya ke `.env`

Contoh:

```env
GEMINI_API_KEY=AIza...
```

Kalau kosong:
- app tetap bisa buka dashboard
- tapi analisa AI tidak akan jalan

## Contoh `.env`

Ini contoh bentuk file yang benar:

```env
# Polymarket CLOB Credentials
POLYGON_PRIVATE_KEY=0xyour_polygon_private_key
POLYMARKET_API_KEY=your_polymarket_api_key
POLYMARKET_API_SECRET=your_polymarket_api_secret
POLYMARKET_API_PASSPHRASE=your_polymarket_api_passphrase
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_FUNDER_ADDRESS=0xyour_polymarket_profile_or_funder_address
POLYGON_RPC_URLS=https://1rpc.io/matic,https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org

# Gemini API Key
GEMINI_API_KEY=your_gemini_api_key
```

## Cara Cek `.env` Sudah Benar

Setelah isi `.env`, jalankan:

```bash
npm run dev
```

Lalu cek di dashboard:
- `Trading Balance` muncul
- market BTC aktif muncul
- order book muncul
- analisa AI bisa jalan

Kalau balance salah:
- cek `POLYMARKET_FUNDER_ADDRESS`
- cek `POLYMARKET_SIGNATURE_TYPE`

Kalau trade gagal auth:
- cek `POLYGON_PRIVATE_KEY`
- cek API key Polymarket

Kalau analisa AI gagal:
- cek `GEMINI_API_KEY`

## Fitur Yang Sudah Ada

- BTC 5-minute market scanner
- AI analysis
- Polymarket order tracker
- trade history
- winrate
- realized PnL
- open positions
- unrealized ROI
- take profit / stop loss

## Catatan Keamanan

- `.env` jangan di-upload ke GitHub
- private key jangan dibagikan
- kalau private key pernah bocor, segera pindahkan dana ke wallet baru
- lebih aman pakai wallet khusus untuk trading bot, jangan wallet utama

## Troubleshooting Singkat

### Balance salah

Cek:
- `POLYMARKET_SIGNATURE_TYPE`
- `POLYMARKET_FUNDER_ADDRESS`

### Order `OPEN` tapi tidak fill

Artinya:
- order sudah live di exchange
- tapi belum ada lawan transaksi di harga kamu

### `Trade terlalu kecil`

Artinya:
- market punya minimum share size
- amount USDC kamu masih di bawah minimum untuk limit price itu

### AI fallback mode

Artinya:
- feed BTC eksternal gagal
- analisa masih jalan pakai data Polymarket saja
- confidence sebaiknya dianggap lebih konservatif
