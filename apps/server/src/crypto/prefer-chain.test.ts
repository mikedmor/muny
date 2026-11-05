import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoReconcile, CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic address and a fake Blockscout. No network.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const T = Date.UTC(2023, 0, 1);
const H1 = `0x${"a1".repeat(32)}`;
const H2 = `0x${"b2".repeat(32)}`;

const chain = (async (url: string) => {
  const action = new URL(url).searchParams.get("action");
  const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
  if (action === "txlist")
    return ok([
      {
        hash: H1,
        blockNumber: "10",
        timeStamp: String(T / 1000),
        from: OTHER,
        to: ME,
        value: "1000000000000000000",
        gasUsed: "1",
        gasPrice: "1",
      },
      {
        hash: H2,
        blockNumber: "11",
        timeStamp: String(T / 1000 + 60),
        from: ME,
        to: OTHER,
        value: "400000000000000000",
        gasUsed: "21000",
        gasPrice: "1000000000",
      },
    ]);
  if (action === "balance") return ok("599979000000000000");
  return ok([]);
}) as unknown as typeof fetch;

describe("use the blockchain's version", () => {
  it("replaces imported rows with the chain's, keeping links to other wallets", async () => {
    const { client, db } = await makeSignedInApp({
      priceFetch: chain,
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const add = async (name: string, kind: string) =>
      (await client.post("/api/crypto/wallets", { name, kind })).json<CryptoWallet>();
    const hot = await add("Hot", "manual");
    const cb = await add("Coinbase", "exchange");
    // An export that rounded and split things differently from the chain.
    const row = (id: string, walletId: string, v: Record<string, unknown>) =>
      db
        .insert(schema.cryptoTxns)
        .values({
          id,
          walletId,
          at: T,
          externalId: `koinly:${id}`,
          source: "import",
          type: "deposit",
          ...v,
        })
        .run();
    row("in", hot.id, {
      receivedAsset: "ETH",
      receivedAmount: "1.05",
      txHash: H1.slice(2),
      label: "mining",
      valueCents: 170_000,
    });
    row("out", hot.id, {
      type: "transfer",
      sentAsset: "ETH",
      sentAmount: "0.5",
      txHash: H2.slice(2),
      at: T + 60_000,
    });
    // A row the chain doesn't have (an export's mistake): kept, and listed.
    row("ghost", hot.id, {
      receivedAsset: "REP",
      receivedAmount: "2",
      txHash: "9".repeat(64),
      at: T + 120_000,
    });
    row("cbin", cb.id, {
      type: "transfer",
      receivedAsset: "ETH",
      receivedAmount: "0.5",
      at: T + 60_000,
    });
    const { eq } = await import("drizzle-orm");
    const link = (a: string, b: string) =>
      db
        .update(schema.cryptoTxns)
        .set({ transferPairId: b })
        .where(eq(schema.cryptoTxns.id, a))
        .run();
    link("out", "cbin");
    link("cbin", "out");
    await client.put(`/api/crypto/wallets/${hot.id}/source`, { chain: "eth", source: ME });
    for (let i = 0; i < 100; i++) {
      const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      if (ws.find((x) => x.id === hot.id)?.status === "ok") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const report = async () => (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
    const issue = (await report()).wallets.find((x) => x.walletId === hot.id);
    expect(issue).toMatchObject({ importedWithHash: 3 });
    expect(issue?.mismatches[0]?.asset).toBe("ETH");

    const res = await client.post("/api/crypto/reconcile/prefer-chain", { walletId: hot.id });
    expect(res.json()).toMatchObject({
      replaced: 2,
      relinked: 1,
      kept: [{ txnId: "ghost", asset: "REP", amount: "2", direction: "in" }],
    });
    expect((await report()).wallets.find((x) => x.walletId === hot.id)).toBeUndefined();
    const page = (await client.get(`/api/crypto/txns?walletId=${hot.id}`)).json<CryptoTxnPage>();
    expect(page.items.find((x) => x.type === "transfer")).toMatchObject({
      transferWalletName: "Coinbase",
      sentAmount: "0.4",
    });
    // What the import knew stays: the tag, its USD value; the chain adds the sender.
    const dep = page.items.find((x) => x.type === "deposit" && x.receivedAsset === "ETH");
    expect(dep).toMatchObject({ label: "mining", valueCents: 170_000, counterparty: OTHER });
    // Rows without a USD value are valued at that day's price.
    db.insert(schema.cryptoPrices)
      .values({ asset: "ETH", date: "2023-01-01", usd: "1200", source: "test" })
      .run();
    const priced = (await client.get(`/api/crypto/txns?walletId=${hot.id}`)).json<CryptoTxnPage>();
    expect(priced.items.find((x) => x.type === "transfer")).toMatchObject({ valueCents: 48_000 });

    // A later Koinly import adds to the synced rows instead of bringing its own back.
    const H =
      "ID (read-only),Date (UTC),Type,Tag,From Wallet (read-only),From Amount,From Currency,To Wallet (read-only),To Amount,To Currency,Net Value (read-only),Value Currency (read-only),Deleted,TxSrc,TxHash,Description";
    const csv = [
      H,
      `9,2023-01-01 00:00:00,deposit,mining,,,,Hot;eth,1.05,ETH;1,1700,USD;10,false,${OTHER},${H1.slice(2)},From the pool`,
    ].join("\n");
    const imp = (
      await client.post("/api/crypto/import/commit", {
        format: "koinly",
        content: csv,
        mapping: { Hot: hot.id },
      })
    ).json<{ imported: number; duplicates: number }>();
    expect(imp).toMatchObject({ imported: 0, duplicates: 1 });
    const after = (await client.get(`/api/crypto/txns?walletId=${hot.id}`)).json<CryptoTxnPage>();
    expect(after.total).toBe(page.total);
    expect(
      after.items.find((x) => x.type === "deposit" && x.receivedAsset === "ETH"),
    ).toMatchObject({
      description: "From the pool",
    });
    expect((await report()).wallets.find((x) => x.walletId === hot.id)).toBeUndefined();
  });
});
