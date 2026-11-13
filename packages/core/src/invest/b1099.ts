/**
 * Reading a broker's 1099-B. Three ways in, most exact first:
 *
 * - TXF, the Tax Exchange Format most brokers offer for tax software (V042):
 *   one record per sale, `TD`, `N<ref>` (the Form 8949 box and term), `P`
 *   description, `D` acquired, `D` sold, `$` cost, `$` net proceeds and an
 *   optional `$` wash sale loss disallowed, ended by `^`.
 * - A CSV of the sales (what most brokers call "1099-B detail" or "realized
 *   gain/loss"): columns found by their headers.
 * - The PDF itself: only the summary totals per box, read from the text and
 *   kept only when the numbers add up (proceeds − cost + adjustments = gain).
 *
 * Pure functions; nothing here touches the network or the database.
 */
import {
  type B1099Sale,
  type B1099Summary,
  type B1099Totals,
  boxTerm,
  type Form8949Box,
  type TaxTerm,
} from "@muny/shared";
import { parseCsv } from "../import/csv.js";
import { termOn } from "./lots.js";

/** "$1,234.56", "-12.3", "(45.00)" → cents; null when it isn't money. */
export function moneyCents(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let s = raw.trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  const m = s.match(/^(\d+)(?:\.(\d{0,2})\d*)?$/);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return neg ? -cents : cents;
}

/** MM/DD/YYYY, M/D/YY or YYYY-MM-DD → YYYY-MM-DD; null for "Various", blanks and anything else. */
export function taxDate(raw: string | undefined | null): string | null {
  const s = (raw ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${(m[2] as string).padStart(2, "0")}-${(m[3] as string).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const y = (m[3] as string).length === 2 ? `20${m[3]}` : (m[3] as string);
  return `${y}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
}

const NOT_TICKER = new Set(["SH", "SH.", "SHS", "SHARES", "SHARE", "OF", "UNITS", "CL", "CLASS"]);

/** "100 sh. AAPL", "50 QCOM", "12.5 SHARES OF VTI", "APPLE INC (AAPL)" → shares and ticker. */
export function describeSale(desc: string): { symbol: string | null; quantity: string | null } {
  const paren = desc.match(/\(([A-Z][A-Z0-9.-]{0,9})\)/);
  const tokens = desc.replace(/,/g, "").trim().split(/\s+/);
  const qty = tokens.find((t) => /^\d+(\.\d+)?$/.test(t)) ?? null;
  if (paren) return { symbol: paren[1] ?? null, quantity: qty };
  const rest = tokens.filter((t) => t !== qty && !NOT_TICKER.has(t.toUpperCase()));
  const only = rest.length === 1 ? (rest[0] as string) : null;
  return {
    symbol: only && /^[A-Z][A-Z0-9.-]{0,9}$/.test(only) ? only : null,
    quantity: qty,
  };
}

const TXF_BOX: Record<string, Form8949Box> = {
  "321": "A",
  "711": "B",
  "712": "C",
  "323": "D",
  "713": "E",
  "714": "F",
};

/** A TXF file's sales; null when the text isn't TXF. */
export function parseTxf(text: string): B1099Sale[] | null {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim());
  const first = lines.find((l) => l);
  if (!first || !/^V0\d\d/.test(first) || !lines.includes("^")) return null;
  const out: B1099Sale[] = [];
  let rec: string[] = [];
  for (const line of lines) {
    if (line !== "^") {
      if (line) rec.push(line);
      continue;
    }
    if (rec[0] === "TD") {
      const code = rec.find((l) => /^N\d+$/.test(l))?.slice(1) ?? "";
      const desc =
        rec
          .find((l) => l.startsWith("P"))
          ?.slice(1)
          .trim() ?? "";
      const dates = rec.filter((l) => l.startsWith("D")).map((l) => l.slice(1).trim());
      const amounts = rec.filter((l) => l.startsWith("$")).map((l) => l.slice(1).trim());
      const box = TXF_BOX[code] ?? "?";
      const proceeds = moneyCents(amounts[1]);
      if (proceeds !== null) {
        const acquired = taxDate(dates[0]);
        const sold = taxDate(dates[1]);
        out.push({
          box,
          term: box === "?" ? (sold ? termOn(acquired, sold) : "unknown") : boxTerm(box),
          description: desc,
          ...describeSale(desc),
          acquired,
          sold,
          proceedsCents: proceeds,
          costCents: moneyCents(amounts[0]),
          washCents: Math.abs(moneyCents(amounts[2]) ?? 0),
        });
      }
    }
    rec = [];
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const COLUMNS: [keyof Cols, RegExp][] = [
  [
    "sold",
    /\b(date sold|sold date|sale date|date of sale|sell date|disposed|date disposed|close date|closing date)\b|^sold$/,
  ],
  [
    "acquired",
    /\b(acquired|purchase date|date purchased|date bought|buy date|open date|opening date)\b/,
  ],
  ["proceeds", /\b(proceeds|sales price|sale price|gross)\b/],
  ["wash", /\bwash\b/],
  ["cost", /\b(cost|basis)\b/],
  ["box", /\b(box|8949)\b/],
  ["term", /\b(term|holding period)\b/],
  ["symbol", /\b(symbol|ticker)\b/],
  ["quantity", /\b(quantity|shares|qty|units)\b/],
  ["description", /\b(description|security|name)\b/],
];

interface Cols {
  sold: number;
  acquired: number;
  proceeds: number;
  wash: number;
  cost: number;
  box: number;
  term: number;
  symbol: number;
  quantity: number;
  description: number;
}

/** A CSV of 1099-B sales; null when no header row with a sale date and proceeds is found. */
export function parse1099bCsv(text: string): B1099Sale[] | null {
  const rows = parseCsv(text);
  for (let h = 0; h < Math.min(rows.length, 30); h++) {
    const header = (rows[h] ?? []).map(norm);
    const cols = {} as Cols;
    for (const [key, re] of COLUMNS) {
      const i = header.findIndex(
        (c, idx) =>
          re.test(c) &&
          !Object.values(cols).includes(idx) &&
          // "Cost basis adjustment" or "Wash sale" aren't the cost column.
          !(key === "cost" && /\b(wash|adjust|discount)\b/.test(c)),
      );
      if (i >= 0) cols[key] = i;
    }
    if (cols.sold === undefined || cols.proceeds === undefined) continue;
    const out: B1099Sale[] = [];
    for (const r of rows.slice(h + 1)) {
      const cell = (k: keyof Cols) => (cols[k] === undefined ? "" : (r[cols[k]] ?? "").trim());
      const sold = taxDate(cell("sold"));
      const proceeds = moneyCents(cell("proceeds"));
      const desc = cell("description");
      if (!sold || proceeds === null || /^total/i.test(desc)) continue;
      const acquired = taxDate(cell("acquired"));
      const boxCell = cell("box")
        .toUpperCase()
        .match(/(?:^|[^A-Z])([A-F])(?:[^A-Z]|$)/);
      const box = (boxCell?.[1] as Form8949Box | undefined) ?? "?";
      const termCell = cell("term").toLowerCase();
      const term: TaxTerm =
        box !== "?"
          ? boxTerm(box)
          : termCell.includes("short")
            ? "short"
            : termCell.includes("long")
              ? "long"
              : termOn(acquired, sold);
      const parsed = describeSale(desc);
      const symbol = cell("symbol").toUpperCase() || parsed.symbol;
      out.push({
        box,
        term,
        description: desc || symbol || "",
        symbol: symbol || null,
        quantity: cell("quantity").replace(/,/g, "") || parsed.quantity,
        acquired,
        sold,
        proceedsCents: proceeds,
        costCents: moneyCents(cell("cost")),
        washCents: Math.abs(moneyCents(cell("wash")) ?? 0),
      });
    }
    return out;
  }
  return null;
}

const empty = (): B1099Totals => ({
  proceedsCents: 0,
  costCents: 0,
  washCents: 0,
  gainCents: 0,
  count: 0,
});

/** Totals per Form 8949 box (wash sale losses added back to the gain, as on the form). */
export function summarize1099b(sales: B1099Sale[]): B1099Summary {
  const out: B1099Summary = {};
  for (const s of sales) {
    const t = out[s.box] ?? empty();
    out[s.box] = t;
    t.proceedsCents += s.proceedsCents;
    t.costCents += s.costCents ?? 0;
    t.washCents += s.washCents;
    t.gainCents += s.proceedsCents - (s.costCents ?? 0) + s.washCents;
    t.count++;
  }
  return out;
}

/** Totals by term (for comparing with Muny's own numbers). */
export function totalsByTerm(sales: B1099Sale[]): Record<TaxTerm, B1099Totals> {
  const out = { short: empty(), long: empty(), unknown: empty() };
  for (const s of sales) {
    const t = out[s.term];
    t.proceedsCents += s.proceedsCents;
    t.costCents += s.costCents ?? 0;
    t.washCents += s.washCents;
    t.gainCents += s.proceedsCents - (s.costCents ?? 0) + s.washCents;
    t.count++;
  }
  return out;
}

const MONEY_CELL = /^\(?-?\$?(\d{1,3}(,\d{3})+|\d+)\.\d{2}-?\)?$/;

/** Which Form 8949 box a summary line is about, from its words. */
function boxOf(text: string): Form8949Box | null {
  const t = text.toLowerCase();
  const direct = t.match(/\bbox\s*\(?([a-f])\)?(?![a-z])/);
  if (direct) return (direct[1] as string).toUpperCase() as Form8949Box;
  const short = /short[- ]?term|\bshort\b/.test(t);
  const long = /long[- ]?term|\blong\b/.test(t);
  if (short === long) return null;
  const letter = t.match(/\(([a-f])\)/)?.[1]?.toUpperCase() as Form8949Box | undefined;
  if (letter && (short ? "ABC" : "DEF").includes(letter)) return letter;
  const none = /\bno(t)?\s+(form\s+)?1099/.test(t);
  const notReported = /non-?covered|not reported|basis (is )?not|unreported/.test(t);
  const reported = /\bcovered|basis (is )?reported|reported to (the )?irs/.test(t);
  if (none) return short ? "C" : "F";
  if (notReported) return short ? "B" : "E";
  if (reported) return short ? "A" : "D";
  return null;
}

/**
 * The summary totals per box from a 1099-B PDF's text lines (cells left to
 * right). Brokers lay these out differently, so a line only counts when its
 * numbers add up: proceeds − cost (+ market discount) + wash sale = gain.
 * The first line found for each box wins.
 */
export function read1099bSummary(lines: string[][]): B1099Summary {
  const out: B1099Summary = {};
  for (const cells of lines) {
    const box = boxOf(cells.join(" "));
    if (!box || out[box]) continue;
    const nums = cells
      .flatMap((c) => c.split(/\s+/))
      .filter((c) => MONEY_CELL.test(c))
      .map((c) => moneyCents(c) as number);
    if (nums.length < 3) continue;
    const [p, c] = nums as [number, number];
    // The gain is the last number, or the one before it (some add tax withheld).
    for (const gi of [nums.length - 1, nums.length - 2]) {
      if (gi < 2) continue;
      const g = nums[gi] as number;
      const mid = nums.slice(2, gi);
      const adds = mid.reduce((s, x) => s + x, 0);
      if (Math.abs(p - c + adds - g) > 1) continue;
      // With two adjustments the second is the wash sale (market discount comes first).
      const wash = mid.length ? Math.abs(mid[mid.length - 1] as number) : 0;
      out[box] = { proceedsCents: p, costCents: c, washCents: wash, gainCents: g, count: 0 };
      break;
    }
  }
  return out;
}
