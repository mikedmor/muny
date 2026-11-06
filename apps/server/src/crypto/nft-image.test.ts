import { schema } from "@muny/db";
import type { CryptoWallet } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";
import { fetchNftImage, isPrivateAddress, NftImageError } from "./nft-image.js";

// Synthetic NFTs and hosts; DNS and fetch are faked.
const C = "0x2222222222222222222222222222222222222222";

async function setup(image: string) {
  const app = await makeSignedInApp();
  const w = (
    await app.client.post("/api/crypto/wallets", { name: "W", kind: "manual" })
  ).json<CryptoWallet>();
  app.db
    .update(schema.cryptoWallets)
    .set({
      syncCursor: JSON.stringify({
        height: 1,
        balances: [],
        nfts: [
          {
            contract: C,
            tokenId: "7",
            type: "ERC-721",
            name: "x.crypto",
            collection: null,
            image,
            amount: "1",
          },
        ],
      }),
    })
    .where(eq(schema.cryptoWallets.id, w.id))
    .run();
  return { ...app, w };
}
const dns = (map: Record<string, string>) =>
  (async (host: string) => [{ address: map[host] ?? "93.184.216.34", family: 4 }]) as never;

describe("NFT images through the server", () => {
  it("is off until turned on, then passes the image on", async () => {
    const { db, client, w } = await setup("https://img.example/x.png");
    const png = new Uint8Array([137, 80, 78, 71]);
    const fake = (async () =>
      new Response(png, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const q = { walletId: w.id, contract: C, tokenId: "7" };
    await expect(fetchNftImage(db, q, { fetch: fake, resolve: dns({}) })).rejects.toMatchObject({
      status: 403,
    });
    await client.put("/api/crypto/settings", { nftImages: true });
    const img = await fetchNftImage(db, q, { fetch: fake, resolve: dns({}) });
    expect(img.type).toBe("image/png");
    expect([...img.body]).toEqual([...png]);
  });

  it("refuses images inside the home network, also after a redirect", async () => {
    const { db, client, w } = await setup("https://evil.example/x.png");
    await client.put("/api/crypto/settings", { nftImages: true });
    const q = { walletId: w.id, contract: C, tokenId: "7" };
    const never = (async () => {
      throw new Error("must not be fetched");
    }) as unknown as typeof fetch;
    await expect(
      fetchNftImage(db, q, { fetch: never, resolve: dns({ "evil.example": "192.168.1.200" }) }),
    ).rejects.toBeInstanceOf(NftImageError);
    const redirect = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8080/admin" },
      })) as unknown as typeof fetch;
    await expect(fetchNftImage(db, q, { fetch: redirect, resolve: dns({}) })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
  });

  it("knows private addresses", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "192.168.1.5",
      "172.20.0.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "::ffff:192.168.0.1",
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"])
      expect(isPrivateAddress(ip)).toBe(false);
  });
});
