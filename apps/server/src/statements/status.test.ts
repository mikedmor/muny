import type { Account, DocumentInfo, StatementStatus } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { detectStatement, guessDate } from "./detect.js";
import { addMonthsIso, linkStatementDocuments, statusFor } from "./status.js";

// Synthetic statement text and files only.
const pdfOf = (tag: string) =>
  Buffer.from(`%PDF-1.4\n% synthetic statement ${tag}\n%%EOF`).toString("base64");

describe("statement status", () => {
  it("steps months, clamping to the month's end", () => {
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsIso("2026-11-15", 2)).toBe("2027-01-15");
  });

  it("lists the months missing between and after statements", () => {
    const s = statusFor("a", ["2026-06-13", "2026-08-13", "2026-08-13"], "2026-11-06");
    expect(s).toMatchObject({
      lastDate: "2026-08-13",
      count: 2,
      // Sep and Oct are out by now; Nov 13 isn't yet.
      missingMonths: ["2026-07", "2026-09", "2026-10"],
      missing: 3,
      nextDate: "2026-11-13",
    });
    // Within a few days of the closing date it isn't missing yet.
    expect(statusFor("a", ["2026-10-03"], "2026-11-06")?.missing).toBe(0);
    expect(statusFor("a", [], "2026-11-06")).toBeNull();
  });

  it("keeps a statement without reading it, for any account", async () => {
    const { client } = await makeSignedInApp();
    const acc = (
      await client.post("/api/accounts", { name: "Checking", type: "checking", mask: "4321" })
    ).json<Account>();
    const store = (date: string, tag: string) =>
      client.post(`/api/accounts/${acc.id}/statements`, {
        pdfBase64: pdfOf(tag),
        statementDate: date,
      });
    const r = await store("2026-09-30", "a");
    expect(r.statusCode).toBe(200);
    expect(r.json<DocumentInfo>()).toMatchObject({
      accountId: acc.id,
      folder: "Statements / Checking",
      documentDate: "2026-09-30",
    });
    await store("2026-10-31", "b");
    // A date is required.
    expect(
      (await client.post(`/api/accounts/${acc.id}/statements`, { pdfBase64: pdfOf("c") }))
        .statusCode,
    ).toBe(400);
    const status = (await client.get("/api/statements/status")).json<StatementStatus[]>();
    expect(status).toEqual([
      expect.objectContaining({ accountId: acc.id, lastDate: "2026-10-31", count: 2 }),
    ]);
  });

  it("tells cards from loans and finds the account by its last 4", async () => {
    const { client, db } = await makeSignedInApp();
    const card = (
      await client.post("/api/accounts", { name: "Card", type: "credit", mask: "1111" })
    ).json<Account>();
    const rows = (t: string[]) => t.map((l) => [l]);
    const cardText = [
      "Account ending in 1111",
      "New Balance $845.12",
      "Payment Due Date 11/10/26",
      "Minimum Payment Due $35.00",
    ];
    expect(detectStatement(db, rows(cardText))).toMatchObject({
      kind: "card",
      accountId: card.id,
      mask: "1111",
    });
    const newCard = detectStatement(db, rows(cardText.map((l) => l.replace("1111", "2222"))));
    expect(newCard).toMatchObject({ kind: "card", accountId: null, mask: "2222" });
    const loan = detectStatement(
      db,
      rows([
        "Mortgage statement",
        "Loan number ending 3333",
        "Statement Date 10/15/2026",
        "Principal Balance $180,000.00",
        "Payment Due Date 11/01/2026",
        "Amount Due $1,450.00",
      ]),
    );
    expect(loan).toMatchObject({ kind: "loan", accountId: null, date: "2026-10-15" });
    expect(detectStatement(db, rows(["Hello", "Nothing here"]))).toMatchObject({
      kind: "unknown",
      date: null,
    });
  });

  it("suggests a date for statements it can't read", () => {
    expect(guessDate(["Statement Period 10/01/26 - 10/31/26"])).toBe("2026-10-31");
    expect(guessDate(["Closing Date: October 20, 2026"])).toBe("2026-10-20");
    expect(guessDate(["No dates"])).toBeNull();
  });

  it("links statements kept before they had an account", async () => {
    const { client, db } = await makeSignedInApp();
    const card = (
      await client.post("/api/accounts", { name: "Travel card", type: "credit" })
    ).json<Account>();
    const up = await client.post("/api/documents", {
      name: "old.pdf",
      mime: "application/pdf",
      dataBase64: pdfOf("old"),
      documentDate: "2026-09-13",
    });
    const id = up.json<DocumentInfo>().id;
    db.$client
      .prepare("update documents set kind = 'card_statement', lender = 'travel card'")
      .run();
    expect(linkStatementDocuments(db)).toBe(1);
    expect(linkStatementDocuments(db)).toBe(0);
    const docs = (await client.get("/api/documents")).json<DocumentInfo[]>();
    expect(docs.find((d) => d.id === id)?.accountId).toBe(card.id);
  });
});
