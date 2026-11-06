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

  it("flags a transfer recorded twice (once with the fee split out), and deletes one", async () => {
    const { client, db, exodus, trezor, list } = await setup();
    const row = (id: string, walletId: string, v: Record<string, unknown>) =>
      db
        .insert(schema.cryptoTxns)
        .values({
          id,
          walletId,
          at: T,
          externalId: `koinly:${id}`,
          source: "import",
          type: "transfer",
          ...v,
        })
        .run();
    const pair = async (a: string, b: string) => {
      await client.post(`/api/crypto/txns/${b}/link`, { otherId: a });
    };
    // The same send, 5 minutes apart: 265.5535684 once, 246 + 19.5535684 fee once.
    row("x1", exodus.id, {
      type: "withdrawal",
      sentAsset: "XLM",
      sentAmount: "265.5535684",
      at: T + 3_600_000,
    });
    row("x1in", trezor.id, {
      type: "deposit",
      receivedAsset: "XLM",
      receivedAmount: "265.5535684",
      at: T + 3_600_000,
    });
    row("x2", exodus.id, {
      type: "withdrawal",
      sentAsset: "XLM",
      sentAmount: "246",
      feeAsset: "XLM",
      feeAmount: "19.5535684",
      at: T + 3_900_000,
    });
    row("x2in", trezor.id, {
      type: "deposit",
      receivedAsset: "XLM",
      receivedAmount: "246",
      at: T + 3_900_000,
    });
    await pair("x1", "x1in");
    await pair("x2", "x2in");

    const flagged = await list("warnings=duplicates");
    expect(flagged.items.map((x) => x.id).sort()).toEqual(["x1", "x2"]);
    expect(flagged.items.find((x) => x.id === "x2")?.possibleDuplicate).toMatchObject({
      id: "x1",
      walletName: "Exodus XLM",
      otherWallet: "Trezor XLM",
    });

    // Deleting a transfer takes both sides.
    expect((await client.delete("/api/crypto/txns/x1")).json()).toMatchObject({ deleted: 2 });
    const left = (await list("")).items.map((x) => x.id);
    expect(left).not.toContain("x1");
    expect(left).toContain("x2");
    expect((await list("warnings=duplicates")).total).toBe(0);
  });

  it("stops flagging a pair you say isn't a duplicate", async () => {
    const { client, db, exodus, list } = await setup();
    for (const id of ["m1", "m2"])
      db.insert(schema.cryptoTxns)
        .values({
          id,
          walletId: exodus.id,
          at: T + (id === "m1" ? 0 : 60_000) + 7 * 86_400_000,
          externalId: `koinly:${id}`,
          source: "import",
          type: "deposit",
          receivedAsset: "XLM",
          receivedAmount: "5",
        })
        .run();
    expect((await list("warnings=duplicates")).total).toBe(2);
    await client.post("/api/crypto/txns/m1/not-duplicate", { otherId: "m2" });
    expect((await list("warnings=duplicates")).total).toBe(0);
  });

  it("doesn't flag equal reward payouts minutes apart", async () => {
    const { db, exodus, list } = await setup();
    for (const id of ["r1", "r2"])
      db.insert(schema.cryptoTxns)
        .values({
          id,
          walletId: exodus.id,
          at: T + (id === "r1" ? 0 : 30_000) + 9 * 86_400_000,
          externalId: `koinly:${id}`,
          source: "import",
          type: "deposit",
          label: "reward",
          receivedAsset: "XLM",
          receivedAmount: "2",
        })
        .run();
    expect((await list("warnings=duplicates")).total).toBe(0);
  });

  it("won't delete a synced row", async () => {
    const { client, db, exodus } = await setup();
    db.insert(schema.cryptoTxns)
      .values({
        id: "s1",
        walletId: exodus.id,
        at: T,
        externalId: "xlm:op:1",
        source: "sync",
        type: "deposit",
        receivedAsset: "XLM",
        receivedAmount: "1",
      })
      .run();
    expect((await client.delete("/api/crypto/txns/s1")).statusCode).toBe(400);
  });

  it("edits a transaction's date and amounts; its type follows", async () => {
    const { client, list } = await setup();
    const at = Date.UTC(2021, 5, 1, 9, 30);
    const res = await client.patch("/api/crypto/txns/buy", {
      at,
      sentAsset: "USD",
      sentAmount: "50",
      receivedAsset: "XLM",
      receivedAmount: "230.7",
      valueCents: 5000,
    });
    expect(res.statusCode).toBe(200);
    expect((await list("")).items.find((x) => x.id === "buy")).toMatchObject({
      at,
      type: "trade",
      sentAmount: "50",
      valueCents: 5000,
    });
    // One side of a transfer can't take on the other side's amounts.
    await client.post("/api/crypto/txns/got/link", { otherId: "send" });
    const bad = await client.patch("/api/crypto/txns/got", { sentAsset: "XLM", sentAmount: "1" });
    expect(bad.statusCode).toBe(400);
    const ok = await client.patch("/api/crypto/txns/got", { receivedAmount: "245" });
    expect(ok.statusCode).toBe(200);
  });

  it("ignores a Reconcile item until its amount changes", async () => {
    const { client, db, exodus } = await setup();
    const report = async () =>
      (await client.get("/api/crypto/reconcile")).json<import("@muny/shared").CryptoReconcile>();
    const item = (await report()).wallets.find((x) => x.walletId === exodus.id)?.missing[0];
    expect(item?.asset).toBe("XLM");
    await client.put("/api/crypto/settings", { ignored: [item?.key] });
    const after = await report();
    expect(after.wallets.find((x) => x.walletId === exodus.id)).toBeUndefined();
    expect(after.ignored).toEqual([expect.objectContaining({ asset: "XLM", kind: "missing" })]);
    // A different shortfall shows again.
    db.insert(schema.cryptoTxns)
      .values({
        id: "more",
        walletId: exodus.id,
        at: T + 3_600_000,
        externalId: "koinly:more",
        source: "import",
        type: "withdrawal",
        sentAsset: "XLM",
        sentAmount: "1",
      })
      .run();
    expect((await report()).wallets.find((x) => x.walletId === exodus.id)?.missing[0]?.asset).toBe(
      "XLM",
    );
  });
});
