import type {
  InvestImportPreview,
  InvestImportResult,
  InvestSummary,
  InvestTxn,
  NetWorthReport,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic exports only.

const POSITIONS = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Last Price Change,Current Value,Cost Basis Total,Type
X00001234,Individual,SPAXX**,HELD IN MONEY MARKET,,,,$500.00,,Cash
X00001234,Individual,VTI,VANGUARD TOTAL STOCK MARKET ETF,10,$250.00,+$1.00,"$2,500.00","$2,000.00",Cash
X00001234,Individual,XYZ,XYZ CORP,5,$10.00,+$0.10,$50.00,,Cash
Y00005678,Roth IRA,VTI,VANGUARD TOTAL STOCK MARKET ETF,2,$250.00,+$1.00,$500.00,$400.00,Cash
`;

const HISTORY = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
11/03/2026,Individual,X00001234,YOU BOUGHT VANGUARD TOTAL STOCK MARKET ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,2,250.00,,,,-500.00,11/04/2026
10/15/2026,Individual,X00001234,DIVIDEND RECEIVED VANGUARD TOTAL STOCK MARKET ETF (VTI) (Cash),VTI,VANGUARD TOTAL STOCK MARKET ETF,Cash,0.000,,,,,12.34,
`;

describe("investments", () => {
  it("imports positions into new accounts, values them, and feeds net worth", async () => {
    const { client } = await makeSignedInApp();
    const preview = (
      await client.post("/api/invest/import/preview", { content: POSITIONS })
    ).json<InvestImportPreview>();
    expect(preview.broker).toBe("Fidelity");
    expect(preview.accounts.map((a) => [a.ref, a.mask, a.positions, a.valueCents])).toEqual([
      ["X00001234", "1234", 3, 305000],
      ["Y00005678", "5678", 1, 50000],
    ]);

    const res = (
      await client.post("/api/invest/import/commit", {
        content: POSITIONS,
        targets: { X00001234: "new", Y00005678: "new" },
      })
    ).json<InvestImportResult>();
    expect(res).toMatchObject({ accountsCreated: 2, holdingsUpdated: 2 });

    const s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    expect(s.valueCents).toBe(355000);
    expect(s.cashCents).toBe(50000);
    // VTI across both accounts: 12 shares, cost known everywhere.
    const vti = s.positions.find((p) => p.symbol === "VTI");
    expect(vti).toMatchObject({ quantity: "12", valueCents: 300000, costBasisCents: 240000 });
    expect(vti?.accounts).toHaveLength(2);
    // XYZ has no reported cost: left out of the gain, shown separately.
    expect(s.gainCents).toBe(60000);
    expect(s.unknownCostValueCents).toBe(5000);
    expect(s.accounts.map((a) => a.name)).toEqual([
      "Fidelity Individual ••1234",
      "Fidelity Roth IRA ••5678",
    ]);
    expect(s.allocation.map((a) => a.type)).toEqual(["etf", "cash", "equity"]);

    const nw = (await client.get("/api/reports/net-worth?months=1")).json<NetWorthReport>();
    expect(nw.byType.find((b) => b.type === "investment")?.cents).toBe(355000);

    // Next time the same file matches the accounts it made.
    const again = (
      await client.post("/api/invest/import/preview", { content: POSITIONS })
    ).json<InvestImportPreview>();
    expect(again.accounts.every((a) => a.matchId)).toBe(true);
  });

  it("imports history once, however often the file is imported", async () => {
    const { client } = await makeSignedInApp();
    const commit = async (targets: Record<string, string>) =>
      (
        await client.post("/api/invest/import/commit", { content: HISTORY, targets })
      ).json<InvestImportResult>();
    expect(await commit({ X00001234: "new" })).toMatchObject({ added: 2, duplicates: 0 });
    const preview = (
      await client.post("/api/invest/import/preview", { content: HISTORY })
    ).json<InvestImportPreview>();
    const id = preview.accounts[0]?.matchId as string;
    expect(await commit({ X00001234: id })).toMatchObject({ added: 0, duplicates: 2 });

    const txns = (await client.get("/api/invest/transactions")).json<InvestTxn[]>();
    expect(txns.map((t) => [t.date, t.type, t.symbol, t.amountCents])).toEqual([
      ["2026-11-03", "buy", "VTI", -50000],
      ["2026-10-15", "dividend", "VTI", 1234],
    ]);
  });

  it("won't import into an account that isn't an investment account", async () => {
    const { client } = await makeSignedInApp();
    const chk = (await client.post("/api/accounts", { name: "Checking", type: "checking" })).json<{
      id: string;
    }>();
    const r = await client.post("/api/invest/import/commit", {
      content: HISTORY,
      targets: { X00001234: chk.id },
    });
    expect(r.statusCode).toBe(400);
  });

  it("explains files that aren't brokerage exports", async () => {
    const { client } = await makeSignedInApp();
    const r = await client.post("/api/invest/import/preview", {
      content: "Date,Description,Amount\n11/01/2026,Coffee,-4.00\n",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json<{ error: string }>().error).toMatch(/brokerage export/);
  });
});
