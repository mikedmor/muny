import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { makeApp as makeBareApp, makeSignedInApp } from "./test-utils.js";

const webDir = mkdtempSync(join(tmpdir(), "muny-web-"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Muny</title>");
afterAll(() => rmSync(webDir, { recursive: true, force: true }));

async function makeApp(env: Record<string, string> = {}) {
  return (await makeBareApp(env)).app;
}

describe("server", () => {
  it("GET /api/health reports ok with migrations applied", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.migrations).toBeGreaterThan(0);
  });

  it("GET /api/meta exposes the source link (AGPL §13)", async () => {
    const app = await makeApp({ MUNY_SOURCE_URL: "https://example.com/muny" });
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    expect(res.json()).toMatchObject({
      name: "Muny",
      license: "AGPL-3.0-only",
      sourceUrl: "https://example.com/muny",
    });
  });

  it("returns JSON 404 for unknown API routes when signed in", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.get("/api/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not Found" });
  });

  it("serves the SPA for client-side routes", async () => {
    const app = await makeApp({ MUNY_WEB_DIR: webDir });
    const res = await app.inject({ method: "GET", url: "/transactions/123" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>Muny</title>");
  });
});

describe("config", () => {
  it("rejects a short secret key", () => {
    expect(() => loadConfig({ MUNY_SECRET_KEY: Buffer.from("short").toString("base64") })).toThrow(
      /MUNY_SECRET_KEY/,
    );
  });

  it("accepts a 32-byte secret key", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(loadConfig({ MUNY_SECRET_KEY: key }).secretKey).toHaveLength(32);
  });
});
