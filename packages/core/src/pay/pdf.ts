/**
 * A PDF's text with positions, for forms read by where things sit on the page
 * (pay stubs, W-2s). The server pulls the items out; reading them is pure.
 */

export interface PdfItem {
  s: string;
  x: number;
  y: number;
  w: number;
  /** Font size. */
  size: number;
}

/** Text close together on a line, with where it starts and ends. */
export interface PdfCell {
  s: string;
  x: number;
  r: number;
}

/**
 * Lines (top to bottom), each a list of cells (left to right). Pieces with a
 * gap under `join` points are one cell, joined with a space.
 */
export function pdfRows(items: PdfItem[], join = 6): PdfCell[][] {
  return pdfRowsAt(items, join).map((r) => r.cells);
}

/** pdfRows, with each line's baseline. */
export function pdfRowsAt(items: PdfItem[], join = 6): { y: number; cells: PdfCell[] }[] {
  const rows: { y: number; items: PdfItem[] }[] = [];
  for (const it of [...items].filter((i) => i.s.trim()).sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2.5, it.size * 0.3));
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => {
      const cells: PdfCell[] = [];
      for (const it of r.items.sort((a, b) => a.x - b.x)) {
        const last = cells[cells.length - 1];
        const gap = last ? it.x - last.r : Number.POSITIVE_INFINITY;
        if (last && gap < it.size * 0.2) {
          last.s += it.s.trim();
          last.r = it.x + it.w;
        } else if (last && gap < join) {
          last.s += ` ${it.s.trim()}`;
          last.r = it.x + it.w;
        } else cells.push({ s: it.s.trim(), x: it.x, r: it.x + it.w });
      }
      return { y: r.y, cells };
    });
}

/**
 * An amount in cents: "1,709.24", "$1,709.24", "-89.55", or the way ADP stubs
 * set them, with the separators drawn rather than written: "3 125 50", "-42 10".
 * A trailing * (taken before tax) is allowed. Anything else is null.
 */
export function amountCents(cell: string): number | null {
  const s = cell.replace(/\*$/, "").replace(/\$/g, "").trim();
  let m = s.match(/^(-?)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/);
  if (m) return sign(m[1], Number((m[2] ?? "").replace(/,/g, "")) * 100 + Number(m[3]));
  m = s.match(/^(-?)\s?(\d{1,3}(?: \d{3})*|\d+) (\d{2})$/);
  if (m) return sign(m[1], Number((m[2] ?? "").replace(/ /g, "")) * 100 + Number(m[3]));
  return null;
}

const sign = (minus: string | undefined, cents: number) => (minus ? -cents : cents);

/** "03/13/2026" → "2026-03-13". */
export function isoDate(s: string | undefined): string | null {
  const m = s?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]?.padStart(2, "0")}-${m[2]?.padStart(2, "0")}` : null;
}

/** "NORTHWIND PARTS , LLC" → "Northwind Parts, LLC". */
export function tidyName(s: string): string {
  const one = s.replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  if (one !== one.toUpperCase()) return one;
  return one
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Llc|Inc|Lp|Llp|Pc|Na|Usa)\b/g, (w) => w.toUpperCase());
}
