import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic addresses; a fake Blockscout. No network.
const ME = "0x1111111111111111111111111111111111111111";
const FROM = "0x3333333333333333333333333333333333333333";
const TO = "0x4444444444444444444444444444444444444444";
const T = 1_672_531_200;
const tx = (hash: string, n: number, from: string, to: string, value: string) => ({
  hash,
  blockNumber: String(10 + n),
  timeStamp: String(T + n * 86_400),
  from,
  to,
  value,
  gasUsed: "21000",
  gasPrice: "1000000000",
});
let calls = 0;
const chain = (async (url: string) => {
  calls++;
  const u = new URL(url);
  const action = u.searchParams.get("action");
  const from = Number(u.searchParams.get("startblock") ?? 0);
  const ok = (result: unknown) => Response.json({ status: "1", message: "OK", result });
  if (action === "txlist")
    return ok(
      [
        tx(`0x${"a1".repeat(32)}`, 0, FROM, ME, "1000000000000000000"),
        tx(`0x${"b2".repeat(32)}`, 1, ME, TO, "100000000000000000"),
        tx(`0x${"c3".repeat(32)}`, 2, FROM, ME, "5000000000000000"),
      ].filter((x) => Number(x.blockNumber) >= from),
    );
  if (action === "balance") return ok("904979000000000000");
  return ok([]);
}) as unknown as typeof fetch;

describe("addresses for rows synced before they were kept", () => {
  it("fills them in on the next sync, without bringing back removed rows", async () => {
    const { client, db } = await makeSignedInApp({
      priceFetch: chain,
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
    const waitIdle = async () => {
      for (let i = 0; i < 200; i++) {
        const ws = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
        if (ws[0]?.status !== "never" && !ws[0]?.syncing && !ws[0]?.queued) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitIdle();
    const t = schema.cryptoTxns;
    expect(
      db
        .select()
        .from(t)
        .all()
        .map((r) => r.counterparty),
    ).toEqual(expect.arrayContaining([FROM, TO]));
    // As synced by an older version: no addresses; one row removed in Reconcile.
    db.update(t).set({ counterparty: null }).run();
    db.delete(t)
      .where(eq(t.txHash, `0x${"a1".repeat(32)}`))
      .run();
    db.delete(schema.appSettings)
      .where(eq(schema.appSettings.key, "crypto.addresses_filled"))
      .run();

    await client.post(`/api/crypto/wallets/${w.id}/sync`);
    await waitIdle();
    const page = (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>();
    expect(page.total).toBe(2);
    expect(page.items.map((x) => x.counterparty).sort()).toEqual([FROM, TO].sort());

    // Done once: the next sync is incremental again.
    const before = calls;
    await client.post(`/api/crypto/wallets/${w.id}/sync`);
    await waitIdle();
    expect(calls - before).toBeLessThan(10);
    expect(
      (await client.get(`/api/crypto/txns?walletId=${w.id}`)).json<CryptoTxnPage>().total,
    ).toBe(2);
  });
});
