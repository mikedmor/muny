import { describe, expect, it } from "vitest";
import {
  addInterval,
  detectRecurring,
  monthlyCents,
  occurrencesBetween,
  type RecurringInput,
} from "./detect.js";

let n = 0;
const tx = (key: string, date: string, amountCents: number, accountId = "a1"): RecurringInput => ({
  id: `t${++n}`,
  key,
  date,
  amountCents,
  accountId,
});

const monthly = (
  key: string,
  start: string,
  count: number,
  amount: number | ((i: number) => number),
) =>
  Array.from({ length: count }, (_, i) =>
    tx(key, addInterval(start, "monthly", i), typeof amount === "number" ? amount : amount(i)),
  );

describe("addInterval", () => {
  it("handles month ends and years", () => {
    expect(addInterval("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(addInterval("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(addInterval("2026-11-15", "quarterly")).toBe("2027-02-15");
    expect(addInterval("2024-02-29", "annual")).toBe("2025-02-28");
    expect(addInterval("2026-01-01", "biweekly")).toBe("2026-01-15");
  });
});

describe("detectRecurring", () => {
  const today = "2026-06-20";

  it("finds a fixed monthly subscription, tolerating a few days of drift", () => {
    const rows = [
      tx("streamflix", "2026-01-05", -1599),
      tx("streamflix", "2026-02-05", -1599),
      tx("streamflix", "2026-03-07", -1599),
      tx("streamflix", "2026-04-05", -1599),
      tx("streamflix", "2026-05-04", -1599),
      tx("streamflix", "2026-06-05", -1599),
    ];
    const [s] = detectRecurring(rows, today);
    expect(s).toMatchObject({
      key: "streamflix",
      direction: "out",
      interval: "monthly",
      fixedAmount: true,
      expectedAmountCents: -1599,
      lastDate: "2026-06-05",
      nextDate: "2026-07-05",
      active: true,
    });
    expect(s?.transactionIds).toHaveLength(6);
    expect(monthlyCents(-1599, "annual")).toBe(-133);
  });

  it("keeps a price increase in the same series and uses the new price", () => {
    const rows = monthly("music", "2026-01-10", 6, (i) => (i < 3 ? -1099 : -1199));
    const [s] = detectRecurring(rows, today);
    expect(s).toMatchObject({ interval: "monthly", expectedAmountCents: -1199, fixedAmount: true });
  });

  it("splits one merchant with two plans into two series", () => {
    const rows = [
      ...monthly("apple", "2026-01-03", 5, -299),
      ...monthly("apple", "2026-01-17", 5, -1099),
    ];
    const found = detectRecurring(rows, today);
    expect(found.map((f) => f.expectedAmountCents).sort((a, b) => a - b)).toEqual([-1099, -299]);
  });

  it("accepts variable monthly bills but not variable weekly shopping", () => {
    const electric = monthly(
      "power co",
      "2026-01-12",
      6,
      (i) => -([9850, 11200, 8730, 7600, 9120, 12480][i] ?? 0),
    );
    const groceries = Array.from({ length: 10 }, (_, i) =>
      tx(
        "kroger",
        addInterval("2026-03-01", "weekly", i),
        -([4520, 8810, 6230, 12040, 3399, 7712, 9020, 5001, 6650, 11000][i] ?? 0),
      ),
    );
    const found = detectRecurring([...electric, ...groceries], today);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: "power co", fixedAmount: false, interval: "monthly" });
  });

  it("detects annual renewals and biweekly paychecks", () => {
    const rows = [
      tx("domain registrar", "2024-08-01", -1500),
      tx("domain registrar", "2025-08-02", -1500),
      ...Array.from({ length: 8 }, (_, i) =>
        tx("acme payroll", addInterval("2026-02-06", "biweekly", i), 250000),
      ),
    ];
    const found = detectRecurring(rows, today);
    expect(found.find((f) => f.key === "domain registrar")).toMatchObject({
      interval: "annual",
      nextDate: "2026-08-02",
      active: true,
    });
    expect(found.find((f) => f.key === "acme payroll")).toMatchObject({
      interval: "biweekly",
      direction: "in",
    });
  });

  it("ignores irregular purchases and marks old series inactive", () => {
    const irregular = ["2026-01-02", "2026-01-09", "2026-02-27", "2026-03-01", "2026-05-15"].map(
      (d) => tx("hardware", d, -2500),
    );
    const old = monthly("old gym", "2024-01-01", 8, -2999);
    const found = detectRecurring([...irregular, ...old], today);
    expect(found.map((f) => f.key)).toEqual(["old gym"]);
    expect(found[0]?.active).toBe(false);
  });

  it("tolerates one missed month", () => {
    const rows = ["2026-01-08", "2026-02-08", "2026-04-08", "2026-05-08", "2026-06-08"].map((d) =>
      tx("cloud", d, -500),
    );
    expect(detectRecurring(rows, today)[0]?.interval).toBe("monthly");
  });

  it("lists occurrences in a window", () => {
    expect(occurrencesBetween("2026-07-05", "monthly", "2026-06-20", "2026-09-30")).toEqual([
      "2026-07-05",
      "2026-08-05",
      "2026-09-05",
    ]);
    expect(occurrencesBetween("2026-07-01", "weekly", "2026-07-10", "2026-07-20")).toEqual([
      "2026-07-15",
    ]);
  });
});
