import "dotenv/config";
import path from "path";
import {
  ROOT,
  readConfig,
  ensureDir,
  writeCSV,
  fetchJSON,
  sleep,
} from "../lib";

async function pythDaily(pythSymbol: string, fromTs?: number, toTs?: number) {
  const base = "https://benchmarks.pyth.network/v1/shims/tradingview/history";
  const resolution = "D";
  const startDefault = Math.floor(
    new Date("2018-01-01T00:00:00Z").getTime() / 1000,
  );
  const start = fromTs ?? startDefault;
  const end = toTs ?? Math.floor(Date.now() / 1000);
  const oneYear = 365 * 24 * 60 * 60;
  const rows: any[] = [];
  let seen = false;

  for (let from = start; from < end; ) {
    const to = Math.min(from + oneYear, end);
    const url = `${base}?symbol=${encodeURIComponent(pythSymbol)}&resolution=${resolution}&from=${from}&to=${to}`;
    const data = await fetchJSON<any>(url, undefined, 5, 700);
    if (data?.s === "ok" && Array.isArray(data.t) && data.t.length) {
      seen = true;
      const { t, o, h, l, c, v } = data;
      for (let i = 0; i < t.length; i++) {
        const date = new Date(t[i] * 1000).toISOString().slice(0, 10);
        rows.push({
          date,
          open: o?.[i] ?? "",
          high: h?.[i] ?? "",
          low: l?.[i] ?? "",
          close: c?.[i] ?? "",
          volume: v?.[i] ?? "",
          source: "pyth",
        });
      }
    }
    await sleep(120);
    from = to;
  }
  if (!seen) {
    console.warn(`Pyth no_data: ${pythSymbol}`);
  }

  const map = new Map<string, any>();
  for (const r of rows) map.set(r.date, r);
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function defillamaCoinMarketCapLastYearByCG(coingeckoId: string) {
  const url = `https://coins.llama.fi/chart/coingecko:${encodeURIComponent(coingeckoId)}`;
  const raw = await fetchJSON<any>(url, undefined, 5, 700);
  let points: any[] = [];
  if (Array.isArray(raw)) points = raw;
  else if (Array.isArray(raw?.points)) points = raw.points;
  else if (Array.isArray(raw?.prices)) points = raw.prices;
  else if (raw?.coins && raw.coins[`coingecko:${coingeckoId}`]) {
    const c = raw.coins[`coingecko:${coingeckoId}`];
    points = Array.isArray(c) ? c : Array.isArray(c?.prices) ? c.prices : [];
  }
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const rows = points
    .map((p: any) => {
      const ts = p.timestamp ?? p.time ?? p.t ?? p[0];
      const mcap = p.mcap ?? p.market_cap ?? p.marketCap ?? p[2];
      if (!ts || mcap == null || Number(ts) < oneYearAgo) return null;
      return {
        date: new Date(Number(ts)).toISOString().slice(0, 10),
        market_cap_usd: mcap,
        source: "defillama_coins",
      };
    })
    .filter(Boolean) as any[];
  const map = new Map<string, any>();
  for (const r of rows) map.set(r.date, r);
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function toUtcMidnight(d = new Date()) {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
function sec(ts: number) {
  return Math.floor(ts / 1000);
}
async function coinpaprikaMarketCapLastYear(coinId: string, days = 360) {
  const endDate = toUtcMidnight(new Date());
  let windowDays = Math.min(Math.max(days, 300), 364);
  let attempts = [0, 7, 14];

  for (const reduce of attempts) {
    const actualDays = windowDays - reduce;
    const end = sec(endDate.getTime());
    const start = end - actualDays * 86400 + 60;

    const url = `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(coinId)}/historical?start=${start}&end=${end}&interval=1d&quote=usd`;

    try {
      const data = await fetchJSON<any[]>(url, undefined, 5, 800);
      const rows = (data || [])
        .map((d) => {
          const date = (d.timestamp || "").slice(0, 10);
          if (!date) return null;
          return {
            date,
            market_cap_usd: d.market_cap ?? "",
            source: "coinpaprika",
          };
        })
        .filter(Boolean) as any[];

      const map = new Map<string, any>();
      for (const r of rows) if (r.market_cap_usd !== "") map.set(r.date, r);
      const out = Array.from(map.values()).sort((a, b) =>
        a.date.localeCompare(b.date),
      );

      if (out.length === 0) {
        console.warn(`CoinPaprika empty window ${coinId} (${actualDays}d)`);
      }
      return out;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("HTTP 402")) {
        console.warn(
          `CoinPaprika 402 ${coinId} (${actualDays}d), retry shrinking window...`,
        );
        continue;
      }
      throw e;
    }
  }

  throw new Error(`CoinPaprika failed after shrink attempts for ${coinId}`);
}
async function coingeckoMarketCap(id: string, apiKey?: string, days = 365) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`;
  const data = await fetchJSON<any>(url, { headers }, 5, 700);
  const mktcaps: [number, number][] = data.market_caps ?? [];
  return mktcaps
    .map(([ts, mc]) => ({
      date: new Date(ts).toISOString().slice(0, 10),
      market_cap_usd: mc,
      source: "coingecko",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function defillamaChainHistoricalExcl(chainSlug: string) {
  const url = `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chainSlug)}`;
  const data = await fetchJSON<any[]>(url);
  return (data || [])
    .map((p: any) => ({
      date: new Date(p.date * 1000).toISOString().slice(0, 10),
      tvl_usd: p.tvl,
      source: "defillama_v2",
      chain: chainSlug,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
async function defillamaChainCharts(chainSlug: string) {
  const url = `https://api.llama.fi/charts/${encodeURIComponent(chainSlug)}`;
  const data = await fetchJSON<any[]>(url);
  return (data || [])
    .map((p: any) => ({
      date: new Date(p.date * 1000).toISOString().slice(0, 10),
      tvl_usd: p.totalLiquidityUSD ?? p.tvl ?? p.totalLiquidityUsd,
      source: "defillama_charts",
      chain: chainSlug,
    }))
    .filter((r) => r.tvl_usd !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function run() {
  const cfg = readConfig();
  const OUT_DIR = path.join(ROOT, "data");
  ensureDir(OUT_DIR);
  const cgKey = process.env.COINGECKO_API_KEY || "";

  for (const c of cfg.crypto || []) {
    const dir = path.join(OUT_DIR, c.symbol.toUpperCase());
    ensureDir(dir);

    if (c.pythSymbol) {
      try {
        const px = await pythDaily(c.pythSymbol);
        if (px.length) {
          writeCSV(dir, "prices.csv", px, [
            "date",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "source",
          ]);
          console.log(`✓ ${c.symbol} -> prices.csv (${px.length} rows)`);
        } else {
          console.warn(`— No price for ${c.symbol} (${c.pythSymbol})`);
        }
      } catch (e: any) {
        console.warn(`Pyth fail ${c.symbol}: ${e.message}`);
      }
    }

    let wrote = false;
    if (c.coingeckoId) {
      try {
        const mc1 = await defillamaCoinMarketCapLastYearByCG(c.coingeckoId);
        if (mc1.length && mc1.some((r) => Number(r.market_cap_usd) > 0)) {
          writeCSV(dir, "marketcap.csv", mc1, [
            "date",
            "market_cap_usd",
            "source",
          ]);
          console.log(
            `✓ ${c.symbol} -> marketcap.csv (DeFiLlama coins, ${mc1.length} rows)`,
          );
          wrote = true;
        }
      } catch (e: any) {
        console.warn(`DefiLlama coins fail ${c.coingeckoId}: ${e.message}`);
      }
    }
    if (!wrote && c.coinpaprikaId) {
      try {
        const mc2 = await coinpaprikaMarketCapLastYear(c.coinpaprikaId);
        if (mc2.length && mc2.some((r) => Number(r.market_cap_usd) > 0)) {
          writeCSV(dir, "marketcap.csv", mc2, [
            "date",
            "market_cap_usd",
            "source",
          ]);
          console.log(
            `✓ ${c.symbol} -> marketcap.csv (CoinPaprika, ${mc2.length} rows)`,
          );
          wrote = true;
        }
      } catch (e: any) {
        console.warn(`CoinPaprika fail ${c.coinpaprikaId}: ${e.message}`);
      }
    }
    if (!wrote && c.coingeckoId) {
      try {
        const mc3 = await coingeckoMarketCap(c.coingeckoId, cgKey, 365);
        if (mc3.length && mc3.some((r) => Number(r.market_cap_usd) > 0)) {
          writeCSV(dir, "marketcap.csv", mc3, [
            "date",
            "market_cap_usd",
            "source",
          ]);
          console.log(
            `✓ ${c.symbol} -> marketcap.csv (CoinGecko, ${mc3.length} rows)`,
          );
          wrote = true;
        } else {
          console.warn(`CoinGecko market cap all zero for ${c.symbol}`);
        }
      } catch (e: any) {
        console.warn(`CoinGecko fail ${c.coingeckoId}: ${e.message}`);
      }
    }

    if (c.defillamaChain) {
      try {
        const excl = await defillamaChainHistoricalExcl(c.defillamaChain);
        if (excl.length) {
          writeCSV(dir, "chain_tvl_excl.csv", excl, [
            "date",
            "tvl_usd",
            "chain",
            "source",
          ]);
          console.log(
            `✓ ${c.symbol} -> chain_tvl_excl.csv (${excl.length} rows)`,
          );
        }
      } catch (e: any) {
        console.warn(`DefiLlama v2 fail ${c.defillamaChain}: ${e.message}`);
      }
      try {
        const charts = await defillamaChainCharts(c.defillamaChain);
        if (charts.length) {
          writeCSV(dir, "chain_tvl.csv", charts, [
            "date",
            "tvl_usd",
            "chain",
            "source",
          ]);
          console.log(`✓ ${c.symbol} -> chain_tvl.csv (${charts.length} rows)`);
        }
      } catch (e: any) {
        console.warn(`DefiLlama charts fail ${c.defillamaChain}: ${e.message}`);
      }
    }
  }

  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
