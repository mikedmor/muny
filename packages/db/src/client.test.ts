import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appliedMigrationCount, newId, openDb, pingDb, schema } from "./index.js";

describe("openDb", () => {
  it("runs migrations on an in-memory database", () => {
    const db = openDb({ filename: ":memory:" });
    expect(pingDb(db)).toBe(true);
    expect(appliedMigrationCount(db)).toBeGreaterThan(0);
  });

  it("stores and reads a transaction with integer cents", () => {
    const db = openDb({ filename: ":memory:" });
    const accountId = newId();
    db.insert(schema.accounts).values({ id: accountId, name: "Checking", type: "checking" }).run();
    const txnId = newId();
    db.insert(schema.transactions)
      .values({
        id: txnId,
        accountId,
        postedDate: "2026-01-15",
        amountCents: -1599,
        rawDescription: "SYNTHETIC STREAMING CO",
        importHash: "test-hash",
      })
      .run();

    const row = db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txnId))
      .get();
    expect(row?.amountCents).toBe(-1599);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(Number.isInteger(row?.createdAt.getTime())).toBe(true);
  });

  it("rejects duplicate import hashes per account", () => {
    const db = openDb({ filename: ":memory:" });
    const accountId = newId();
    db.insert(schema.accounts).values({ id: accountId, name: "Card", type: "credit" }).run();
    const base = {
      accountId,
      postedDate: "2026-01-15",
      amountCents: -500,
      rawDescription: "X",
      importHash: "same",
    };
    db.insert(schema.transactions)
      .values({ id: newId(), ...base })
      .run();
    expect(() =>
      db
        .insert(schema.transactions)
        .values({ id: newId(), ...base })
        .run(),
    ).toThrow();
  });

  it("enforces foreign keys", () => {
    const db = openDb({ filename: ":memory:" });
    expect(() =>
      db
        .insert(schema.transactions)
        .values({
          id: newId(),
          accountId: "missing",
          postedDate: "2026-01-01",
          amountCents: 1,
          rawDescription: "X",
          importHash: "h",
        })
        .run(),
    ).toThrow();
  });
});

describe("newId", () => {
  it("is 26 chars and time-sortable", () => {
    const a = newId(1_000);
    const b = newId(2_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});
