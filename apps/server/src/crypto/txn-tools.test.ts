import { schema } from "@muny/db";
import type { CryptoTxnPage, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic wallets and amounts only.
const T = Date.UTC(2021, 2, 24, 4, 16);

async function setup() {
  const app = await makeSignedInApp();
  const { client, db } = app;
  const add = async (name: string) =>
    (await client.post("/api/crypto/wallets", { name, kind: "manual" })).json<CryptoWallet>();
  const exodus = await add("Exodus XLM");
  const trezor = await add("Trezor XLM");
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
  // Exodus had 230.7 XLM but sent 246 (+19.55 fee): 34.85 has no purchase history.
  row("buy", exodus.id, { receivedAsset: "XLM", receivedAmount: "230.7", at: T - 86_400_000 });
  row("send", exodus.id, {
    type: "withdrawal",
    sentAsset: "XLM",
    sentAmount: "246",
    feeAsset: "XLM",
    feeAmount: "19.55",
  });
  row("got", trezor.id, { receivedAsset: "XLM", receivedAmount: "246", at: T + 60_000 });
  const list = async (qs: string) =>
    (await client.get(`/api/crypto/txns?${qs}`)).json<CryptoTxnPage>();
  return { ...app, exodus, trezor, list };
}

describe("transaction tools", () => {
  it("flags sends with missing purchase history, and filters by it", async () => {
    const { list } = await setup();
    const all = await list("");
    expect(all.items.find((x) => x.id === "send")?.missingHistory).toEqual([
      { asset: "XLM", amount: "34.85" },
    ]);
    expect(all.items.find((x) => x.id === "got")?.missingHistory).toEqual([]);
    const flagged = await list("warnings=missing");
    expect(flagged.items.map((x) => x.id)).toEqual(["send"]);
  });

  it("marks a deposit as a transfer from another wallet, and undoes it", async () => {
    const { client, exodus, trezor, list } = await setup();
    const matches = (await client.get("/api/crypto/txns/got/matches")).json<
      { id: string; walletName: string }[]
    >();
    expect(matches).toEqual([expect.objectContaining({ id: "send", walletName: "Exodus XLM" })]);
    await client.post("/api/crypto/txns/got/link", { otherId: "send" });

    // Both wallets selected: the transfer shows once, from the sending side.
    const both = await list(`walletId=${exodus.id},${trezor.id}`);
    expect(both.items.map((x) => x.id)).toEqual(["send", "buy"]);
    expect(both.items[0]).toMatchObject({
      type: "transfer",
      transfer: { walletName: "Trezor XLM", amount: "246" },
    });
    // Just the receiving wallet: its side shows.
    expect((await list(`walletId=${trezor.id}`)).items.map((x) => x.id)).toEqual(["got"]);

    await client.post("/api/crypto/txns/got/unlink");
    const after = await list("");
    expect(after.items.find((x) => x.id === "got")).toMatchObject({
      type: "deposit",
      transfer: null,
    });
    expect(after.items.find((x) => x.id === "send")).toMatchObject({ type: "withdrawal" });
  });

  it("refuses to link two transactions that aren't a send and a receipt", async () => {
    const { client } = await setup();
    const res = await client.post("/api/crypto/txns/got/link", { otherId: "buy" });
    expect(res.statusCode).toBe(400);
  });
});
