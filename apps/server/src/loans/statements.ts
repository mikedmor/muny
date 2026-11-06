import type { LoanStatement, LoanStatementGroup } from "@muny/shared";
import { getDocumentProxy } from "unpdf";

/**
 * Student loan statements (PDF), e.g. from federal servicers:
 * each loan group's rate, principal, accrued interest, regular payment, due
 * date, and what was applied to it since the last statement (interest and
 * principal). Only these numbers are kept; the PDF, account number, name and
 * address are never stored or logged.
 */

/** The PDF's text as lines (cells left to right), top to bottom, page by page. */
export async function pdfLines(bytes: Uint8Array): Promise<string[][]> {
  const doc = await getDocumentProxy(bytes);
  const out: string[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = (content.items as { str?: string; transform?: number[]; width?: number }[])
      .filter((i) => i.str?.trim() && i.transform)
      .map((i) => ({
        s: (i.str as string).trim(),
        x: (i.transform as number[])[4] ?? 0,
        y: (i.transform as number[])[5] ?? 0,
        w: i.width ?? 0,
        // Font size, from the text matrix.
        size:
          Math.hypot((i.transform as number[])[0] ?? 0, (i.transform as number[])[1] ?? 0) || 10,
      }));
    // Rows: items on (nearly) the same baseline; a value set in bigger or bold
    // type can sit a little lower than its label, so allow about half a line.
    const rows: { y: number; items: typeof items }[] = [];
    for (const it of items.sort((a, b) => b.y - a.y)) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2.5, it.size * 0.45));
      if (row) row.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    }
    for (const r of rows.sort((a, b) => b.y - a.y)) {
      // Cells: items close together are one cell (a label split into words). Pieces
      // that nearly touch are one word: some PDFs store "$3,083.68" as "$3,08" + "3.68".
      const cells: string[] = [];
      let end = Number.NEGATIVE_INFINITY;
      for (const it of r.items.sort((a, b) => a.x - b.x)) {
        const gap = it.x - end;
        if (cells.length && gap < it.size * 0.2) cells[cells.length - 1] += it.s;
        else if (cells.length && gap < 6) cells[cells.length - 1] += ` ${it.s}`;
        else cells.push(it.s);
        end = it.x + it.w;
      }
      out.push(cells);
    }
  }
  return out;
}

const cents = (s: string | undefined) => {
  if (!s) return null;
  const m = s.replace(/[$,\s]/g, "").match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const v = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -v : v;
};
const iso = (s: string | undefined) => {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]?.padStart(2, "0")}-${m[2]?.padStart(2, "0")}` : null;
};
const bps = (s: string | undefined) => {
  const m = s?.match(/^(\d+(?:\.\d+)?)%$/);
  return m ? Math.round(Number(m[1]) * 100) : null;
};

const VALUE = /-?\$-?[\d,]+\.\d{2}|\d+(?:\.\d+)?%|\d{1,2}\/\d{1,2}\/\d{4}|\b\d+\b/g;

/** Read a statement's lines. Returns null when it doesn't look like one. */
export function parseLoanStatement(lines: string[][]): LoanStatement | null {
  const text = lines.map((l) => l.join(" ").replace(/\s+/g, " ").trim());
  const statementDate = iso(
    text.map((t) => t.match(/^Statement Date (\d{1,2}\/\d{1,2}\/\d{4})/)?.[1]).find(Boolean),
  );
  const last = text
    .map((t) => t.match(/Last Payment \(Effective (\d{1,2}\/\d{1,2}\/\d{4})\) \$([\d,]+\.\d{2})/))
    .find(Boolean);

  // Each "Account Snapshot: Group AA Group AB ..." table, then its rows.
  const groups: LoanStatementGroup[] = [];
  for (let i = 0; i < text.length; i++) {
    const head = text[i] ?? "";
    if (!/^Account Snapshot:?/.test(head)) continue;
    const names = [...head.matchAll(/Group ([A-Z0-9]{1,4})/g)].map((m) => m[1] as string);
    if (!names.length) continue;
    const table = names.map((name) => ({ name }) as LoanStatementGroup & Record<string, unknown>);
    const row = (label: RegExp) => {
      for (let j = i + 1; j < text.length; j++) {
        const t = text[j] ?? "";
        if (/^Account Snapshot:?/.test(t)) break;
        const m = t.match(label);
        if (!m) continue;
        const values = t.slice(m[0].length).match(VALUE) ?? [];
        if (values.length < names.length) continue;
        return values.slice(-names.length);
      }
      return null;
    };
    const set = <K extends keyof LoanStatementGroup>(
      key: K,
      label: RegExp,
      read: (s: string | undefined) => LoanStatementGroup[K],
    ) => {
      const v = row(label);
      table.forEach((g, k) => {
        (g as LoanStatementGroup)[key] = read(v?.[k]);
      });
    };
    set("aprBps", /^Interest Rate( is)?/i, bps);
    set("originalPrincipalCents", /^Original Principal Amount/i, cents);
    set("firstDisbursed", /^First Disbursement Date/i, iso);
    set("accruedInterestCents", /^Accrued Interest on \d{1,2}\/\d{1,2}\/\d{4}/i, cents);
    set("monthlyPaymentCents", /^Regular Monthly Payment Amount/i, cents);
    set(
      "principalCents",
      /^Outstanding Principal Balance\*?( on( \d{1,2}\/\d{1,2}\/\d{4})?)?/i,
      cents,
    );
    set("paymentsLeft", /^Loan Term \(payments remaining\)/i, (s) => (s ? Number(s) : null));
    set("paidCents", /^Total Amount Paid Since Last Statement/i, cents);
    set("paidInterestCents", /^Applied to Interest/i, cents);
    set("paidPrincipalCents", /^Applied to Principal/i, cents);
    set("amountDueCents", /^Amount Due/i, cents);
    set("dueDate", /^Due Date/i, iso);
    for (const g of table) if (g.principalCents !== null) groups.push(g);
  }
  if (!statementDate || !groups.length) return null;
  return {
    statementDate,
    lastPayment: last
      ? { date: iso(last[1]) ?? statementDate, amountCents: cents(last[2]) ?? 0 }
      : null,
    groups,
  };
}
