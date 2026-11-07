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
    expect(three[1]?.[0]).toBe("calendar");
    expect(three[2]).toContain("recent");
    expect(three[2]?.[0]).toBe("accounts");
    expect(arrangeColumns(standard, 4).columns).toHaveLength(4);
    expect(arrangeColumns(standard, 2).columns[1]).toContain("accounts");
  });
});
