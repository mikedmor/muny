import { ROCKET_MONEY_HEADERS } from "@muny/core";
import { schema } from "@muny/db";
import type {
  Account,
  CategoryGroup,
  ImportPreview,
  ImportResult,
  TransactionPage,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only.
const RM = [
  ROCKET_MONEY_HEADERS.join(","),
  "2026-01-21,2026-01-21,Cash,MAIN ACCOUNT,1111,Example Bank,PAYPAL INST XFER MEALKIT,,40.73,PAYPAL INST XFER MEALKIT,Groceries,,,,",
  "2026-01-22,2026-01-22,Cash,MAIN ACCOUNT,1111,Example Bank,ACME PAYROLL,Acme Payroll,-2500.00,ACME PAYROLL DIR DEP,Paychecks,,,,",
  "2026-01-23,2026-01-23,Credit Card,Rewards Card,2222,Card Co,STREAMFLIX.COM,StreamFlix,15.99,STREAMFLIX.COM,Entertainment & Rec.,,,,subscriptions",
  "2026-01-23,2026-01-23,Credit Card,Rewards Card,2222,Card Co,COFFEE,,4.50,COFFEE,Coffee Shops,,,,",
  "2026-01-23,2026-01-23,Credit Card,Rewards Card,2222,Card Co,COFFEE,,4.50,COFFEE,Coffee Shops,,,,",
  "2026-01-24,2026-01-24,Credit Card,Rewards Card,2222,Card Co,CARD PAYMENT,,-500,CARD PAYMENT,Credit Card Payment,,everything,,",
].join("\n");

const body = { filename: "transactions.csv", content: RM };

describe("Rocket Money import", () => {
  it("previews accounts, counts, and new categories", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/import/preview", body);
    expect(res.statusCode).toBe(200);
    const p = res.json<ImportPreview>();
    expect(p).toMatchObject({
      format: "rocket_money",
      transactionCount: 6,
      duplicateCount: 0,
      firstDate: "2026-01-21",
      lastDate: "2026-01-24",
      errorCount: 0,
    });
    expect(p.accounts.map((a) => [a.name, a.type, a.transactionCount, a.match])).toEqual([
      ["MAIN ACCOUNT", "checking", 2, null],
      ["Rewards Card", "credit", 4, null],
    ]);
    // "Paychecks" and "Entertainment & Rec." map via aliases; "Coffee Shops" is new.
    expect(p.newCategories).toEqual(["Coffee Shops"]);
  });

  it("imports everything into new accounts and is idempotent", async () => {
    const { client } = await makeSignedInApp();
    const p = (await client.post("/api/import/preview", body)).json<ImportPreview>();
    const accountMap = Object.fromEntries(p.accounts.map((a) => [a.key, "new"]));

    const r = (
      await client.post("/api/import/commit", { ...body, accountMap })
    ).json<ImportResult>();
    expect(r).toMatchObject({
      imported: 6,
      duplicates: 0,
      accountsCreated: 2,
      categoriesCreated: 1,
    });

    const accounts = (await client.get("/api/accounts")).json<Account[]>();
    const card = accounts.find((a) => a.name === "Rewards Card");
    expect(card).toMatchObject({ provider: "file", mask: "2222", institutionName: "Card Co" });
    // -15.99 - 4.50 - 4.50 + 500 payment
    expect(card?.balanceCents).toBe(-1599 - 450 - 450 + 50000);

    const txns = (
      await client.get("/api/transactions?hidden=include&limit=50")
    ).json<TransactionPage>();
    const stream = txns.items.find((t) => t.rawDescription === "STREAMFLIX.COM");
    expect(stream).toMatchObject({
      description: "StreamFlix",
      categoryName: "Entertainment",
      amountCents: -1599,
    });
    expect(stream?.tags.map((t) => t.name)).toEqual(["subscriptions"]);
    const pay = txns.items.find((t) => t.rawDescription === "ACME PAYROLL DIR DEP");
    expect(pay).toMatchObject({ categoryName: "Paycheck", amountCents: 250000 });
    expect(txns.items.find((t) => t.rawDescription === "CARD PAYMENT")?.hidden).toBe(true);

    // Same file again: preview sees duplicates, commit adds nothing.
    const p2 = (await client.post("/api/import/preview", body)).json<ImportPreview>();
    expect(p2.duplicateCount).toBe(6);
    expect(p2.accounts.every((a) => a.match !== null)).toBe(true);
    const r2 = (
      await client.post("/api/import/commit", {
        ...body,
        accountMap: Object.fromEntries(p2.accounts.map((a) => [a.key, a.match?.id ?? "new"])),
      })
    ).json<ImportResult>();
    expect(r2).toMatchObject({ imported: 0, duplicates: 6, accountsCreated: 0 });
  });

  it("keeps two identical same-day transactions", async () => {
    const { client, db } = await makeSignedInApp();
    const p = (await client.post("/api/import/preview", body)).json<ImportPreview>();
    await client.post("/api/import/commit", {
      ...body,
      accountMap: Object.fromEntries(p.accounts.map((a) => [a.key, "new"])),
    });
    const coffees = db
      .select()
      .from(schema.transactions)
      .all()
      .filter((t) => t.rawDescription === "COFFEE");
    expect(coffees).toHaveLength(2);
  });

  it("can map into an existing account and skip another", async () => {
    const { client } = await makeSignedInApp();
    const mine = (
      await client.post("/api/accounts", { name: "My Checking", type: "checking" })
    ).json<Account>();
    const p = (await client.post("/api/import/preview", body)).json<ImportPreview>();
    const [main, card] = p.accounts;
    const r = (
      await client.post("/api/import/commit", {
        ...body,
        accountMap: { [main?.key ?? ""]: mine.id, [card?.key ?? ""]: "skip" },
      })
    ).json<ImportResult>();
    expect(r).toMatchObject({ imported: 2, skipped: 4, accountsCreated: 0 });
    expect((await client.get(`/api/accounts/${mine.id}`)).json<Account>().transactionCount).toBe(2);
  });

  it("puts new income/transfer categories in the right group", async () => {
    const { client } = await makeSignedInApp();
    const content = [
      ROCKET_MONEY_HEADERS.join(","),
      "2026-01-01,2026-01-01,Cash,A,1,B,X,,-10,X,Side Hustle Income,,,,",
      "2026-01-02,2026-01-02,Cash,A,1,B,Y,,10,Y,Brokerage Transfer,,,,",
      "2026-01-03,2026-01-03,Cash,A,1,B,Z,,10,Z,Homelab,,,,",
    ].join("\n");
    const p = (
      await client.post("/api/import/preview", { filename: "x.csv", content })
    ).json<ImportPreview>();
    await client.post("/api/import/commit", {
      filename: "x.csv",
      content,
      accountMap: Object.fromEntries(p.accounts.map((a) => [a.key, "new"])),
    });
    const groups = (await client.get("/api/categories")).json<CategoryGroup[]>();
    const groupOf = (name: string) => groups.find((g) => g.categories.some((c) => c.name === name));
    expect(groupOf("Side Hustle Income")?.kind).toBe("income");
    expect(groupOf("Brokerage Transfer")?.kind).toBe("transfer");
    expect(groupOf("Homelab")?.name).toBe("Imported");
  });

  it("rejects unsupported files clearly", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/import/preview", {
      filename: "bank.csv",
      content: "Foo,Bar\n1,2",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn't supported yet/);
  });
});
