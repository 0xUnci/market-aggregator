# Market Data Collector & Google Sheets Integration

This project collects **financial and macroeconomic data** from multiple public sources (FRED, Stooq, DeFiLlama, Pyth, CoinGecko, CoinPaprika, etc.) and exports them into **CSV** files, organized by asset.
Additionally, it can synchronize the CSVs into a **Google Spreadsheet**, each dataset in a dedicated tab.

## ⚙️ Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Environment variables
Create a `.env` file in the root:
```bash
FRED_API_KEY=your_fred_api_key
COINGECKO_API_KEY=optional_demo_key
GOOGLE_SERVICE_ACCOUNT_JSON=path_to_service_account.json
SPREADSHEET_ID=your_google_sheet_id
```

### 3. Configure `config.json`
Example:
```json
{
  "crypto": [
    { "symbol": "BTC", "pythSymbol": "Crypto.BTC/USD", "coingeckoId": "bitcoin", "defillamaChain": "bitcoin" },
    { "symbol": "ETH", "pythSymbol": "Crypto.ETH/USD", "coingeckoId": "ethereum", "defillamaChain": "ethereum" }
  ],
  "forex": [
    { "symbol": "EUR", "stooqPair": "eurusd" },
    { "symbol": "JPY", "stooqPair": "jpyusd" }
  ],
  "rates": [
    { "symbol": "EFFR", "fredId": "EFFR" },
    { "symbol": "SOFR", "fredId": "SOFR" },
    { "symbol": "DGS10", "fredId": "DGS10" }
  ],
  "macro": {
    "series": [
      { "id": "GDP", "name": "US GDP" },
      { "id": "CPIAUCSL", "name": "CPI" }
    ]
  }
}
```

---

## ▶️ Run collectors

Each collector is independent:

```bash
npx ts-node src/update-crypto.ts   # Crypto prices + market cap + TVL
npx ts-node src/update-forex.ts    # Forex
npx ts-node src/update-rates.ts    # Interest rates
npx ts-node src/update-macro.ts    # Macroeconomic series
```

---

## 🔄 Google Sheets Integration

The `sync-to-sheets.ts` script uploads CSVs to a **single Google Sheet**, one tab per dataset.

### Setup
1. Create a **Google Cloud Project** and enable **Google Sheets API**.
2. Create a **Service Account** and download its JSON key.
3. Share the target Google Sheet with the Service Account email.
4. Set the following environment variables in `.env`:
   ```bash
   GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json
   SPREADSHEET_ID=your_sheet_id
   ```

### Run sync
```bash
npm run sync
```

This will push all CSVs in `data/` and `macro/` into the configured Google Sheet.

---

## 📖 Sources

- **Stooq** → equities & FX (free) (https://stooq.com/db/h/)
- **Pyth** → crypto OHLCV, FX, some rates (https://benchmarks.pyth.network/docs#/Updates/price_updates_timestamp_route_v1_updates_price__timestamp__ge)
- **CoinGecko / CoinPaprika** → crypto market caps (https://docs.coinpaprika.com/) (https://docs.coingecko.com/v3.0.1/reference/endpoint-overview)
- **DeFiLlama** → chain-level TVL data (https://api-docs.defillama.com/)
- **FRED** → macroeconomic data & interest rates (https://fred.stlouisfed.org/docs/api/fred/)

---

## ✅ Notes

- CoinPaprika free plan allows only 1y history → fallback to CoinGecko for longer history.
- Google Sheets integration overwrites sheets each run (static tab names).
- Use logging to monitor skipped or missing datasets.
