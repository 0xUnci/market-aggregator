import "dotenv/config";
import fs from "fs";
import path from "path";
import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
const ROOTS = (process.env.SYNC_ROOTS || "data,macro")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!SHEET_ID) {
  console.error("Missing GOOGLE_SHEET_ID in .env");
  process.exit(1);
}
if (!CREDENTIALS || !fs.existsSync(CREDENTIALS)) {
  console.error("Missing/invalid GOOGLE_APPLICATION_CREDENTIALS path in .env");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function listCsvFiles(roots: string[]): string[] {
  const out: string[] = [];
  const visit = (p: string) => {
    if (!fs.existsSync(p)) return;
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      for (const f of fs.readdirSync(p)) visit(path.join(p, f));
    } else if (s.isFile() && p.toLowerCase().endsWith(".csv")) {
      out.push(p);
    }
  };
  roots.forEach((r) => visit(path.resolve(r)));
  return out.sort();
}

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0,
    field = "",
    row: string[] = [],
    inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        i++;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i++;
        continue;
      }
      if (ch === "\r") {
        i++;
        continue;
      }
      field += ch;
      i++;
    }
  }
  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) rows.push(row);
  return rows;
}

function tabNameFromPath(p: string, roots: string[]): string {
  const abs = path.resolve(p);
  let rel = abs;
  for (const r of roots.map((x) => path.resolve(x))) {
    if (abs.startsWith(r + path.sep)) {
      rel = abs.slice(r.length + 1);
      break;
    }
  }
  rel = rel.replace(/\\/g, "/").replace(/\.csv$/i, "");
  const parts = rel.split("/");
  if (parts[0] === "data" || parts[0] === "macro") parts.shift();
  const name = parts.join("_").replace(/[^A-Za-z0-9_\-\.]/g, "_");
  return `DATA_${name.slice(0, 90) || "Sheet"}`;
}

const BASE_DELAY_MS = 700;
const MAX_RETRIES = 6;
const BETWEEN_WRITES_MS = Number(process.env.SHEETS_THROTTLE_MS || 1200);
const MAX_CELLS_PER_UPDATE = Number(process.env.SHEETS_MAX_CELLS || 40000);
const GRID_ROW_BUFFER = Number(process.env.SHEETS_GRID_ROW_BUFFER || 200);
const GRID_COL_BUFFER = Number(process.env.SHEETS_GRID_COL_BUFFER || 5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimitedError(e: any) {
  const code = e?.code || e?.response?.status;
  const reason =
    e?.errors?.[0]?.reason ||
    e?.response?.data?.error?.errors?.[0]?.reason ||
    e?.response?.data?.error?.status;
  return (
    code === 429 ||
    code === 503 ||
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded"
  );
}
function getRetryAfterMs(e: any, attempt: number) {
  const hdr =
    e?.response?.headers?.["retry-after"] ||
    e?.response?.headers?.["Retry-After"];
  if (hdr) {
    const seconds = parseFloat(String(hdr));
    if (!Number.isNaN(seconds)) return Math.max(1000, seconds * 1000);
  }
  return BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
}
async function gcall<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const out = await fn();
      if (BETWEEN_WRITES_MS) await sleep(BETWEEN_WRITES_MS);
      return out;
    } catch (e: any) {
      lastErr = e;
      if (isRateLimitedError(e)) {
        const wait = getRetryAfterMs(e, i);
        console.warn(`Sheets rate-limit: retry in ${Math.round(wait)}ms`);
        await sleep(wait);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

type SheetInfo = { id: number; title: string; rows: number; cols: number };

async function getSheetsInfo(
  spreadsheetId: string,
): Promise<Record<string, SheetInfo>> {
  const resp = await gcall(() => sheets.spreadsheets.get({ spreadsheetId }));
  const map: Record<string, SheetInfo> = {};
  resp.data.sheets?.forEach((s) => {
    const title = s.properties?.title!;
    const sid = s.properties?.sheetId!;
    const rows = s.properties?.gridProperties?.rowCount ?? 1000;
    const cols = s.properties?.gridProperties?.columnCount ?? 26;
    map[title] = { id: sid, title, rows, cols };
  });
  return map;
}

async function deleteDataSheets(
  spreadsheetId: string,
  info: Record<string, SheetInfo>,
) {
  const toDelete = Object.values(info)
    .filter((x) => x.title.startsWith("DATA_"))
    .map((x) => x.id);
  if (toDelete.length === 0) return;
  await gcall(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toDelete.map((sid) => ({ deleteSheet: { sheetId: sid } })),
      },
    }),
  );
  console.log(`Deleted ${toDelete.length} DATA_ sheets`);
}

async function ensureSheet(
  spreadsheetId: string,
  title: string,
  info: Record<string, SheetInfo>,
): Promise<SheetInfo> {
  if (info[title]) return info[title];
  const req = await gcall(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    }),
  );
  const added = req.data.replies?.[0]?.addSheet?.properties;
  if (!added?.sheetId) throw new Error(`Failed to create sheet '${title}'`);
  const newInfo: SheetInfo = {
    id: added.sheetId,
    title,
    rows: added.gridProperties?.rowCount ?? 1000,
    cols: added.gridProperties?.columnCount ?? 26,
  };
  info[title] = newInfo;
  return newInfo;
}

async function ensureGridSize(
  spreadsheetId: string,
  sheet: SheetInfo,
  needRows: number,
  needCols: number,
  infoMap: Record<string, SheetInfo>,
) {
  const rows = Math.max(sheet.rows, needRows + GRID_ROW_BUFFER);
  const cols = Math.max(sheet.cols, needCols + GRID_COL_BUFFER);
  if (rows === sheet.rows && cols === sheet.cols) return;

  await gcall(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheet.id,
                gridProperties: { rowCount: rows, columnCount: cols },
              },
              fields: "gridProperties(rowCount,columnCount)",
            },
          },
        ],
      },
    }),
  );
  sheet.rows = rows;
  sheet.cols = cols;
  infoMap[sheet.title] = sheet;
}

async function clearSheet(spreadsheetId: string, title: string) {
  await gcall(() =>
    sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${title}!A:ZZZ`,
    }),
  );
}

function chunkRowsByCellBudget(rows: string[][], maxCells: number) {
  if (!rows.length) return [];
  const cols = rows[0].length || 1;
  const rowsPerChunk = Math.max(1, Math.floor(maxCells / Math.max(cols, 1)));
  if (rows.length <= rowsPerChunk) return [rows];
  const out: string[][][] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    out.push(rows.slice(i, i + rowsPerChunk));
  }
  return out;
}

async function writeRowsSmart(
  spreadsheetId: string,
  title: string,
  rows: string[][],
) {
  const totalCells = rows.length * (rows[0]?.length || 1);
  if (totalCells <= MAX_CELLS_PER_UPDATE) {
    await gcall(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: rows },
      }),
    );
    return;
  }
  const chunks = chunkRowsByCellBudget(rows, MAX_CELLS_PER_UPDATE);
  let startRow = 1;
  for (const slice of chunks) {
    const range = `${title}!A${startRow}`;
    await gcall(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: slice },
      }),
    );
    startRow += slice.length;
  }
}

async function autoResize(
  spreadsheetId: string,
  sheetId: number,
  colCount = 26,
) {
  await gcall(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: colCount,
              },
            },
          },
        ],
      },
    }),
  );
}

async function main() {
  console.log(`Scanning roots: ${ROOTS.join(", ")}`);
  const files = listCsvFiles(ROOTS);
  if (files.length === 0) {
    console.log("No CSV found. Nothing to sync.");
    return;
  }

  let info = await getSheetsInfo(SHEET_ID);
  await deleteDataSheets(SHEET_ID, info);
  info = await getSheetsInfo(SHEET_ID); // refresh

  for (const file of files) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const rows = parseCSV(text);
      if (!rows.length) {
        console.warn(`Skip empty CSV: ${file}`);
        continue;
      }

      const title = tabNameFromPath(file, ROOTS);
      const sheet = await ensureSheet(SHEET_ID, title, info);

      const needRows = rows.length;
      const needCols = rows[0]?.length ?? 1;
      await ensureGridSize(SHEET_ID, sheet, needRows, needCols, info);

      await clearSheet(SHEET_ID, title);
      await writeRowsSmart(SHEET_ID, title, rows);
      await autoResize(SHEET_ID, sheet.id, Math.min(Math.max(needCols, 3), 50));

      console.log(`✓ Synced '${file}' -> tab '${title}' (${rows.length} rows)`);
    } catch (e: any) {
      console.warn(`Failed sync for ${file}: ${e.message}`);
    }
  }

  console.log("Sync completed.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
