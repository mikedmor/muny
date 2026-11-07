import { newId, schema } from "@muny/db";
import type { Account, TransactionPage } from "@muny/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { repairRawAchPayees, repairStubPayees } from "./payees.js";
import { payeesByShape } from "./transactions.js";

// Synthetic data only.

describe("repairRawAchPayees", () => {
  it("renames merchants saved as raw ACH text, even on edited transactions", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    const raw = "ORIG CO NAME:LENDER CO ENTRY DESCR:WEB PAY SEC:WEB IND ID:1";
    for (const d of ["2026-09-03", "2026-10-03"])
      await client.post("/api/transactions", {
        accountId: acc.id,
        postedDate: d,
        amountCents: -15000,
        description: raw,
      });
    // Simulate what older versions stored.
    const bad = newId();
    db.insert(schema.payees)
      .values({ id: bad, displayName: "Orig Co Name:lender Co Entry Descr:web Pay Sec:web Ind" })
      .run();
    db.update(schema.transactions).set({ payeeId: bad, userModified: false }).run();
    const [first] = db.select().from(schema.transactions).all();
    db.update(schema.transactions)
      .set({ userModified: true })
      .where(eq(schema.transactions.id, first?.id ?? ""))
      .run();

    expect(repairRawAchPayees(db)).toBe(2);
    const items = (await client.get("/api/transactions?limit=10")).json<TransactionPage>().items;
    expect(items.map((t) => t.payeeName)).toEqual(["Lender", "Lender"]);
    expect(
      db
        .select()
        .from(schema.payees)
        .all()
        .some((p) => p.id === bad),
    ).toBe(false);
    // A second run changes nothing.
    expect(repairRawAchPayees(db)).toBe(0);
  });
});

describe("repairStubPayees", () => {
  it("re-derives names cut to a stub, but not ones you renamed", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    for (const [d, raw] of [
      ["2026-09-07", "WD7 512-555-0100 TX 09/05"],
      ["2026-10-07", "WD7 512-555-0100 TX 10/06"],
      ["2026-10-09", "ZZ TOP SHOP 555-0100 TX 10/08"],
    ] as const)
      await client.post("/api/transactions", {
        accountId: acc.id,
        postedDate: d,
        amountCents: -5000,
        description: raw,
      });
    // What older versions stored: "Tx"; and a stub the user chose themselves.
    const stub = newId();
    const mine = newId();
    db.insert(schema.payees).values({ id: stub, displayName: "Tx" }).run();
    db.insert(schema.payees).values({ id: mine, displayName: "Zed" }).run();
    db.update(schema.transactions)
      .set({ payeeId: stub })
      .where(sql`raw_description like 'WD7%'`)
      .run();
    db.update(schema.transactions)
      .set({ payeeId: mine })
      .where(sql`raw_description like 'ZZ%'`)
      .run();
    await client.patch(`/api/payees/${mine}`, { displayName: "Zz" });

    expect(repairStubPayees(db)).toBe(2);
    const items = (await client.get("/api/transactions?limit=10")).json<TransactionPage>().items;
    expect(items.map((t) => t.payeeName).sort()).toEqual(["WD7", "WD7", "Zz"]);
    expect(repairStubPayees(db)).toBe(0);
  });

  it("gives new charges the merchant earlier ones like them have", async () => {
    const { client, db } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking" })
    ).json<Account>();
    await client.post("/api/transactions", {
      accountId: acc.id,
      postedDate: "2026-09-07",
      amountCents: -5000,
      description: "WD7 512-555-0100 TX 09/05",
    });
    const pid = newId();
    db.insert(schema.payees).values({ id: pid, displayName: "Sanitation District" }).run();
    db.update(schema.transactions).set({ payeeId: pid }).run();
    const first = db.select().from(schema.transactions).get();
    const known = payeesByShape(db);
    expect(known("WD7 512-555-0100 TX 10/06")).toBe(first?.payeeId);
    expect(known("SOMETHING ELSE ENTIRELY")).toBeUndefined();
  });
});
