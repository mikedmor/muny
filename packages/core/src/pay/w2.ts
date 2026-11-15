import type { W2Read } from "@muny/shared";
import { amountCents, type PdfCell, type PdfItem, pdfRows, tidyName } from "./pdf.js";

/**
 * W-2s, read by position: each box's value sits on the line under its label,
 * within the label's width. The first copy on the page is used (they're all
 * the same). ADP's earnings summary, when there, gives gross pay and what was
 * taken out before tax. The SSN, employer ID and addresses aren't kept.
 */

/** ADP sets summary amounts as digit groups about 6 points apart. */
const JOIN = 8;

const BOX12 = new Set(
  "A B C D E F G H J K L M N P Q R S T V W Y Z AA BB DD EE FF GG HH II".split(" "),
);

const decimal = (s: string) => (/^\d[\d,]*\.\d{2}$/.test(s) ? amountCents(s) : null);

export function isW2(items: PdfItem[]): boolean {
  const all = items.map((i) => i.s).join(" ");
  return /Wages, tips, other comp/i.test(all) && /Federal income tax withheld/i.test(all);
}

export function readW2(items: PdfItem[]): W2Read | null {
  if (!isW2(items)) return null;
  const rows = pdfRows(items, JOIN);

  const find = (re: RegExp): [number, PdfCell] | null => {
    for (let n = 0; n < rows.length; n++) {
      const c = rows[n]?.find((c) => re.test(c.s));
      if (c) return [n, c];
    }
    return null;
  };
  /** The amount on the line under a label, within the label's width. */
  const box = (re: RegExp): number | null => {
    const at = find(re);
    if (!at) return null;
    const [n, label] = at;
    for (const c of rows[n + 1] ?? []) {
      const v = decimal(c.s);
      if (v !== null && c.x < label.r + 10 && c.r > label.x) return v;
    }
    return null;
  };

  const wagesCents = box(/Wages, tips, other comp/i);
  if (wagesCents === null) return null;

  let year: number | null = null;
  for (const r of rows) {
    const line = r.map((c) => c.s).join(" ");
    const m = /W-2/.test(line) ? line.match(/\b(20\d\d)\b/) : null;
    if (m) {
      year = Number(m[1]);
      break;
    }
  }
  if (!year) return null;

  let employer: string | null = null;
  const emp = find(/Employer.s name, address/i);
  if (emp) {
    const name = rows[emp[0] + 1]?.find((c) => Math.abs(c.x - emp[1].x) < 40);
    if (name && !decimal(name.s)) employer = tidyName(name.s);
  }

  let state: string | null = null;
  let stateWagesCents: number | null = null;
  const st = find(/\b15\s*State\b/i);
  if (st) {
    const next = rows[st[0] + 1] ?? [];
    state = next.find((c) => /^[A-Z]{2}$/.test(c.s))?.s ?? null;
    stateWagesCents = next.map((c) => decimal(c.s)).find((v) => v !== null) ?? null;
  }

  const box12: W2Read["box12"] = [];
  for (const r of rows)
    r.forEach((c, i) => {
      const code = c.s.match(/^(?:12[a-d]\s*)?([A-Z]{1,2})$/)?.[1];
      const v = decimal(r[i + 1]?.s ?? "");
      if (code && BOX12.has(code) && v !== null && !box12.some((b) => b.code === code))
        box12.push({ code, cents: v });
    });

  // ADP's "Your Gross Pay was adjusted as follows": the first column is box 1.
  const firstAmountAfter = (row: PdfCell[], i: number) =>
    row
      .slice(i + 1)
      .map((c) => amountCents(c.s))
      .find((v) => v !== null) ?? null;
  let grossCents: number | null = null;
  const adjustments: W2Read["summary"]["adjustments"] = [];
  for (const r of rows)
    r.forEach((c, i) => {
      if (/^Gross Pay$/i.test(c.s) && grossCents === null) grossCents = firstAmountAfter(r, i);
      const adj = c.s.match(/^(Plus|Less)\s*(.+)$/i);
      if (adj) {
        const v = firstAmountAfter(r, i);
        if (v !== null)
          adjustments.push({
            name: (adj[2] ?? "").trim(),
            cents: /^less/i.test(adj[1] ?? "") ? -Math.abs(v) : Math.abs(v),
          });
      }
    });

  return {
    year,
    employer,
    boxes: {
      wagesCents,
      federalCents: box(/Federal income tax withheld/i),
      ssWagesCents: box(/Social security wages/i),
      ssCents: box(/Social security tax withheld/i),
      medicareWagesCents: box(/Medicare wages and tips/i),
      medicareCents: box(/Medicare tax withheld/i),
      state,
      stateWagesCents,
      stateCents: box(/\b17\s*State income tax/i),
      localWagesCents: box(/\b18\s*Local wages/i),
      localCents: box(/\b19\s*Local income tax/i),
    },
    box12,
    summary: { grossCents, adjustments },
  };
}
