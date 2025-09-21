import "dotenv/config";
import path from "path";
import { ROOT, readConfig, ensureDir, writeCSV } from "../lib";

async function stooqFxDaily(pairLower: string) {
  const url = `https://stooq.pl/q/d/l/?s=${encodeURIComponent(pairLower)}&i=d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stooq FX HTTP ${res.status} for ${pairLower}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length <= 1) return [];
  lines.shift();
  const rows = lines
    .map((l) => {
      const [date, open, high, low, close, volume] = l.split(",");
      return { date, open, high, low, close, volume, source: "stooq_fx" };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function run() {
  const cfg = readConfig();
  const OUT_DIR = path.join(ROOT, "data");
  ensureDir(OUT_DIR);

  for (const f of cfg.forex || []) {
    const dir = path.join(OUT_DIR, `FX_${f.symbol.toUpperCase()}`);
    ensureDir(dir);
    try {
      const rows = await stooqFxDaily(f.stooqPair.toLowerCase());
      if (rows.length) {
        writeCSV(dir, "prices.csv", rows, [
          "date",
          "open",
          "high",
          "low",
          "close",
          "volume",
          "source",
        ]);
        console.log(`✓ FX ${f.symbol} -> prices.csv (${rows.length} rows)`);
      } else {
        console.warn(`— No FX data for ${f.symbol} (pair: ${f.stooqPair})`);
      }
    } catch (e: any) {
      console.warn(`Stooq FX fail ${f.symbol} (${f.stooqPair}): ${e.message}`);
    }
  }

  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
