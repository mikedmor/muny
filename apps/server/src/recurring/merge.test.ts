import { schema } from "@muny/db";
import type { Account, RecurringSeries } from "@muny/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { listSeries, rescanRecurring, steadyDescription } from "./service.js";

// Synthetic data only.
const TODAY = "2026-11-08";

describe("two series one rule set says are the same", () => {
  it("merge into one, priced from the newest charges", async () => {
    const ctx = await makeSignedInApp();
    const { db, client } = ctx;
    const scan = () => db.transaction((tx) => rescanRecurring(tx, TODAY));
    const series = (): RecurringSeries[] => listSeries(db, TODAY);
    const acct = (
      await client.post("/api/accounts", { name: "Wallet", type: "checking", balanceCents: 0 })
    ).json<Account>();
    const add = (d: string, c: number) =>
      client.post("/api/transactions", {
        accountId: acct.id,
        postedDate: d,
        amountCents: c,
        description: "Sample Ink Club",
      });
    for (const d of ["2024-03-11", "2024-04-12", "2024-05-11", "2024-06-11"]) await add(d, -159);
    for (const m of ["2024-12", "2025-01", "2025-02", "2025-03", "2025-04"])
      await add(`${m}-18`, -529);
    for (const m of [
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ])
      await add(`${m}-18`, -582);
    for (const m of ["2026-08", "2026-09", "2026-10"]) await add(`${m}-18`, -635);
    scan();
    const before = series().filter((s) => s.name.includes("Ink"));
    for (const s of before) {
      await client.post("/api/rules", {
        name: `r${s.id.slice(-4)}`,
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "Sample Ink Club" }],
        actions: [{ type: "setRecurring", seriesId: s.id }],
      });
    }
    scan();
    scan();
    const after = series().filter((s) => s.name.includes("Ink"));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      expectedAmountCents: -635,
      lastDate: "2026-10-18",
      late: false,
    });
  });

  it("fold an empty duplicate into the series its rule's charges went to", async () => {
    const ctx = await makeSignedInApp();
    const { db, client } = ctx;
    const scan = () => db.transaction((tx) => rescanRecurring(tx, TODAY));
    const acct = (
      await client.post("/api/accounts", { name: "Wallet", type: "checking", balanceCents: 0 })
    ).json<Account>();
    for (const m of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"])
      await client.post("/api/transactions", {
        accountId: acct.id,
        postedDate: `${m}-18`,
        amountCents: -635,
        description: "Sample Ink Club",
      });
    scan();
    const [real] = listSeries(db, TODAY);
    await client.patch(`/api/recurring/${real?.id}`, { status: "confirmed" });
    // Left over from before: an empty copy, with a rule of its own.
    const s = schema.recurringSeries;
    const copy = db.select().from(s).all()[0] as typeof s.$inferSelect;
    db.insert(s)
      .values({ ...copy, id: "dup-series", status: "detected" })
      .run();
    const rule = (
      await client.post("/api/rules", {
        name: "Ink",
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "Sample Ink" }],
        actions: [{ type: "setRecurring", seriesId: "dup-series" }],
      })
    ).json<{ id: string }>();
    await client.post("/api/rules", {
      name: "Ink too",
      priority: -10,
      match: "all",
      conditions: [{ field: "description", op: "contains", value: "Sample Ink Club" }],
      actions: [{ type: "setRecurring", seriesId: real?.id }],
    });
    // Make the second rule win, as the user's newer rule did.
    db.update(schema.rules)
      .set({ priority: -10 })
      .where(sql`${schema.rules.name} = 'Ink too'`)
      .run();
    scan();
    const left = listSeries(db, TODAY);
    expect(left.map((x) => x.id)).toEqual([real?.id]);
    const rules = (await client.get("/api/rules")).json<
      { id: string; actions: { type: string; seriesId?: string }[] }[]
    >();
    expect(rules.find((r) => r.id === rule.id)?.actions).toEqual([
      { type: "setRecurring", seriesId: real?.id },
    ]);
  });
});

describe("the steady part of a bank description", () => {
  it("keeps the words and drops what changes each time", () => {
    expect(steadyDescription("ACME CORP PAYROLL PPD ID: 9000000001")).toBe("ACME CORP PAYROLL");
    expect(steadyDescription("SAMPLE PAY *STREAMCO")).toBe("SAMPLE PAY *STREAMCO");
    expect(steadyDescription("SAMPLEPAY *GYM B7X2 05/04")).toBe("SAMPLEPAY *GYM");
    expect(steadyDescription("SD9 SEWER 123456")).toBe("SD9 SEWER");
    expect(steadyDescription("Sample Ink Club")).toBe("Sample Ink Club");
    expect(steadyDescription("12345")).toBeNull();
  });
});

describe("two series with one bank description", () => {
  it("each get a rule, told apart by amount", async () => {
    const ctx = await makeSignedInApp();
    const { db, client } = ctx;
    const scan = () => db.transaction((tx) => rescanRecurring(tx, TODAY));
    const acct = (
      await client.post("/api/accounts", { name: "Main", type: "checking", balanceCents: 0 })
    ).json<Account>();
    for (const m of ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) {
      for (const [day, cents] of [
        ["16", -7_539],
        ["29", -22_461],
      ] as const)
        await client.post("/api/transactions", {
          accountId: acct.id,
          postedDate: `${m}-${day}`,
          amountCents: cents,
          description: "SAMPLE LOAN SERVICER PMT 0001",
        });
    }
    scan();
    const loans = listSeries(db, TODAY);
    expect(loans).toHaveLength(2);
    for (const l of loans) await client.patch(`/api/recurring/${l.id}`, { status: "confirmed" });
    scan();
    type R = {
      conditions: { field: string; op?: string; value: unknown }[];
      actions: { type: string; seriesId?: string }[];
    };
    const rules = (await client.get("/api/rules")).json<R[]>();
    for (const l of loans) {
      const r = rules.find((x) => x.actions.some((a) => a.seriesId === l.id));
      expect(r?.conditions.filter((c) => c.field === "amount")).toHaveLength(2);
    }
    // Rescans keep each payment where it was.
    scan();
    expect(
      listSeries(db, TODAY)
        .map((x) => x.expectedAmountCents)
        .sort(),
    ).toEqual([-22_461, -7_539]);
  });
});
