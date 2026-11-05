import { randomBytes } from "node:crypto";
import type { CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../../test-utils.js";

// Synthetic addresses and fake explorers. No network.
const A = "ab".repeat(38);
const B = "cd".repeat(38);
const EXT = "ef".repeat(38);
const H = (sc: string) => `${sc}${"0".repeat(24)}`; // whole SC → hastings

const events: Record<string, unknown[]> = {
  [A]: [
    {
      id: "e3",
      index: { height: 3 },
      type: "miner",
      timestamp: "2024-01-03T00:00:00Z",
      data: { siacoinElement: { siacoinOutput: { address: A, value: H("5") } } },
    },
    {
      id: "e2",
      index: { height: 2 },
      type: "v2Transaction",
      timestamp: "2024-01-02T00:00:00Z",
      data: {
        siacoinInputs: [{ parent: { siacoinOutput: { address: A, value: H("10") } } }],
        siacoinOutputs: [
          { siacoinOutput: { address: EXT, value: H("7") } },
          { siacoinOutput: { address: B, value: `29${"0".repeat(23)}` } },
        ],
        minerFee: `1${"0".repeat(23)}`,
      },
    },
    {
      id: "e1",
      index: { height: 1 },
      type: "v1Transaction",
      timestamp: "2024-01-01T00:00:00Z",
      data: {
        transaction: {
          siacoinInputs: [{ address: EXT, value: H("11") }],
          siacoinOutputs: [{ siacoinOutput: { address: A, value: H("10") } }],
          minerFees: [H("1")],
        },
      },
    },
  ],
};
events[B] = [(events[A] as unknown[])[1]];

const siascan = (async (url: string) => {
  const u = new URL(url);
  const [, , addr, what] = u.pathname.split("/");
  if (what === "events")
    return Response.json(
      Number(u.searchParams.get("offset")) ? [] : (events[addr as string] ?? []),
    );
  if (what === "balance")
    return Response.json({
      unspentSiacoins: addr === A ? H("5") : `29${"0".repeat(23)}`,
      immatureSiacoins: "0",
    });
  return new Response("", { status: 404 });
}) as unknown as typeof fetch;

async function wallet(fake: typeof fetch, chain: string, source: string) {
  const app = await makeSignedInApp({
    priceFetch: fake,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const w = (
    await app.client.post("/api/crypto/wallets", { name: "W", kind: "blockchain", chain, source })
  ).json<CryptoWallet>();
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const ws = (await app.client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      const x = ws.find((y) => y.id === w.id);
      if (x && x.status !== "never" && !x.syncing) return x;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no sync");
  };
  return { ...app, w, settle };
}

describe("Siacoin", () => {
  it("syncs a wallet's several addresses, counting shared events once", async () => {
    const { client, w, settle } = await wallet(siascan, "sc", `${A}, ${B}`);
    const done = await settle();
    expect(done).toMatchObject({ status: "ok", onChain: [{ asset: "SC", amount: "7.9" }] });
    const page = (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>();
    expect(page.total).toBe(3);
    expect(page.items.find((t) => t.sentAsset === "SC")).toMatchObject({
      sentAmount: "7",
      feeAmount: "0.1",
    });
    expect(page.items.find((t) => t.label === "mining")).toMatchObject({ receivedAmount: "5" });
    // History adds up to the chain: nothing to reconcile.
    expect(done.balances).toEqual([expect.objectContaining({ asset: "SC", amount: "7.9" })]);
  });
});

describe("a Sia wallet with many addresses", () => {
  it("takes 100 addresses and asks balances only of the used ones", async () => {
    const many = [
      A,
      B,
      ...Array.from({ length: 98 }, (_, i) => i.toString(16).padStart(2, "0").repeat(38)),
    ];
    const balanceCalls: string[] = [];
    const counting = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/balance")) balanceCalls.push(u.pathname.split("/")[2] as string);
      return siascan(url, init);
    }) as unknown as typeof fetch;
    const { w, settle } = await wallet(counting, "sc", many.join("\n"));
    const done = await settle();
    expect(done).toMatchObject({ status: "ok", sourceHint: "100 addresses" });
    expect(done.onChain).toEqual([{ asset: "SC", amount: "7.9" }]);
    expect(balanceCalls.sort()).toEqual([A, B].sort());
    expect(w.id).toBeTruthy();
  });
});

describe("Siacoin's other addresses", () => {
  it("finds the address an imported deposit was paid to, and adds it", async () => {
    const C = "12".repeat(38);
    const TX = "9a".repeat(32);
    const fake = (async (url: string) => {
      const u = new URL(url);
      const parts = u.pathname.split("/");
      if (u.pathname === `/transactions/${TX}`)
        return Response.json({
          id: TX,
          siacoinOutputs: [
            { siacoinOutput: { address: C, value: `3000000${"0".repeat(18)}` } },
            { siacoinOutput: { address: EXT, value: H("1") } },
          ],
        });
      if (parts[1] !== "addresses") return new Response("no transaction found", { status: 404 });
      const addr = parts[2];
      if (parts[3] === "events")
        return Response.json(
          Number(u.searchParams.get("offset")) || addr !== C
            ? []
            : [
                {
                  id: TX,
                  index: { height: 5 },
                  type: "v1Transaction",
                  timestamp: "2017-07-11T00:00:00Z",
                  data: {
                    transaction: {
                      siacoinInputs: [{ address: EXT, value: H("4") }],
                      siacoinOutputs: [{ siacoinOutput: { address: C, value: H("3") } }],
                    },
                  },
                },
              ],
        );
      return Response.json({ unspentSiacoins: addr === C ? H("3") : "0", immatureSiacoins: "0" });
    }) as unknown as typeof fetch;
    const { client, db, w, settle } = await wallet(fake, "sc", A);
    await settle();
    const { schema } = await import("@muny/db");
    db.insert(schema.cryptoTxns)
      .values({
        id: "imp",
        walletId: w.id,
        at: Date.UTC(2017, 6, 11),
        externalId: "koinly:imp",
        source: "import",
        type: "deposit",
        receivedAsset: "SC",
        receivedAmount: "3.000001",
        txHash: TX,
      })
      .run();
    const res = (
      await client.post("/api/crypto/reconcile/sia-addresses", { walletId: w.id })
    ).json();
    expect(res).toEqual({ checked: 1, added: 1 });
    const done = await settle();
    expect(done.onChain).toEqual([{ asset: "SC", amount: "3" }]);
    // The imported deposit stays; its synced copy isn't added again.
    const page = (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>();
    expect(page.items.map((t) => t.id)).toEqual(["imp"]);
  });
});

describe("Siacoin addresses from an imported send", () => {
  it("adds what a send spent from and where its change went, on its own", async () => {
    const B2 = "34".repeat(38);
    const C2 = "56".repeat(38);
    const TX2 = "7b".repeat(32);
    const spend = {
      id: TX2,
      index: { height: 9 },
      type: "v1Transaction",
      timestamp: "2021-02-05T00:00:00Z",
      data: {
        transaction: {
          siacoinInputs: [{ address: B2, value: H("6138") }],
          siacoinOutputs: [{ siacoinOutput: { address: C2, value: `6137982${"0".repeat(21)}` } }],
          minerFees: [`18${"0".repeat(21)}`],
        },
      },
    };
    const fake = (async (url: string) => {
      const u = new URL(url);
      const parts = u.pathname.split("/");
      if (u.pathname === `/transactions/${TX2}`) return Response.json(spend.data.transaction);
      if (parts[1] !== "addresses") return new Response("no transaction found", { status: 404 });
      const addr = parts[2] as string;
      if (parts[3] === "events")
        return Response.json(Number(u.searchParams.get("offset")) || addr === A ? [] : [spend]);
      return Response.json({ unspentSiacoins: addr === C2 ? `6137982${"0".repeat(21)}` : "0" });
    }) as unknown as typeof fetch;
    const { client, db, w, settle } = await wallet(fake, "sc", A);
    await settle();
    const { schema } = await import("@muny/db");
    db.insert(schema.cryptoTxns)
      .values({
        id: "fee",
        walletId: w.id,
        at: Date.UTC(2021, 1, 5),
        externalId: "koinly:fee",
        source: "import",
        type: "withdrawal",
        sentAsset: "SC",
        sentAmount: "0.018",
        txHash: TX2,
      })
      .run();
    await client.post(`/api/crypto/wallets/${w.id}/sync`);
    const done = await settle();
    expect(done.sourceHint).toBe("3 addresses");
    expect(done.onChain).toEqual([{ asset: "SC", amount: "6137.982" }]);
  });
});

describe("Zcash", () => {
  const ZEC = `t1${"a".repeat(33)}`;
  it("asks for a Blockbook server first, then syncs through it", async () => {
    const bb = (async (url: string) => {
      const u = new URL(url);
      if (u.host !== "bb.example") return new Response("", { status: 404 });
      return Response.json({
        page: 1,
        totalPages: 1,
        balance: "150000000",
        transactions: [
          {
            txid: "z1",
            blockHeight: 100,
            blockTime: 1_700_000_000,
            fees: "1000",
            vin: [{ addresses: [`t1${"b".repeat(33)}`], value: "150001000" }],
            vout: [{ addresses: [ZEC], value: "150000000" }],
          },
        ],
      });
    }) as unknown as typeof fetch;
    const { client, w, settle } = await wallet(bb, "zec", ZEC);
    expect((await settle()).lastError).toMatch(/Blockbook server/);
    const set = await client.put("/api/crypto/settings", {
      servers: { zec: "https://bb.example" },
    });
    expect(set.statusCode).toBe(200);
    await client.post(`/api/crypto/wallets/${w.id}/sync`);
    const done = await settle();
    expect(done).toMatchObject({
      status: "ok",
      lastError: null,
      onChain: [{ asset: "ZEC", amount: "1.5" }],
    });
    expect(done.balances[0]).toMatchObject({ asset: "ZEC", amount: "1.5" });
  });
});
