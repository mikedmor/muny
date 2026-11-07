import { describe, expect, it } from "vitest";
import type { CardDoc, CardQuery } from "./doc.js";
import { type DataRow, resolveRange, runCardDoc } from "./engine.js";
import { ExprError, parseExpr } from "./expr.js";
import { formatCell } from "./format.js";
import * as R from "./rational.js";

const TODAY = "2026-11-15";

const tx = (date: string, cents: number, category: string, merchant = "Shop"): DataRow => ({
  date,
  amount: -cents,
  spending: cents,
  income: 0,
  category,
  merchant,
  account: "Everyday",
  pending: false,
  is_transfer: false,
  notes: null,
});

const pay = (date: string, cents: number): DataRow => ({
  date,
  amount: cents,
  spending: 0,
  income: cents,
  category: "Paycheck",
  merchant: "Employer",
  account: "Everyday",
  pending: false,
  is_transfer: false,
  notes: null,
});

const ROWS: Record<string, DataRow[]> = {
  transactions: [
    tx("2026-11-01", 1000, "Groceries", "Corner Market"),
    tx("2026-11-03", 2550, "Groceries", "Corner Market"),
    tx("2026-11-03", 999, "Dining", "Noodle Bar"),
    tx("2026-11-10", 4001, "Fun", "Arcade"),
    tx("2026-10-02", 5000, "Groceries", "Corner Market"),
    tx("2026-10-20", 3000, "Dining", "Noodle Bar"),
    pay("2026-11-05", 100_000),
    pay("2026-10-05", 90_000),
  ],
  accounts: [
    { name: "Everyday", type: "checking", balance: 250_000, owed: 0, is_debt: false },
    { name: "Visa", type: "credit", balance: -50_000, owed: 50_000, is_debt: true },
  ],
};

const provider = (dataset: string) => ROWS[dataset] ?? [];

function run(query: CardQuery) {
  const doc: CardDoc = {
    v: 2,
    blocks: [{ id: "b", kind: "table", w: 12, query }],
  };
  const result = runCardDoc(doc, provider, TODAY).blocks.b;
  if (result?.error) throw new Error(result.error);
  return result?.queries[0] as NonNullable<typeof result>["queries"][number];
}

describe("exact arithmetic", () => {
  it("never loses a cent", () => {
    // 0.1 + 0.2 is the classic float failure.
    const sum = R.add(R.fromCents(10), R.fromCents(20));
    expect(R.toCents(sum)).toBe(30);
    expect(R.cmp(sum, R.fromDecimal("0.3") as R.Rat)).toBe(0);
    // A third of a dollar, three times, is a dollar exactly.
    const third = R.div(R.fromCents(100), R.rat(3)) as R.Rat;
    expect(R.toCents(R.mul(third, R.rat(3)))).toBe(100);
  });

  it("rounds halves away from zero", () => {
    expect(R.toCents(R.fromDecimal("1.005") as R.Rat)).toBe(101);
    expect(R.toCents(R.fromDecimal("-1.005") as R.Rat)).toBe(-101);
  });

  it("reads decimals exactly and refuses nonsense", () => {
    expect(R.ratToString(R.fromDecimal("0.00000123") as R.Rat)).toBe("0.000001");
    expect(R.fromDecimal("1e3")).toEqual(R.rat(1000));
    expect(R.fromDecimal("abc")).toBeNull();
    expect(R.fromDecimal("")).toBeNull();
  });

  it("doesn't grow without limit", () => {
    let v = R.ONE;
    for (let i = 3; i < 400; i += 2) v = R.add(v, R.div(R.ONE, R.rat(i)) as R.Rat);
    expect(v.d <= 10n ** 30n).toBe(true);
  });
});

describe("formulas", () => {
  it("parses what people write", () => {
    expect(() => parseExpr("sum([Spending]) / sum([Income]) * 100")).not.toThrow();
    expect(() => parseExpr('if($left < 0, "over", "under")')).not.toThrow();
    expect(() => parseExpr("[Amount] * 10%")).not.toThrow();
    expect(() => parseExpr("$100 + 2500.50")).not.toThrow();
  });

  it("explains mistakes", () => {
    expect(() => parseExpr("")).toThrow(ExprError);
    expect(() => parseExpr("sum(")).toThrow(ExprError);
    expect(() => parseExpr("nope(1)")).toThrow(/no function called nope/);
    expect(() => parseExpr("1 +")).toThrow(ExprError);
    expect(() => parseExpr("[Amount")).toThrow(/closing/);
    expect(() => parseExpr("abs(1, 2)")).toThrow(ExprError);
  });

  it("has no way to reach code", () => {
    for (const attack of [
      "constructor.constructor('return process')()",
      "process.env",
      "__proto__",
      "this.x",
      "eval('1')",
      "require('fs')",
    ]) {
      const doc: CardDoc = {
        v: 2,
        metrics: [{ id: "x", expr: attack }],
        blocks: [],
      };
      const out = runCardDoc(doc, provider, TODAY).metrics.x;
      expect(out && "error" in out, attack).toBe(true);
    }
  });

  it("caps size and nesting", () => {
    expect(() => parseExpr("1+".repeat(2000))).toThrow(/too long/);
    expect(() => parseExpr(`${"(".repeat(100)}1${")".repeat(100)}`)).toThrow(/too deeply/);
    expect(() => parseExpr(`${"abs(".repeat(100)}1${")".repeat(100)}`)).toThrow(/too deeply/);
  });
});

describe("queries", () => {
  it("groups, totals and orders largest first", () => {
    const q = run({
      dataset: "transactions",
      range: { preset: "this_month" },
      dimensions: [{ field: "category" }],
      measures: [{ id: "spent", field: "spending", agg: "sum" }],
      filters: [{ field: "spending", op: "gt", value: 0 }],
    });
    expect(q.rows).toEqual([
      ["Fun", 4001],
      ["Groceries", 3550],
      ["Dining", 999],
    ]);
    expect(q.totals.spent).toBe(8550);
    expect(q.columns[1]?.type).toBe("money");
  });

  it("works out formulas exactly, with money as dollars", () => {
    const q = run({
      dataset: "transactions",
      range: { preset: "this_month" },
      measures: [
        { id: "spent", field: "spending" },
        { id: "earned", field: "income" },
        { id: "rate", expr: "(earned - spent) / earned", format: "percent" },
        { id: "bonus", expr: "[Income] * 10% + 5" },
        { id: "large", expr: "count([Spending] > 25)" },
        { id: "groceries", expr: 'sum([Spending], [Category] = "groceries")' },
      ],
    });
    const [row] = q.rows;
    expect(row?.[0]).toBe(8550);
    expect(row?.[1]).toBe(100_000);
    expect(row?.[2]).toBeCloseTo(0.9145, 6);
    expect(row?.[3]).toBe(10_500);
    expect(row?.[4]).toBe(2);
    expect(row?.[5]).toBe(3550);
    expect(q.columns.map((c) => c.type)).toEqual([
      "money",
      "money",
      "percent",
      "money",
      "number",
      "money",
    ]);
  });

  it("buckets dates and fills the gaps", () => {
    const q = run({
      dataset: "transactions",
      range: { from: "2026-10-01", to: "2026-11-30" },
      filters: [{ field: "category", op: "eq", value: "Groceries" }],
      dimensions: [{ field: "date", bucket: "month" }],
      measures: [{ id: "spent", field: "spending" }],
      fill: true,
    });
    expect(q.rows).toEqual([
      ["2026-10", 5000],
      ["2026-11", 3550],
    ]);
    const days = run({
      dataset: "transactions",
      range: { preset: "this_month" },
      dimensions: [{ field: "date", bucket: "day" }],
      measures: [{ id: "spent", field: "spending" }],
      fill: true,
    });
    // Every day so far, and none in the future.
    expect(days.rows).toHaveLength(15);
    expect(days.rows[1]).toEqual(["2026-11-02", 0]);
  });

  it("does running totals per series, for a this-month-against-last chart", () => {
    const q = run({
      dataset: "transactions",
      range: { preset: "this_and_last_month" },
      dimensions: [
        { field: "date", bucket: "day_of_month" },
        { field: "date", bucket: "month", label: "Month" },
      ],
      measures: [{ id: "total", expr: "running_sum([Spending])" }],
      fill: true,
    });
    const series = (m: string) => q.rows.filter((r) => r[1] === m);
    // October has all its days; November stops today.
    expect(series("2026-10")).toHaveLength(31);
    expect(series("2026-11")).toHaveLength(15);
    expect(series("2026-11").at(-1)?.[2]).toBe(8550);
    expect(series("2026-10").at(-1)?.[2]).toBe(8000);
  });

  it("does the other over-rows functions", () => {
    const q = run({
      dataset: "transactions",
      dimensions: [{ field: "date", bucket: "month" }],
      measures: [
        { id: "spent", field: "spending" },
        { id: "change", expr: "diff(spent)" },
        { id: "share", expr: "pct_of_total(spent)" },
        { id: "rank", expr: "rank(spent)" },
        { id: "avg", expr: "moving_avg(spent, 2)" },
        { id: "before", expr: "prev(spent)" },
      ],
    });
    expect(q.rows[0]?.slice(1, 3)).toEqual([8000, null]);
    expect(q.rows[0]?.[3]).toBeCloseTo(8000 / 16550, 6);
    expect(q.rows[0]?.slice(4, 7)).toEqual([2, 8000, null]);
    const nov = q.rows[1];
    expect(nov?.[2]).toBe(550);
    expect(nov?.[4]).toBe(1);
    expect(nov?.[5]).toBe(8275);
    expect(nov?.[6]).toBe(8000);
  });

  it("limits, and folds the rest into Other", () => {
    const q = run({
      dataset: "transactions",
      filters: [{ field: "spending", op: "gt", value: 0 }],
      dimensions: [{ field: "merchant" }],
      measures: [{ id: "spent", field: "spending" }],
      limit: 1,
      other: true,
    });
    expect(q.rows).toEqual([
      ["Corner Market", 8550],
      ["Other", 8000],
    ]);
  });

  it("lists raw rows newest first", () => {
    const q = run({
      dataset: "transactions",
      raw: true,
      dimensions: [{ field: "merchant" }, { field: "date" }],
      measures: [{ id: "amount", field: "amount" }],
      limit: 2,
    });
    expect(q.rows.map((r) => r[1])).toEqual(["2026-11-10", "2026-11-05"]);
    expect(q.rows[0]?.[2]).toBe(-4001);
  });

  it("calculates per row, including as a grouping", () => {
    const q = run({
      dataset: "transactions",
      calculated: [{ id: "size", expr: 'if([Spending] >= 30, "Big", "Small")' }],
      filters: [{ field: "spending", op: "gt", value: 0 }],
      dimensions: [{ field: "size" }],
      measures: [{ id: "n", agg: "count" }],
    });
    expect(q.rows).toEqual(
      expect.arrayContaining([
        ["Big", 3],
        ["Small", 3],
      ]),
    );
  });

  it("filters with money in dollars and text in any case", () => {
    const q = run({
      dataset: "transactions",
      filters: [
        { field: "spending", op: "gte", value: "25.50" },
        { field: "category", op: "in", value: ["GROCERIES"] },
      ],
      measures: [{ id: "n", agg: "count" }],
    });
    expect(q.rows[0]?.[0]).toBe(2);
  });

  it("ignores a filter you haven't filled in yet, and reads money as you'd write it", () => {
    const all = run({ dataset: "transactions", measures: [{ id: "n", agg: "count" }] });
    const blank = run({
      dataset: "transactions",
      filters: [{ field: "category", op: "eq", value: "" }],
      measures: [{ id: "n", agg: "count" }],
    });
    expect(blank.rows).toEqual(all.rows);
    const typed = run({
      dataset: "transactions",
      filters: [{ field: "income", op: "gte", value: "$1,000" }],
      measures: [{ id: "n", agg: "count" }],
    });
    expect(typed.rows[0]?.[0]).toBe(1);
  });

  it("stays quick on a lot of rows", () => {
    const many: DataRow[] = Array.from({ length: 30_000 }, (_, i) => ({
      date: `2026-${String((i % 12) + 1).padStart(2, "0")}-15`,
      amount: -(i % 500),
      spending: i % 500,
      merchant: `Shop ${i % 3000}`,
    }));
    const doc: CardDoc = {
      v: 2,
      blocks: [
        {
          id: "b",
          kind: "table",
          w: 12,
          query: {
            dataset: "transactions",
            calculated: [{ id: "half", expr: "[Spending] / 2" }],
            dimensions: [{ field: "merchant" }],
            measures: [
              { id: "spent", field: "spending" },
              { id: "half_total", expr: "sum([half])" },
              { id: "rank", expr: "rank(spent)" },
              { id: "share", expr: "pct_of_total(spent)" },
            ],
          },
        },
      ],
    };
    const started = Date.now();
    const out = runCardDoc(doc, () => many, TODAY).blocks.b;
    expect(out?.error).toBeUndefined();
    expect(out?.queries[0]?.rows.length).toBe(2000);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("doesn't fill in an enormous grid", () => {
    const rows: DataRow[] = Array.from({ length: 3000 }, (_, i) => ({
      date: "2026-11-01",
      spending: 100,
      merchant: `Shop ${i}`,
    }));
    const out = runCardDoc(
      {
        v: 2,
        blocks: [
          {
            id: "b",
            kind: "line",
            w: 12,
            query: {
              dataset: "transactions",
              range: { from: "2025-01-01", to: "2026-11-15" },
              dimensions: [{ field: "date", bucket: "day" }, { field: "merchant" }],
              measures: [{ id: "spent", field: "spending" }],
              fill: true,
            },
          },
        ],
      },
      () => rows,
      TODAY,
    ).blocks.b;
    expect(out?.queries[0]?.rows.length).toBe(2000);
    expect(out?.queries[0]?.truncated).toBe(true);
  });

  it("totals ratios properly rather than adding them", () => {
    const q = run({
      dataset: "transactions",
      dimensions: [{ field: "date", bucket: "month" }],
      measures: [{ id: "avg", expr: "avg([Income], [Income] > 0)" }],
    });
    expect(q.totals.avg).toBe(95_000);
  });

  it("names the mistake when a field doesn't exist", () => {
    expect(() =>
      run({ dataset: "transactions", dimensions: [{ field: "nope" }], measures: [] }),
    ).toThrow(/no field called "nope"/);
    expect(() => run({ dataset: "users", measures: [{ id: "n", agg: "count" }] })).toThrow(
      /no dataset called "users"/,
    );
  });
});

describe("cards", () => {
  it("reads named values across datasets", () => {
    const doc: CardDoc = {
      v: 2,
      metrics: [
        { id: "cash", dataset: "accounts", expr: "sum([balance], not [is_debt])", format: "money" },
        { id: "debt", dataset: "accounts", expr: "sum([owed])", format: "money" },
        {
          id: "spent",
          dataset: "transactions",
          range: { preset: "this_month" },
          expr: "sum([Spending])",
        },
        { id: "months", expr: "$cash / $spent", format: "number" },
        { id: "net", expr: "$cash - $debt" },
      ],
      blocks: [
        {
          id: "s",
          kind: "stat",
          w: 6,
          options: {
            value: "$net",
            compare: "$debt",
            text: "{{$cash}} in cash, {{round($months, 1)}} months of spending",
            toneExpr: 'if($net > 0, "positive", "negative")',
          },
        },
      ],
    };
    const out = runCardDoc(doc, provider, TODAY);
    expect(out.metrics.net).toMatchObject({ value: 200_000, type: "money", text: "$2,000.00" });
    const s = out.blocks.s;
    expect(s?.value?.value).toBe(200_000);
    expect(s?.delta?.value).toBe(150_000);
    expect(s?.text).toBe("$2,500.00 in cash, 29.2 months of spending");
    expect(s?.tone).toBe("positive");
  });

  it("catches circles", () => {
    const out = runCardDoc(
      {
        v: 2,
        metrics: [
          { id: "a", expr: "$b + 1" },
          { id: "b", expr: "$a + 1" },
        ],
        blocks: [],
      },
      provider,
      TODAY,
    );
    expect(out.metrics.a).toMatchObject({ error: expect.stringContaining("circle") });
  });

  it("keeps one broken block from taking the card down", () => {
    const out = runCardDoc(
      {
        v: 2,
        blocks: [
          { id: "bad", kind: "stat", w: 6, options: { value: "$missing" } },
          {
            id: "good",
            kind: "stat",
            w: 6,
            query: { dataset: "accounts", measures: [{ id: "n", agg: "count" }] },
          },
        ],
      },
      provider,
      TODAY,
    );
    expect(out.blocks.bad?.error).toContain("$missing");
    expect(out.blocks.good?.value?.value).toBe(2);
  });

  it("reads each dataset once however many blocks use it", () => {
    let reads = 0;
    const q: CardQuery = {
      dataset: "transactions",
      range: { preset: "this_month" },
      measures: [{ id: "n", agg: "count" }],
    };
    runCardDoc(
      {
        v: 2,
        blocks: [
          { id: "a", kind: "stat", w: 6, query: q },
          { id: "b", kind: "stat", w: 6, query: q },
        ],
      },
      (d) => {
        reads++;
        return provider(d);
      },
      TODAY,
    );
    expect(reads).toBe(1);
  });
});

describe("ranges and formats", () => {
  it("works out date ranges", () => {
    expect(resolveRange({ preset: "this_month" }, TODAY)).toEqual({
      from: "2026-11-01",
      to: TODAY,
    });
    expect(resolveRange({ preset: "last_month" }, TODAY)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(resolveRange({ preset: "last_12_months" }, TODAY).from).toBe("2025-12-01");
    expect(resolveRange({ preset: "next_30_days" }, TODAY).to).toBe("2026-12-15");
    expect(resolveRange({ last: 3, unit: "days" }, TODAY)).toEqual({
      from: "2026-11-13",
      to: TODAY,
    });
    expect(resolveRange({ next: 1, unit: "months" }, "2026-01-31").to).toBe("2026-02-28");
    expect(resolveRange({ preset: "all_time" }, TODAY)).toEqual({});
  });

  it("shows values the way the app does", () => {
    expect(formatCell(123456, "money")).toBe("$1,234.56");
    expect(formatCell(-50, "money")).toBe("-$0.50");
    expect(formatCell(0.25, "percent")).toBe("25%");
    expect(formatCell(0.0312, "percent")).toBe("3.1%");
    expect(formatCell(null, "money")).toBe("—");
    expect(formatCell(true, "boolean")).toBe("Yes");
    expect(formatCell("2026-11-07", "date")).toBe("Nov 7, 2026");
    expect(formatCell("2026-11", "text", "month")).toBe("Nov 2026");
    expect(formatCell(3, "text", "weekday")).toBe("Wed");
  });
});
