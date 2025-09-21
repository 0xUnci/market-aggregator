import "dotenv/config";
import path from "path";
import { ROOT, readConfig, ensureDir, writeCSV, fredSeries } from "../lib";

async function run() {
  const cfg = readConfig();
  const OUT_DIR = path.join(ROOT, "data");
  ensureDir(OUT_DIR);

  const fredKey = process.env.FRED_API_KEY || "";
  if (!fredKey) {
    console.warn("FRED disabled: FRED_API_KEY missing in .env");
    process.exit(0);
  }

  for (const r of cfg.rates || []) {
    const dir = path.join(OUT_DIR, `RATE_${r.symbol.toUpperCase()}`);
    ensureDir(dir);
    try {
      const rows = await fredSeries(r.fredId, fredKey);
      if (rows.length) {
        writeCSV(dir, "prices.csv", rows, [
          "date",
          "value",
          "series",
          "source",
        ]);
        console.log(
          `✓ RATE ${r.symbol} (${r.fredId}) -> prices.csv (${rows.length} rows)`,
        );
      } else {
        console.warn(`— No FRED data for ${r.symbol} (${r.fredId})`);
      }
    } catch (e: any) {
      console.warn(`FRED fail ${r.symbol} (${r.fredId}): ${e.message}`);
    }
  }

  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
