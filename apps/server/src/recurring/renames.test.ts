import { schema } from "@muny/db";
import type { Account, RecurringSeries } from "@muny/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { overview } from "../reports/service.js";
import { makeSignedInApp } from "../test-utils.js";
import { listSeries, rescanRecurring } from "./service.js";

// Synthetic data only.

const TODAY = "2026-11-07";

async function setup() {
  const ctx = await makeSignedInApp();
  const account = async (name: string) =>
    (
      await ctx.client.post("/api/accounts", { name, type: "checking", balanceCents: 0 })
    ).json<Account>();
  const add = (accountId: string, postedDate: string, amountCents: number, description: string) =>
    ctx.client.post("/api/transactions", { accountId, postedDate, amountCents, description });
  const scan = () => ctx.db.transaction((tx) => rescanRecurring(tx, TODAY));
  const series = (): RecurringSeries[] => listSeries(ctx.db, TODAY);
  const seriesOf = (description: string, date: string) => {
    const t = schema.transactions;
    const row = ctx.db
      .select({ d: t.rawDescription, date: t.postedDate, s: t.recurringSeriesId })
      .from(t)
      .all()
      .find((r) => r.d === description && r.date === date);
    return series().find((x) => x.id === row?.s)?.name ?? null;
  };
  return { ...ctx, account, add, scan, series, seriesOf };
}

describe("the Coming up card's data", () => {
  it("includes expected income as well as bills", async () => {
    const { db, account, add, scan } = await setup();
    const a = await account("Main");
    for (const m of ["05", "06", "07", "08", "09", "10"]) {
      await add(a.id, `2026-${m}-10`, 250_000, "ACME EMPLOYER");
      await add(a.id, `2026-${m}-11`, -5_000, "SAMPLE STREAMING");
    }
    scan();
    const coming = overview(db, TODAY).upcoming;
    expect(coming.find((u) => u.amountCents > 0)).toMatchObject({
      date: "2026-11-10",
      amountCents: 250_000,
    });
    expect(coming.find((u) => u.amountCents < 0)).toMatchObject({ amountCents: -5_000 });
  });
});

describe("anticipated spending on the Spent this month chart", () => {
  it("adds recurring bills still due, on their dates, and only what counts as spending", async () => {
    const { db, client, account, add, scan, series } = await setup();
    const main = await account("Main");
    for (const m of ["2026-07", "2026-08", "2026-09", "2026-10"]) {
      await add(main.id, `${m}-20`, -2_500, "SAMPLE GYM");
      await add(main.id, `${m}-25`, -40_000, "SAMPLE MOVE TO SAVINGS");
    }
    await add(main.id, "2026-11-03", -1_234, "SAMPLE CORNER STORE");
    scan();
    const moved = series().find((s) => s.expectedAmountCents === -40_000);
    const groups = (await client.get("/api/categories")).json<
      { categories: { id: string; name: string }[] }[]
    >();
    const transfer = groups
      .flatMap((g) => g.categories)
      .find((c) => c.name === "Internal Transfer");
    expect(transfer && moved).toBeTruthy();
    await client.patch(`/api/recurring/${moved?.id}`, { categoryId: transfer?.id });

    const s = overview(db, TODAY).spending;
    // The gym on the 20th counts; the transfer on the 25th doesn't.
    expect(s.billsExpectedCents).toBe(2_500);
    expect(s.billsExpectedDaily).toHaveLength(24); // Nov 7 through Nov 30.
    expect(s.billsExpectedDaily[0]).toBe(s.monthToDateCents);
    expect(s.billsExpectedDaily[12]).toBe(s.monthToDateCents); // Nov 19.
    expect(s.billsExpectedDaily[13]).toBe(s.monthToDateCents + 2_500); // Nov 20.
    expect(s.billsExpectedDaily.at(-1)).toBe(s.monthToDateCents + 2_500);
  });
});

describe("merchants the bank rewords", () => {
  it("keeps a bill that varies with its series when the name changes", async () => {
    const { account, add, scan, series, seriesOf } = await setup();
    const a = await account("Main");
    for (const [date, cents] of [
      ["2026-05-07", -30000],
      ["2026-06-08", -35200],
      ["2026-07-07", -29500],
      ["2026-08-06", -35205],
      ["2026-09-08", -30161],
      ["2026-10-07", -28848],
    ] as const)
      await add(a.id, date, cents, "SAMPLEPOWER BILL PAY");
    scan();
    const before = series().find((s) => s.name.toLowerCase().includes("samplepower"));
    expect(before?.lastDate).toBe("2026-10-07");

    await add(a.id, "2026-11-05", -22952, "SAMPLE POWER");
    scan();
    const after = series().find((s) => s.id === before?.id);
    expect(after?.lastDate).toBe("2026-11-05");
    expect(after?.paidThisMonth.cents).toBe(-22952);
    expect(seriesOf("SAMPLE POWER", "2026-11-05")).toBe(before?.name);
    expect(series().filter((s) => s.name.toLowerCase().includes("sample"))).toHaveLength(1);

    // Every restart scans again, and the answer has to stay the same.
    scan();
    scan();
    const later = series().find((s) => s.id === before?.id);
    expect(later?.lastDate).toBe("2026-11-05");
    expect(later?.nextDate).toBe("2026-12-05");
    expect(seriesOf("SAMPLE POWER", "2026-11-05")).toBe(before?.name);
  });

  it("links a deposit to the series on its own account, not one with the same name elsewhere", async () => {
    const { account, add, scan, series, db } = await setup();
    const main = await account("Main");
    const side = await account("Side");
    const other = await account("Other");
    const fridays = [
      "2026-09-04",
      "2026-09-11",
      "2026-09-18",
      "2026-09-25",
      "2026-10-02",
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ];
    for (const d of fridays) {
      await add(main.id, d, 170925, "ACME PAYROLL");
      await add(side.id, d, 5000, "ACME PAYROLL SMITH,PAT");
    }
    for (const d of [
      "2026-09-09",
      "2026-09-16",
      "2026-09-23",
      "2026-09-30",
      "2026-10-07",
      "2026-10-14",
      "2026-10-21",
      "2026-10-28",
    ])
      await add(other.id, d, 5000, "ACME PAYROLL");
    scan();
    const named = series().filter((s) => s.name.startsWith("Acme") || s.name.startsWith("ACME"));
    expect(named).toHaveLength(3);

    // The same-amount deposit arrives on Side with Other's wording.
    await add(side.id, "2026-11-06", 5000, "ACME PAYROLL");
    scan();
    const sideSeries = series().find((s) => s.lastAmountCents === 5000 && s.accountId === side.id);
    expect(sideSeries?.lastDate).toBe("2026-11-06");
    expect(sideSeries?.late).toBe(false);
    const otherSeries = series().find((s) => s.accountId === other.id);
    expect(otherSeries?.lastDate).toBe("2026-10-28");
    const t = schema.transactions;
    const row = db
      .select()
      .from(t)
      .all()
      .find((r) => r.accountId === side.id && r.postedDate === "2026-11-06");
    expect(row?.recurringSeriesId).toBe(sideSeries?.id);

    // Every restart scans again, and the answer has to stay the same.
    scan();
    scan();
    const later = series().find((s) => s.id === sideSeries?.id);
    expect(later?.lastDate).toBe("2026-11-06");
    expect(series().find((s) => s.accountId === other.id)?.lastDate).toBe("2026-10-28");
    const again = db
      .select()
      .from(t)
      .all()
      .find((r) => r.accountId === side.id && r.postedDate === "2026-11-06");
    expect(again?.recurringSeriesId).toBe(sideSeries?.id);
  });

  it("leaves a different purchase from the same company alone", async () => {
    const { account, add, scan, series } = await setup();
    const a = await account("Main");
    for (const d of ["2026-06-03", "2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03"])
      await add(a.id, d, -1499, "BIGSHOP PRIME MEMBERSHIP");
    scan();
    const prime = series().find((s) => s.name.toLowerCase().includes("bigshop"));
    // Soon after the last charge: too soon to be the next one, whatever it's called.
    await add(a.id, "2026-10-08", -1450, "BIGSHOP MARKETPLACE");
    // A very different amount.
    await add(a.id, "2026-11-03", -8900, "BIGSHOP MARKETPLACE");
    scan();
    const after = series().find((s) => s.id === prime?.id);
    expect(after?.lastDate).toBe("2026-10-03");
  });
});

describe("a paycheck the bank renames", () => {
  it("keeps this week's check with the weekly series, not an old one by the new name", async () => {
    const { db, account, add, scan, series, seriesOf } = await setup();
    const main = await account("Main");
    const side = await account("Side");
    const desc = "ACME CORP PAYROLL PPD ID: 9000000001";
    // A year ago the same employer was named "Acme Corp" (an old, finished series).
    for (const d of ["2025-06-06", "2025-06-13", "2025-06-20", "2025-06-27", "2025-07-04"])
      await add(main.id, d, 150_000, "ACME CORP DIRECT DEP");
    // Every Friday since: the weekly paycheck.
    for (const d of [
      "2026-09-25",
      "2026-10-02",
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ])
      await add(main.id, d, 170_925, desc);
    // A small weekly split into another account, under the employer's payroll name.
    for (const d of ["2026-09-30", "2026-10-07", "2026-10-14", "2026-10-21", "2026-10-28"])
      await add(side.id, d, 5_000, "ACME CORP PAYROLL");
    scan();
    const payroll = series().find((s) => s.expectedAmountCents === 170_925);
    expect(payroll?.lastDate).toBe("2026-10-30");

    // This Friday's check arrives with the bank calling the merchant "Acme Corp".
    await add(main.id, "2026-11-06", 170_925, desc);
    const t = schema.transactions;
    const old = db
      .select()
      .from(t)
      .all()
      .find((r) => r.rawDescription === "ACME CORP DIRECT DEP");
    const row = db
      .select()
      .from(t)
      .all()
      .find((r) => r.postedDate === "2026-11-06");
    db.update(t).set({ payeeId: old?.payeeId }).where(sql`${t.id} = ${row?.id}`).run();
    scan();
    scan();

    expect(seriesOf(desc, "2026-11-06")).toBe(payroll?.name);
    const after = series().find((s) => s.id === payroll?.id);
    expect(after?.lastDate).toBe("2026-11-06");
    expect(after?.late).toBe(false);
  });
});

describe("a paycheck renamed back to an old series' name", () => {
  it("joins the running weekly series, as in real payroll history", async () => {
    const { db, account, add, series, seriesOf } = await setup();
    const today = "2026-11-08";
    const scanOn = () => db.transaction((tx) => rescanRecurring(tx, today));
    const main = await account("Main");
    const side = await account("Side");
    const third = await account("Third");
    const fridays = (from: string, to: string) => {
      const out: string[] = [];
      for (
        let d = new Date(`${from}T00:00:00Z`);
        d.toISOString().slice(0, 10) <= to;
        d.setUTCDate(d.getUTCDate() + 7)
      )
        out.push(d.toISOString().slice(0, 10));
      return out;
    };
    // Sep 2024 to Jul 2025: the employer was "ACME CORP" (a long, finished series).
    for (const d of fridays("2024-09-06", "2025-07-25")) {
      await add(main.id, d, 159_500, "ACME CORP");
      await add(third.id, d, 5_000, "ACME CORP");
    }
    // From Aug 2025: "ACME CORP PAYROLL", weekly, plus splits into two other accounts.
    for (const d of fridays("2025-08-01", "2026-10-30")) {
      await add(main.id, d, 170_925, "ACME CORP PAYROLL");
      await add(third.id, d, 5_000, "ACME CORP PAYROLL SAMPLE,PERSON");
    }
    for (const d of fridays("2025-07-30", "2026-10-28"))
      await add(side.id, d, 5_000, "ACME CORP PAYROLL");
    scanOn();
    const payroll = series().find((s) => s.expectedAmountCents === 170_925);
    expect(payroll?.lastDate).toBe("2026-10-30");

    // This Friday the bank names it "Acme Corp" again.
    await add(main.id, "2026-11-06", 170_925, "ACME CORP");
    scanOn();
    scanOn();
    expect(seriesOf("ACME CORP", "2026-11-06")).toBe(payroll?.name);
    expect(series().find((s) => s.id === payroll?.id)?.late).toBe(false);
  });
});

describe("rules that count transactions as a recurring series", () => {
  it("link a renamed paycheck to its series, so income isn't counted twice", async () => {
    const { db, client, account, add, series, seriesOf } = await setup();
    const today = "2026-11-08";
    const scanOn = () => db.transaction((tx) => rescanRecurring(tx, today));
    const main = await account("Main");
    for (const d of [
      "2026-09-25",
      "2026-10-02",
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ])
      await add(main.id, d, 170_925, "ACME CORP PAYROLL PPD ID: 9000000001");
    scanOn();
    const payroll = series().find((s) => s.expectedAmountCents === 170_925);
    expect(payroll).toBeDefined();

    // The bank's feed starts calling it something no name check could connect.
    await add(main.id, "2026-11-06", 170_925, "ACME CORP PAYROLL PPD ID: 9000000001");
    const t = schema.transactions;
    const row = db
      .select()
      .from(t)
      .all()
      .find((r) => r.postedDate === "2026-11-06");
    const odd = db
      .insert(schema.payees)
      .values({ id: "p-odd", displayName: "Zeta Holdings" })
      .returning()
      .get();
    db.update(t).set({ payeeId: odd.id }).where(sql`${t.id} = ${row?.id}`).run();
    // Unlink it, as a scan that failed to match would leave it.
    db.update(t).set({ recurringSeriesId: null }).where(sql`${t.id} = ${row?.id}`).run();

    // The rule: what the description says, not what the merchant is called.
    const preview = (
      await client.post("/api/rules/preview", {
        match: "all",
        conditions: [{ field: "description", op: "contains", value: "ACME CORP PAYROLL" }],
        actions: [{ type: "setRecurring", seriesId: payroll?.id }],
      })
    ).json<{ matched: number; wouldChange: number }>();
    expect(preview).toMatchObject({ matched: 7, wouldChange: 1 });
    const made = await client.post("/api/rules", {
      name: "Paycheck",
      match: "all",
      conditions: [{ field: "description", op: "contains", value: "ACME CORP PAYROLL" }],
      actions: [{ type: "setRecurring", seriesId: payroll?.id }],
    });
    expect(made.statusCode).toBe(201);
    scanOn();
    scanOn();

    expect(seriesOf("ACME CORP PAYROLL PPD ID: 9000000001", "2026-11-06")).toBe(payroll?.name);
    const after = series().find((s) => s.id === payroll?.id);
    expect(after).toMatchObject({ lastDate: "2026-11-06", late: false });
    // Expected income: Nov 13, 20 and 27 only, not a second Nov 6 check.
    const o = overview(db, today);
    expect(o.spending.incomeExpectedCents).toBe(3 * 170_925);

    // A rule for a series that doesn't exist is refused.
    const bad = await client.post("/api/rules", {
      name: "Nope",
      match: "all",
      conditions: [{ field: "description", op: "contains", value: "X" }],
      actions: [{ type: "setRecurring", seriesId: "missing" }],
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("each recurring series has a rule of its own", () => {
  it("adds Count as recurring to your rule for a series, but not to a broad one", async () => {
    const { db, client, account, add, series } = await setup();
    const today = "2026-11-08";
    const scanOn = () => db.transaction((tx) => rescanRecurring(tx, today));
    const a = await account("Main");
    for (const m of ["2024-11-08", "2025-10-21", "2026-10-21"])
      await add(a.id, m, -24_266, "SAMPLE WASTE CO 555-0100");
    for (const m of ["06", "07", "08", "09", "10"]) {
      await add(a.id, `2026-${m}-03`, -1_599, "SAMPLE PAY *STREAMCO");
      await add(a.id, `2026-${m}-09`, -1_099, "SAMPLE PAY *TUNEBOX");
    }
    scanOn();
    const waste = series().find((s) => s.expectedAmountCents === -24_266);
    expect(waste).toBeDefined();
    // Your own rule for the bill files it; another rule spans two subscriptions.
    const make = (name: string, value: string) =>
      client.post("/api/rules", {
        name,
        match: "all",
        conditions: [{ field: "description", op: "contains", value }],
        actions: [{ type: "addTag", name: "x" }],
      });
    const mine = (await make("Waste", "SAMPLE WASTE")).json<{ id: string }>();
    const broad = (await make("Pay", "SAMPLE PAY")).json<{ id: string }>();
    scanOn();
    const rules = (await client.get("/api/rules")).json<
      { id: string; actions: { type: string; seriesId?: string }[] }[]
    >();
    const wasteRule = rules.find((r) => r.id === mine.id);
    expect(wasteRule?.actions).toContainEqual({ type: "setRecurring", seriesId: waste?.id });
    expect(
      rules.find((r) => r.id === broad.id)?.actions.some((x) => x.type === "setRecurring"),
    ).toBe(false);

    // Take it off again: it stays off.
    await client.patch(`/api/rules/${mine.id}`, { actions: [{ type: "addTag", name: "x" }] });
    scanOn();
    const again = (await client.get("/api/rules")).json<
      { id: string; actions: { type: string }[] }[]
    >();
    expect(
      again.find((r) => r.id === mine.id)?.actions.some((x) => x.type === "setRecurring"),
    ).toBe(false);
  });

  it("makes a rule for each confirmed series, so a renamed charge stays with it", async () => {
    const { db, client, account, add, series, seriesOf } = await setup();
    const today = "2026-11-08";
    const scanOn = () => db.transaction((tx) => rescanRecurring(tx, today));
    const main = await account("Main");
    const desc = "ACME CORP PAYROLL PPD ID: 9000000001";
    for (const d of [
      "2026-09-25",
      "2026-10-02",
      "2026-10-09",
      "2026-10-16",
      "2026-10-23",
      "2026-10-30",
    ])
      await add(main.id, d, 170_925, desc);
    for (const m of ["06", "07", "08", "09", "10"])
      await add(main.id, `2026-${m}-12`, -999, "SAMPLE GYM");
    scanOn();
    const payroll = series().find((s) => s.expectedAmountCents === 170_925);
    const gym = series().find((s) => s.expectedAmountCents === -999);
    await client.patch(`/api/recurring/${payroll?.id}`, { status: "confirmed" });
    scanOn();
    type R = {
      id: string;
      name: string;
      conditions: { field: string; value: unknown }[];
      actions: { type: string; seriesId?: string }[];
    };
    const rules = (await client.get("/api/rules")).json<R[]>();
    const auto = rules.find((r) =>
      r.actions.some((x) => x.type === "setRecurring" && x.seriesId === payroll?.id),
    );
    expect(auto?.conditions).toContainEqual({
      field: "description",
      op: "contains",
      value: "ACME CORP PAYROLL",
    });
    // Waiting for review: no rule yet.
    if (gym?.status === "detected")
      expect(
        rules.some((r) =>
          r.actions.some((x) => x.type === "setRecurring" && x.seriesId === gym.id),
        ),
      ).toBe(false);

    // The bank renames the merchant: the rule keeps it in the series.
    await add(main.id, "2026-11-06", 170_925, desc);
    const t = schema.transactions;
    const row = db
      .select()
      .from(t)
      .all()
      .find((r) => r.postedDate === "2026-11-06");
    db.insert(schema.payees).values({ id: "p-odd2", displayName: "Zeta Holdings" }).run();
    db.update(t)
      .set({ payeeId: "p-odd2", recurringSeriesId: null })
      .where(sql`${t.id} = ${row?.id}`)
      .run();
    scanOn();
    expect(seriesOf(desc, "2026-11-06")).toBe(payroll?.name);
    expect(series().find((s) => s.id === payroll?.id)?.late).toBe(false);

    // Delete the automatic rule: it isn't made again.
    await client.delete(`/api/rules/${auto?.id}`);
    scanOn();
    const after = (await client.get("/api/rules")).json<R[]>();
    expect(
      after.some((r) =>
        r.actions.some((x) => x.type === "setRecurring" && x.seriesId === payroll?.id),
      ),
    ).toBe(false);
  });
});
