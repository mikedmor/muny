import { randomBytes } from "node:crypto";
import type { CryptoReconcile, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic address; a fake Blockscout whose balance history has a change
// (a fee of 0.005 ETH in transaction H3) that the transaction lists miss.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const T = 1_672_531_200; // 2023-01-01
const H1 = `0x${"a1".repeat(32)}`;
const H2 = `0x${"b2".repeat(32)}`;
const H3 = `0x${"c3".repeat(32)}`;

const fake = (async (url: string) => {
  const u = new URL(url);
  const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
  if (u.pathname.endsWith("/coin-balance-history"))
    return Response.json({
      items: [
        {
          transaction_hash: H3,
          block_timestamp: "2023-01-03T00:00:00Z",
          delta: "-5000000000000000",
        },
        {
          transaction_hash: H2,
          block_timestamp: "2023-01-02T00:00:00Z",
          delta: "-400021000000000000",
        },
        {
          transaction_hash: H1,
          block_timestamp: "2023-01-01T00:00:00Z",
          delta: "1000000000000000000",
        },
      ],
      next_page_params: null,
    });
  const action = u.searchParams.get("action");
  if (action === "txlist")
    return ok([
      {
        hash: H1,
        blockNumber: "10",
        timeStamp: String(T),
        from: OTHER,
        to: ME,
        value: "1000000000000000000",
        gasUsed: "1",
        gasPrice: "1",
      },
      {
        hash: H2,
        blockNumber: "11",
        timeStamp: String(T + 86400),
        from: ME,
        to: OTHER,
        value: "400000000000000000",
        gasUsed: "21000",
        gasPrice: "1000000000",
      },
    ]);
  if (action === "balance") return ok("594979000000000000");
  return ok([]);
}) as unknown as typeof fetch;

describe("compare with the chain, transaction by transaction", () => {
  it("finds the transaction Muny records differently and corrects it", async () => {
    const { client } = await makeSignedInApp({
      priceFetch: fake,
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const w = (
      await client.post("/api/crypto/wallets", {
        name: "Hot",
        kind: "blockchain",
        chain: "eth",
        source: ME,
      })
    ).json<CryptoWallet>();
    for (let i = 0; i < 100; i++) {
      const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      if (ws[0]?.status === "ok") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const report = async () => (await client.get("/api/crypto/reconcile")).json<CryptoReconcile>();
    expect((await report()).wallets[0]?.mismatches[0]).toMatchObject({ diff: "0.005" });

    const cmp = (await client.post("/api/crypto/reconcile/compare", { walletId: w.id })).json<{
      asset: string;
      diffs: { txHash: string | null; at: number; chain: string; muny: string }[];
    }>();
    expect(cmp.asset).toBe("ETH");
    expect(cmp.diffs).toEqual([
      { txHash: H3.slice(2), at: Date.UTC(2023, 0, 3), chain: "-0.005", muny: "0" },
    ]);
    await client.post("/api/crypto/reconcile/correct", {
      walletId: w.id,
      asset: "ETH",
      ...cmp.diffs[0],
    });
    expect((await report()).wallets).toEqual([]);
  });
});
