import type { DateFormat } from "@muny/shared";

export type { DateFormat };

function valid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Parse a bank date string into ISO YYYY-MM-DD, or null if invalid.
 * Accepts single-digit month/day and 2-digit years (assumed 20xx) for the
 * slash formats; ignores any trailing time component.
 */
export function parseDate(input: string, format: DateFormat): string | null {
  const s = input.trim().split(/[ T]/)[0] ?? "";
  let y: number;
  let m: number;
  let d: number;
  if (format === "YYYY-MM-DD") {
    const r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (!r) return null;
    [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else if (format === "YYYYMMDD") {
    const r = /^(\d{4})(\d{2})(\d{2})/.exec(s);
    if (!r) return null;
    [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  } else {
    const r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (!r) return null;
    const a = Number(r[1]);
    const b = Number(r[2]);
    y = Number(r[3]);
    if (y < 100) y += 2000;
    [m, d] = format === "MM/DD/YYYY" ? [a, b] : [b, a];
  }
  return valid(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Guess the date format from sample values: the one that parses the most (ties: earlier wins). */
export function detectDateFormat(samples: string[]): DateFormat | null {
  const values = samples
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  if (values.length === 0) return null;
  const order: DateFormat[] = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "YYYYMMDD"];
  let best: DateFormat | null = null;
  let bestCount = 0;
  for (const f of order) {
    const n = values.filter((v) => parseDate(v, f) !== null).length;
    if (n > bestCount) [best, bestCount] = [f, n];
  }
  return best;
}
