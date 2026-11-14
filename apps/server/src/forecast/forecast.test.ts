import { newId, schema } from "@muny/db";
import type { BalanceForecast } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { setAccountAlerts } from "../alerts/accounts.js";
import { evaluateRules, type RuleRow } from "../alerts/evaluate.js";
import { updateCard } from "../cards/service.js";
import { makeSignedInApp } from "../test-utils.js";
import { balanceForecast } from "./service.js";

// Synthetic only: a made-up checking account, card and bills.

const TODAY = "2026-11-14";

async function setup() {
  const ctx = await makeSignedInApp();
  const { db } = ctx;
  const acct = (
    name: string,
    type: "checking" | "savings" | "credit",
    openingBalanceCents: number,
  ) => {
    const id = newId();
    db.insert(schema.accounts).values({ id, name, type, openingBalanceCents }).run();
    return id;
  };
  const checking = acct("Everyday Checking", "checking", 300_000);
  acct("Rainy Day Savings", "savings", 500_000);
  const card = acct("Sample Card", "credit", -45_000);
  let n = 0;
  const tx = (accountId: string, date: string, amountCents: number, pending = false) =>
    db
      .insert(schema.transactions)
      .values({
        id: newId(),
        accountId,
        postedDate: date,
        amountCents,
        rawDescription: `ITEM ${++n}`,
        pending,
        importHash: `h${n}`,
      })
      .run();
  // 90 days of $20 a day everyday spending, plus one $900 repair (left out as a one-off).
  for (let i = 1; i <= 90; i++) {
    const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    tx(checking, d, -2_000);
  }
  tx(checking, "2026-10-20", -90_000);
  tx(checking, TODAY, -5_000, true); // pending
  const series = (
    name: string,
    kind: "income" | "bill",
    interval: "biweekly" | "monthly",
    lastDate: string,
    cents: number,
  ) =>
    db
      .insert(schema.recurringSeries)
      .values({
        id: newId(),
        name,
        matchKey: name.toLowerCase(),
        direction: cents > 0 ? "in" : "out",
        anchorCents: Math.abs(cents),
        kind,
        status: "confirmed",
        interval,
        expectedAmountCents: cents,
        firstDate: "2026-01-01",
        lastDate,
        lastAmountCents: cents,
        accountId: checking,
      })
      .run();
  series("Acme Payroll", "income", "biweekly", "2026-11-06", 200_000);
  series("Sample Property Mgmt", "bill", "monthly", "2026-11-01", -165_000);
  updateCard(db, card, {
    statementBalanceCents: 40_000,
    statementDate: "2026-11-01",
    dueDate: "2026-11-25",
    paymentFromAccountId: checking,
  });
  return { ...ctx, checking, card };
}

describe("balance forecast", () => {
  it("adds bills, pay, the card payment and everyday spending to today's balance", async () => {
    const { db, checking } = await setup();
    const f = balanceForecast(db, { days: 30 }, TODAY);
    // The busiest checking account is the default.
    expect(f.account?.id).toBe(checking);
    expect(f.accounts.map((a) => a.name).sort()).toEqual([
      "Everyday Checking",
      "Rainy Day Savings",
    ]);
    // $3,000 opening − 90 × $20 − $900, then the pending $50.
    expect(f.account?.balanceCents).toBe(300_000 - 180_000 - 90_000);
    expect(f.startCents).toBe(30_000 - 5_000);
    expect(f.pendingCents).toBe(-5_000);
    // The repair is the largest 5% and left out: $20 a day.
    expect(f.dailySpendCents).toBe(2_000);
    const names = f.items.map((i) => `${i.date} ${i.name} ${i.amountCents}`);
    expect(names).toContain("2026-11-20 Acme Payroll 200000");
    expect(names).toContain("2026-11-25 Sample Card payment -40000");
    expect(names).toContain("2026-12-01 Sample Property Mgmt -165000");
    expect(names).toContain("2026-12-04 Acme Payroll 200000");
    expect(f.points).toHaveLength(31);
    // Day 6 (Nov 20): $250 − 6 × $20 + $2,000.
    expect(f.points[6]).toEqual({ date: "2026-11-20", balanceCents: 25_000 - 12_000 + 200_000 });
    // It runs short before the 20th's paycheck? No: $250 − 5 × $20 = $150 on the 19th; below zero isn't reached until later.
    expect(f.lowest.balanceCents).toBeLessThan(f.startCents);
  });

  it("warns once when an account is headed below its low-balance amount", async () => {
    const { db, client, checking } = await setup();
    setAccountAlerts(db, checking, {
      lowBalanceCents: 20_000,
      largeChargeCents: null,
      unusualCharge: false,
      duplicateCharge: false,
    });
    const f = (
      await client.get(`/api/forecast?accountId=${checking}&days=14`)
    ).json<BalanceForecast>();
    expect(f.thresholdCents).toBe(20_000);
    // $250 today, $20 a day: below $200 on the 17th.
    expect(f.firstBelow).toEqual({ date: "2026-11-17", balanceCents: 19_000 });

    const rules: RuleRow[] = [
      { type: "low_balance_ahead", params: { daysBefore: 14 }, since: new Date(0) },
    ];
    const first = evaluateRules(db, rules, TODAY, new Date(`${TODAY}T12:00:00Z`));
    expect(first.map((c) => c.title)).toEqual([
      expect.stringMatching(/^Everyday Checking may drop below \$200\.00 on Tue, Nov 17$/),
    ]);
    // Saved state: no second warning while it stays the same.
    const again = evaluateRules(db, rules, TODAY, new Date(`${TODAY}T12:05:00Z`));
    expect(again).toHaveLength(0);
  });
});
