import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { localDay } from "./budget.js";

// Synthetic address and history in the Etherscan-compatible format Blockscout
// serves. No network.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const T = String(Date.UTC(2025, 5, 1) / 1000);

const TXS = [
  {
    hash: "0xd1",
    blockNumber: "10",
    timeStamp: T,
    from: OTHER,
    to: ME,
    value: "1000000000000000000",
    gasUsed: "21000",
    gasPrice: "1",
  },
  {
    hash: "0xs2",
    blockNumber: "11",
    timeStamp: T,
    from: ME,
    to: OTHER,
    value: "500000000000000000",
    gasUsed: "21000",
    gasPrice: "10000000000",
  },
];
const TOKENS = [
  {
    hash: "0xt3",
    blockNumber: "11",
    timeStamp: T,
    from: OTHER,
    to: ME,
    value: "5000000",
    tokenSymbol: "USDC",
    tokenDecimal: "6",
  },
];

interface Call {
  url: URL;
  auth: string | null;
}

function fakeBlockscout(txs = TXS, tokens = TOKENS) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    const p = u.searchParams;
    const from = Number(p.get("startblock") ?? 0);
    const after = <R extends { blockNumber: string }>(rows: R[]) =>
      rows.filter((r) => Number(r.blockNumber) >= from);
    const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
    switch (p.get("action")) {
      case "txlist":
        return ok(after(txs));
      case "txlistinternal":
        return Response.json({ status: "0", message: "No transactions found", result: [] });
      case "tokentx":
        return ok(after(tokens));
      case "balance":
        return ok("499790000000000000");
      case "tokenlist":
        return ok([
          { balance: "5000000", decimals: "6", symbol: "USDC", type: "ERC-20" },
          { balance: "1", decimals: "0", symbol: "Claim at spam.example", type: "ERC-20" },
        ]);
      default:
        return new Response("not found", { status: 404 });
    }
  }) as unknown as typeof fetch;
  return { f, calls };
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
  it("syncs an Ethereum address from Blockscout incrementally and stores it encrypted", async () => {
    const bs = fakeBlockscout();
    const { client, db, settle } = await setup(bs.f);
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
    expect(Object.fromEntries(w.balances.map((b) => [b.asset, b.amount]))).toEqual({
      ETH: "0.49979",
      USDC: "5",
    });
    // Spam tokens are ignored; on-chain balances match the transactions.
    expect(w.onChain).toEqual([
      { asset: "ETH", amount: "0.49979" },
      { asset: "USDC", amount: "5" },
    ]);
    // Without a key: the chain's public instance, no auth header.
    expect(bs.calls[0]?.url.origin).toBe("https://eth.blockscout.com");
    expect(bs.calls[0]?.url.pathname).toBe("/api");
    expect(bs.calls.every((c) => c.auth === null)).toBe(true);

    const row = db
      .select()
      .from(schema.cryptoWallets)
      .where(eq(schema.cryptoWallets.id, w.id))
      .get();
    expect(row?.sourceEnc).not.toContain(ME.slice(2, 12));

    // Manual sync: only from the last synced block; nothing new.
    bs.calls.length = 0;
    const again = (await client.post(`/api/crypto/wallets/${w.id}/sync`)).json();
    expect(again).toMatchObject({ added: 0 });
    const lists = bs.calls.filter((c) => c.url.searchParams.has("startblock"));
    expect(lists.every((c) => c.url.searchParams.get("startblock") === "11")).toBe(true);

    // Each attempt is in the wallet's sync history, newest first.
    const runs = (await client.get(`/api/crypto/wallets/${w.id}/syncs`)).json<
      { status: string; added: number }[]
    >();
    expect(runs.map((r) => [r.status, r.added])).toEqual([
      ["ok", 0],
      ["ok", 3],
    ]);

    // Visiting again the same day doesn't sync again.
    const n = bs.calls.length;
    await client.get("/api/crypto/wallets");
    await client.get("/api/crypto/overview");
    expect(bs.calls.length).toBe(n);

    const page = (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>();
    expect(page.items.map((t) => [t.type, t.txHash]).sort()).toEqual([
      ["deposit", "0xd1"],
      ["deposit", "0xt3"],
      ["withdrawal", "0xs2"],
    ]);
  });

  it("uses the unified API with a saved key, sent as a header and never in the URL", async () => {
    const bs = fakeBlockscout();
    const { client, settle } = await setup(bs.f);
    const s = await client.put("/api/crypto/settings", { blockscoutKey: "proapi_test_key" });
    expect(s.json()).toMatchObject({ hasBlockscoutKey: true });
    const w = (
      await client.post("/api/crypto/wallets", {
        name: "Base",
        kind: "blockchain",
        chain: "base",
        source: ME,
      })
    ).json<CryptoWallet>();
    expect((await settle(w.id)).status).toBe("ok");
    const u = bs.calls[0]?.url as URL;
    expect(u.origin + u.pathname).toBe("https://api.blockscout.com/8453/api");
    // The key goes with every call to the key-based API (NFT lookups use the public site).
    const keyed = bs.calls.filter((c) => c.url.host === "api.blockscout.com");
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every((c) => c.auth === "Bearer proapi_test_key")).toBe(true);
    expect(bs.calls.filter((c) => c.url.host !== "api.blockscout.com").every((c) => !c.auth)).toBe(
      true,
    );
    expect(bs.calls.some((c) => c.url.href.includes("proapi"))).toBe(false);
  });

  it("doesn't duplicate imported transactions", async () => {
    const bs = fakeBlockscout(
      [
        {
          hash: "0xabc",
          blockNumber: "20",
          timeStamp: String(Date.UTC(2025, 1, 1, 12) / 1000),
          from: OTHER,
          to: ME,
          value: "299000000000000000",
          gasUsed: "1",
          gasPrice: "1",
        },
      ],
      [],
    );
    const { client, settle } = await setup(bs.f);
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

  it("picks the service from the coin and rejects keys of another coin", async () => {
    const bs = fakeBlockscout();
    const { client } = await setup(bs.f);
    const w = (
      await client.post("/api/crypto/wallets", { name: "BTC", kind: "manual" })
    ).json<CryptoWallet>();
    // A Bitcoin zpub is not a Dogecoin key.
    const zpub =
      "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
    const bad = await client.put(`/api/crypto/wallets/${w.id}/source`, {
      chain: "doge",
      source: zpub,
    });
    expect(bad.statusCode).toBe(400);
    await client.put(`/api/crypto/wallets/${w.id}/source`, {
      chain: "btc",
      source: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    });
    await client.post(`/api/crypto/wallets/${w.id}/sync`);
    expect(bs.calls[0]?.url.origin).toBe("https://mempool.space");
  });

  it("never goes over the daily request budget", async () => {
    const bs = fakeBlockscout();
    const { client, db } = await setup(bs.f);
    const day = localDay();
    db.insert(schema.appSettings)
      .values({
        key: "crypto.usage",
        value: { blockscout: { day, dayCount: 1500, month: day.slice(0, 7), monthCount: 1500 } },
      })
      .run();
    const w = (
      await client.post("/api/crypto/wallets", { name: "Hot", kind: "manual" })
    ).json<CryptoWallet>();
    await client.put(`/api/crypto/wallets/${w.id}/source`, { chain: "eth", source: ME });
    const res = await client.post(`/api/crypto/wallets/${w.id}/sync`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/Daily limit/);
    expect(bs.calls).toEqual([]);
    const s = (await client.get("/api/crypto/settings")).json<{
      usage: { provider: string; today: number; dayLimit: number }[];
    }>();
    expect(s.usage.find((u) => u.provider === "blockscout")).toMatchObject({
      today: 1500,
      dayLimit: 1500,
    });
  });
});
