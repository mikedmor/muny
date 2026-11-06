import { describe, expect, it } from "vitest";
import { claimSetupToken, guessType, SimpleFinProvider } from "./simplefin.js";

// A fake SimpleFIN Bridge with synthetic accounts.
const ACCESS = "https://user123:pass456@bridge.example.com/simplefin";
const token = Buffer.from("https://bridge.example.com/simplefin/claim/abc").toString("base64");

function bridge() {
  const calls: { url: string; auth: string | null }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? null });
    if (url.endsWith("/claim/abc")) return new Response(ACCESS);
    if (url.includes("/simplefin/accounts"))
      return Response.json({
        errors: [],
        accounts: [
          {
            org: { name: "Example Card Co" },
            id: "acct-1",
            name: "Rewards Visa ...4321",
            currency: "USD",
            balance: "-512.34",
            transactions: [
              { id: "t1", posted: 1_780_000_000, amount: "-12.34", description: "CORNER CAFE" },
              {
                id: "t2",
                posted: 0,
                transacted_at: 1_780_100_000,
                amount: "-5.00",
                description: "PENDING SHOP",
                pending: true,
              },
            ],
          },
        ],
      });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("SimpleFIN", () => {
  it("claims a setup token, reads accounts and transactions with basic auth", async () => {
    const b = bridge();
    const access = await claimSetupToken(token, b.f);
    expect(access).toBe(ACCESS);
    const p = new SimpleFinProvider(b.f);
    const info = await p.getAccounts({ accessUrl: access });
    expect(info.accounts[0]).toMatchObject({
      ref: "acct-1",
      type: "credit",
      mask: "4321",
      balanceCents: -51_234,
    });
    // Credentials go in the header, never the URL.
    const call = b.calls.find((c) => c.url.includes("/accounts"));
    expect(call?.url).not.toContain("pass456");
    expect(call?.auth).toBe(`Basic ${Buffer.from("user123:pass456").toString("base64")}`);
    const r = await p.syncTransactions({ accessUrl: access }, null);
    expect(r.added.map((t) => [t.amountCents, t.pending])).toEqual([
      [-1_234, false],
      [-500, true],
    ]);
    expect(r.windowFrom).toBeTruthy();
  });

  it("rejects things that aren't setup tokens, and guesses account types", async () => {
    await expect(claimSetupToken("not a token at all!!", bridge().f)).rejects.toThrow(
      /setup token/,
    );
    expect(guessType("Discover It", -100)).toBe("credit");
    expect(guessType("High Yield Savings", 100)).toBe("savings");
    expect(guessType("Everyday", 100)).toBe("checking");
  });
});
