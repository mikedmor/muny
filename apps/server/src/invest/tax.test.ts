import { newId, schema } from "@muny/db";
import type { B1099Doc, InvestTxnPage, ReconcileReport, StockTaxReport } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { stockTaxReport } from "./tax.js";

// Synthetic only: made-up accounts, tickers and trades.

const SECRET = Buffer.alloc(32, 9).toString("base64");

async function setup() {
  const ctx = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET } });
  const { db } = ctx;
  const acct = (name: string) => {
    const id = newId();
    db.insert(schema.accounts).values({ id, name, type: "investment" }).run();
    return id;
  };
  const brokerage = acct("Sample Brokerage");
  const ira = acct("Sample Rollover IRA");
  const sec = (symbol: string) => {
    const id = newId();
    db.insert(schema.securities)
      .values({ id, symbol, name: `${symbol} Corp`, type: "equity" })
      .run();
    return id;
  };
  const xyz = sec("XYZ");
  const abc = sec("ABC");
  const qrs = sec("QRS");
  let n = 0;
  const tx = (
    accountId: string,
    securityId: string,
    date: string,
    type: "buy" | "sell" | "dividend",
    quantity: string | null,
    amountCents: number,
    source: "import" | "plaid" = "import",
  ) =>
    db
      .insert(schema.investmentTxns)
      .values({
        id: newId(),
        accountId,
        securityId,
        date,
        type,
        quantity,
        amountCents,
        externalId: `t${++n}`,
        source,
      })
      .run();
  tx(brokerage, xyz, "2024-01-10", "buy", "10", -100_000);
  tx(brokerage, xyz, "2025-11-01", "buy", "10", -150_000);
  tx(brokerage, xyz, "2026-02-01", "sell", "15", 240_000);
  tx(brokerage, xyz, "2026-03-01", "dividend", null, 1_500);
  tx(brokerage, abc, "2026-05-01", "buy", "10", -50_000);
  tx(brokerage, abc, "2026-06-01", "sell", "10", 40_000);
  tx(ira, abc, "2026-06-10", "buy", "4", -16_000);
  tx(ira, abc, "2026-07-01", "dividend", null, 999, "plaid");
  tx(brokerage, qrs, "2026-01-05", "buy", "5", -10_000);
  const hold = (
    accountId: string,
    securityId: string,
    quantity: string,
    valueCents: number,
    costBasisCents: number | null,
  ) =>
    db
      .insert(schema.investmentHoldings)
      .values({
        accountId,
        securityId,
        quantity,
        valueCents,
        costBasisCents,
        asOf: "2026-11-13",
        source: "import",
      })
      .run();
  hold(brokerage, xyz, "5", 80_000, 75_000);
  hold(brokerage, qrs, "20", 300_000, 200_000);
  hold(ira, abc, "4", 18_000, 16_000);
  return { ...ctx, brokerage, ira, qrs };
}

describe("stock taxes", () => {
  it("works out sales by term, wash sales, dividends and what's held", async () => {
    const { db } = await setup();
    const r = stockTaxReport(db, 2026, "2026-11-13");
    // XYZ: 5 short-term shares ($750 → $800) and 10 long-term ($1,000 → $1,600). ABC: a $100 loss.
    expect(r.realized.short).toEqual({ profitCents: 5_000, lossCents: -10_000 });
    expect(r.realized.long).toEqual({ profitCents: 60_000, lossCents: 0 });
    // 4 ABC shares bought back in the IRA within 30 days: 4/10 of the loss, lost for good.
    expect(r.washCents).toBe(4_000);
    const abcSale = r.sales.find((s) => s.symbol === "ABC");
    expect(abcSale).toMatchObject({ washCents: 4_000, washInRetirement: true, term: "short" });
    // The IRA's dividend doesn't count.
    expect(r.dividendsCents).toBe(1_500);
    expect(r.accounts.find((a) => a.name.includes("IRA"))).toMatchObject({
      treatment: "deferred",
      guessed: true,
    });
    expect(r.sheltered.deferredCents).toBe(18_000);

    const xyz = r.assets.find((a) => a.symbol === "XYZ");
    // Bought 2025-11-01: long term from 2026-11-02.
    expect(xyz?.long.quantity).toBe("5");
    expect(xyz?.lots[0]).toMatchObject({
      acquired: "2025-11-01",
      costCents: 75_000,
      longFrom: "2026-11-02",
    });
    // QRS: 5 shares from trades, 15 from before the history, at the rest of the broker's cost.
    const qrs = r.assets.find((a) => a.symbol === "QRS");
    expect(qrs?.unknown.quantity).toBe("15");
    expect(qrs?.lots[0]).toMatchObject({ acquired: null, quantity: "15", costCents: 190_000 });
    expect(r.assets.some((a) => a.symbol === "ABC")).toBe(false);
    expect(r.needsReconcile).toBe(1);
    expect(r.maturity).toHaveLength(13);
  });

  it("reconciles trades with holdings, adds and removes trades, and sets the tax treatment", async () => {
    const { client, brokerage, ira, qrs } = await setup();
    let rec = (await client.get("/api/invest/reconcile")).json<ReconcileReport>();
    expect(rec.rows.find((x) => x.symbol === "QRS")).toMatchObject({
      status: "missing_buys",
      differenceQuantity: "15",
    });
    expect(rec.rows.find((x) => x.symbol === "XYZ")?.status).toBe("ok");

    // Fill in the earlier purchase by hand.
    const add = await client.post("/api/invest/txns", {
      accountId: brokerage,
      type: "buy",
      symbol: "qrs",
      date: "2020-01-02",
      quantity: "15",
      totalCents: 150_000,
    });
    expect(add.statusCode).toBe(200);
    rec = (await client.get("/api/invest/reconcile")).json<ReconcileReport>();
    // Shares match now; the cost ($1,600) still differs from the broker's ($2,000).
    expect(rec.rows.find((x) => x.securityId === qrs)?.status).toBe("cost_differs");

    const page = (await client.get("/api/invest/txns?type=dividend")).json<InvestTxnPage>();
    expect(page.total).toBe(2);
    const synced = page.items.find((x) => x.source === "plaid");
    expect((await client.delete(`/api/invest/txns/${synced?.id}`)).statusCode).toBe(400);
    expect(
      (await client.delete(`/api/invest/txns/${add.json<{ id: string }>().id}`)).statusCode,
    ).toBe(200);
    const bad = await client.post("/api/invest/txns", {
      accountId: brokerage,
      type: "buy",
      date: "2026-01-01",
    });
    expect(bad.statusCode).toBe(400);

    // Call the IRA taxable and its ABC shows up; back to the guess and it's gone.
    await client.put(`/api/invest/accounts/${ira}/tax-treatment`, { treatment: "taxable" });
    let r = (await client.get("/api/invest/tax/2026")).json<StockTaxReport>();
    expect(r.assets.some((a) => a.symbol === "ABC")).toBe(true);
    await client.put(`/api/invest/accounts/${ira}/tax-treatment`, { treatment: null });
    r = (await client.get("/api/invest/tax/2026")).json<StockTaxReport>();
    expect(r.assets.some((a) => a.symbol === "ABC")).toBe(false);
  });

  it("reads a 1099-B, compares it and exports Form 8949 lines", async () => {
    const { client, brokerage } = await setup();
    const txf = [
      "V042",
      "AExample Broker",
      "D02/10/2027",
      "^",
      "TD",
      "N321",
      "C1",
      "L1",
      "P5 sh. XYZ",
      "D11/01/2025",
      "D02/01/2026",
      "$750.00",
      "$800.00",
      "^",
      "TD",
      "N323",
      "C1",
      "L1",
      "P10 sh. XYZ",
      "D01/10/2024",
      "D02/01/2026",
      "$1000.00",
      "$1600.00",
      "^",
      "TD",
      "N321",
      "C1",
      "L1",
      "P10 sh. ABC",
      "D05/01/2026",
      "D06/01/2026",
      "$500.00",
      "$400.00",
      "$",
      "^",
    ].join("\n");
    const up = await client.post("/api/invest/tax/2026/docs", {
      accountId: brokerage,
      filename: "1099b-2026.txf",
      contentType: "text/plain",
      base64: Buffer.from(txf).toString("base64"),
    });
    expect(up.statusCode).toBe(200);
    const docs = (await client.get("/api/invest/tax/2026/docs")).json<B1099Doc[]>();
    expect(docs[0]).toMatchObject({ format: "txf", saleCount: 3, summarySource: "sales" });
    expect(docs[0]?.summary.A).toMatchObject({
      proceedsCents: 120_000,
      costCents: 125_000,
      count: 2,
    });
    // Muny's own short-term numbers for the account include its wash sale estimate.
    expect(docs[0]?.muny.short).toMatchObject({
      proceedsCents: 120_000,
      costCents: 125_000,
      washCents: 4_000,
    });

    const file = await client.get(`/api/invest/tax/docs/${docs[0]?.id}/file`);
    expect(file.body).toContain("P5 sh. XYZ");

    // A PDF Muny can't read is kept; its totals can be typed in.
    const pdf = await client.post("/api/invest/tax/2026/docs", {
      accountId: brokerage,
      filename: "1099.pdf",
      contentType: "application/pdf",
      base64: Buffer.from("%PDF-1.4 not really a pdf").toString("base64"),
    });
    expect(pdf.statusCode).toBe(200);
    const id = pdf.json<{ id: string }>().id;
    const put = await client.put(`/api/invest/tax/docs/${id}/summary`, {
      summary: {
        D: { proceedsCents: 160_000, costCents: 100_000, washCents: 0, gainCents: 60_000 },
      },
    });
    expect(put.statusCode).toBe(200);
    const after = (await client.get("/api/invest/tax/2026/docs")).json<B1099Doc[]>();
    expect(after.find((d) => d.id === id)).toMatchObject({
      summarySource: "entered",
      format: "pdf",
    });

    const csv = (await client.get("/api/invest/tax/2026/8949.csv")).body;
    expect(csv).toContain(
      "I,A,5 sh. XYZ,11/01/2025,02/01/2026,800.00,750.00,,,50.00,Sample Brokerage,1099-B",
    );
    expect(csv).not.toContain("Muny estimate");

    const none = await client.post("/api/invest/tax/2026/docs", {
      accountId: brokerage,
      filename: "notes.csv",
      contentType: "text/csv",
      base64: Buffer.from("a,b\n1,2").toString("base64"),
    });
    expect(none.statusCode).toBe(400);
    expect((await client.delete(`/api/invest/tax/docs/${id}`)).statusCode).toBe(200);
  });
});
