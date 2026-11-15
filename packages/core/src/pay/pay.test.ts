import { describe, expect, it } from "vitest";
import { amountCents, type PdfItem, tidyName } from "./pdf.js";
import { readAdpStub, stubProblems } from "./stub.js";
import { employerKey, HEALTH_PREMIUMS, latestPeriod, payBreakdown, w2Check } from "./summary.js";
import { readW2 } from "./w2.js";

// Synthetic forms only: a made-up employer, person and amounts, laid out where
// ADP puts things (digit groups drawn apart, headings drawn as graphics).

/** Rough widths at 9pt: digits and signs about 5 points, letters nearer 3.7. */
const width = (s: string, size = 9) =>
  ([...s].reduce((t, c) => t + (/[\d$*,.-]/.test(c) ? 5 : 3.7), 0) * size) / 9;
const item = (s: string, x: number, y: number, size = 9): PdfItem => ({
  s,
  x,
  y,
  w: width(s, size),
  size,
});
const words = (s: string, x: number, y: number) => item(s, x, y);

/** An amount the way ADP sets it: digit groups right-aligned to `right`, about 5 points apart. */
function adp(text: string, right: number, y: number): PdfItem[] {
  const m = text.match(/^([-$]*)([\d,]+)\.(\d{2})(\*?)$/);
  if (!m) throw new Error(text);
  const groups = (m[2] as string).split(",");
  groups[0] = `${m[1]}${groups[0]}`;
  const parts = [...groups, `${m[3]}${m[4]}`];
  const out: PdfItem[] = [];
  let r = right;
  for (const p of parts.reverse()) {
    const it = item(p, r - width(p), y);
    out.push(it);
    r = it.x - 5;
  }
  return out;
}

const THIS = 256;
const YTD = 336;
const INFO_THIS = 505;
const INFO_TOTAL = 586;

function stubItems(o: { payDate?: string; medical?: string } = {}): PdfItem[] {
  const medical = o.medical ?? "-180.00*";
  return [
    words("Earnings Statement", 350, 759),
    words("NORTHWIND PARTS", 100, 736),
    words(", LLC", 187, 736),
    words("Period Beginning:", 354, 736),
    words("03/01/2026", 455, 736),
    words("Period Ending:", 354, 724),
    words("03/07/2026", 455, 724),
    words("Pay Date:", 354, 712),
    words(o.payDate ?? "03/13/2026", 455, 712),
    words("ALEX SAMPLE", 372, 670),
    // Column headings
    words("rate", 131, 600),
    words("salary/hours", 155, 600),
    words("this", 212, 600),
    words("period", 231, 600),
    words("year", 282, 600),
    words("to", 304, 600),
    words("date", 316, 600),
    words("Regular", 21, 587),
    ...adp("2,000.00", 145, 587),
    ...adp("40.00", 190, 587),
    ...adp("2,000.00", THIS, 587),
    ...adp("88,000.00", YTD, 587),
    words("Your", 364, 581),
    words("federal taxable wages this period are", 388, 581),
    words("Bonus Plan", 21, 575),
    ...adp("2,000.00", YTD, 575),
    ...adp("$1,800.00", 409, 569),
    words("Gross Pay", 95, 563),
    ...adp("$2,000.00", THIS, 563),
    ...adp("90,000.00", YTD, 563),
    words("Other", 354, 550),
    words("Benefits", 384, 550),
    words("and", 426, 550),
    words("this", 464, 540),
    words("period", 482, 540),
    words("total", 534, 540),
    words("to", 555, 540),
    words("date", 567, 540),
    words("Statutory", 95, 533),
    words("Gtl", 354, 527),
    ...adp("1.20", INFO_THIS, 527),
    ...adp("50.40", INFO_TOTAL, 527),
    words("Federal Income Tax", 95, 521),
    ...adp("-150.00", THIS, 521),
    ...adp("6,750.00", YTD, 521),
    words("Social Security Tax", 95, 509),
    ...adp("-115.00", THIS, 509),
    ...adp("5,175.00", YTD, 509),
    words("Vac Balance", 354, 509),
    ...adp("24.00", INFO_TOTAL, 509),
    words("Medicare Tax", 95, 497),
    ...adp("-26.90", THIS, 497),
    ...adp("1,210.50", YTD, 497),
    words("OH", 95, 485),
    words("State Income Tax", 112, 485),
    ...adp("-55.10", THIS, 485),
    ...adp("2,479.50", YTD, 485),
    // (the "Other" deductions heading is a graphic: a blank line here)
    words("Dental", 95, 455),
    ...adp("-20.00*", THIS + 4, 455),
    ...adp("900.00", YTD, 455),
    words("Long Term Disab", 95, 443),
    ...adp("-6.00", THIS, 443),
    words("Medical", 95, 431),
    ...adp(medical, THIS + 4, 431),
    ...adp("8,100.00", YTD, 431),
    words("Vol Life", 95, 419),
    ...adp("-4.00", THIS, 419),
    ...adp("180.00", YTD, 419),
    words("Net Pay", 95, 401),
    ...adp("$1,443.00", THIS, 401),
    words("Checking", 95, 389),
    ...adp("-1,393.00", THIS, 389),
    ...adp("60,000.00", YTD, 389),
    words("Checking", 95, 377),
    ...adp("-50.00", THIS, 377),
    words("Net Check", 95, 359),
    ...adp("$0.00", THIS, 359),
    words("Excluded from federal taxable wages", 105, 330),
    words("Pay date:", 354, 189),
    words("03/13/2026", 465, 189),
    words("xxxxx1234", 350, 130),
    words("xxxx", 441, 130),
    words("xxxx", 466, 130),
    ...adp("$1,393.00", 587, 130),
    words("xxxx5678", 350, 119),
    words("xxxx", 441, 119),
    words("xxxx", 466, 119),
    ...adp("$50.00", 587, 119),
  ];
}

describe("amounts", () => {
  it("reads ADP digit groups and plain amounts", () => {
    expect(amountCents("3 125 50")).toBe(312550);
    expect(amountCents("-42 10")).toBe(-4210);
    expect(amountCents("-18 05*")).toBe(-1805);
    expect(amountCents("$1 482 16")).toBe(148216);
    expect(amountCents("64,210.75")).toBe(6421075);
    expect(amountCents("64210.75")).toBe(6421075);
    expect(amountCents("0000123456")).toBeNull();
    expect(amountCents("03/13/2026")).toBeNull();
  });

  it("tidies employer names", () => {
    expect(tidyName("NORTHWIND PARTS , LLC")).toBe("Northwind Parts, LLC");
    expect(employerKey("Northwind Parts, LLC")).toBe(employerKey("NORTHWIND PARTS LLC"));
  });
});

describe("ADP pay stub", () => {
  it("reads earnings, taxes, deductions and deposits, and adds up", () => {
    const s = readAdpStub(stubItems());
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.employer).toBe("Northwind Parts, LLC");
    expect([s.periodStart, s.periodEnd, s.payDate]).toEqual([
      "2026-03-01",
      "2026-03-07",
      "2026-03-13",
    ]);
    expect(s.grossCents).toBe(200000);
    expect(s.ytdGrossCents).toBe(9000000);
    expect(s.netCents).toBe(144300);
    expect(s.federalTaxableCents).toBe(180000);
    const by = (kind: string) =>
      s.lines.filter((l) => l.kind === kind).map((l) => [l.name, l.cents, l.ytdCents]);
    expect(by("earning")).toEqual([
      ["Regular", 200000, 8800000],
      ["Bonus Plan", null, 200000],
    ]);
    expect(by("tax")).toEqual([
      ["Federal Income Tax", 15000, 675000],
      ["Social Security Tax", 11500, 517500],
      ["Medicare Tax", 2690, 121050],
      ["OH State Income Tax", 5510, 247950],
    ]);
    expect(by("deduction")).toEqual([
      ["Dental", 2000, 90000],
      ["Long Term Disab", 600, null],
      ["Medical", 18000, 810000],
      ["Vol Life", 400, 18000],
    ]);
    expect(s.lines.filter((l) => l.preTax).map((l) => l.name)).toEqual(["Dental", "Medical"]);
    expect(by("info")).toEqual([
      ["Gtl", 120, 5040],
      ["Vac Balance", null, 2400],
    ]);
    expect(s.deposits).toEqual([
      { cents: 139300, last4: "1234" },
      { cents: 5000, last4: "5678" },
    ]);
    expect(s.checkCents).toBe(0);
    expect(stubProblems(s)).toEqual([]);
  });

  it("says when a stub doesn't add up", () => {
    const s = readAdpStub(stubItems({ medical: "-181.00*" }));
    expect(s && stubProblems(s)).toEqual([
      "Gross pay less taxes and deductions is $1,442.00, not the net pay of $1,443.00.",
    ]);
  });

  it("isn't fooled by other PDFs", () => {
    expect(
      readAdpStub([words("Statement of account", 10, 700), words("Pay Date:", 10, 690)]),
    ).toBeNull();
  });
});

/** A W-2 laid out like ADP's: the earnings summary at the top right, then the copies. */
function w2Items(): PdfItem[] {
  return [
    item("2026 W-2 and EARNINGS SUMMARY", 281, 772, 15),
    item("c", 9, 699, 6),
    item("Employer’s name, address, and ZIP code", 21, 699, 6),
    words("NORTHWIND PARTS LLC", 34, 689),
    item("Gross Pay", 229, 610, 7),
    item("100", 355, 610, 7),
    item("000", 372, 610, 7),
    item("00", 389, 610, 7),
    item("100", 414, 610, 7),
    item("000", 431, 610, 7),
    item("00", 449, 610, 7),
    item("Plus", 210, 600, 8),
    item("GTL (C-Box 12)", 229, 600, 7),
    item("50", 376, 600, 7),
    item("40", 389, 600, 7),
    item("Less", 210, 590, 8),
    item("Other Cafe 125", 229, 590, 7),
    item("10", 359, 590, 7),
    item("400", 372, 590, 7),
    item("00", 389, 590, 7),
    item("1", 10, 570, 6),
    item("Wages, tips, other comp.", 20, 570, 6),
    item("2", 106, 570, 6),
    item("Federal income tax withheld", 114, 570, 6),
    item("89650.40", 58, 560, 8),
    item("7000.00", 165, 560, 8),
    item("3", 10, 553, 6),
    item("Social security wages", 19, 552, 6),
    item("4", 106, 553, 6),
    item("Social security tax withheld", 115, 553, 6),
    item("89650.40", 58, 544, 8),
    item("5558.32", 165, 544, 8),
    item("5", 10, 536, 6),
    item("Medicare wages and tips", 19, 536, 6),
    item("6", 106, 536, 6),
    item("Medicare tax withheld", 114, 536, 6),
    item("89650.40", 58, 528, 8),
    item("1299.93", 165, 528, 8),
    item("C", 122, 483, 8),
    item("50.40", 167, 483, 8),
    item("12b DD", 104, 470, 6),
    item("20000.00", 160, 470, 8),
    item("15 State Employer’s state ID no. 16 State wages, tips, etc.", 9, 440, 6),
    item("OH", 12, 430, 8),
    item("000123456", 40, 430, 8),
    item("89650.40", 150, 430, 8),
    item("17 State income tax", 9, 420, 6),
    item("18 Local wages, tips, etc.", 104, 420, 6),
    item("3200.00", 60, 410, 8),
    item("19 Local income tax", 9, 400, 6),
    item("20 Locality name", 104, 400, 6),
  ];
}

describe("W-2", () => {
  it("reads the boxes and ADP's summary", () => {
    const w = readW2(w2Items());
    expect(w).toEqual({
      year: 2026,
      employer: "Northwind Parts LLC",
      boxes: {
        wagesCents: 8965040,
        federalCents: 700000,
        ssWagesCents: 8965040,
        ssCents: 555832,
        medicareWagesCents: 8965040,
        medicareCents: 129993,
        state: "OH",
        stateWagesCents: 8965040,
        stateCents: 320000,
        localWagesCents: null,
        localCents: null,
      },
      box12: [
        { code: "C", cents: 5040 },
        { code: "DD", cents: 2000000 },
      ],
      summary: {
        grossCents: 10000000,
        adjustments: [
          { name: "GTL (C-Box 12)", cents: 5040 },
          { name: "Other Cafe 125", cents: -1040000 },
        ],
      },
    });
  });
});

describe("a year of pay", () => {
  const march = readAdpStub(stubItems()) as NonNullable<ReturnType<typeof readAdpStub>>;
  const earlier = readAdpStub(stubItems({ payDate: "03/06/2026" })) as typeof march;

  it("takes the year so far from the latest stub, adding up lines with no year to date", () => {
    const b = payBreakdown(2026, [earlier, march], []);
    expect(b?.source).toBe("stubs");
    expect(b?.asOf).toBe("2026-03-13");
    expect(b?.grossCents).toBe(9000000);
    expect(b?.taxes.map((t) => [t.name, t.cents])).toEqual([
      ["Federal Income Tax", 675000],
      ["Social Security Tax", 517500],
      ["OH State Income Tax", 247950],
      ["Medicare Tax", 121050],
    ]);
    expect(b?.deductions).toContainEqual({ name: "Long Term Disab", cents: 1200, fromStubs: true });
    expect(b?.deductions).toContainEqual({ name: "Medical", cents: 810000, preTax: true });
    const out = [...(b?.taxes ?? []), ...(b?.deductions ?? [])].reduce((t, a) => t + a.cents, 0);
    expect(b?.takeHomeCents).toBe(9000000 - out);
  });

  it("uses a W-2 alone for a year with no stubs", () => {
    const w = readW2(w2Items()) as NonNullable<ReturnType<typeof readW2>>;
    const b = payBreakdown(2026, [], [w]);
    expect(b?.source).toBe("w2");
    expect(b?.grossCents).toBe(10000000);
    expect(b?.deductions).toEqual([{ name: HEALTH_PREMIUMS, cents: 1040000, preTax: true }]);
    expect(b?.healthCoverageCents).toBe(2000000);
    expect(b?.yourHealthCents).toBe(1040000);
    expect(b?.employerHealthCents).toBe(960000);
    expect(b?.takeHomeCents).toBe(10000000 - 700000 - 555832 - 129993 - 320000 - 1040000);
  });

  it("shows the latest period and checks a W-2 against the last stub", () => {
    const p = latestPeriod([earlier, march]);
    expect(p?.periodsPerYear).toBe(52);
    expect(p?.netCents).toBe(144300);
    expect(p?.deductionsCents).toBe(21000);
    const w = readW2(w2Items()) as NonNullable<ReturnType<typeof readW2>>;
    const c = w2Check(w, [earlier, march]);
    expect(c?.stubDate).toBe("2026-03-13");
    expect(c?.rows).toContainEqual({
      label: "Federal income tax (box 2)",
      w2Cents: 700000,
      stubCents: 675000,
    });
    expect(c?.rows).toContainEqual({
      label: "OH income tax (box 17)",
      w2Cents: 320000,
      stubCents: 247950,
    });
  });
});
