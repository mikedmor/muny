import { describe, expect, it } from "vitest";
import { detectCsvPreset, guessCsvMapping, parseBankCsv } from "./bank-csv.js";

// Synthetic data only. Column layouts match real exports.

const CHASE_CHECKING = [
  "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #",
  // Chase checking rows carry a trailing empty field.
  "DEBIT,01/15/2026,EXAMPLE GROCERY #123,-54.21,DEBIT_CARD,1000.00,,",
  "CREDIT,01/14/2026,ACME CORP PAYROLL PPD ID: 000,2500.00,ACH_CREDIT,1054.21,,",
].join("\n");

const CHASE_CARD = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "01/10/2026,01/11/2026,STREAMFLIX.COM,Entertainment,Sale,-15.99,",
  "01/12/2026,01/12/2026,Payment Thank You-Mobile,,Payment,500.00,",
  "01/13/2026,01/14/2026,CORNER CAFE,Food & Drink,Sale,-4.50,extra shot",
].join("\n");

const ALLY = [
  "Date, Time, Amount, Type, Description",
  "2026-01-20, 08:00:00, 1.23, Deposit, Interest Paid",
  "2026-01-21, 09:30:00, -200.00, Withdrawal, Online Transfer to CHK",
].join("\n");

const PAYPAL = [
  '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","Balance Impact"',
  '"01/05/2026","10:00:00","EST","Mealkit Co","PreApproved Payment Bill User Payment","Completed","USD","-40.73","0.00","-40.73","x@example.com","Debit"',
  '"01/05/2026","10:00:01","EST","","General Card Deposit","Completed","USD","40.73","0.00","40.73","","Credit"',
  '"01/06/2026","11:00:00","EST","Some Shop","General Authorization","Pending","USD","-10.00","0.00","-10.00","","Memo"',
  '"01/07/2026","12:00:00","EST","Friend","General Payment","Completed","USD","25.00","-1.03","23.97","","Credit"',
].join("\n");

describe("bank CSV presets", () => {
  it("detects each preset by header", () => {
    const hdr = (csv: string) => (csv.split("\n")[0] ?? "").replace(/"/g, "").split(/,\s*/);
    expect(detectCsvPreset(hdr(CHASE_CHECKING))?.id).toBe("chase_checking");
    expect(detectCsvPreset(hdr(CHASE_CARD))?.id).toBe("chase_card");
    expect(detectCsvPreset(hdr(ALLY))?.id).toBe("ally");
    expect(detectCsvPreset(hdr(PAYPAL))?.id).toBe("paypal");
    expect(detectCsvPreset(["Foo", "Bar"])).toBeNull();
  });

  it("parses Chase checking and takes the last 4 from the filename", () => {
    const r = parseBankCsv(CHASE_CHECKING, { filename: "Chase1234_Activity_20260120.CSV" });
    expect(r.errors).toEqual([]);
    expect(r.accounts).toEqual([
      expect.objectContaining({ institutionName: "Chase", mask: "1234", type: "checking" }),
    ]);
    expect(r.transactions.map((t) => [t.postedDate, t.amountCents, t.rawDescription])).toEqual([
      ["2026-01-15", -5421, "EXAMPLE GROCERY #123"],
      ["2026-01-14", 250000, "ACME CORP PAYROLL PPD ID: 000"],
    ]);
  });

  it("parses Chase card with post/transaction dates, category and memo", () => {
    const r = parseBankCsv(CHASE_CARD, { filename: "Chase9999_Activity.CSV" });
    expect(r.accounts[0]).toMatchObject({ type: "credit", mask: "9999" });
    const [stream, payment, cafe] = r.transactions;
    expect(stream).toMatchObject({
      postedDate: "2026-01-11",
      authorizedDate: "2026-01-10",
      amountCents: -1599,
      categoryName: "Entertainment",
    });
    expect(payment).toMatchObject({ amountCents: 50000, authorizedDate: null, categoryName: null });
    expect(cafe).toMatchObject({ notes: "extra shot", categoryName: "Food & Drink" });
  });

  it("parses Ally with padded headers", () => {
    const r = parseBankCsv(ALLY, { filename: "transactions.csv" });
    expect(r.accounts[0]).toMatchObject({ institutionName: "Ally Bank", mask: null });
    expect(r.transactions.map((t) => t.amountCents)).toEqual([123, -20000]);
  });

  it("parses PayPal: completed rows only, Net amount, Type when Name is empty", () => {
    const r = parseBankCsv(PAYPAL, { filename: "Download.CSV" });
    expect(r.transactions.map((t) => [t.rawDescription, t.amountCents])).toEqual([
      ["Mealkit Co", -4073],
      ["General Card Deposit", 4073],
      ["Friend", 2397],
    ]);
    expect(r.transactions[0]?.notes).toBe("PreApproved Payment Bill User Payment");
    expect(r.transactions[1]?.notes).toBeNull();
  });
});

describe("generic bank CSV", () => {
  it("guesses debit/credit columns and the date format", () => {
    const csv = [
      "Transaction Date,Description,Debit,Credit,Running Balance",
      "15/01/2026,Groceries,54.21,,100",
      "16/01/2026,Salary,,2500.00,2600",
    ].join("\n");
    const r = parseBankCsv(csv, { filename: "my_bank_export_2026.csv" });
    expect(r.preset).toBeNull();
    expect(r.mapping).toMatchObject({
      date: "Transaction Date",
      dateFormat: "DD/MM/YYYY",
      debit: "Debit",
      credit: "Credit",
    });
    expect(r.accounts[0]?.name).toBe("my bank");
    expect(r.transactions.map((t) => t.amountCents)).toEqual([-5421, 250000]);
  });

  it("returns no mapping when it can't find the columns", () => {
    const r = parseBankCsv("Foo,Bar\n1,2", { filename: "x.csv" });
    expect(r.mapping).toBeNull();
    expect(r.transactions).toEqual([]);
    expect(r.headers).toEqual(["Foo", "Bar"]);
  });

  it("honours an explicit mapping, including negate", () => {
    const csv = "When,What,How much\n2026-01-02,Coffee,4.50\n2026-01-03,Refund,-2.00";
    expect(guessCsvMapping(["When", "What", "How much"], [])).toBeNull();
    const r = parseBankCsv(csv, {
      filename: "card.csv",
      mapping: {
        date: "When",
        dateFormat: "YYYY-MM-DD",
        description: "What",
        amount: "How much",
        negate: true,
      },
    });
    expect(r.transactions.map((t) => t.amountCents)).toEqual([-450, 200]);
  });

  it("reports bad rows and unknown columns", () => {
    const csv = "Date,Description,Amount\n2026-01-01,A,1\nnope,B,2\n2026-01-03,C,abc";
    const r = parseBankCsv(csv, { filename: "x.csv" });
    expect(r.transactions).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);

    const bad = parseBankCsv(csv, {
      filename: "x.csv",
      mapping: { date: "Date", dateFormat: "YYYY-MM-DD", description: "Nope", amount: "Amount" },
    });
    expect(bad.errors[0]?.message).toMatch(/"Nope" isn't in this file/);
  });
});
