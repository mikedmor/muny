import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@muny/db";
import type { Account, BackupInfo } from "@muny/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { makeSignedInApp, OWNER, TestClient } from "../test-utils.js";
import { createBackup, listBackups } from "./backups.js";

async function withTransactions() {
  const ctx = await makeSignedInApp();
  const acc = (
    await ctx.client.post("/api/accounts", { name: "Checking", type: "checking" })
  ).json<Account>();
  for (const [postedDate, amountCents, description] of [
    ["2026-01-01", -1234, '=HYPERLINK("evil")'],
    ["2026-01-02", 50000, 'Paycheck, "January"'],
  ] as const) {
    await ctx.client.post("/api/transactions", {
      accountId: acc.id,
      postedDate,
      amountCents,
      description,
    });
  }
  return { ...ctx, acc };
}

describe("export", () => {
  it("exports transactions as CSV with formula cells neutralized", async () => {
    const { client } = await withTransactions();
    const res = await client.get("/api/export/transactions.csv");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="muny-transactions-/);
    const lines = res.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toMatch(/^Date,Account,Payee,Description,Amount,Currency,Category/);
    expect(lines[1]).toContain('"Paycheck, ""January"""');
    expect(lines[1]).toContain(",500.00,USD,");
    expect(lines[2]).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(lines[2]).toContain(",-12.34,USD,"); // numbers are not escaped

    const filtered = await client.get("/api/export/transactions.csv?from=2026-01-02");
    expect(filtered.body.trim().split("\r\n")).toHaveLength(2);
  });

  it("exports everything as JSON without users or sessions", async () => {
    const { client } = await withTransactions();
    const res = await client.get("/api/export/muny.json");
    const body = res.json();
    expect(body).toMatchObject({ format: "muny-export", formatVersion: 1 });
    expect(body.transactions).toHaveLength(2);
    expect(body.accounts).toHaveLength(1);
    expect(body.categories.length).toBeGreaterThan(10);
    expect(body).not.toHaveProperty("users");
    expect(res.body).not.toContain(OWNER.email);
  });

  it("requires sign-in", async () => {
    const { app } = await makeSignedInApp();
    const anon = new TestClient(app);
    expect((await anon.get("/api/export/muny.json")).statusCode).toBe(401);
    expect((await anon.get("/api/backups")).statusCode).toBe(401);
  });
});

describe("backups", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), "muny-backup-test-"));
    dirs.push(d);
    return d;
  };

  it("writes a readable SQLite copy and keeps only the newest N", async () => {
    const dir = tempDir();
    const db = openDb({ filename: ":memory:" });
    const first = await createBackup(db, dir, 2);
    expect(first.name).toMatch(/^muny-\d{8}-\d{6}\.db$/);
    // A real, openable SQLite database with the schema in it.
    const copy = openDb({ filename: join(dir, first.name) });
    expect(copy.$client.prepare("select count(*) as n from categories").get()).toEqual({ n: 0 });
    copy.$client.close();

    await createBackup(db, dir, 2);
    await createBackup(db, dir, 2);
    expect(await listBackups(dir)).toHaveLength(2);
  }, 10_000);

  it("lists, creates and downloads backups over the API; rejects bad names", async () => {
    const dir = tempDir();
    const config = loadConfig({ NODE_ENV: "test", MUNY_BACKUP_DIR: dir });
    const db = openDb({ filename: ":memory:" });
    const app = await buildApp({ config, db });
    const client = new TestClient(app);
    await client.post("/api/auth/setup", OWNER);

    expect((await client.get("/api/backups")).json()).toMatchObject({ backups: [], keep: 14 });
    const created = await client.post("/api/backups");
    expect(created.statusCode).toBe(201);
    const b = created.json<BackupInfo>();
    const dl = await client.get(`/api/backups/${b.name}`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 15).toString()).toBe("SQLite format 3");

    expect((await client.get("/api/backups/..%2Fmuny.db")).statusCode).toBe(400);
    expect((await client.get("/api/backups/muny-20200101-000000.db")).statusCode).toBe(404);
  });
});
