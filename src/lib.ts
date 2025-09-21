import fs from "fs";
import path from "path";

export const ROOT = process.cwd();

export type CryptoCfg = {
  symbol: string;
  pythSymbol?: string;
  coingeckoId?: string;
  coinpaprikaId?: string;
  defillamaChain?: string | null;
};

export type ForexCfg = {
  symbol: string;
  stooqPair: string;
};

export type RateCfg = {
  symbol: string;
  fredId: string;
};

export type MacroSeries = { id: string; name?: string };

export type Config = {
  crypto?: CryptoCfg[];
  forex?: ForexCfg[];
  rates?: RateCfg[];
  macro?: { series: MacroSeries[] };
};

export function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function toCSV(rows: Record<string, any>[], headers?: string[]): string {
  if (!rows || rows.length === 0) return "";
  let cols: string[];
  if (headers?.length) cols = headers.slice();
  else {
    const set = new Set<string>();
    for (const r of rows) Object.keys(r).forEach((k) => set.add(k));
    cols = Array.from(set).sort((a, b) =>
      a === "date" ? -1 : b === "date" ? 1 : a.localeCompare(b),
    );
  }
  const esc = (v: any) => {
    if (v == null) return "";
    const s = String(v);
    return /"|,|\n|\r/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(",")),
  ].join("\n");
}

export function writeCSV(
  dir: string,
  filename: string,
  rows: any[],
  headers: string[],
) {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, filename), toCSV(rows, headers));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchJSON<T = any>(
  url: string,
  init?: RequestInit,
  retries = 5,
  baseDelay = 600,
): Promise<T> {
  let last: any;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "iyield-research/1.0",
          ...(init?.headers ?? {}),
        },
        ...init,
      });
      if (res.ok) return res.json() as Promise<T>;
      const st = res.status;
      const ra = res.headers.get("retry-after");
      if ([429, 500, 502, 503, 504].includes(st)) {
        const wait = ra
          ? parseFloat(ra) * 1000
          : baseDelay * Math.pow(2, i) + Math.random() * 400;
        await sleep(wait);
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${st} - ${body.slice(0, 200)}`);
    } catch (e) {
      last = e;
      await sleep(baseDelay * Math.pow(2, i) + Math.random() * 200);
    }
  }
  throw new Error(`Failed fetch after retries: ${url} :: ${String(last)}`);
}

export async function fredSeries(seriesId: string, apiKey: string) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json`;
  const data = await fetchJSON<any>(url);
  const obs = data.observations ?? [];
  return obs
    .map((o: any) => ({
      date: o.date,
      value: o.value,
      source: "fred",
      series: seriesId,
    }))
    .sort((a: any, b: any) => a.date.localeCompare(b.date));
}

export function readConfig(configRelPath = "src/config.json"): Config {
  const configPath = path.join(ROOT, configRelPath);
  if (!fs.existsSync(configPath))
    throw new Error(`Config not found: ${configPath}`);
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
}
