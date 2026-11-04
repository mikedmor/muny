import { type CsvMapping, type CsvPresetInfo, MoneyParseError, parseAmount } from "@muny/shared";
import { parseCsv } from "./csv.js";
import { detectDateFormat, parseDate } from "./dates.js";
import type { ParsedAccount, ParsedTransaction, ParseResult } from "./types.js";

/**
 * Single-account bank CSV import, driven by a column mapping. Presets cover
 * common US bank exports; anything else gets a best-guess mapping the user can
 * adjust in the UI.
 */

export interface CsvPreset extends CsvPresetInfo {
  /** All of these headers must be present (case-insensitive). */
  headers: string[];
  mapping: CsvMapping;
  /** Pull the account's last 4 digits out of the filename, if the bank includes them. */
  maskFromFilename?: RegExp;
}

export const CSV_PRESETS: CsvPreset[] = [
  {
    id: "chase_checking",
    label: "Chase checking/savings",
    institutionName: "Chase",
    accountType: "checking",
    headers: ["Details", "Posting Date", "Description", "Amount", "Type", "Balance"],
    mapping: {
      date: "Posting Date",
      dateFormat: "MM/DD/YYYY",
      description: "Description",
      amount: "Amount",
    },
    maskFromFilename: /^chase(\d{4})_/i,
  },
  {
    id: "chase_card",
    label: "Chase credit card",
    institutionName: "Chase",
    accountType: "credit",
    headers: ["Transaction Date", "Post Date", "Description", "Category", "Type", "Amount"],
    mapping: {
      date: "Post Date",
      authorizedDate: "Transaction Date",
      dateFormat: "MM/DD/YYYY",
      description: "Description",
      amount: "Amount",
      category: "Category",
      notes: "Memo",
    },
    maskFromFilename: /^chase(\d{4})_/i,
  },
  {
    id: "ally",
    label: "Ally Bank",
    institutionName: "Ally Bank",
    accountType: "savings",
    headers: ["Date", "Time", "Amount", "Type", "Description"],
    mapping: {
      date: "Date",
      dateFormat: "YYYY-MM-DD",
      description: "Description",
      amount: "Amount",
    },
  },
  {
    id: "paypal",
    label: "PayPal activity",
    institutionName: "PayPal",
    accountType: "checking",
    headers: ["Date", "Name", "Type", "Status", "Currency", "Gross", "Net"],
    mapping: {
      date: "Date",
      dateFormat: "MM/DD/YYYY",
      description: "Name",
      descriptionFallback: "Type",
      amount: "Net",
      notes: "Type",
      filters: [
        { column: "Status", op: "in", values: ["Completed"] },
        // Rows marked "Memo" don't change the PayPal balance (e.g. authorizations).
        { column: "Balance Impact", op: "notIn", values: ["Memo"] },
      ],
    },
  },
];

const lc = (s: string) => s.trim().toLowerCase();

export function detectCsvPreset(headers: string[]): CsvPreset | null {
  const set = new Set(headers.map(lc));
  return CSV_PRESETS.find((p) => p.headers.every((h) => set.has(lc(h)))) ?? null;
}

function pick(headers: string[], candidates: string[], exclude: (string | undefined)[] = []) {
  const avail = headers.filter((h) => !exclude.includes(h));
  for (const c of candidates) {
    const hit = avail.find((h) => lc(h) === c);
    if (hit) return hit;
  }
  return undefined;
}

/** Best-guess mapping from header names and sample values; null if no date/amount found. */
export function guessCsvMapping(headers: string[], rows: string[][]): CsvMapping | null {
  const date = pick(headers, [
    "posting date",
    "posted date",
    "post date",
    "date",
    "transaction date",
    "trans date",
    "trans. date",
    "booking date",
  ]);
  if (!date) return null;
  const authorizedDate = pick(headers, ["transaction date", "trans date", "trans. date"], [date]);
  const amount = pick(headers, ["amount", "transaction amount", "amount (usd)", "net", "value"]);
  const debit = pick(headers, ["debit", "debit amount", "withdrawal", "withdrawals", "money out"]);
  const credit = pick(headers, ["credit", "credit amount", "deposit", "deposits", "money in"]);
  if (!amount && !(debit && credit)) return null;
  const description = pick(
    headers,
    ["description", "payee", "name", "merchant", "transaction description", "narrative", "memo"],
    [date],
  );
  if (!description) return null;

  const col = headers.indexOf(date);
  const dateFormat = detectDateFormat(rows.map((r) => r[col] ?? "")) ?? "MM/DD/YYYY";
  const category = pick(headers, ["category"]);
  const notes = pick(headers, ["memo", "notes", "note"], [description]);
  return {
    date,
    dateFormat,
    description,
    ...(amount ? { amount } : { debit, credit }),
    ...(authorizedDate && { authorizedDate }),
    ...(category && { category }),
    ...(notes && { notes }),
  };
}

export interface BankCsvParse extends ParseResult {
  headers: string[];
  sample: string[][];
  preset: CsvPreset | null;
  mapping: CsvMapping | null;
}

export const CSV_ACCOUNT_KEY = "csv";

function passes(filters: CsvMapping["filters"], get: (col: string) => string | undefined) {
  return (filters ?? []).every((f) => {
    const v = get(f.column);
    if (v === undefined) return true; // column not in this export: ignore the filter
    const hit = f.values.some((x) => lc(x) === lc(v));
    return f.op === "in" ? hit : !hit;
  });
}

export function parseBankCsv(
  content: string,
  opts: { filename: string; mapping?: CsvMapping },
): BankCsvParse {
  const rows = parseCsv(content);
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const data = rows.slice(1);
  const preset = detectCsvPreset(headers);
  const mapping = opts.mapping ?? preset?.mapping ?? guessCsvMapping(headers, data);

  const result: BankCsvParse = {
    format: "csv",
    accounts: [],
    transactions: [],
    errors: [],
    headers,
    sample: data.slice(0, 5),
    preset,
    mapping,
  };
  if (!mapping) return result;

  const index = new Map(headers.map((h, i) => [lc(h), i]));
  const colOf = (name: string | undefined) => (name ? index.get(lc(name)) : undefined);
  const required = [
    mapping.date,
    mapping.description,
    mapping.amount,
    mapping.debit,
    mapping.credit,
  ];
  for (const c of required) {
    if (c && colOf(c) === undefined) {
      result.errors.push({ line: 1, message: `Column "${c}" isn't in this file` });
      return result;
    }
  }
  if (!mapping.amount && !(mapping.debit || mapping.credit)) {
    result.errors.push({ line: 1, message: "Choose an amount column (or debit/credit columns)" });
    return result;
  }

  const mask = (preset?.maskFromFilename?.exec(opts.filename)?.[1] ?? null) || null;
  const account: ParsedAccount = {
    key: CSV_ACCOUNT_KEY,
    name: preset?.label.replace(/ activity$/, "") ?? accountNameFromFile(opts.filename),
    institutionName: preset?.institutionName ?? null,
    mask,
    type: preset?.accountType ?? "checking",
  };

  data.forEach((r, i) => {
    const line = i + 2;
    const get = (c: string | undefined) => {
      const idx = colOf(c);
      return idx === undefined ? undefined : (r[idx] ?? "").trim();
    };
    if (!passes(mapping.filters, get)) return;

    const rawDate = get(mapping.date) ?? "";
    const postedDate = parseDate(rawDate, mapping.dateFormat);
    if (!postedDate) {
      result.errors.push({ line, message: `Invalid date "${rawDate}"` });
      return;
    }

    let amountCents: number;
    try {
      if (mapping.amount) {
        amountCents = parseAmount(get(mapping.amount) ?? "", { round: true });
        if (mapping.negate) amountCents = -amountCents;
      } else {
        const d = get(mapping.debit);
        const c = get(mapping.credit);
        const debit = d ? Math.abs(parseAmount(d, { round: true })) : 0;
        const credit = c ? Math.abs(parseAmount(c, { round: true })) : 0;
        if (!d && !c) throw new MoneyParseError("Empty amount");
        amountCents = credit - debit;
      }
    } catch (e) {
      if (!(e instanceof MoneyParseError)) throw e;
      result.errors.push({ line, message: "Invalid or missing amount" });
      return;
    }

    const authRaw = get(mapping.authorizedDate);
    const authorized = authRaw ? parseDate(authRaw, mapping.dateFormat) : null;
    const notes = get(mapping.notes);
    const description =
      get(mapping.description) || get(mapping.descriptionFallback) || "(no description)";

    const txn: ParsedTransaction = {
      accountKey: account.key,
      line,
      postedDate,
      authorizedDate: authorized && authorized !== postedDate ? authorized : null,
      amountCents,
      rawDescription: description,
      payeeName: null,
      categoryName: get(mapping.category) || null,
      notes: notes && notes !== description ? notes : null,
      tags: [],
      hidden: false,
      providerTxnRef: null,
    };
    result.transactions.push(txn);
  });

  if (result.transactions.length > 0) result.accounts = [account];
  return result;
}

function accountNameFromFile(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(transactions?|activity|export|statement|download)\b/gi, "")
    .replace(/\d{4,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return base.length >= 2 ? base.slice(0, 60) : "Imported account";
}
