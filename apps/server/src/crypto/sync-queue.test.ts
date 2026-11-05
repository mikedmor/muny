import { randomBytes } from "node:crypto";
import type { CryptoOverview, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// A fake Blockscout that holds every request until released. No network.
describe("sync all", () => {
  it("shows waiting wallets as queued until their turn is over", async () => {
    let release: () => void = () => {};
    let gate = new Promise<void>((r) => {
      release = r;
    });
    const f = (async (url: string) => {
      await gate;
      const action = new URL(url).searchParams.get("action");
      return Response.json({ status: "1", message: "OK", result: action === "balance" ? "0" : [] });
    }) as unknown as typeof fetch;
    const { client, db } = await makeSignedInApp({
      priceFetch: f,
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const wallets = async () => (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    // Two synced wallets (attached without syncing yet).
    const { schema } = await import("@muny/db");
    for (const [name, addr] of [
      ["A", "0x1111111111111111111111111111111111111111"],
      ["B", "0x2222222222222222222222222222222222222222"],
    ] as const) {
      const w = (
        await client.post("/api/crypto/wallets", { name, kind: "manual" })
      ).json<CryptoWallet>();
      await client.put(`/api/crypto/wallets/${w.id}/source`, { chain: "eth", source: addr });
    }
    // Let the syncs started by attaching finish, then mark them as old.
    release();
    for (let i = 0; i < 100 && (await wallets()).some((w) => w.syncing || w.queued); i++)
      await new Promise((r) => setTimeout(r, 10));
    db.update(schema.cryptoWallets)
      .set({ lastSyncAt: new Date(0) })
      .run();

    gate = new Promise<void>((r) => {
      release = r;
    });
    expect((await client.post("/api/crypto/sync")).statusCode).toBe(202);
    const during = await wallets();
    expect(during.map((w) => [w.name, w.syncing, w.queued])).toEqual([
      ["A", true, false],
      ["B", false, true],
    ]);
    expect((await client.get("/api/crypto/overview")).json<CryptoOverview>().syncing).toBe(true);
    release();
    for (let i = 0; i < 100 && (await wallets()).some((w) => w.syncing || w.queued); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((await wallets()).every((w) => !w.syncing && !w.queued && w.status === "ok")).toBe(true);
  });
});
