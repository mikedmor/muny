import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEMES,
  contrastRatio,
  findTheme,
  HEX_COLOR,
  mixColors,
  readableOn,
  resolveTheme,
  SYSTEM_THEME,
  THEME_COLOR_KEYS,
  type Theme,
  themeVariables,
  themeWarnings,
} from "./themes.js";

describe("themes", () => {
  it("ships complete, readable themes", () => {
    for (const t of BUILTIN_THEMES) {
      for (const key of THEME_COLOR_KEYS)
        expect(t.colors[key], `${t.id} ${key}`).toMatch(HEX_COLOR);
      expect(themeWarnings(t), t.id).toEqual([]);
      const ids = BUILTIN_THEMES.filter((x) => x.id === t.id);
      expect(ids).toHaveLength(1);
    }
  });

  it("follows the device unless a known theme is chosen", () => {
    expect(resolveTheme(SYSTEM_THEME, [], true).id).toBe("dark");
    expect(resolveTheme(SYSTEM_THEME, [], false).id).toBe("light");
    expect(resolveTheme("forest", [], false).id).toBe("forest");
    expect(resolveTheme("deleted-one", [], true).id).toBe("dark");
  });

  it("finds custom themes", () => {
    const mine = { ...(findTheme("sand") as Theme), id: "x1", name: "Mine" };
    expect(resolveTheme("x1", [mine], true).name).toBe("Mine");
  });

  it("does color math", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(mixColors("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixColors("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(readableOn("#ffe680")).toBe("#0b0b0b");
    expect(readableOn("#0d9488")).toBe("#ffffff");
  });

  it("sets every variable the pages rely on", () => {
    for (const t of BUILTIN_THEMES) {
      const vars = themeVariables(t);
      for (const v of [
        "--color-slate-50",
        "--color-slate-500",
        "--color-slate-950",
        "--color-brand-600",
        "--color-on-brand",
        "--color-surface",
        "--color-emerald-700",
        "--color-red-600",
        "--color-amber-500",
        "--viz-surface",
        "--viz-series-1",
        "--viz-series-8",
        "--viz-other",
      ])
        expect(vars[v], `${t.id} ${v}`).toBeTruthy();
    }
  });

  it("puts a custom theme's colors where the pages look for them", () => {
    const base = findTheme("sand") as Theme;
    const vars = themeVariables(base);
    expect(vars["--color-slate-50"]).toBe(base.colors.background);
    expect(vars["--color-slate-200"]).toBe(base.colors.border);
    expect(vars["--color-slate-900"]).toBe(base.colors.text);
    expect(vars["--color-surface"]).toBe(base.colors.surface);
    const night = themeVariables(findTheme("midnight") as Theme);
    expect(night["--color-slate-950"]).toBe("#0b1020");
    expect(night["--color-slate-900"]).toBe("#131a2e");
    expect(night["--color-slate-800"]).toBe("#252f4a");
    expect(night["--color-slate-100"]).toBe("#e8ecf8");
  });

  it("warns about unreadable combinations", () => {
    const base = findTheme("light") as Theme;
    const bad = themeWarnings({
      colors: { ...base.colors, text: "#f0f0f0", chart1: "#ffffff" },
    });
    expect(bad.map((w) => w.message).join(" ")).toContain("Text is hard to read on cards");
    expect(bad.some((w) => w.colors.includes("chart1"))).toBe(true);
  });
});
