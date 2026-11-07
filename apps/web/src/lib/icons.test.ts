import { describe, expect, it } from "vitest";
import { loadEmoji, searchIcons } from "./icons.js";

describe("icon search", () => {
  it("finds icons by name, keyword, shortcode and money words", async () => {
    const all = await loadEmoji();
    expect(all.length).toBeGreaterThan(1500);
    const top = (q: string) => searchIcons(all, q).map((e) => e.emoji);
    expect(top("robot")[0]).toBe("🤖");
    expect(top("ai")).toContain("🤖");
    expect(top(":car:")).toContain("🚗");
    expect(top("water")).toContain("💧");
    expect(top("sewer")).toContain("🚰");
    expect(top("dog")).toContain("🐶");
    expect(top("zzzzqqq")).toEqual([]);
  });
});
