import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "./csv.js";
import { detectDateFormat, parseDate } from "./dates.js";
import { isRocketMoneyCsv, parseRocketMoneyCsv, ROCKET_MONEY_HEADERS } from "./rocket-money.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded newlines, CRLF and BOM", () => {
    const csv = '﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n1,2,3\n';
    expect(parseCsv(csv)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "multi\nline"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps empty fields and skips blank lines", () => {
    expect(parseCsv("a,,c\n\n,,\n1,2,")).toEqual([
      ["a", "", "c"],
      ["1", "2", ""],
    ]);
  });

  it("detects semicolon delimiters", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("maps records by trimmed headers (Ally-style leading spaces)", () => {
    const { headers, records } = parseCsvRecords("Date, Amount\n2026-01-01, -5.00");
    expect(headers).toEqual(["Date", "Amount"]);
    expect(records[0]).toEqual({ line: 2, values: { Date: "2026-01-01", Amount: "-5.00" } });
  });
});

describe("dates", () => {
  it.each([
    ["2026-01-05", "YYYY-MM-DD", "2026-01-05"],
    ["1/5/2026", "MM/DD/YYYY", "2026-01-05"],
    ["01/05/26", "MM/DD/YYYY", "2026-01-05"],
    ["05/01/2026", "DD/MM/YYYY", "2026-01-05"],
    ["20260105120000[-5:EST]", "YYYYMMDD", "2026-01-05"],
    ["2026-01-05T10:00:00", "YYYY-MM-DD", "2026-01-05"],
  ] as const)("parses %s as %s", (input, fmt, out) => {
    expect(parseDate(input, fmt)).toBe(out);
  });

  it("rejects impossible dates", () => {
    expect(parseDate("2026-02-30", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("13/01/2026", "MM/DD/YYYY")).toBeNull();
  });

  it("detects formats", () => {
    expect(detectDateFormat(["2026-01-05", "2026-12-31"])).toBe("YYYY-MM-DD");
    expect(detectDateFormat(["01/05/2026", "12/31/2026"])).toBe("MM/DD/YYYY");
    expect(detectDateFormat(["31/12/2026"])).toBe("DD/MM/YYYY");
  });
});

// Synthetic data only. Column layout matches a real Rocket Money export.
const HEADER = ROCKET_MONEY_HEADERS.join(",");
const RM_CSV = [
  HEADER,
  "2026-01-21,2026-01-20,Cash,MAIN ACCOUNT,1111,Example Bank,PAYPAL INST XFER MEALKIT,,40.73,PAYPAL INST XFER MEALKIT,Groceries,,,,",
  "2026-01-22,2026-01-22,Cash,MAIN ACCOUNT,1111,Example Bank,ACME PAYROLL,Acme Payroll,-2500.00,ACME PAYROLL DIR DEP,Income,biweekly,,,",
  '2026-01-23,2026-01-23,Credit Card,Rewards Card,2222,Card Co,STREAMFLIX.COM,StreamFlix,15.99,STREAMFLIX.COM,Entertainment,,,TRUE,"family, subscriptions"',
  "2026-01-24,2026-01-24,Cash,High Yield Savings,3333,Online Bank,TRANSFER,,-100,TRANSFER FROM MAIN,Internal Transfers,,everything,,",
  "2026-01-25,2026-01-25,Credit Card,Rewards Card,2222,Card Co,REFUND,,-5.5,REFUND,Shopping,,budget,,",
  "not-a-date,,Cash,MAIN ACCOUNT,1111,Example Bank,X,,1,X,,,,,",
].join("\n");

describe("Rocket Money import", () => {
  it("recognizes the header", () => {
    expect(isRocketMoneyCsv([...ROCKET_MONEY_HEADERS])).toBe(true);
    expect(isRocketMoneyCsv(["Date", "Amount", "Description"])).toBe(false);
  });

  it("parses accounts with types and masks", () => {
    const r = parseRocketMoneyCsv(RM_CSV);
    expect(r.accounts).toEqual([
      expect.objectContaining({
        name: "MAIN ACCOUNT",
        institutionName: "Example Bank",
        mask: "1111",
        type: "checking",
      }),
      expect.objectContaining({ name: "Rewards Card", mask: "2222", type: "credit" }),
      expect.objectContaining({ name: "High Yield Savings", type: "savings" }),
    ]);
  });

  it("flips the sign so spending is negative", () => {
    const r = parseRocketMoneyCsv(RM_CSV);
    expect(r.transactions.map((t) => t.amountCents)).toEqual([-4073, 250000, -1599, 10000, 550]);
  });

  it("maps names, notes, tags, hidden flags and original dates", () => {
    const [grocery, pay, stream, transfer, refund] = parseRocketMoneyCsv(RM_CSV).transactions;
    expect(grocery).toMatchObject({
      authorizedDate: "2026-01-20",
      payeeName: null,
      categoryName: "Groceries",
    });
    expect(pay).toMatchObject({
      payeeName: "Acme Payroll",
      notes: "biweekly",
      authorizedDate: null,
    });
    expect(stream?.tags).toEqual(["family", "subscriptions", "tax-deductible"]);
    expect(transfer?.hidden).toBe(true);
    expect(refund).toMatchObject({ hidden: true, tags: ["rm-ignored-from-budget"] });
  });

  it("treats Uncategorized as no category", () => {
    const csv = [HEADER, "2026-01-01,2026-01-01,Cash,A,1,B,X,,1,X,Uncategorized,,,,"].join("\n");
    expect(parseRocketMoneyCsv(csv).transactions[0]?.categoryName).toBeNull();
  });

  it("reports bad rows without failing the file", () => {
    const r = parseRocketMoneyCsv(RM_CSV);
    expect(r.transactions).toHaveLength(5);
    expect(r.errors).toEqual([{ line: 7, message: 'Invalid date "not-a-date"' }]);
  });
});
