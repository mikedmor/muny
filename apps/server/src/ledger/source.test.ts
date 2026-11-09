import { schema } from "@muny/db";
import type { Account, Transaction } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.

describe("where a transaction came from", () => {
  it("is named from how it was recorded", async () => {
    const { db, client } = await makeSignedInApp();
    const acct = (
      await client.post("/api/accounts", { name: "Main", type: "checking", balanceCents: 0 })
    ).json<Account>();
    const add = async (description: string) =>
      (
        await client.post("/api/transactions", {
          accountId: acct.id,
          postedDate: "2026-11-01",
          amountCents: -500,
          description,
        })
      ).json<{ id: string }>().id;
    const t = schema.transactions;
    const hand = await add("SAMPLE HAND");
    const statement = await add("SAMPLE STATEMENT");
    const synced = await add("SAMPLE SYNC");
    const file = await add("SAMPLE FILE");
    const orphan = await add("SAMPLE ORPHAN");
    const setHash = (id: string, importHash: string) =>
      db.update(t).set({ importHash }).where(eq(t.id, id)).run();
    setHash(statement, "stmt:acct:2026-11-01:-500:SAMPLE");
    setHash(synced, "plaid:ref-1");
    setHash(file, "abc123");
    setHash(orphan, "def456");
    db.insert(schema.importBatches).values({ id: "b1", source: "rocket_money" }).run();
    db.update(t).set({ importBatchId: "b1" }).where(eq(t.id, file)).run();

    const res = (await client.get("/api/transactions")).json<{ items: Transaction[] }>();
    const sourceOf = (id: string) => res.items.find((x) => x.id === id)?.source;
    expect(sourceOf(hand)).toBe("Added by hand");
    expect(sourceOf(statement)).toBe("Statement upload");
    expect(sourceOf(synced)).toBe("Plaid");
    expect(sourceOf(file)).toBe("Rocket Money import");
    expect(sourceOf(orphan)).toBe("Imported file");
  });
});
