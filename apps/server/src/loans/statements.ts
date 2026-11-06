import type { LoanStatement, LoanStatementGroup, SingleLoanStatement } from "@muny/shared";
import { getDocumentProxy } from "unpdf";

/**
 * Student loan statements (PDF), e.g. from federal servicers:
 * each loan group's rate, principal, accrued interest, regular payment, due
 * date, and what was applied to it since the last statement (interest and
 * principal). Only these numbers are kept; the PDF, account number, name and
 * address are never stored or logged.
 */

/**
 * Some statement fonts put "$" at a private-use code point (e.g. U+E024):
 * before a number it's a dollar sign; anywhere else, drop it.
 */
const PRIVATE_USE = `${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}`;
const PUA_BEFORE_NUMBER = new RegExp(`[${PRIVATE_USE}](?=\\s*\\d)`, "g");
const PUA = new RegExp(`[${PRIVATE_USE}]`, "g");
export function cleanPdfText(s: string) {
  return s.replace(PUA_BEFORE_NUMBER, "$").replace(PUA, "").trim();
}

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
        s: cleanPdfText(i.str as string),
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

const DATE_RE = String.raw`(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})`;
const MONEY_RE = String.raw`\$?\s?([\d,]+\.\d{2})`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function anyDate(s: string | undefined): string | null {
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = (m[3] as string).length === 2 ? `20${m[3]}` : (m[3] as string);
    return `${y}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
  }
  m = s.match(/^([A-Z][a-z]{2,8})\.? (\d{1,2}),? (\d{4})$/);
  if (!m) return null;
  const mo = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase());
  return mo < 0
    ? null
    : `${m[3]}-${String(mo + 1).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
}

/**
 * One loan's statement (mortgage, auto, personal, most servicers): the common
 * labels for the statement and due dates, the principal or current balance,
 * the rate, the regular payment, the last payment and interest paid this year.
 * Returns null when it finds neither a balance nor a due date.
 */
export function parseSingleLoanStatement(text: string): SingleLoanStatement | null {
  const t = text.replace(/\s+/g, " ");
  const find = (re: RegExp) => t.match(re)?.[1];
  const money = (re: RegExp) => cents(find(re));
  const statementDate = anyDate(find(new RegExp(`Statement Date:? ${DATE_RE}`, "i")));
  const dueDate = anyDate(find(new RegExp(`(?:Payment )?Due Date:?[^\\d]{0,30}?${DATE_RE}`, "i")));
  const balanceCents =
    money(
      new RegExp(
        `(?:Outstanding |Current |Unpaid |Remaining )?Principal Balance:?(?: as of \\S+)? ${MONEY_RE}`,
        "i",
      ),
    ) ?? money(new RegExp(`(?:Current|Loan|Outstanding|Account|New) Balance:? ${MONEY_RE}`, "i"));
  const rate = find(
    /(?:Interest Rate|Annual Percentage Rate|APR)(?: \(APR\))?[^%\d]{0,30}(\d{1,2}(?:\.\d{1,4})?)\s?%/i,
  );
  const paymentCents =
    money(new RegExp(`(?:Regular )?Monthly Payment(?: Amount)?:? ${MONEY_RE}`, "i")) ??
    money(new RegExp(`(?:Regular |Scheduled )?Payment Amount:? ${MONEY_RE}`, "i")) ??
    money(new RegExp(`(?:Total )?Amount Due:? ${MONEY_RE}`, "i"));
  const last = t.match(
    new RegExp(
      `Last Payment(?: Received| Amount)?(?: \\(?(?:on |Effective |Received )?${DATE_RE}\\)?)?:? ${MONEY_RE}`,
      "i",
    ),
  );
  const interestYtdCents = money(
    /(?:Interest Paid Year[- ]to[- ]Date|Year[- ]to[- ]Date Interest(?: Paid)?|YTD Interest(?: Paid)?|Interest Paid YTD|Interest Paid This Year)[:\s]*\$?\s?([\d,]+\.\d{2})/i,
  );
  if (balanceCents === null && !dueDate) return null;
  return {
    statementDate,
    dueDate,
    balanceCents,
    aprBps: rate ? Math.round(Number(rate) * 100) : null,
    paymentCents,
    lastPayment: last ? { date: anyDate(last[1]), amountCents: cents(last[2]) ?? 0 } : null,
    interestYtdCents,
  };
}
