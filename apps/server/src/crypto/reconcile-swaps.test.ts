import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoOverview, CryptoReconcile, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic data only; the "chain" is a fake Blockscout. No network.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const T = Date.UTC(2021, 3, 1);
const HASH = `0x${"ab".repeat(32)}`;

const fakeChain = (async (url: string) => {
  const action = new URL(url).searchParams.get("action");
  const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
  if (action === "txlist")
    return ok([
      {
        hash: HASH,
        blockNumber: "10",
        timeStamp: String(T / 1000),
        from: OTHER,
        to: ME,
        value: "123456789012345678",
        gasUsed: "1",
        gasPrice: "1",
      },
    ]);
  if (action === "balance") return ok("123456789012345678");
  return ok([]);
}) as unknown as typeof fetch;

async function setup() {
  const ctx = await makeSignedInApp({
    priceFetch: fakeChain,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const { client } = ctx;
  const report = async () => (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
  const synced = async () => {
    const w = (
      await client.post("/api/crypto/wallets", {
        name: "Exodus ETH",
        kind: "blockchain",
        chain: "eth",
        source: ME,
      })
    ).json<CryptoWallet>();
    for (let i = 0; i < 100; i++) {
      const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      if (ws.find((x) => x.id === w.id)?.status === "ok") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return w;
  };
  return { ...ctx, report, synced };
}

describe("reconcile: Koinly's quirks", () => {
  it("matches imported rows without 0x and with rounded amounts", async () => {
    const { db, report, synced } = await setup();
    const w = await synced();
    db.insert(schema.cryptoTxns)
      .values({
        id: "imp",
        walletId: w.id,
        at: T,
        type: "deposit",
        label: "mining",
        receivedAsset: "ETH",
        receivedAmount: "0.12345679", // rounded by the export
        txHash: HASH.slice(2).toUpperCase(), // no 0x
        externalId: "koinly:x",
        source: "import",
      })
      .run();
    expect((await report()).wallets[0]).toMatchObject({ duplicates: 1 });
  });

  it("moves cross-chain swap proceeds to the wallet they arrived in", async () => {
    const { client, db, report, synced } = await setup();
    const eth = await synced();
    // Koinly put the ETH from a TRX → ETH swap in the TRON wallet.
    const trx = (
      await client.post("/api/crypto/wallets", { name: "Exodus TRX", kind: "manual" })
    ).json<CryptoWallet>();
    db.insert(schema.cryptoTxns)
      .values({
        id: "swap",
        walletId: trx.id,
        at: T - 600_000,
        type: "trade",
        sentAsset: "TRX",
        sentAmount: "5000",
        receivedAsset: "ETH",
        receivedAmount: "0.12345679",
        externalId: "koinly:swap",
        source: "import",
      })
      .run();
    db.insert(schema.cryptoTxns)
      .values({
        id: "fund",
        walletId: trx.id,
        at: T - 900_000,
        type: "deposit",
        receivedAsset: "TRX",
        receivedAmount: "5000",
        externalId: "koinly:fund",
        source: "import",
      })
      .run();
    let o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    // Counted in both wallets.
    expect(o.holdings.find((h) => h.asset === "ETH")?.wallets).toHaveLength(2);

    const issue = (await report()).wallets.find((x) => x.walletId === trx.id);
    expect(issue?.crossChain).toEqual([
      expect.objectContaining({ txnId: "swap", asset: "ETH", toWalletId: eth.id }),
    ]);
    const c = issue?.crossChain[0];
    await client.post("/api/crypto/reconcile/crosschain", {
      moves: [{ txnId: c?.txnId, toTxnId: c?.toTxnId }],
    });
    o = (await client.get("/api/crypto/overview")).json<CryptoOverview>();
    expect(o.holdings.find((h) => h.asset === "ETH")?.wallets.map((x) => x.walletName)).toEqual([
      "Exodus ETH",
    ]);
    expect((await report()).wallets.find((x) => x.walletId === trx.id)).toBeUndefined();
  });
});
