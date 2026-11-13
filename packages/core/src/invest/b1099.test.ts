import { describe, expect, it } from "vitest";
import {
  describeSale,
  moneyCents,
  parse1099bCsv,
  parseTxf,
  read1099bSummary,
  summarize1099b,
  taxDate,
  totalsByTerm,
} from "./b1099.js";

// Synthetic forms only: made-up tickers and amounts.

const TXF = `V042
AExample Broker Tax Export
D02/10/2027
^
TD
N321
C1
L1
P100 sh. XYZ
D01/05/2026
D06/01/2026
$1000.00
$1250.00
^
TD
N321
C1
L1
P50 ABC
D03/02/2026
D04/15/2026
$1,500.00
$1,300.00
$200.00
^
TD
N713
C1
L1
P10 sh. QRS
DVarious
D09/09/2026
$
$900.00
^
`;

describe("1099-B readers", () => {
  it("reads money, dates and descriptions", () => {
    expect(moneyCents("$1,234.56")).toBe(123_456);
    expect(moneyCents("(45.00)")).toBe(-4_500);
    expect(moneyCents("12.3")).toBe(1_230);
    expect(moneyCents("abc")).toBeNull();
    expect(taxDate("1/5/26")).toBe("2026-01-05");
    expect(taxDate("VARIOUS")).toBeNull();
    expect(describeSale("100 sh. XYZ")).toEqual({ symbol: "XYZ", quantity: "100" });
    expect(describeSale("SAMPLE ROBOTICS INC (SRBT)")).toEqual({ symbol: "SRBT", quantity: null });
  });

  it("reads TXF records: box, cost, proceeds and wash sale", () => {
    const sales = parseTxf(TXF);
    expect(sales).toHaveLength(3);
    expect(sales?.[0]).toMatchObject({
      box: "A",
      term: "short",
      symbol: "XYZ",
      quantity: "100",
      acquired: "2026-01-05",
      sold: "2026-06-01",
      costCents: 100_000,
      proceedsCents: 125_000,
      washCents: 0,
    });
    expect(sales?.[1]).toMatchObject({
      costCents: 150_000,
      proceedsCents: 130_000,
      washCents: 20_000,
    });
    expect(sales?.[2]).toMatchObject({ box: "E", term: "long", acquired: null, costCents: null });
    const sum = summarize1099b(sales ?? []);
    // A: +$250 gain, and a $200 loss fully disallowed by the wash sale.
    expect(sum.A).toMatchObject({
      proceedsCents: 255_000,
      costCents: 250_000,
      washCents: 20_000,
      gainCents: 25_000,
      count: 2,
    });
    expect(totalsByTerm(sales ?? []).long.count).toBe(1);
    expect(parseTxf("Date,Amount\n1,2")).toBeNull();
  });

  it("finds a CSV's columns by their headers", () => {
    const csv = `Realized Gain/Loss for 2026
Description,Symbol,Quantity,Date Acquired,Date Sold,Proceeds,Cost Basis,Wash Sale Loss Disallowed,Gain/Loss,Term,Form 8949 Box
XYZ CORP,XYZ,100,01/05/2026,06/01/2026,"$1,250.00","$1,000.00",,$250.00,Short Term,A
QRS INC,QRS,10,Various,09/09/2026,$900.00,,,,Long Term,
Total,,,,,"$2,150.00",,,,,
`;
    const sales = parse1099bCsv(csv);
    expect(sales).toHaveLength(2);
    expect(sales?.[0]).toMatchObject({
      box: "A",
      term: "short",
      symbol: "XYZ",
      costCents: 100_000,
      proceedsCents: 125_000,
    });
    expect(sales?.[1]).toMatchObject({ box: "?", term: "long", acquired: null, costCents: null });
    expect(parse1099bCsv("a,b\n1,2")).toBeNull();
  });

  it("reads PDF summary lines only when their numbers add up", () => {
    const lines = [
      ["Summary of Proceeds, Gains & Losses"],
      [
        "Short-term transactions for which basis is reported to the IRS (A)",
        "12,500.00",
        "10,000.00",
        "0.00",
        "150.00",
        "2,650.00",
      ],
      ["Long-term, basis not reported (E)", "900.00", "0.00", "900.00"],
      // Doesn't add up: not a summary line.
      ["Box D long term", "1,000.00", "800.00", "50.00"],
    ];
    const s = read1099bSummary(lines);
    expect(s.A).toMatchObject({
      proceedsCents: 1_250_000,
      costCents: 1_000_000,
      washCents: 15_000,
      gainCents: 265_000,
    });
    expect(s.E).toMatchObject({ proceedsCents: 90_000, gainCents: 90_000 });
    expect(s.D).toBeUndefined();
  });
});
