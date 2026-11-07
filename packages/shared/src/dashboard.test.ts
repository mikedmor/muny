import { describe, expect, it } from "vitest";
import {
  type ArrangeCard,
  arrangeColumns,
  BUILTIN_CARDS,
  DEFAULT_DASHBOARD,
  layoutFromSaved,
  moveCard,
} from "./dashboard.js";

const main = (card: string, weight = 10): ArrangeCard => ({ card, placement: "main", weight });
const side = (card: string, weight = 10): ArrangeCard => ({ card, placement: "side", weight });

describe("arrangeColumns", () => {
  const cards = [main("a"), side("x"), main("b"), side("y"), main("c")];

  it("is simply the priority order in one column", () => {
    expect(arrangeColumns(cards, 1)).toEqual({
      columns: [["a", "x", "b", "y", "c"]],
      hasSide: false,
    });
  });

  it("keeps side cards in the right column, in order", () => {
    expect(arrangeColumns(cards, 2)).toEqual({
      columns: [
        ["a", "b", "c"],
        ["x", "y"],
      ],
      hasSide: true,
    });
  });

  it("spreads main cards across the other columns, shortest first", () => {
    expect(arrangeColumns(cards, 3).columns).toEqual([["a", "c"], ["b"], ["x", "y"]]);
    expect(arrangeColumns(cards, 4).columns).toEqual([["a"], ["b"], ["c"], ["x", "y"]]);
    const tall = [main("big", 50), main("s1"), main("s2"), side("x")];
    expect(arrangeColumns(tall, 3).columns).toEqual([["big"], ["s1", "s2"], ["x"]]);
  });

  it("gives every column to one kind of card when there's no other", () => {
    expect(arrangeColumns([side("x"), side("y")], 3)).toEqual({
      columns: [["x"], ["y"], []],
      hasSide: false,
    });
    expect(arrangeColumns([main("a"), main("b")], 2)).toEqual({
      columns: [["a"], ["b"]],
      hasSide: false,
    });
  });

  it("stops the right column running on past the others", () => {
    const lists = [main("a", 30), main("b", 30), main("c", 30)];
    for (const n of ["u", "v", "w", "x", "y", "z"]) lists.push(side(n, 30));
    const { columns } = arrangeColumns(lists, 4);
    // Three stay on the right, and the rest overflow, without making the page any taller.
    expect(columns[3]).toEqual(["u", "v", "w"]);
    expect(columns.slice(0, 3)).toEqual([
      ["a", "x"],
      ["b", "y"],
      ["c", "z"],
    ]);
    // Always keeps its top card, however tall.
    expect(arrangeColumns([main("a", 1), side("huge", 5000), side("n", 1)], 4).columns[3]).toEqual([
      "huge",
    ]);
  });

  it("makes room for one very tall card rather than stacking on it", () => {
    const tall = [
      main("a", 30),
      main("b", 30),
      main("c", 30),
      main("d", 30),
      side("x", 30),
      side("huge", 200),
    ];
    const { columns } = arrangeColumns(tall, 4);
    const weightOf = new Map(tall.map((c) => [c.card, c.weight]));
    const heights = columns.map((col) => col.reduce((s, c) => s + (weightOf.get(c) ?? 0), 0));
    // Nothing is stacked on it: it's alone, and the others share the rest.
    expect(Math.max(...heights)).toBe(200);
    expect(columns.find((col) => col.includes("huge"))).toEqual(["huge"]);
  });

  it("reads in priority order within every column, highest-priority column first", () => {
    const list = [main("first", 5), main("big", 90), main("mid", 40), main("low", 30)];
    const { columns } = arrangeColumns(list, 2);
    expect(columns[0]?.[0]).toBe("first");
    const rank = (c: string) => list.findIndex((x) => x.card === c);
    for (const col of columns) expect(col).toEqual([...col].sort((x, y) => rank(x) - rank(y)));
  });

  it("handles no cards", () => {
    expect(arrangeColumns([], 3).columns.flat()).toEqual([]);
  });
});

describe("moveCard", () => {
  const list = ["a", "b", "c", "d"];
  it("moves up, down, and stays on the list", () => {
    expect(moveCard(list, "c", 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveCard(list, "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveCard(list, "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveCard(list, "b", -5)).toEqual(["b", "a", "c", "d"]);
    expect(moveCard(list, "nope", 1)).toEqual(list);
  });
});

describe("saved layouts", () => {
  it("reads the current format and converts grid positions from the earlier one", () => {
    expect(layoutFromSaved(null)).toBeNull();
    expect(layoutFromSaved(["a", "b"])).toEqual(["a", "b"]);
    expect(
      layoutFromSaved([
        { card: "low", x: 0, y: 40, w: 8, h: 10 },
        { card: "right", x: 8, y: 0, w: 4, h: 10 },
        { card: "left", x: 0, y: 0, w: 8, h: 10 },
      ]),
    ).toEqual(["left", "right", "low"]);
  });
});

describe("the standard Overview", () => {
  const known = new Map(BUILTIN_CARDS.map((c) => [c.id, c]));
  const standard = DEFAULT_DASHBOARD.map((card) => {
    const c = known.get(card);
    if (!c) throw new Error(`unknown card ${card}`);
    return { card, placement: c.placement, weight: c.weight };
  });

  it("uses known cards once each, and leaves Coming up to add", () => {
    expect(new Set(DEFAULT_DASHBOARD).size).toBe(DEFAULT_DASHBOARD.length);
    expect(known.has("coming-up")).toBe(true);
    expect(DEFAULT_DASHBOARD).not.toContain("coming-up");
  });

  it("restores the wide layouts: calendar beside spending, recent on the right", () => {
    const three = arrangeColumns(standard, 3).columns;
    expect(three).toHaveLength(3);
    expect(three[0]?.[0]).toBe("spending");
    expect(three.slice(0, 2).map((c) => c[0])).toContain("calendar");
    expect(three[2]?.[0]).toBe("accounts");
    expect(three.flat()).toContain("recent");
    expect(arrangeColumns(standard, 4).columns).toHaveLength(4);
    expect(arrangeColumns(standard, 2).columns[1]).toContain("accounts");
  });

  it("keeps the columns about level on an ultrawide screen", () => {
    const weight = new Map(standard.map((c) => [c.card, c.weight]));
    const { columns } = arrangeColumns(standard, 4);
    expect(columns.flat().sort()).toEqual([...DEFAULT_DASHBOARD].sort());
    const heights = columns.map((col) => col.reduce((s, c) => s + (weight.get(c) ?? 0), 0));
    expect(Math.max(...heights)).toBeLessThanOrEqual(Math.min(...heights) * 1.6);
    expect(columns[3]?.[0]).toBe("accounts");
    expect(columns[0]?.[0]).toBe("spending");
  });

  it("leaves every list on the right on a laptop", () => {
    const right = arrangeColumns(standard, 2).columns[1];
    expect(right).toContain("recent");
    expect(right).toContain("budget");
  });
});
