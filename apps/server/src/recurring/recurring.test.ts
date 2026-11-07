import { addInterval } from "@muny/core";
import { newId, schema } from "@muny/db";
import type {
  Account,
  RecurringScanResult,
  RecurringSeries,
  Transaction,
  TransactionPage,
  UpcomingCharge,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { makeSignedInApp, type TestClient } from "../test-utils.js";

// Synthetic data only. Dates are relative to today so "active" holds.

const today = localToday();
const monthsAgo = (n: number, day = 5) => {
  const d = addInterval(today, "monthly", -n);
  return `${d.slice(0, 8)}${String(day).padStart(2, "0")}`;
};

function csv(rows: [string, string, string][]) {
  return ["Date,Description,Amount", ...rows.map((r) => r.join(","))].join("\n");
}

async function setup() {
  const ctx = await makeSignedInApp();
  const rows: [string, string, string][] = [];
  for (let i = 6; i >= 1; i--)
    rows.push([monthsAgo(i, 5), "STREAMFLIX.COM 800-555-0100", "-15.99"]);
  for (let i = 6; i >= 1; i--)
    rows.push([
      monthsAgo(i, 12),
      "POWER CO BILL PAY",
      `-${[98.5, 112, 87.3, 76, 91.2, 124.8][i - 1]}`,
    ]);
  rows.push([monthsAgo(3, 20), "HARDWARE STORE", "-30.00"]);
  rows.push([monthsAgo(2, 9), "HARDWARE STORE", "-12.00"]);
  await ctx.client.post("/api/import/commit", {
    filename: "bank.csv",
    content: csv(rows),
    accountMap: { csv: "new" },
  });
  return ctx;
}

const list = async (c: TestClient) => (await c.get("/api/recurring")).json<RecurringSeries[]>();

describe("recurring", () => {
  it("detects subscriptions and bills on import", async () => {
    const { client } = await setup();
    const all = await list(client);
    expect(all.map((s) => [s.name, s.kind, s.interval, s.fixedAmount]).sort()).toEqual([
      ["Power Co", "bill", "monthly", false],
      ["Streamflix", "subscription", "monthly", true],
    ]);
    const sf = all.find((s) => s.name === "Streamflix") as RecurringSeries;
    expect(sf).toMatchObject({
      expectedAmountCents: -1599,
      monthlyCents: -1599,
      annualCents: -19188,
      transactionCount: 6,
      active: true,
      status: "detected",
      accountName: "bank",
    });
    expect(sf.nextDate >= today || sf.late).toBe(true);
    const history = (await client.get(`/api/recurring/${sf.id}/transactions`)).json<
      Transaction[]
    >();
    expect(history).toHaveLength(6);
  });

  it("lists upcoming charges", async () => {
    const { client } = await setup();
    const up = (await client.get("/api/recurring/upcoming")).json<UpcomingCharge[]>();
    // Unique names: on the charge day itself a 30-day window can hold two occurrences.
    expect([...new Set(up.map((u) => u.name))].sort()).toEqual(["Power Co", "Streamflix"]);
    expect(up.every((u) => u.date >= today)).toBe(true);
    const year = (
      await client.get(`/api/recurring/upcoming?from=${today}&to=${addInterval(today, "annual")}`)
    ).json<UpcomingCharge[]>();
    expect(year.filter((u) => u.name === "Streamflix").length).toBeGreaterThanOrEqual(12);
    expect(
      (await client.get(`/api/recurring/upcoming?from=${today}&to=2000-01-01`)).statusCode,
    ).toBe(400);
  });

  it("keeps the user's edits and ignored items across rescans", async () => {
    const { client } = await setup();
    const [a, b] = await list(client);
    await client.patch(`/api/recurring/${a?.id}`, {
      name: "My Stream",
      kind: "bill",
      status: "confirmed",
    });
    await client.patch(`/api/recurring/${b?.id}`, { status: "ignored" });
    const r = (await client.post("/api/recurring/rescan")).json<RecurringScanResult>();
    expect(r.created).toBe(0);
    const after = await list(client);
    expect(after.find((s) => s.id === a?.id)).toMatchObject({
      name: "My Stream",
      kind: "bill",
      status: "confirmed",
    });
    expect(after.find((s) => s.id === b?.id)).toMatchObject({
      status: "ignored",
      transactionCount: 0,
    });
  });

  it("flags charges after cancelling", async () => {
    const { client } = await setup();
    const sf = (await list(client)).find((s) => s.name === "Streamflix") as RecurringSeries;
    const cancelled = (
      await client.patch(`/api/recurring/${sf.id}`, { status: "cancelled" })
    ).json<RecurringSeries>();
    expect(cancelled).toMatchObject({
      cancelledAt: today,
      active: false,
      chargedAfterCancel: false,
    });
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0] as Account;
    // The next month's charge shows up anyway.
    const next = addInterval(today, "monthly");
    await client.post("/api/import/commit", {
      filename: "more.csv",
      content: csv([[next, "STREAMFLIX.COM 800-555-0100", "-15.99"]]),
      accountMap: { csv: acc.id },
    });
    expect((await list(client)).find((s) => s.id === sf.id)).toMatchObject({
      chargedAfterCancel: true,
    });
    expect(
      (await client.get("/api/recurring/upcoming"))
        .json<UpcomingCharge[]>()
        .some((u) => u.seriesId === sf.id),
    ).toBe(false);
  });

  it("links a charge worded differently by the bank sync to the existing bill", async () => {
    const { client } = await setup();
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0] as Account;
    const history: [string, string, string][] = [];
    for (let i = 5; i >= 1; i--)
      // The payment went up (escrow) a month ago: more than 10% above the older ones.
      history.push([
        addInterval(today, "monthly", -i),
        "MORTGAGE BANK MTG",
        i === 1 ? "-2740.90" : "-2456.19",
      ]);
    await client.post("/api/import/commit", {
      filename: "history.csv",
      content: csv(history),
      accountMap: { csv: acc.id },
    });
    const mtg = (await list(client)).find((s) => s.name === "Mortgage Bank Mtg") as RecurringSeries;
    expect(mtg).toBeTruthy();

    // This month's payment arrives in raw ACH wording, plus an unrelated small charge.
    await client.post("/api/import/commit", {
      filename: "sync.csv",
      content: csv([
        [
          today,
          "ORIG CO NAME:MORTGAGE BANK CO ENTRY DESCR:MTG SEC:WEB TRACE#:1 IND ID:2",
          "-2740.90",
        ],
        [today, "ORIG CO NAME:MORTGAGE BANK CO ENTRY DESCR:FEE SEC:WEB", "-25.00"],
      ]),
      accountMap: { csv: acc.id },
    });
    const after = (await list(client)).find((s) => s.id === mtg.id) as RecurringSeries;
    expect(after).toMatchObject({ lastDate: today, transactionCount: 6 });
    const txns = (
      await client.get("/api/transactions?q=mortgage&limit=50")
    ).json<TransactionPage>();
    const fee = txns.items.find((t) => t.amountCents === -2500) as Transaction;
    expect(fee.recurringSeriesId).toBeNull();
    // Paid this month, so it's not "coming up" until next month.
    const up = (await client.get("/api/recurring/upcoming")).json<UpcomingCharge[]>();
    expect(up.filter((u) => u.seriesId === mtg.id).every((u) => u.date > today)).toBe(true);
  });

  it("creates a series by hand from a transaction", async () => {
    const { client } = await setup();
    const txns = (await client.get("/api/transactions?limit=50")).json<TransactionPage>().items;
    const hw = txns.find((t) => t.payeeName === "Hardware Store") as Transaction;
    const r = await client.post("/api/recurring", { transactionId: hw.id, interval: "annual" });
    expect(r.statusCode).toBe(201);
    const s = r.json<RecurringSeries>();
    expect(s).toMatchObject({
      source: "manual",
      status: "confirmed",
      interval: "annual",
      kind: "subscription",
    });
    expect((await client.delete(`/api/recurring/${s.id}`)).statusCode).toBe(200);
    const detected = (await list(client))[0] as RecurringSeries;
    expect((await client.delete(`/api/recurring/${detected.id}`)).statusCode).toBe(400);
  });
});

describe("recurring: names that change, and pending charges", () => {
  it("keeps a series when its merchant is renamed", async () => {
    const { client, db } = await setup();
    const before = (await list(client)).find((s) => s.name === "Streamflix") as RecurringSeries;
    const payee = db
      .select()
      .from(schema.payees)
      .all()
      .find((p) => p.displayName === "Streamflix");
    if (!payee) throw new Error("payee missing");
    await client.patch(`/api/payees/${payee.id}`, { displayName: "Flix Plus" });
    await client.post("/api/recurring/rescan", {});
    const after = await list(client);
    expect(after.filter((s) => s.expectedAmountCents === -1599)).toHaveLength(1);
    expect(after.find((s) => s.id === before.id)?.transactionCount).toBe(before.transactionCount);
    const row = db
      .select()
      .from(schema.recurringSeries)
      .all()
      .find((s) => s.id === before.id);
    expect(row?.matchKey).toBe("flix plus");
  });

  it("says what a series has paid this month", async () => {
    const { client } = await setup();
    const sf = (await list(client)).find((s) => s.name === "Streamflix") as RecurringSeries;
    expect(sf.paidThisMonth).toEqual({ cents: 0, count: 0, lastDate: null });
    await client.post("/api/import/commit", {
      filename: "more.csv",
      content: csv([[today, "STREAMFLIX.COM 800-555-0100", "-15.99"]]),
      accountMap: { csv: sf.accountId },
    });
    await client.post("/api/recurring/rescan", {});
    const now = (await list(client)).find((s) => s.id === sf.id) as RecurringSeries;
    expect(now.paidThisMonth).toEqual({ cents: -1599, count: 1, lastDate: today });
  });

  it("shows a pending charge as the next one", async () => {
    const { client, db } = await setup();
    const sf = (await list(client)).find((s) => s.name === "Streamflix") as RecurringSeries;
    const acc = db.select().from(schema.accounts).get();
    if (!acc) throw new Error("account missing");
    db.insert(schema.transactions)
      .values({
        id: newId(),
        accountId: acc.id,
        postedDate: today,
        amountCents: -1599,
        currency: "USD",
        rawDescription: "POS DEBIT STREAMFLIX.COM SEATTLE WA",
        pending: true,
        importHash: newId(),
      })
      .run();
    const now = (await list(client)).find((s) => s.id === sf.id) as RecurringSeries;
    expect(now.pending).toMatchObject({ date: today, amountCents: -1599 });
    expect(now.late).toBe(false);
    const up = (await client.get(`/api/recurring/upcoming?from=${today}`)).json<UpcomingCharge[]>();
    const mine = up.filter((u) => u.seriesId === sf.id);
    expect(mine[0]).toMatchObject({ pending: true, date: today });
    // The pending charge stands for the next expected one.
    expect(
      mine.filter((u) => !u.pending).every((u) => u.date > addInterval(sf.lastDate, "monthly")),
    ).toBe(true);
  });
});
