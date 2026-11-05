import { randomBytes } from "node:crypto";
import type { CryptoReconcile, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../../test-utils.js";

// Synthetic address; a fake Blockscout. The token contracts are Augur's public
// old and new REP contracts.
const ME = "0x1111111111111111111111111111111111111111";
const EXODUS = "0x2222222222222222222222222222222222222222";
const OLD_REP = "0x48c80f1f4d53d5951e5d5438b54cba84f29f32a5";
const NEW_REP = "0xe94327d07fc17907b4db788e5adf2ed424addff6";
const tok = (hash: string, n: number, contract: string, from: string, to: string) => ({
  hash,
  blockNumber: String(n),
  timeStamp: String(1_497_000_000 + n * 86_400),
  contractAddress: contract,
  from,
  to,
  value: "2728221760000000000",
  tokenSymbol: "REP",
  tokenDecimal: "18",
});

const fake = (async (url: string) => {
  const action = new URL(url).searchParams.get("action");
  const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
  if (action === "tokentx")
    return ok([
      // Old REP in; after the 2017 migration, new REP (granted 1:1) sent out.
      tok(`0x${"a1".repeat(32)}`, 1, OLD_REP, EXODUS, ME),
      tok(`0x${"b2".repeat(32)}`, 70, NEW_REP, ME, EXODUS),
    ]);
  if (action === "tokenlist")
    return ok([
      {
        contractAddress: OLD_REP,
        symbol: "REP",
        decimals: "18",
        balance: "2728221760000000000",
        type: "ERC-20",
      },
    ]);
  if (action === "balance") return ok("0");
  return ok([]);
}) as unknown as typeof fetch;

describe("a token replaced by a new contract", () => {
  it("doesn't compare what's left on the old contract with the history", async () => {
    const { client } = await makeSignedInApp({
      priceFetch: fake,
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    await client.post("/api/crypto/wallets", {
      name: "Jaxx",
      kind: "blockchain",
      chain: "eth",
      source: ME,
    });
    for (let i = 0; i < 100; i++) {
      const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
      if (ws[0]?.status === "ok") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    expect(ws[0]?.onChain).toEqual([{ asset: "ETH", amount: "0" }]);
    expect((await client.get("/api/crypto/reconcile")).json<CryptoReconcile>().wallets).toEqual([]);
  });
});
