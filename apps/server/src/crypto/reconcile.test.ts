import { randomBytes } from "node:crypto";
import type { CryptoOverview, CryptoReconcile, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only; the "chain" is a fake Blockscout. No network.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const T = Date.UTC(2025, 5, 1);

const fakeChain = (async (url: string) => {
  const action = new URL(url).searchParams.get("action");
  const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
  if (action === "txlist")
    return ok([
      {
        hash: "0xd1",
        blockNumber: "10",
        timeStamp: String(T / 1000),
        from: OTHER,
        to: ME,
        value: "1000000000000000000",
        gasUsed: "1",
        gasPrice: "1",
      },
    ]);
  if (action === "balance") return ok("1000000000000000000");
  return ok([]);
}) as unknown as typeof fetch;

async function setup() {
  const ctx = await makeSignedInApp({
    priceFetch: fakeChain,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const { client } = ctx;
  const wallets = async () => (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
  const report = async () => (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      if (!(await wallets()).some((w) => w.syncing || (w.sourceHint && w.status === "never")))
        return;
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const wallet = async (name: string) =>
    (await client.post("/api/crypto/wallets", { name, kind: "manual" })).json<CryptoWallet>();
  const txn = (walletId: string, body: object) =>
    client.post("/api/crypto/txns", { walletId, at: T, ...body });
  return { ...ctx, wallets, report, settle, wallet, txn };
}

describe("crypto reconcile", () => {
  it("finds wallets syncing the same address and merges them", async () => {
    const { client, wallets, report, settle } = await setup();
    for (const name of ["Trezor ETH", "Trezor BAT"])
      await client.post("/api/crypto/wallets", {
        name,
        kind: "blockchain",
        chain: "eth",
        source: ME,
      });
    await settle();
    // Counted twice: 1 ETH on chain, 2 ETH in Muny.
    let o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    expect(o.holdings.find((h) => h.asset === "ETH")?.amount).toBe("2");
    const r = await report();
    expect(r.sameAddress).toHaveLength(1);
    const [keep, drop] = r.sameAddress[0]?.wallets ?? [];
    const res = await client.post("/api/crypto/reconcile/merge", {
      into: keep?.id,
      from: [drop?.id],
    });
    expect(res.json()).toMatchObject({ walletsRemoved: 1 });
    expect((await wallets()).map((w) => w.name)).toEqual([keep?.name]);
    o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    expect(o.holdings.find((h) => h.asset === "ETH")?.amount).toBe("1");
    expect((await report()).sameAddress).toEqual([]);
  });

  it("suggests the matching withdrawal for missing history and links it", async () => {
    const { client, report, wallet, txn } = await setup();
    const exchange = await wallet("Exchange");
    const cold = await wallet("Cold");
    await txn(exchange.id, { type: "deposit", receivedAsset: "ETH", receivedAmount: "2" });
    const out = (
      await txn(exchange.id, {
        type: "withdrawal",
        sentAsset: "ETH",
        sentAmount: "1",
        at: T + 1000,
      })
    ).json<{ id: string }>();
    // Cold spends ETH it never received in Muny.
    await txn(cold.id, { type: "withdrawal", sentAsset: "ETH", sentAmount: "0.4", at: T + 5000 });
    // Fiat going negative is not flagged.
    await txn(exchange.id, { type: "withdrawal", sentAsset: "USD", sentAmount: "50" });

    const r = await report();
    const coldIssue = r.wallets.find((w) => w.walletId === cold.id);
    expect(coldIssue?.missing).toEqual([expect.objectContaining({ asset: "ETH", deficit: "0.4" })]);
    expect(coldIssue?.missing[0]?.suggestions[0]).toMatchObject({
      txnId: out.id,
      fromWalletName: "Exchange",
      amount: "1",
    });
    expect(r.wallets.find((w) => w.walletId === exchange.id)).toBeUndefined();

    await client.post("/api/crypto/reconcile/link", { walletId: cold.id, txnId: out.id });
    expect((await report()).wallets).toEqual([]);
    const o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    expect(o.missingHistory).toEqual([]);
  });

  it("adds an opening balance and hides spam tokens", async () => {
    const { client, report, wallet, txn } = await setup();
    const w = await wallet("Old");
    await txn(w.id, { type: "withdrawal", sentAsset: "BTC", sentAmount: "0.1" });
    await txn(w.id, { type: "deposit", receivedAsset: "SPAMX", receivedAmount: "1000" });
    const issue = (await report()).wallets[0]?.missing[0];
    await client.post("/api/crypto/reconcile/opening", {
      walletId: w.id,
      asset: issue?.asset,
      amount: issue?.deficit,
      at: issue?.firstAt,
    });
    expect((await report()).wallets).toEqual([]);

    await client.put("/api/crypto/settings", { hiddenAssets: ["SPAMX"] });
    const o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    expect(o.holdings.map((h) => h.asset)).not.toContain("SPAMX");
    expect(o.unpricedAssets).not.toContain("SPAMX");
  });

  it("finds synced copies of imported transactions and removes them", async () => {
    const { client, db, report, settle } = await setup();
    const w = (
      await client.post("/api/crypto/wallets", {
        name: "Hot",
        kind: "blockchain",
        chain: "eth",
        source: ME,
      })
    ).json<CryptoWallet>();
    await settle();
    // An imported row for the same deposit, a day off and without a hash.
    const { schema } = await import("@muny/db");
    db.insert(schema.cryptoTxns)
      .values({
        id: "imp1",
        walletId: w.id,
        at: T + 86_400_000,
        type: "deposit",
        receivedAsset: "ETH",
        receivedAmount: "1",
        externalId: "koinly:x",
        source: "import",
      })
      .run();
    const r = await report();
    expect(r.wallets[0]).toMatchObject({ walletId: w.id, duplicates: 1 });
    expect(r.wallets[0]?.mismatches[0]).toMatchObject({ asset: "ETH", diff: "1" });
    await client.post("/api/crypto/reconcile/duplicates", { walletId: w.id });
    expect((await report()).wallets).toEqual([]);
  });

  it("explains a surplus with the deposits that add up to it, and fills a shortfall", async () => {
    const { client, db, report, settle } = await setup();
    const w = (
      await client.post("/api/crypto/wallets", {
        name: "Hot",
        kind: "blockchain",
        chain: "eth",
        source: ME,
      })
    ).json<CryptoWallet>();
    await settle();
    const { schema } = await import("@muny/db");
    const imp = (id: string, at: number, v: Record<string, string>) =>
      db
        .insert(schema.cryptoTxns)
        .values({
          id,
          walletId: w.id,
          at,
          type: "deposit",
          externalId: `koinly:${id}`,
          source: "import",
          ...v,
        })
        .run();
    // Reward withdrawals Koinly recorded as deposits (counted twice), plus one unrelated.
    imp("r1", T + 10 * 86_400_000, {
      receivedAsset: "ETH",
      receivedAmount: "0.3",
      label: "reward",
    });
    imp("r2", T + 20 * 86_400_000, { receivedAsset: "ETH", receivedAmount: "0.2" });
    imp("x", T + 30 * 86_400_000, { receivedAsset: "ETH", receivedAmount: "0.7" });
    imp("out", T + 40 * 86_400_000, { type: "withdrawal", sentAsset: "ETH", sentAmount: "0.7" });
    let m = (await report()).wallets[0]?.mismatches[0];
    expect(m).toMatchObject({ asset: "ETH", diff: "0.5" });
    expect(m?.extra.map((e) => e.txnId).sort()).toEqual(["r1", "r2"]);
    await client.post("/api/crypto/reconcile/remove", {
      walletId: w.id,
      txnIds: m?.extra.map((e) => e.txnId),
    });
    expect((await report()).wallets).toEqual([]);

    // A shortfall: history the service doesn't have.
    imp("gone", T + 50 * 86_400_000, { type: "withdrawal", sentAsset: "ETH", sentAmount: "0.25" });
    m = (await report()).wallets[0]?.mismatches[0];
    expect(m).toMatchObject({ diff: "-0.25", extra: [] });
    await client.post("/api/crypto/reconcile/adjust", {
      walletId: w.id,
      asset: "ETH",
      amount: "0.25",
      staking: false,
    });
    expect((await report()).wallets).toEqual([]);
  });
});
