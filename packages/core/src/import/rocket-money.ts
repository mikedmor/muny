import { type AccountType, MoneyParseError, parseAmount } from "@muny/shared";
import { parseCsvRecords } from "./csv.js";
import { parseDate } from "./dates.js";
import type { ParsedAccount, ParsedTransaction, ParseResult } from "./types.js";

/**
 * Rocket Money "Export transactions" CSV.
 *
 * Header (as of 2026-11):
 *   Date, Original Date, Account Type, Account Name, Account Number,
 *   Institution Name, Name, Custom Name, Amount, Description, Category, Note,
 *   Ignored From, Tax Deductible, Transaction Tags
 *
 * Quirks:
 * - Amount is POSITIVE for money out (spending) and negative for money in,
 *   the opposite of Muny's convention, so it is negated here.
 * - "Account Number" holds only the last 4 digits.
 * - "Ignored From" is empty, "budget" or "everything".
 */
export const ROCKET_MONEY_HEADERS = [
  "Date",
  "Original Date",
  "Account Type",
  "Account Name",
  "Account Number",
  "Institution Name",
  "Name",
  "Custom Name",
  "Amount",
  "Description",
  "Category",
  "Note",
  "Ignored From",
  "Tax Deductible",
  "Transaction Tags",
] as const;

const REQUIRED = ["Date", "Account Name", "Amount", "Category"];

export function isRocketMoneyCsv(headers: string[]): boolean {
  const set = new Set(headers);
  return (
    REQUIRED.every((h) => set.has(h)) &&
    set.has("Custom Name") &&
    set.has("Ignored From") &&
    set.has("Institution Name")
  );
}

function accountType(rmType: string, name: string): AccountType {
  const t = rmType.toLowerCase();
  if (t.includes("credit")) return "credit";
  if (t.includes("loan") || t.includes("mortgage")) return "loan";
  if (t.includes("invest") || t.includes("brokerage") || t.includes("retire")) return "investment";
  if (t.includes("property") || t.includes("real estate") || t.includes("vehicle")) return "asset";
  if (t === "cash" || t.includes("depository") || t.includes("bank")) {
    return /sav/i.test(name) ? "savings" : "checking";
  }
  return "other";
}

const splitTags = (s: string) =>
  s
    .split(/[,;|]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);

export function parseRocketMoneyCsv(content: string): ParseResult {
  const { headers, records } = parseCsvRecords(content);
  const result: ParseResult = {
    format: "rocket_money",
    accounts: [],
    transactions: [],
    errors: [],
  };
  if (!isRocketMoneyCsv(headers)) {
    result.errors.push({ line: 1, message: "This doesn't look like a Rocket Money export" });
    return result;
  }

  const accounts = new Map<string, ParsedAccount>();
  for (const { line, values: v } of records) {
    const postedDate = parseDate(v.Date ?? "", "YYYY-MM-DD");
    if (!postedDate) {
      result.errors.push({ line, message: `Invalid date "${v.Date}"` });
      continue;
    }
    let amountCents: number;
    try {
      amountCents = -parseAmount(v.Amount ?? "", { round: true });
    } catch (e) {
      if (!(e instanceof MoneyParseError)) throw e;
      result.errors.push({ line, message: `Invalid amount "${v.Amount}"` });
      continue;
    }

    const name = v["Account Name"] || "Unknown account";
    const institution = v["Institution Name"] || null;
    const mask = (v["Account Number"] ?? "").replace(/\D/g, "").slice(-4) || null;
    const key = [institution ?? "", name, mask ?? ""].join("|");
    if (!accounts.has(key)) {
      accounts.set(key, {
        key,
        name,
        institutionName: institution,
        mask,
        type: accountType(v["Account Type"] ?? "", name),
      });
    }

    const original = v["Original Date"] ? parseDate(v["Original Date"], "YYYY-MM-DD") : null;
    const ignored = (v["Ignored From"] ?? "").toLowerCase();
    const tags = splitTags(v["Transaction Tags"] ?? "");
    if (ignored === "budget") tags.push("rm-ignored-from-budget");
    const taxDeductible = (v["Tax Deductible"] ?? "").toLowerCase();
    if (taxDeductible && taxDeductible !== "false" && taxDeductible !== "no")
      tags.push("tax-deductible");

    const txn: ParsedTransaction = {
      accountKey: key,
      line,
      postedDate,
      authorizedDate: original && original !== postedDate ? original : null,
      amountCents,
      rawDescription: v.Description || v.Name || "(no description)",
      payeeName: v["Custom Name"] || null,
      // Rocket Money writes "Uncategorized" for transactions without a category.
      categoryName: v.Category && v.Category.toLowerCase() !== "uncategorized" ? v.Category : null,
      notes: v.Note || null,
      tags: [...new Set(tags)],
      hidden: ignored !== "",
      providerTxnRef: null,
    };
    result.transactions.push(txn);
  }
  result.accounts = [...accounts.values()];
  return result;
}
