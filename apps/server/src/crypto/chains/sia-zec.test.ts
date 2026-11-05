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
