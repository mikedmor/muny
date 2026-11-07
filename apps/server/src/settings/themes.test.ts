import { BUILTIN_THEMES, SYSTEM_THEME, type Theme, type ThemeState } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

const sand = BUILTIN_THEMES.find((t) => t.id === "sand") as Theme;
const input = { name: "Mine", mode: sand.mode, colors: sand.colors };

describe("themes", () => {
  it("starts by following the device, and remembers a choice", async () => {
    const { client } = await makeSignedInApp();
    expect((await client.get("/api/theme")).json<ThemeState>().selected).toBe(SYSTEM_THEME);
    const res = await client.put("/api/theme/selected", { id: "forest" });
    expect(res.statusCode).toBe(200);
    expect((await client.get("/api/theme")).json<ThemeState>().selected).toBe("forest");
    expect((await client.put("/api/theme/selected", { id: "nope" })).statusCode).toBe(400);
  });

  it("creates, updates and deletes custom themes", async () => {
    const { client } = await makeSignedInApp();
    const created = await client.post("/api/themes", input);
    expect(created.statusCode).toBe(201);
    const theme = created.json<Theme>();
    expect((await client.put("/api/theme/selected", { id: theme.id })).statusCode).toBe(200);
    const updated = await client.put(`/api/themes/${theme.id}`, { ...input, name: "Renamed" });
    expect(updated.json<Theme>().name).toBe("Renamed");
    expect((await client.delete(`/api/themes/${theme.id}`)).statusCode).toBe(200);
    expect((await client.get("/api/theme")).json<ThemeState>().custom).toEqual([]);
  });

  it("only stores colors", async () => {
    const { client } = await makeSignedInApp();
    const inject = {
      ...input,
      colors: { ...input.colors, surface: "red; background: url(https://evil.example/x)" },
    };
    expect((await client.post("/api/themes", inject)).statusCode).toBe(400);
    const extra = { ...input, colors: { ...input.colors, sneaky: "#000000" } };
    expect((await client.post("/api/themes", extra)).statusCode).toBe(400);
    expect((await client.post("/api/themes", { ...input, css: "x" })).statusCode).toBe(400);
  });
});
