import { randomBytes } from "node:crypto";
import { HdAccount } from "@muny/core";
import { schema } from "@muny/db";
import type { CryptoWallet } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// BIP84 test vector (public) and a synthetic address; no network (sync is faked).
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const ME = "0x1111111111111111111111111111111111111111";
const quiet = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;

describe("receive address", () => {
  it("gives a plain address as is, and an xpub's next unused receive address", async () => {
    const { client, db } = await makeSignedInApp({
      priceFetch: quiet,
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const add = async (chain: string, source: string) =>
      (
        await client.post("/api/crypto/wallets", { name: chain, kind: "blockchain", chain, source })
      ).json<CryptoWallet>();
    const eth = await add("eth", ME);
    expect((await client.get(`/api/crypto/wallets/${eth.id}/receive`)).json()).toMatchObject({
      chainName: "Ethereum",
      coin: "ETH",
      address: ME,
    });

    const btc = await add("btc", ZPUB);
    // Receive addresses 0 and 1 have been used.
    db.update(schema.cryptoWallets)
      .set({
        syncCursor: JSON.stringify({
          height: 1,
          balances: [],
          pos: { "0/0": 1, "0/1": 2, "1/0": 1 },
        }),
      })
      .where(eq(schema.cryptoWallets.id, btc.id))
      .run();
    const r = (await client.get(`/api/crypto/wallets/${btc.id}/receive`)).json<{
      address: string;
    }>();
    expect(r.address).toBe(new HdAccount(ZPUB, "btc").address(0, 2));
    expect(r.address).toMatch(/^bc1q/);
  });
});
