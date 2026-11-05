import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { localDay } from "./budget.js";

// Synthetic address and transactions in Blockbook API v2 shape. No network.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const T = Date.UTC(2025, 5, 1) / 1000;

const TXS = [
  {
    txid: "0xd1",
    blockHeight: 10,
    blockTime: T,
    value: "1000000000000000000",
    fees: "100",
    vin: [{ addresses: [OTHER] }],
    vout: [{ addresses: [ME] }],
  },
  {
    txid: "0xs2",
    blockHeight: 11,
    blockTime: T + 3600,
    value: "500000000000000000",
    fees: "210000000000000",
    vin: [{ addresses: [ME] }],
    vout: [{ addresses: [OTHER] }],
  },
  { txid: "0xpending", blockHeight: -1, blockTime: T + 7200, value: "1", vin: [], vout: [] },
];

function fakeBlockbook(txs = TXS) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const from = Number(new URL(url).searchParams.get("from") ?? 0);
    return Response.json({
      page: 1,
      totalPages: 1,
      balance: "499790000000000000",
      transactions: txs.filter((t) => t.blockHeight < 0 || t.blockHeight >= from),
      tokens: [
        { type: "ERC20", symbol: "DAI", decimals: 18, balance: "5000000000000000000" },
        { type: "ERC721", symbol: "SPAM", decimals: 0, balance: "1" },
      ],
    });
  }) as unknown as typeof fetch;
  return { f, urls };
}

async function setup(f: typeof fetch) {
  const ctx = await makeSignedInApp({
    priceFetch: f,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const wallets = async () => (await ctx.client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
  const settle = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const w = (await wallets()).find((x) => x.id === id) as CryptoWallet;
      if (w.status !== "never" && !w.syncing) return w;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("sync didn't finish");
  };
  return { ...ctx, wallets, settle };
}

describe("crypto wallet sync", () => {
  it("syncs an Ethereum address incrementally and stores it encrypted", async () => {
    const bb = fakeBlockbook();
    const { client, db, settle } = await setup(bb.f);
    const bad = await client.post("/api/crypto/wallets", {
      name: "Hot",
      kind: "blockchain",
      chain: "eth",
      source: "0x1234567890",
    });
    expect(bad.statusCode).toBe(400);

    const created = (
      await client.post("/api/crypto/wallets", {
        name: "Hot",
        kind: "blockchain",
        chain: "eth",
        source: ME,
      })
    ).json<CryptoWallet>();
    const w = await settle(created.id);
    expect(w).toMatchObject({ status: "ok", sourceHint: "0x1111…11111", syncEnabled: true });
    expect(w.balances).toEqual([{ asset: "ETH", amount: "0.49979", valueCents: null }]);
    expect(w.onChain).toEqual([
      { asset: "ETH", amount: "0.49979" },
      { asset: "DAI", amount: "5" },
    ]);
    expect(bb.urls[0]).toMatch(/^https:\/\/eth1\.trezor\.io\/api\/v2\/address\/0x1+\?details=txs/);

    const row = db
      .select()
      .from(schema.cryptoWallets)
      .where(eq(schema.cryptoWallets.id, w.id))
      .get();
    expect(row?.sourceEnc).not.toContain(ME.slice(2, 12));

    // Manual sync: only from the last synced block; nothing new.
    const again = (await client.post(`/api/crypto/wallets/${w.id}/sync`)).json();
    expect(again).toEqual({ added: 0, duplicates: 1 });
    expect(bb.urls.at(-1)).toContain("&from=11");

    // Visiting again the same day doesn't sync again.
    const n = bb.urls.length;
    await client.get("/api/crypto/wallets");
    await client.get("/api/crypto/overview");
    expect(bb.urls.length).toBe(n);

    const page = (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>();
    expect(page.items.map((t) => [t.type, t.txHash])).toEqual([
      ["withdrawal", "0xs2"],
      ["deposit", "0xd1"],
    ]);
  });

  it("doesn't duplicate imported transactions and pairs transfers between own wallets", async () => {
    const bb = fakeBlockbook([
      {
        txid: "0xabc",
        blockHeight: 20,
        blockTime: Date.UTC(2025, 1, 1, 12) / 1000,
        value: "299000000000000000",
        fees: "0",
        vin: [{ addresses: [OTHER] }],
        vout: [{ addresses: [ME] }],
      },
    ]);
    const { client, settle } = await setup(bb.f);
    const csv = [
      "Date,Type,Tag,Sending Wallet,Sent Amount,Sent Currency,Sent Cost Basis,Receiving Wallet,Received Amount,Received Currency,Received Cost Basis,Fee Amount,Fee Currency,Gain (USD),Net Value (USD),Fee Value (USD),TxSrc,TxDest,TxHash,Description",
      "2025-02-01 12:00:00 UTC,crypto_deposit,,,,,,Cold ETH,0.299,ETH,,,,,600.00,,,,0xABC,",
    ].join("\n");
    await client.post("/api/crypto/import/commit", { format: "koinly", content: csv });
    const cold = (await client.get("/api/crypto/wallets")).json<
      CryptoWallet[]
    >()[0] as CryptoWallet;
    const put = await client.put(`/api/crypto/wallets/${cold.id}/source`, {
      chain: "eth",
      source: ME,
    });
    expect(put.statusCode).toBe(200);
    const w = await settle(cold.id);
    expect(w.status).toBe("ok");
    expect(w.txnCount).toBe(1); // the imported row, not a second copy
    expect(w.balances[0]?.amount).toBe("0.299");
  });

  it("never goes over the daily request budget", async () => {
    const bb = fakeBlockbook();
    const { client, db } = await setup(bb.f);
    const day = localDay();
    db.insert(schema.appSettings)
      .values({
        key: "crypto.usage",
        value: { blockbook: { day, dayCount: 500, month: day.slice(0, 7), monthCount: 500 } },
      })
      .run();
    const w = (
      await client.post("/api/crypto/wallets", { name: "Hot", kind: "manual" })
    ).json<CryptoWallet>();
    await client.put(`/api/crypto/wallets/${w.id}/source`, { chain: "eth", source: ME });
    const res = await client.post(`/api/crypto/wallets/${w.id}/sync`);
    expect(res.statusCode).toBe(400);
    expect(res.json().message ?? res.body).toMatch(/Daily limit/);
    expect(bb.urls).toEqual([]);
    const s = (await client.get("/api/crypto/settings")).json<{
      usage: { provider: string; today: number; dayLimit: number }[];
    }>();
    expect(s.usage.find((u) => u.provider === "blockbook")).toMatchObject({
      today: 500,
      dayLimit: 500,
    });
  });
});
