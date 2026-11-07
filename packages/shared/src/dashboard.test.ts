import { describe, expect, it } from "vitest";
import {
  addCard,
  BUILTIN_CARDS,
  clampRect,
  type DashboardItem,
  DEFAULT_DASHBOARD,
  GRID_COLUMNS,
  normalizeLayout,
  placeCard,
  removeCard,
} from "./dashboard.js";

const item = (card: string, x: number, y: number, w: number, h: number): DashboardItem => ({
  card,
  x,
  y,
  w,
  h,
});

function noOverlaps(items: DashboardItem[]) {
  const cells = new Set<string>();
  for (const i of items)
    for (let x = i.x; x < i.x + i.w; x++)
      for (let y = i.y; y < i.y + i.h; y++) {
        const k = `${x},${y}`;
        expect(cells.has(k), `${i.card} overlaps at ${k}`).toBe(false);
        cells.add(k);
      }
}

const at = (items: DashboardItem[], card: string) => items.find((i) => i.card === card);

describe("dashboard grid", () => {
  it("keeps cards on the 12 columns", () => {
    expect(clampRect(item("a", 11, -3, 6, 2))).toMatchObject({ x: 6, y: 0, w: 6, h: 4 });
    expect(clampRect(item("a", 0, 0, 40, 9000))).toMatchObject({ w: GRID_COLUMNS, h: 200 });
    expect(clampRect(item("a", 0, 0, 1, 10)).w).toBe(2);
    // No upper limit on how far down a card can go.
    expect(clampRect(item("a", 0, 100_000, 4, 10)).y).toBe(100_000);
  });

  it("floats cards up and resolves overlaps", () => {
    const out = normalizeLayout([item("a", 0, 50, 6, 10), item("b", 0, 52, 6, 10)]);
    expect(at(out, "a")?.y).toBe(0);
    expect(at(out, "b")?.y).toBe(10);
    noOverlaps(out);
  });

  it("leaves side-by-side cards side by side", () => {
    const out = normalizeLayout([item("a", 0, 0, 6, 10), item("b", 6, 0, 6, 20)]);
    expect(at(out, "b")).toMatchObject({ x: 6, y: 0 });
  });

  it("moves a card into another's spot, and the other makes room", () => {
    const start = [item("a", 0, 0, 12, 10), item("b", 0, 10, 12, 10)];
    const out = placeCard(start, "b", { x: 0, y: 0, w: 12, h: 10 });
    expect(at(out, "b")?.y).toBe(0);
    expect(at(out, "a")?.y).toBe(10);
    noOverlaps(out);
  });

  it("makes room when a card is resized", () => {
    const start = [item("a", 0, 0, 6, 10), item("b", 6, 0, 6, 10)];
    const out = placeCard(start, "a", { x: 0, y: 0, w: 12, h: 10 });
    expect(at(out, "a")?.w).toBe(12);
    expect(at(out, "b")?.y).toBe(10);
    noOverlaps(out);
  });

  it("adds under everything, once, and closes the gap on removal", () => {
    const start = [item("a", 0, 0, 12, 10)];
    const added = addCard(start, "b", { w: 4, h: 8 });
    expect(at(added, "b")).toMatchObject({ x: 0, y: 10 });
    expect(addCard(added, "b", { w: 4, h: 8 })).toHaveLength(2);
    const removed = removeCard(added, "a");
    expect(removed).toHaveLength(1);
    expect(at(removed, "b")?.y).toBe(0);
  });

  it("gives empty cards no space", () => {
    const out = normalizeLayout([item("a", 0, 0, 6, 0), item("b", 0, 5, 6, 10)]);
    expect(at(out, "b")?.y).toBe(0);
  });

  it("has a valid default that uses only known cards and leaves Coming up to add", () => {
    const known = new Set(BUILTIN_CARDS.map((c) => c.id));
    for (const i of DEFAULT_DASHBOARD) expect(known.has(i.card)).toBe(true);
    expect(new Set(DEFAULT_DASHBOARD.map((i) => i.card)).size).toBe(DEFAULT_DASHBOARD.length);
    noOverlaps(normalizeLayout(DEFAULT_DASHBOARD));
    expect(known.has("coming-up")).toBe(true);
    expect(at(DEFAULT_DASHBOARD, "coming-up")).toBeUndefined();
    expect(at(DEFAULT_DASHBOARD, "calendar")?.x).toBe(0);
    expect(at(DEFAULT_DASHBOARD, "recent")?.x).toBe(8);
  });
});
