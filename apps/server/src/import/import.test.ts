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
});

describe("bank CSV import", () => {
  const CHASE_CARD = [
    "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
    // Same as the Rocket Money rows (date + amount), different description text.
    "01/22/2026,01/23/2026,STREAMFLIX.COM 800-555-0100,Entertainment,Sale,-15.99,",
    "01/23/2026,01/23/2026,COFFEE SHOP,Food & Drink,Sale,-4.50,",
    "01/23/2026,01/23/2026,COFFEE SHOP,Food & Drink,Sale,-4.50,",
    // Posting-date drift: Rocket Money had this on 01/24.
    "01/24/2026,01/26/2026,Payment Thank You - Web,,Payment,500.00,",
    // Genuinely new.
    "01/30/2026,01/31/2026,HARDWARE STORE,Home,Sale,-30.00,",
    "01/31/2026,02/01/2026,MYSTERY,Uncategorizable Thing,Sale,-1.00,",
  ].join("\n");
  const chase = { filename: "Chase2222_Activity_20260201.CSV", content: CHASE_CARD };

  it("detects the preset and matches the existing account by institution + last 4", async () => {
    const { client } = await makeSignedInApp();
    const card = (
      await client.post("/api/accounts", {
        name: "Freedom",
        type: "credit",
        institutionName: "Chase",
        mask: "2222",
      })
    ).json<Account>();
    const p = (await client.post("/api/import/preview", chase)).json<ImportPreview>();
    expect(p.format).toBe("csv");
    expect(p.csv?.preset?.id).toBe("chase_card");
    expect(p.csv?.headers).toContain("Post Date");
    expect(p.accounts).toEqual([
      expect.objectContaining({
        key: "csv",
        mask: "2222",
        match: { id: card.id, name: "Freedom" },
      }),
    ]);
    // Bank categories map onto existing ones but never create new ones.
    expect(p.newCategories).toEqual([]);
  });

  it("skips transactions already imported from Rocket Money", async () => {
    const { client } = await makeSignedInApp();
    const rm = (await client.post("/api/import/preview", body)).json<ImportPreview>();
    await client.post("/api/import/commit", {
      ...body,
      accountMap: Object.fromEntries(rm.accounts.map((a) => [a.key, "new"])),
    });
    const card = (await client.get("/api/accounts"))
      .json<Account[]>()
      .find((a) => a.mask === "2222");
    expect(card).toBeDefined();

    const p = (await client.post("/api/import/preview", chase)).json<ImportPreview>();
    expect(p.accounts[0]?.match?.id).toBe(card?.id);
    expect(p.duplicateCount).toBe(4);

    const r = (
      await client.post("/api/import/commit", { ...chase, accountMap: { csv: card?.id ?? "" } })
    ).json<ImportResult>();
    expect(r).toMatchObject({ imported: 2, duplicates: 4, categoriesCreated: 0 });

    const txns = (
      await client.get(`/api/transactions?accountId=${card?.id}&limit=50`)
    ).json<TransactionPage>();
    const hw = txns.items.find((t) => t.rawDescription === "HARDWARE STORE");
    expect(hw).toMatchObject({ amountCents: -3000, postedDate: "2026-01-31" });
    expect(txns.items.find((t) => t.rawDescription === "MYSTERY")?.categoryName).toBeNull();

    // Re-importing the bank file is a no-op too.
    const again = (
      await client.post("/api/import/commit", { ...chase, accountMap: { csv: card?.id ?? "" } })
    ).json<ImportResult>();
    expect(again).toMatchObject({ imported: 0, duplicates: 6 });
  });

  it("returns headers and no accounts when columns can't be guessed, then accepts a mapping", async () => {
    const { client } = await makeSignedInApp();
    const file = { filename: "odd.csv", content: "When,What,How much\n2026-01-02,Coffee,4.50" };
    const p = (await client.post("/api/import/preview", file)).json<ImportPreview>();
    expect(p.csv).toMatchObject({ headers: ["When", "What", "How much"], mapping: null });
    expect(p.accounts).toEqual([]);
    expect((await client.post("/api/import/commit", { ...file, accountMap: {} })).statusCode).toBe(
      400,
    );

    const csv = {
      date: "When",
      dateFormat: "YYYY-MM-DD",
      description: "What",
      amount: "How much",
      negate: true,
    };
    const p2 = (await client.post("/api/import/preview", { ...file, csv })).json<ImportPreview>();
    expect(p2.transactionCount).toBe(1);
    const r = (
      await client.post("/api/import/commit", { ...file, csv, accountMap: { csv: "new" } })
    ).json<ImportResult>();
    expect(r).toMatchObject({ imported: 1, accountsCreated: 1 });
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0];
    expect(acc).toMatchObject({ name: "odd", balanceCents: -450 });
  });

  it("validates the mapping", async () => {
    const { client } = await makeSignedInApp();
    const res = await client.post("/api/import/preview", {
      filename: "x.csv",
      content: "a,b\n1,2",
      csv: { date: "a", dateFormat: "YYYY-MM-DD", description: "b" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("OFX import", () => {
  const OFX = `OFXHEADER:100
DATA:OFXSGML

<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Example Bank</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>1<ACCTID>000123459999<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-20.00<FITID>A1<NAME>GROCER</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260106<TRNAMT>-20.00<FITID>A2<NAME>GROCER</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260107<TRNAMT>100.00<FITID>A3<NAME>PAY</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1060.00<DTASOF>20260107</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const file = { filename: "statement.qfx", content: OFX };

  it("imports, applies the statement balance, and dedupes by FITID", async () => {
    const { client } = await makeSignedInApp();
    const p = (await client.post("/api/import/preview", file)).json<ImportPreview>();
    expect(p).toMatchObject({ format: "ofx", transactionCount: 3, csv: null });
    expect(p.accounts[0]).toMatchObject({
      key: "ofx-1",
      name: "Example Bank Checking",
      mask: "9999",
      statementBalance: { cents: 106000, asOf: "2026-01-07" },
    });

    const r = (
      await client.post("/api/import/commit", {
        ...file,
        accountMap: { "ofx-1": "new" },
        applyBalances: ["ofx-1"],
      })
    ).json<ImportResult>();
    expect(r).toMatchObject({ imported: 3, accountsCreated: 1, balancesUpdated: 1 });
    const acc = (await client.get("/api/accounts")).json<Account[]>()[0];
    expect(acc?.balanceCents).toBe(106000);

    // Same FITIDs with a changed description are still duplicates.
    const renamed = { ...file, content: OFX.replace(/GROCER/g, "GROCERY STORE") };
    const r2 = (
      await client.post("/api/import/commit", { ...renamed, accountMap: { "ofx-1": acc?.id } })
    ).json<ImportResult>();
    expect(r2).toMatchObject({ imported: 0, duplicates: 3, balancesUpdated: 0 });
  });
});
