import type {
  CryptoImportPreview,
  CryptoImportResult,
  CryptoOverview,
  CryptoTxnPage,
  CryptoWallet,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only, in Koinly's export layout.
const HEADER =
  "Date,Type,Tag,Sending Wallet,Sent Amount,Sent Currency,Sent Cost Basis,Receiving Wallet,Received Amount,Received Currency,Received Cost Basis,Fee Amount,Fee Currency,Gain (USD),Net Value (USD),Fee Value (USD),TxSrc,TxDest,TxHash,Description";
const KOINLY = [
  "Koinly Transaction History",
  HEADER,
  "2025-01-10 10:00:00 UTC,buy,,Demo Exchange,1000.00,USD,,Demo Exchange,0.5,ETH,,,,,1000.00,,,,,",
  "2025-02-01 12:00:00 UTC,transfer,,Demo Exchange,0.3,ETH,,Cold ETH,0.299,ETH,,0.001,ETH,,600.00,2.00,,,0xabc,",
  "2025-03-05 08:00:00 UTC,crypto_deposit,Reward,,,,,Demo Exchange,0.01,ATOM,,,,,0.05,,,,,",
  "2025-04-01 09:00:00 UTC,sell,,Demo Exchange,0.1,ETH,200.00,Demo Exchange,250.00,USD,,,,50.00,250.00,,,,,",
].join("\n");

async function setup(priceFetch?: typeof fetch) {
  const ctx = await makeSignedInApp(priceFetch ? { priceFetch } : {});
  const imp = async () =>
    (
      await ctx.client.post("/api/crypto/import/commit", { format: "koinly", content: KOINLY })
    ).json<CryptoImportResult>();
  const wallets = async () => (await ctx.client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
  return { ...ctx, imp, wallets };
}

describe("crypto", () => {
  it("previews and imports a Koinly export without duplicating on re-import", async () => {
    const { client, imp } = await setup();
    const pre = (
      await client.post("/api/crypto/import/preview", { format: "koinly", content: KOINLY })
    ).json<CryptoImportPreview>();
    expect(pre).toMatchObject({ txns: 5, duplicates: 0, errors: [] });
    expect(pre.wallets.map((w) => [w.name, w.exists, w.txns])).toEqual([
      ["Demo Exchange", false, 4],
      ["Cold ETH", false, 1],
    ]);
    expect(await imp()).toMatchObject({ imported: 5, duplicates: 0, walletsCreated: 2 });
    expect(await imp()).toMatchObject({ imported: 0, duplicates: 5, walletsCreated: 0 });
    const bad = await client.post("/api/crypto/import/preview", {
      format: "koinly",
      content: "a,b\n1,2",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("computes exact wallet balances and links transfers", async () => {
    const { client, imp, wallets } = await setup();
    await imp();
    const ws = await wallets();
    const ex = ws.find((w) => w.name === "Demo Exchange") as CryptoWallet;
    const cold = ws.find((w) => w.name === "Cold ETH") as CryptoWallet;
    // ETH: +0.5 buy, −0.3 −0.001 fee transfer out, −0.1 sell = 0.099
    // USD would be -750 (the deposit that funded the buy is not in the file): flagged, not shown.
    expect(Object.fromEntries(ex.balances.map((b) => [b.asset, b.amount]))).toEqual({
      ETH: "0.099",
      ATOM: "0.01",
    });
    expect(cold.balances).toEqual([{ asset: "ETH", amount: "0.299", valueCents: null }]);
    expect(ex.txnCount).toBe(4);

    const page = (await client.get(`/api/crypto/txns?walletId=${cold.id}`)).json<CryptoTxnPage>();
    expect(page.items[0]).toMatchObject({ type: "transfer", transferWalletName: "Demo Exchange" });
    const rewards = (await client.get("/api/crypto/txns?label=reward")).json<CryptoTxnPage>();
    expect(rewards.total).toBe(1);
    const eth = (await client.get("/api/crypto/txns?asset=ETH")).json<CryptoTxnPage>();
    expect(eth.total).toBe(4);
  });

  it("adds manual transactions and validates them", async () => {
    const { client, wallets } = await setup();
    const w = (
      await client.post("/api/crypto/wallets", { name: "Paper", kind: "manual" })
    ).json<CryptoWallet>();
    const ok = await client.post("/api/crypto/txns", {
      walletId: w.id,
      at: Date.UTC(2025, 5, 1),
      type: "deposit",
      receivedAsset: "btc",
      receivedAmount: "0.00012345",
    });
    expect(ok.statusCode).toBe(201);
    const bad = await client.post("/api/crypto/txns", {
      walletId: w.id,
      at: Date.UTC(2025, 5, 1),
      type: "trade",
      sentAsset: "BTC",
      sentAmount: "-1",
    });
    expect(bad.statusCode).toBe(400);
    expect((await wallets())[0]?.balances).toEqual([
      { asset: "BTC", amount: "0.00012345", valueCents: null },
    ]);
  });

  it("prices holdings from DefiLlama only when turned on, sending only coin ids", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes("/prices/current/"))
        return Response.json({
          coins: { "coingecko:ethereum": { price: 2000 }, "coingecko:cosmos": { price: 1.5 } },
        });
      if (url.includes("/percentage/"))
        return Response.json({ coins: { "coingecko:ethereum": 5.5, "coingecko:cosmos": -2 } });
      // /chart: two daily closes for whichever coin was asked.
      const id = decodeURIComponent(url.split("/chart/")[1]?.split("?")[0] ?? "");
      return Response.json({
        coins: {
          [id]: {
            prices: [
              { timestamp: Date.UTC(2025, 0, 10) / 1000, price: 2000 },
              { timestamp: Date.UTC(2025, 1, 2) / 1000, price: 2500 },
            ],
          },
        },
      });
    }) as unknown as typeof fetch;
    const { client, imp } = await setup(fakeFetch);
    await imp();
    expect((await client.post("/api/crypto/prices/refresh")).statusCode).toBe(400);
    expect(urls).toEqual([]);

    await client.put("/api/crypto/settings", { pricesEnabled: true });
    // Turning prices on starts an update in the background; wait for it.
    let o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    for (let i = 0; i < 50 && !o.holdings.some((h) => h.price); i++) {
      await new Promise((r) => setTimeout(r, 20));
      o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    }
    expect(urls.every((u) => u.startsWith("https://coins.llama.fi/"))).toBe(true);
    expect(urls.some((u) => u.includes("coingecko%3Aethereum"))).toBe(true);
    expect(urls.join(" ")).not.toMatch(/0\.299|Demo|Cold/);
    // History starts at each coin's first transaction (ETH: 2025-01-10).
    expect(urls.some((u) => u.includes(`start=${Date.UTC(2025, 0, 10) / 1000}`))).toBe(true);

    const eth = o.holdings.find((h) => h.asset === "ETH");
    expect(eth).toMatchObject({
      amount: "0.398",
      price: "2000",
      valueCents: 79_600,
      change24hPct: 5.5,
    });
    expect(o.unpricedAssets).toEqual([]);
    // USD going negative (the bank deposit is not in the file) is not flagged: fiat.
    expect(o.missingHistory).toEqual([]);
    expect(o.totalValueCents).toBe(79_600 + 2); // + 0.01 ATOM at $1.50
    expect(o.history.length).toBeGreaterThanOrEqual(2);
    expect(o.history[0]).toEqual({ date: "2025-01-10", valueCents: 100_000 });

    // A second update only fetches what's missing (no chart calls for stored days).
    urls.length = 0;
    await client.post("/api/crypto/prices/refresh");
    expect(urls.filter((u) => u.includes("/chart/")).length).toBeLessThanOrEqual(2);
  });

  it("can use CoinGecko instead", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      if (url.includes("/simple/price"))
        return Response.json({ ethereum: { usd: 2000, usd_24h_change: 1 }, cosmos: { usd: 1 } });
      return Response.json({ prices: [[Date.UTC(2025, 0, 10), 2000]] });
    }) as unknown as typeof fetch;
    const { client, imp } = await setup(fakeFetch);
    await imp();
    await client.put("/api/crypto/settings", { provider: "coingecko" });
    await client.put("/api/crypto/settings", { pricesEnabled: true });
    let o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    for (let i = 0; i < 50 && !o.holdings.some((h) => h.price); i++) {
      await new Promise((r) => setTimeout(r, 20));
      o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    }
    expect(urls.every((u) => u.startsWith("https://api.coingecko.com/"))).toBe(true);
    expect(o.holdings.find((h) => h.asset === "ETH")?.price).toBe("2000");
  });
});
