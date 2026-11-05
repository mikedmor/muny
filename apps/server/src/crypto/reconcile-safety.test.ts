import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoReconcile, CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic accounts; a Stellar service that has no history (a closed account).
const XLM = `G${"A".repeat(55)}`;
const closed = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;

async function setup() {
  return makeSignedInApp({
    priceFetch: closed,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
}
const row = (
  db: Awaited<ReturnType<typeof setup>>["db"],
  id: string,
  walletId: string,
  v: Record<string, unknown>,
) =>
  db
    .insert(schema.cryptoTxns)
    .values({
      id,
      walletId,
      at: Date.UTC(2021, 2, 24),
      externalId: `koinly:${id}`,
      source: "import",
      type: "deposit",
      ...v,
    })
    .run();

describe("reconcile safety", () => {
  it("never replaces imports when the chain service has no history", async () => {
    const { client, db } = await setup();
    const w = (
      await client.post("/api/crypto/wallets", { name: "Trezor XLM", kind: "manual" })
    ).json<CryptoWallet>();
    row(db, "in", w.id, { receivedAsset: "XLM", receivedAmount: "500", txHash: "aa" });
    row(db, "out", w.id, {
      type: "withdrawal",
      sentAsset: "XLM",
      sentAmount: "500",
      txHash: "bb",
      at: Date.UTC(2025, 0, 15),
    });
    await client.put(`/api/crypto/wallets/${w.id}/source`, { chain: "xlm", source: XLM });
    for (let i = 0; i < 100; i++) {
      const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      if (ws[0]?.status !== "never" && !ws[0]?.syncing) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // The wallet has a "no history" notice, so the fix isn't offered...
    const r = (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
    expect(r.wallets.find((x) => x.walletId === w.id)?.importedWithHash ?? 0).toBe(0);
    // ...and asking anyway changes nothing.
    const res = await client.post("/api/crypto/reconcile/prefer-chain", { walletId: w.id });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/doesn't have 2 of this wallet's 2/);
    const page = (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>();
    expect(page.total).toBe(2);
  });

  it("finds a Reconcile fix left with nothing to move, and undoes it", async () => {
    const { client, db } = await setup();
    const add = async (name: string) =>
      (await client.post("/api/crypto/wallets", { name, kind: "manual" })).json<CryptoWallet>();
    const eth = await add("Exodus ETH");
    const ada = await add("Exodus ADA");
    // The swap import that a "Move there" fix was built on…
    row(db, "swap", eth.id, {
      type: "trade",
      sentAsset: "ETH",
      sentAmount: "1",
      receivedAsset: "ADA",
      receivedAmount: "100",
    });
    row(db, "fund", eth.id, {
      receivedAsset: "ETH",
      receivedAmount: "1",
      at: Date.UTC(2021, 0, 1),
    });
    row(db, "arrive", ada.id, { receivedAsset: "ADA", receivedAmount: "100" });
    const { moveCrossChain } = await import("./reconcile.js");
    moveCrossChain(db, "swap", { toTxnId: "arrive", toWalletId: ada.id });
    // …is later replaced (e.g. by the blockchain's version).
    db.delete(schema.cryptoTxns).where(eq(schema.cryptoTxns.id, "swap")).run();

    const r = (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
    const m = r.wallets.find((x) => x.walletId === eth.id)?.missing.find((x) => x.asset === "ADA");
    expect(m?.staleFixes).toHaveLength(1);
    await client.post("/api/crypto/reconcile/undo", { walletId: eth.id, txnIds: m?.staleFixes });
    const after = (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
    expect(
      after.wallets.find((x) => x.walletId === eth.id)?.missing.find((x) => x.asset === "ADA"),
    ).toBeUndefined();
    // The arrival is a plain deposit again.
    const arrive = db
      .select()
      .from(schema.cryptoTxns)
      .where(eq(schema.cryptoTxns.id, "arrive"))
      .get();
    expect(arrive).toMatchObject({ type: "deposit", transferPairId: null });
  });
});
