import type { InvestSummary } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic exports only. Neither broker file reports a cost for XYZ.

const POSITIONS = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total
X00001234,Individual,XYZ,XYZ CORP,5,$12.00,$60.00,
X00001234,Individual,ABC,ABC CO,2,$50.00,$100.00,
`;

const HISTORY = `Run Date,Account,Account Number,Action,Symbol,Description,Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
03/01/2026,Individual,X00001234,YOU BOUGHT XYZ,XYZ,XYZ CORP,Cash,10,8.00,,,,-80.00,
04/01/2026,Individual,X00001234,YOU SOLD XYZ,XYZ,XYZ CORP,Cash,5,11.00,,,,55.00,
`;

describe("holding cost", () => {
  it("works cost out from trades when they explain every share, else takes what you enter", async () => {
    const { client } = await makeSignedInApp();
    await client.post("/api/invest/import/commit", {
      content: POSITIONS,
      targets: { X00001234: "new" },
    });
    const accountId = (await client.get("/api/invest/summary")).json<InvestSummary>().accounts[0]
      ?.id as string;
    await client.post("/api/invest/import/commit", {
      content: HISTORY,
      targets: { X00001234: accountId },
    });

    let s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    const xyz = s.positions.find((p) => p.symbol === "XYZ");
    // Bought 10 for $80, sold the oldest 5: the 5 left cost $40.
    expect(xyz).toMatchObject({ costBasisCents: 4000, gainCents: 2000 });
    expect(xyz?.accounts[0]?.costSource).toBe("trades");
    const abc = s.positions.find((p) => p.symbol === "ABC");
    expect(abc?.costBasisCents).toBeNull();

    // Enter ABC's average cost per share: 2 × $40.
    const put = await client.put(`/api/invest/holdings/${accountId}/${abc?.securityId}/cost`, {
      perShare: "40",
    });
    expect(put.statusCode).toBe(200);
    s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    const abc2 = s.positions.find((p) => p.symbol === "ABC");
    expect(abc2).toMatchObject({ costBasisCents: 8000, gainCents: 2000 });
    expect(abc2?.accounts[0]?.costSource).toBe("entered");
    expect(s.unknownCostValueCents).toBe(0);

    // Clearing it puts it back to unknown.
    await client.put(`/api/invest/holdings/${accountId}/${abc?.securityId}/cost`, { clear: true });
    s = (await client.get("/api/invest/summary")).json<InvestSummary>();
    expect(s.positions.find((p) => p.symbol === "ABC")?.costBasisCents).toBeNull();

    const bad = await client.put(`/api/invest/holdings/${accountId}/nope/cost`, {
      totalCents: 100,
    });
    expect(bad.statusCode).toBe(400);
  });
});
