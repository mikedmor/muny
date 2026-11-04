import type { Account, TransactionPage, TransferPreview } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp, type TestClient } from "../test-utils.js";

// Synthetic data only.

async function setup() {
  const ctx = await makeSignedInApp();
  const mk = async (name: string, type: string, extra: Record<string, string> = {}) =>
    (await ctx.client.post("/api/accounts", { name, type, ...extra })).json<Account>();
  const chk = await mk("Checking", "checking", { institutionName: "Example Bank", mask: "1111" });
  const sav = await mk("High Yield Savings", "savings", {
    institutionName: "Online Bank",
    mask: "2222",
  });
  const card = await mk("Rewards Card", "credit", { institutionName: "Card Co", mask: "3333" });
  const add = (accountId: string, postedDate: string, amountCents: number, description: string) =>
    ctx.client.post("/api/transactions", { accountId, postedDate, amountCents, description });
  return { ...ctx, chk, sav, card, add };
}

async function all(client: TestClient) {
  return (await client.get("/api/transactions?hidden=include&limit=100")).json<TransactionPage>()
    .items;
}

describe("transfer detection", () => {
  it("pairs real transfers and leaves look-alikes alone", async () => {
    const { client, chk, sav, card, add } = await setup();
    // checking -> savings, 2 days apart, with transfer wording
    await add(chk.id, "2026-01-10", -50000, "ONLINE TRANSFER TO SAV 2222");
    await add(sav.id, "2026-01-12", 50000, "DEPOSIT FROM EXAMPLE BANK");
    // card payment: no wording on the card side, but money into a credit card
    await add(chk.id, "2026-01-15", -12345, "CARD CO AUTOPAY");
    await add(card.id, "2026-01-16", 12345, "THANK YOU");
    // same amount, opposite sign, but unrelated (refund vs. dinner) -> not a transfer
    await add(chk.id, "2026-01-20", -4000, "DINNER WITH FRIENDS");
    await add(card.id, "2026-01-21", 4000, "STORE REFUND");
    // too far apart
    await add(chk.id, "2026-02-01", -7000, "TRANSFER TO SAVINGS");
    await add(sav.id, "2026-02-10", 7000, "TRANSFER FROM CHECKING");

    const p = (await client.post("/api/transfers/preview")).json<TransferPreview>();
    expect(p.pairs).toBe(2);
    expect(p.sample.map((s) => [s.from, s.to, s.amountCents])).toEqual([
      ["Checking", "Rewards Card", 12345],
      ["Checking", "High Yield Savings", 50000],
    ]);
    // Preview writes nothing.
    expect((await all(client)).every((t) => t.transferPairId === null)).toBe(true);

    expect((await client.post("/api/transfers/apply")).json()).toEqual({ paired: 2 });
    const items = await all(client);
    const byDesc = (d: string) => items.find((t) => t.rawDescription === d);
    expect(byDesc("ONLINE TRANSFER TO SAV 2222")).toMatchObject({
      transferAccountName: "High Yield Savings",
      transferPairId: byDesc("DEPOSIT FROM EXAMPLE BANK")?.id,
    });
    // Manual transactions are hand-edited, so their categories aren't touched.
    expect(byDesc("CARD CO AUTOPAY")?.transferAccountName).toBe("Rewards Card");
    expect(byDesc("DINNER WITH FRIENDS")?.transferPairId).toBeNull();
    expect(byDesc("TRANSFER TO SAVINGS")?.transferPairId).toBeNull();
    expect((await client.post("/api/transfers/apply")).json()).toEqual({ paired: 0 });
  });

  it("categorizes imported transfers and respects 'not a transfer'", async () => {
    const { client, chk, sav } = await setup();
    const csv = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");
    await client.post("/api/import/commit", {
      filename: "chk.csv",
      content: csv(["2026-03-01,ONLINE TRANSFER TO SAVINGS,-100.00"]),
      accountMap: { csv: chk.id },
    });
    await client.post("/api/import/commit", {
      filename: "sav.csv",
      content: csv(["2026-03-02,TRANSFER FROM CHECKING,100.00"]),
      accountMap: { csv: sav.id },
    });
    const [a, b] = await all(client);
    expect(a?.transferPairId).toBe(b?.id);
    expect([a?.categoryName, b?.categoryName]).toEqual(["Internal Transfer", "Internal Transfer"]);

    const r = await client.delete(`/api/transactions/${a?.id}/transfer`);
    expect(r.json().transferPairId).toBeNull();
    expect((await all(client)).every((t) => t.transferPairId === null)).toBe(true);
    expect((await client.post("/api/transfers/preview")).json<TransferPreview>().pairs).toBe(0);
  });
});
