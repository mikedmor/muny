import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoReconcile, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic Cardano stake address and a fake Koios. No network.
const STAKE = `stake1${"u".repeat(53)}`;
const WD = "ab".repeat(32); // the transaction that withdrew the rewards

const koios = (async (url: string) => {
  const p = new URL(url).pathname.replace("/api/v1/", "");
  const j = (v: unknown) => Response.json(v);
  if (p === "account_txs") return j([]);
  if (p === "account_reward_history")
    return j([
      { earned_epoch: 300, spendable_epoch: 302, amount: "3000000", type: "member", pool_id: "p" },
      { earned_epoch: 301, spendable_epoch: 303, amount: "2000000", type: "member", pool_id: "p" },
    ]);
  if (p === "account_info") return j([{ total_balance: "0" }]);
  if (p === "tx_info")
    return j([{ tx_hash: WD, withdrawals: [{ stake_addr: STAKE, amount: "5000000" }] }]);
  return new Response("nf", { status: 404 });
}) as unknown as typeof fetch;

async function setup() {
  const ctx = await makeSignedInApp({
    priceFetch: koios,
    env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
  });
  const { client, db } = ctx;
  const w = (
    await client.post("/api/crypto/wallets", {
      name: "Exodus ADA",
      kind: "blockchain",
      chain: "ada",
      source: STAKE,
    })
  ).json<CryptoWallet>();
  for (let i = 0; i < 100; i++) {
    const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    if (ws[0]?.status === "ok") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  // Koinly's view: the withdrawal (5 ADA rewards + a returned 2 ADA deposit) as a
  // plain deposit, then everything sent on.
  const at = Date.UTC(2025, 0, 7);
  const row = (id: string, v: Record<string, unknown>) =>
    db
      .insert(schema.cryptoTxns)
      .values({
        id,
        walletId: w.id,
        at,
        externalId: `koinly:${id}`,
        source: "import",
        type: "deposit",
        ...v,
      })
      .run();
  row("wd", { receivedAsset: "ADA", receivedAmount: "7", txHash: WD, valueCents: 700 });
  row("out", { type: "withdrawal", sentAsset: "ADA", sentAmount: "7", at: at + 1000 });
  const report = async () => (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
  return { ...ctx, w, report };
}

describe("staking rewards counted twice", () => {
  it("keeps per-epoch rewards and takes the withdrawal out of the imported deposit", async () => {
    const { client, db, w, report } = await setup();
    const m = (await report()).wallets[0]?.mismatches[0];
    expect(m).toMatchObject({ asset: "ADA", diff: "5", rewardsTwice: { synced: 2, chain: "ada" } });
    const res = await client.post("/api/crypto/reconcile/rewards", {
      walletId: w.id,
      keep: "synced",
    });
    expect(res.json()).toMatchObject({ adjusted: 1 });
    expect((await report()).wallets).toEqual([]);
    const { eq } = await import("drizzle-orm");
    const left = db.select().from(schema.cryptoTxns).where(eq(schema.cryptoTxns.id, "wd")).get();
    // The returned 2 ADA deposit stays, its value scaled to match.
    expect(left).toMatchObject({ receivedAmount: "2", valueCents: 200 });
  });

  it("or keeps the imported version and stops syncing rewards", async () => {
    const { client, w, report } = await setup();
    await client.post("/api/crypto/reconcile/rewards", { walletId: w.id, keep: "imported" });
    expect((await report()).wallets).toEqual([]);
    // A later sync doesn't bring them back.
    await client.post(`/api/crypto/wallets/${w.id}/sync`);
    expect((await report()).wallets).toEqual([]);
  });
});
