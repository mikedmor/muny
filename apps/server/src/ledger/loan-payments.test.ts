import { schema } from "@muny/db";
import type {
  Account,
  CategoryGroup,
  RecurringSeries,
  SpendingReport,
  TransactionPage,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { localToday } from "../lib/dates.js";
import { rescanRecurring } from "../recurring/service.js";
import { makeSignedInApp } from "../test-utils.js";
import { pairLoanPayments } from "./transfers.js";

// Synthetic data only.

const monthsAgo = (n: number, day: number) => {
  const d = new Date(`${localToday()}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(day);
  return d.toISOString().slice(0, 10);
};

describe("loan payments", () => {
  it("pairs a payment you filed as spending with the money arriving in the loan", async () => {
    const { client, db } = await makeSignedInApp();
    const chk = (
      await client.post("/api/accounts", {
        name: "Checking",
        type: "checking",
        institutionName: "Example Bank",
      })
    ).json<Account>();
    const loan = (
      await client.post("/api/accounts", {
        name: "Apollo",
        type: "loan",
        institutionName: "GreenSky",
      })
    ).json<Account>();
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const loanPayment = groups.flatMap((g) => g.categories).find((c) => c.name === "Loan Payment");
    expect(loanPayment).toBeDefined();
    for (let m = 6; m >= 1; m--) {
      const pay = (
        await client.post("/api/transactions", {
          accountId: chk.id,
          postedDate: monthsAgo(m, 10),
          amountCents: -15000,
          description: "GREENSKY WEB PAY GREENSKY",
        })
      ).json<{ id: string }>();
      await client.patch(`/api/transactions/${pay.id}`, { categoryId: loanPayment?.id });
      await client.post("/api/transactions", {
        accountId: loan.id,
        postedDate: monthsAgo(m, 8),
        amountCents: 15000,
        description: "Web",
      });
      await client.post("/api/transactions", {
        accountId: loan.id,
        postedDate: monthsAgo(m, 5),
        amountCents: -7434,
        description: "Finance Charge",
      });
    }

    const paired = db.transaction((tx) => pairLoanPayments(tx));
    expect(paired).toBe(6);
    db.transaction((tx) => rescanRecurring(tx));

    // The checking side keeps "Loan Payment"; the loan side is a transfer, not income.
    const chkTxns = (
      await client.get(`/api/transactions?accountId=${chk.id}&hidden=include&limit=100`)
    ).json<TransactionPage>().items;
    expect(chkTxns.every((t) => t.categoryName === "Loan Payment" && t.transferPairId)).toBe(true);

    // Recurring: the payment is a bill; nothing comes from the loan account itself.
    const series = (await client.get("/api/recurring")).json<RecurringSeries[]>();
    expect(series.some((x) => x.accountId === loan.id)).toBe(false);
    expect(series.some((x) => x.kind === "income")).toBe(false);

    // Spending counts the payments, not the loan's interest charges as well.
    const from = monthsAgo(6, 1);
    const sp = (
      await client.get(`/api/reports/spending?from=${from}&to=${localToday()}&by=category`)
    ).json<SpendingReport>();
    expect(sp.totalCents).toBe(6 * 15000);
    expect(db.select().from(schema.transactions).all().length).toBe(18);
  });
});
