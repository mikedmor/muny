import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoReconcile, CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic accounts; a Stellar service that no longer has the account (closed).
const XLM = `G${"B".repeat(55)}`;
const closed = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
const T = Date.UTC(2021, 2, 24);

async function setup() {
  const app = await makeSignedInApp({
    priceFetch: closed,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const { client, db } = app;
  const add = async (name: string) =>
    (await client.post("/api/crypto/wallets", { name, kind: "manual" })).json<CryptoWallet>();
  const xlm = await add("Exodus XLM");
  const cb = await add("Coinbase");
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
  // The history ends with 205.5 XLM left; the merge that emptied it is missing.
  row("in", xlm.id, { receivedAsset: "XLM", receivedAmount: "205.5", txHash: "aa" });
  // Coinbase got (almost) all of it a few weeks later.
  row("cb", cb.id, { receivedAsset: "XLM", receivedAmount: "205.49999", at: T + 20 * 86_400_000 });
  await client.put(`/api/crypto/wallets/${xlm.id}/source`, { chain: "xlm", source: XLM });
  for (let i = 0; i < 100; i++) {
    const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    const x = ws.find((y) => y.id === xlm.id);
    if (x?.status !== "never" && !x?.syncing) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const report = async () =>
    (await client.get("/api/crypto/reconcile"))
      .json<CryptoReconcile>()
      .wallets.find((x) => x.walletId === xlm.id);
  return { ...app, xlm, cb, report };
}

describe("a closed account", () => {
  it("suggests where what was left went, and links it as a transfer", async () => {
    const { client, xlm, report } = await setup();
    const m = (await report())?.mismatches[0];
    expect(m).toMatchObject({ asset: "XLM", onChain: "0", diff: "205.5" });
    expect(m?.closed?.lastAt).toBe(T);
    expect(m?.closed?.suggestions).toEqual([
      expect.objectContaining({ fromWalletName: "Coinbase", amount: "205.49999" }),
    ]);

    await client.post("/api/crypto/reconcile/closed", {
      walletId: xlm.id,
      asset: "XLM",
      amount: "205.5",
      toTxnId: m?.closed?.suggestions[0]?.txnId,
    });
    expect(await report()).toBeUndefined();
    const page = (await client.get(`/api/crypto/txns?walletId=${xlm.id}`)).json<CryptoTxnPage>();
    expect(page.items[0]).toMatchObject({
      type: "transfer",
      sentAmount: "205.49999",
      feeAmount: "0.00001",
      transferWalletName: "Coinbase",
    });
  });

  it("or records it as sent out of your wallets on a chosen day", async () => {
    const { client, xlm, report } = await setup();
    const at = Date.UTC(2021, 3, 1, 12);
    await client.post("/api/crypto/reconcile/closed", {
      walletId: xlm.id,
      asset: "XLM",
      amount: "205.5",
      at,
    });
    expect(await report()).toBeUndefined();
    const page = (await client.get(`/api/crypto/txns?walletId=${xlm.id}`)).json<CryptoTxnPage>();
    expect(page.items[0]).toMatchObject({ type: "withdrawal", sentAmount: "205.5", at });
  });

  it("isn't called closed when only the history is gone: the balance is still read", async () => {
    const noHistory = (async (url: string) => {
      const p = new URL(url).pathname;
      if (p.endsWith("/effects") || p.endsWith("/transactions"))
        return new Response("not found", { status: 404 });
      return Response.json({ balances: [{ asset_type: "native", balance: "1.0000001" }] });
    }) as unknown as typeof fetch;
    const app = await makeSignedInApp({
      priceFetch: noHistory,
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const w = (
      await app.client.post("/api/crypto/wallets", {
        name: "Exodus XLM",
        kind: "blockchain",
        chain: "xlm",
        source: XLM,
      })
    ).json<CryptoWallet>();
    let done: CryptoWallet | undefined;
    for (let i = 0; i < 100; i++) {
      done = (await app.client.get("/api/crypto/wallets"))
        .json<CryptoWallet[]>()
        .find((x) => x.id === w.id);
      if (done?.status !== "never" && !done?.syncing) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(done).toMatchObject({ status: "ok", onChain: [{ asset: "XLM", amount: "1.0000001" }] });
    expect(done?.lastError).toMatch(/no longer keeps this account's history/);
  });

  it("records a small surplus as a network fee the history missed", async () => {
    const { client, db, xlm } = await setup();
    const at = Date.UTC(2021, 5, 1);
    db.insert((await import("@muny/db")).schema.cryptoTxns)
      .values({
        id: "x",
        walletId: xlm.id,
        at,
        externalId: "koinly:x",
        source: "import",
        type: "deposit",
        receivedAsset: "BTC",
        receivedAmount: "1",
      })
      .run();
    const res = await client.post("/api/crypto/reconcile/adjust", {
      walletId: xlm.id,
      asset: "XLM",
      amount: "0.00001",
      staking: false,
      out: "fee",
    });
    expect(res.statusCode).toBe(200);
    const page = (await client.get(`/api/crypto/txns?walletId=${xlm.id}`)).json<CryptoTxnPage>();
    expect(page.items[0]).toMatchObject({
      type: "withdrawal",
      sentAmount: null,
      feeAsset: "XLM",
      feeAmount: "0.00001",
      description: "Added in Reconcile: a network fee missing from history",
    });
    // Dated just after the wallet's last transaction (the deposit added above).
    expect(page.items[0]?.at).toBe(at + 1000);
  });

  it("dates a balance adjustment when asked (not today)", async () => {
    const { client, xlm } = await setup();
    const at = Date.UTC(2021, 3, 1, 12);
    await client.post("/api/crypto/reconcile/adjust", {
      walletId: xlm.id,
      asset: "XLM",
      amount: "1",
      staking: false,
      at,
    });
    const page = (await client.get(`/api/crypto/txns?walletId=${xlm.id}`)).json<CryptoTxnPage>();
    expect(page.items.find((x) => x.receivedAmount === "1")).toMatchObject({ type: "deposit", at });
  });
});
