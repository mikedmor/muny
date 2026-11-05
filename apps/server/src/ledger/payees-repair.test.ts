import { newId, schema } from "@muny/db";
import type { Account, TransactionPage } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { repairRawAchPayees } from "./payees.js";

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
