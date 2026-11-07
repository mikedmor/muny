import { schema } from "@muny/db";
import type { Account, RecurringSeries } from "@muny/shared";
import { describe, expect, it } from "vitest";
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
