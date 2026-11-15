import type { PayLine, PayStubRead } from "@muny/shared";
import { amountCents, isoDate, type PdfCell, type PdfItem, pdfRowsAt, tidyName } from "./pdf.js";

/**
 * ADP earnings statements (pay stubs), read by position: earnings, then the
 * statutory taxes, then other deductions (a blank heading line apart), net
 * pay and where it was deposited. ADP draws the commas and decimal points, so
 * amounts come through as digit groups ("3 125 50"). Account numbers are cut
 * to their last 4 digits; names and addresses aren't kept.
 */

/** Digit groups of one amount sit about 5-7 points apart; columns 15 or more. */
const JOIN = 9;
/** How far a value's right edge may sit from its column heading's. */
const COLUMN_SLACK = 14;

const TAX_NAME =
  /\b(tax|fica|oasdi|medicare|social security|withholding|sdi|sui|fli|pfml|occ(upational)?|local)\b/i;

interface Row {
  y: number;
  cells: PdfCell[];
}

const rowsWithY = (items: PdfItem[]): Row[] => pdfRowsAt(items, JOIN);

const text = (cells: PdfCell[]) =>
  cells
    .filter((c) => amountCents(c.s) === null)
    .map((c) => c.s)
    .join(" ")
    .trim();

/** The cell right after one matching `label` on the same row. */
function after(rows: Row[], label: RegExp): string | undefined {
  for (const r of rows) {
    const i = r.cells.findIndex((c) => label.test(c.s));
    if (i >= 0) return r.cells[i + 1]?.s;
  }
  return undefined;
}

export function isAdpStub(items: PdfItem[]): boolean {
  const all = items.map((i) => i.s).join(" ");
  return /Earnings Statement/i.test(all) && /Pay Date:/i.test(all) && /Net Pay/i.test(all);
}

/** One page of an ADP earnings statement, or null when it isn't one. */
export function readAdpStub(items: PdfItem[]): PayStubRead | null {
  if (!isAdpStub(items)) return null;
  const rows = rowsWithY(items);
  const payDate = isoDate(after(rows, /^Pay Date:$/i));
  if (!payDate) return null;

  // Column headings: "this period" / "year to date" on the left, then the
  // "Other Benefits and Information" box on the right with "total to date".
  const head = rows.find(
    (r) =>
      r.cells.some((c) => /^this period$/i.test(c.s)) &&
      r.cells.some((c) => /year to date/i.test(c.s)),
  );
  if (!head) return null;
  const thisCol = head.cells.find((c) => /^this period$/i.test(c.s)) as PdfCell;
  const ytdCol = head.cells.find((c) => /year to date/i.test(c.s)) as PdfCell;
  const infoHead = rows.find(
    (r) =>
      r !== head &&
      r.cells.some((c) => /^this period$/i.test(c.s)) &&
      r.cells.some((c) => /total to date/i.test(c.s)),
  );
  const infoThis = infoHead?.cells.find((c) => /^this period$/i.test(c.s));
  const infoTotal = infoHead?.cells.find((c) => /total to date/i.test(c.s));
  // Anything starting right of the year-to-date column is in that box.
  const split = ytdCol.r + COLUMN_SLACK;

  const near = (c: PdfCell, col: PdfCell | undefined) =>
    !!col && Math.abs(c.r - col.r) <= COLUMN_SLACK;
  const amounts = (cells: PdfCell[], a: PdfCell | undefined, b: PdfCell | undefined) => {
    let cur: number | null = null;
    let ytd: number | null = null;
    let preTax = false;
    for (const c of cells) {
      const v = amountCents(c.s);
      if (v === null) continue;
      if (near(c, a)) {
        cur = Math.abs(v);
        preTax ||= c.s.endsWith("*");
      } else if (near(c, b)) ytd = Math.abs(v);
    }
    return { cur, ytd, preTax };
  };

  const lines: PayLine[] = [];
  let section: "earning" | "tax" | "deduction" | "deposit" | "done" = "earning";
  let grossCents: number | null = null;
  let ytdGrossCents: number | null = null;
  let netCents: number | null = null;
  let checkCents = 0;
  let federalTaxableCents: number | null = null;
  let lastTaxY: number | null = null;
  let sawGap = false;
  const spacing: number[] = [];
  const taxRows: { y: number; line: PayLine }[] = [];

  const start = rows.indexOf(head);
  for (let n = start + 1; n < rows.length; n++) {
    const r = rows[n] as Row;
    const left = r.cells.filter((c) => c.x < split);
    const right = r.cells.filter((c) => c.x >= split);
    const label = text(left);

    if (right.length && section !== "done") {
      const rl = text(right);
      if (/federal taxable wages/i.test(rl)) {
        // The amount is on the next line of this box; lines on the left can sit between.
        for (const next of rows.slice(n + 1, n + 4)) {
          const v = next.cells
            .filter((c) => c.x >= split)
            .map((c) => amountCents(c.s))
            .find((v) => v !== null);
          if (v !== undefined && v !== null) {
            federalTaxableCents = v;
            break;
          }
        }
      } else if (rl && infoHead && n > rows.indexOf(infoHead)) {
        const { cur, ytd } = amounts(right, infoThis, infoTotal);
        if (cur !== null || ytd !== null)
          lines.push({ kind: "info", name: rl, cents: cur, ytdCents: ytd });
      }
    }

    if (section === "done" || !label) continue;
    if (/^Statutory$/i.test(label) || /\bStatutory$/i.test(label)) {
      section = "tax";
      continue;
    }
    const { cur, ytd, preTax } = amounts(left, thisCol, ytdCol);
    if (/^Gross Pay$/i.test(label)) {
      grossCents = cur;
      ytdGrossCents = ytd;
      continue;
    }
    if (/^Net Pay$/i.test(label)) {
      netCents = cur;
      section = "deposit";
      continue;
    }
    if (/^Net Check$/i.test(label)) {
      checkCents = cur ?? 0;
      section = "done";
      continue;
    }
    if (cur === null && ytd === null) continue;
    if (section === "tax") {
      // A taller gap than the lines around it is where the "Other" heading sits.
      if (lastTaxY !== null) {
        const gap = lastTaxY - r.y;
        const usual = spacing.length ? Math.min(...spacing) : gap;
        if (spacing.length && gap > usual * 1.8) {
          section = "deduction";
          sawGap = true;
        } else spacing.push(gap);
      }
      lastTaxY = r.y;
    }
    const line: PayLine = { kind: section, name: label, cents: cur, ytdCents: ytd };
    if (preTax) line.preTax = true;
    lines.push(line);
    if (section === "tax") taxRows.push({ y: r.y, line });
  }
  // No blank heading line found: tell taxes from deductions by name.
  if (!sawGap)
    for (const { line } of taxRows) if (!TAX_NAME.test(line.name)) line.kind = "deduction";

  if (grossCents === null || netCents === null) return null;

  // The voucher at the bottom: each deposit with the account's last 4 digits.
  const deposits: PayStubRead["deposits"] = [];
  for (const r of rows) {
    const acct = r.cells.find((c) => /^x{2,}\d{4}$/i.test(c.s));
    if (!acct) continue;
    const cents = r.cells
      .filter((c) => c.x > acct.r)
      .map((c) => amountCents(c.s))
      .filter((v): v is number => v !== null)
      .pop();
    if (cents !== undefined) deposits.push({ cents: Math.abs(cents), last4: acct.s.slice(-4) });
  }
  if (!deposits.length)
    for (const l of lines)
      if (l.kind === "deposit" && l.cents) deposits.push({ cents: l.cents, last4: null });

  const employerRow = rows.find((r) => r.cells.some((c) => /^Period Beginning:$/i.test(c.s)));
  const label = employerRow?.cells.find((c) => /^Period Beginning:$/i.test(c.s));
  const employer =
    employerRow && label
      ? employerRow.cells
          .filter((c) => c.r <= label.x)
          .map((c) => c.s)
          .join(" ")
      : "";

  return {
    employer: employer ? tidyName(employer) : null,
    periodStart: isoDate(after(rows, /^Period Beginning:$/i)),
    periodEnd: isoDate(after(rows, /^Period Ending:$/i)),
    payDate,
    grossCents,
    netCents,
    ytdGrossCents,
    federalTaxableCents,
    lines,
    deposits,
    checkCents,
  };
}

/** Ways a stub doesn't add up (empty when it does). */
export function stubProblems(s: PayStubRead): string[] {
  const sum = (kind: PayLine["kind"]) =>
    s.lines.filter((l) => l.kind === kind).reduce((t, l) => t + (l.cents ?? 0), 0);
  const out: string[] = [];
  const earned = sum("earning");
  if (earned && earned !== s.grossCents)
    out.push(
      `Earnings add up to ${dollars(earned)}, not the gross pay of ${dollars(s.grossCents)}.`,
    );
  const left = s.grossCents - sum("tax") - sum("deduction");
  if (left !== s.netCents)
    out.push(
      `Gross pay less taxes and deductions is ${dollars(left)}, not the net pay of ${dollars(s.netCents)}.`,
    );
  const paid = s.deposits.reduce((t, d) => t + d.cents, 0) + s.checkCents;
  if (paid !== s.netCents)
    out.push(
      `Deposits and checks add up to ${dollars(paid)}, not the net pay of ${dollars(s.netCents)}.`,
    );
  return out;
}

const dollars = (c: number) =>
  `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
