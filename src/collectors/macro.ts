import "dotenv/config";
import path from "path";
import { ROOT, readConfig, ensureDir, writeCSV, fredSeries } from "../lib";

async function run() {
  const cfg = readConfig();
  const OUT_DIR = path.join(ROOT, "macro");
  ensureDir(OUT_DIR);

  const fredKey = process.env.FRED_API_KEY || "";
  if (!fredKey) {
    console.warn("FRED disabled: FRED_API_KEY missing in .env");
    return;
  }

  for (const s of cfg.macro?.series || []) {
    try {
      const rows = await fredSeries(s.id, fredKey);
      if (rows.length) {
        writeCSV(OUT_DIR, `fred_${s.id}.csv`, rows, [
          "date",
          "value",
          "series",
          "source",
        ]);
        console.log(`✓ macro -> fred_${s.id}.csv (${rows.length} rows)`);
      } else {
        console.warn(`— No FRED data for ${s.id}`);
      }
    } catch (e: any) {
      console.warn(`FRED fail ${s.id}: ${e.message}`);
    }
  }

  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
