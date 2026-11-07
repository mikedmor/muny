import type { QueryResult, ResultColumn } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { buildChart, niceTicks } from "./xychart.js";

const dim = (id: string, extra: Partial<ResultColumn> = {}): ResultColumn => ({
  id,
  label: id,
  type: "text",
  role: "dimension",
  ...extra,
});
const measure = (id: string, extra: Partial<ResultColumn> = {}): ResultColumn => ({
  id,
  label: id,
  type: "money",
  role: "measure",
  ...extra,
});
const query = (columns: ResultColumn[], rows: QueryResult["rows"]): QueryResult => ({
  columns,
  rows,
  totals: {},
});

describe("buildChart", () => {
  it("draws every value, one series each", () => {
    const c = buildChart(
      [
        query(
          [dim("month", { bucket: "month" }), measure("in"), measure("out")],
          [
            ["2026-10", 100, 50],
            ["2026-11", 200, 75],
          ],
        ),
      ],
      "column",
      {},
    );
    expect(c.x.map((p) => p.key)).toEqual(["2026-10", "2026-11"]);
    expect(c.x.map((p) => p.tick)).toEqual(["Oct", "Nov"]);
    expect(c.series.map((s) => s.values)).toEqual([
      [100, 200],
      [50, 75],
    ]);
    expect(new Set(c.series.map((s) => s.color)).size).toBe(2);
  });

  it("splits every value when there's a second grouping, dropping what's empty", () => {
    const c = buildChart(
      [
        query(
          [dim("month"), dim("group"), measure("in"), measure("out")],
          [
            ["a", "Food", 0, 40],
            ["a", "Pay", 100, 0],
            ["b", "Food", 0, 60],
            ["b", "Pay", 100, 0],
          ],
        ),
      ],
      "column",
      {},
    );
    expect(c.series.map((s) => s.label).sort()).toEqual(["Food · out", "Pay · in"]);
  });

  it("names a split by its value alone when there's one measure", () => {
    const c = buildChart(
      [query([dim("m"), dim("group"), measure("v")], [["a", "Food", 40]])],
      "line",
      {},
    );
    expect(c.series.map((s) => s.label)).toEqual(["Food"]);
  });

  it("folds what doesn't fit into Other, without losing any money", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ["a", `S${i}`, 100 + i]);
    const c = buildChart([query([dim("m"), dim("s"), measure("v")], rows)], "column", {
      stacked: true,
    });
    expect(c.series).toHaveLength(8);
    const last = c.series[c.series.length - 1];
    expect(last?.label).toBe("Other");
    expect(last?.color).toBe("var(--viz-other)");
    const total = c.series.reduce((s, x) => s + (x.values[0] ?? 0), 0);
    expect(total).toBe(rows.reduce((s, r) => s + Number(r[2]), 0));
  });

  it("keeps each name's color when a filter changes the ranking", () => {
    const colorOf = (rows: QueryResult["rows"], name: string) =>
      buildChart([query([dim("m"), dim("s"), measure("v")], rows)], "line", {}).series.find(
        (s) => s.label === name,
      )?.color;
    const big = [
      ["a", "Apples", 100],
      ["a", "Pears", 50],
    ];
    const flipped = [
      ["a", "Apples", 50],
      ["a", "Pears", 100],
    ];
    expect(colorOf(big, "Apples")).toBe(colorOf(flipped, "Apples"));
  });

  it("lines layers from different data up on one axis", () => {
    const c = buildChart(
      [
        query(
          [dim("day", { bucket: "day_of_month" }), measure("now")],
          [
            [1, 10],
            [2, 20],
          ],
        ),
        query(
          [dim("day", { bucket: "day_of_month" }), measure("then", { mark: "dashed" })],
          [
            [1, 5],
            [2, 6],
            [3, 7],
          ],
        ),
      ],
      "area",
      {},
    );
    expect(c.x.map((p) => p.key)).toEqual(["1", "2", "3"]);
    expect(c.series[0]?.values).toEqual([10, 20, null]);
    expect(c.series[1]?.values).toEqual([5, 6, 7]);
    expect(c.series[1]?.mark).toBe("dashed");
  });

  it("uses theme colors only", () => {
    const c = buildChart(
      [
        query(
          [
            dim("m"),
            measure("a", { color: "positive" }),
            measure("b"),
            measure("c", { color: "series3" }),
          ],
          [["x", 1, 2, 3]],
        ),
      ],
      "column",
      {},
    );
    expect(c.series.map((s) => s.color)).toEqual([
      "var(--viz-positive)",
      "var(--viz-series-1)",
      "var(--viz-series-3)",
    ]);
  });
});

describe("niceTicks", () => {
  it("covers the range with distinct round numbers", () => {
    for (const [lo, hi] of [
      [0, 1],
      [0, 137],
      [-50, 400],
      [0, 123_456_78],
      [0.1, 0.4],
    ] as const) {
      const t = niceTicks(lo, hi);
      expect(new Set(t).size, `${lo}-${hi}`).toBe(t.length);
      expect(t[0]).toBeLessThanOrEqual(lo);
      expect(t[t.length - 1]).toBeGreaterThanOrEqual(hi);
    }
  });
});
