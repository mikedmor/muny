import type {
  CryptoImportPreview,
  CryptoImportResult,
  CryptoTxnPage,
  CryptoWallet,
} from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic rows in the layout of Koinly's full "Transactions" export.
const HEADER =
  "ID (read-only),Parent ID (read-only),Date (UTC),Type,Tag,From Wallet (read-only),From Wallet ID,From Amount,From Currency,To Wallet (read-only),To Wallet ID,To Amount,To Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Fee Worth Amount,Fee Worth Currency,Net Value (read-only),Fee Value (read-only),Value Currency (read-only),Deleted,From Source (read-only),To Source (read-only),Negative Balances (read-only),Missing Rates (read-only),Missing Cost Basis (read-only),Synced To Accounting At (UTC read-only),TxSrc,TxDest,TxHash,Method Name (read-only),Description";
const row = (cols: Record<string, string>) => {
  const names = HEADER.split(",");
  return names.map((n) => cols[n] ?? "").join(",");
};
const CSV = [
  HEADER,
  row({
    "ID (read-only)": "A1",
    "Date (UTC)": "2017-08-01 10:00:00",
    Type: "deposit",
    "To Wallet (read-only)": "Coinbase;coinbase",
    "To Amount": "2.0",
    "To Currency": "ETH;1",
    "Net Value (read-only)": "500.00",
    "Value Currency (read-only)": "USD;10",
    Deleted: "false",
  }),
  row({
    "ID (read-only)": "A2",
    "Date (UTC)": "2017-09-01 10:00:00",
    Type: "transfer",
    "From Wallet (read-only)": "Coinbase;coinbase",
    "From Amount": "1.5",
    "From Currency": "ETH;1",
    "To Wallet (read-only)": "ETH Exodus;eth",
    "To Amount": "1.5",
    "To Currency": "ETH;1",
    "Fee Amount": "0.01",
    "Fee Currency": "ETH;1",
    "Value Currency (read-only)": "USD;10",
    Deleted: "false",
  }),
  row({
    "ID (read-only)": "A3",
    "Date (UTC)": "2021-03-01 10:00:00",
    Type: "deposit",
    Tag: "other_income",
    "To Wallet (read-only)": "ETH Exodus;eth",
    "To Amount": "0.1",
    "To Currency": "ETH;1",
    "Value Currency (read-only)": "USD;10",
    Deleted: "false",
  }),
  row({
    "ID (read-only)": "GONE",
    "Date (UTC)": "2021-03-02 10:00:00",
    Type: "deposit",
    "To Wallet (read-only)": "ETH Exodus;eth",
    "To Amount": "99",
    "To Currency": "ETH;1",
    Deleted: "true",
  }),
].join("\n");

describe("Koinly full export", () => {
  it("maps wallets by name in any word order, replaces earlier imports and links transfers", async () => {
    const { client } = await makeSignedInApp();
    // An existing wallet (named the other way round) with an earlier Koinly row
    // and a fix Reconcile added on top.
    const ex = (
      await client.post("/api/crypto/wallets", { name: "Exodus ETH", kind: "manual" })
    ).json<CryptoWallet>();
    await client.post("/api/crypto/txns", {
      walletId: ex.id,
      at: Date.UTC(2021, 0, 1),
      type: "withdrawal",
      sentAsset: "ETH",
      sentAmount: "5",
    });
    const pre = (
      await client.post("/api/crypto/import/preview", { format: "koinly", content: CSV })
    ).json<CryptoImportPreview>();
    expect(pre.full).toBe(true);
    expect(pre.txns).toBe(4); // deposit, transfer (2 sides), income; the deleted row is skipped
    const exodus = pre.wallets.find((x) => x.name === "ETH Exodus");
    expect(exodus).toMatchObject({ exists: true, suggestedWalletId: ex.id });
    expect(pre.wallets.find((x) => x.name === "Coinbase")).toMatchObject({
      kind: "exchange",
      exists: false,
    });

    const res = (
      await client.post("/api/crypto/import/commit", {
        format: "koinly",
        content: CSV,
        replace: true,
        mapping: { "ETH Exodus": ex.id, Coinbase: "new" },
      })
    ).json<CryptoImportResult & { replaced: number }>();
    expect(res).toMatchObject({ imported: 4, walletsCreated: 1 });

    const wallets = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    const bal = (name: string) =>
      Object.fromEntries(
        (wallets.find((x) => x.name === name)?.balances ?? []).map((b) => [b.asset, b.amount]),
      );
    // The hand-added 5 ETH withdrawal stays (only imports and Reconcile fixes are replaced).
    // 2 in, 1.5 sent on plus a 0.01 fee (Koinly lists the fee on top of the amount sent).
    expect(bal("Coinbase")).toEqual({ ETH: "0.49" });
    const page = (await client.get(`/api/crypto/txns?walletId=${ex.id}`)).json<CryptoTxnPage>();
    expect(page.items.find((x) => x.type === "transfer")).toMatchObject({
      transferWalletName: "Coinbase",
      receivedAmount: "1.5",
    });
    expect(page.items.find((x) => x.label === "income")).toBeTruthy();

    // Importing the same file again adds nothing.
    const again = (
      await client.post("/api/crypto/import/commit", {
        format: "koinly",
        content: CSV,
        mapping: { "ETH Exodus": ex.id },
      })
    ).json<CryptoImportResult>();
    expect(again).toMatchObject({ imported: 0, duplicates: 4 });
  });

  it("skips wallets marked skip, leaving the other side of their transfers as a plain move", async () => {
    const { client } = await makeSignedInApp();
    const res = (
      await client.post("/api/crypto/import/commit", {
        format: "koinly",
        content: CSV,
        mapping: { Coinbase: "skip", "ETH Exodus": "new" },
      })
    ).json<CryptoImportResult>();
    expect(res).toMatchObject({ imported: 2, walletsCreated: 1 });
    const wallets = (await client.get("/api/crypto/wallets")).json<CryptoWallet[]>();
    expect(wallets.map((x) => x.name)).toEqual(["ETH Exodus"]);
    const page = (
      await client.get(`/api/crypto/txns?walletId=${wallets[0]?.id}`)
    ).json<CryptoTxnPage>();
    expect(page.items.map((x) => x.type).sort()).toEqual(["deposit", "deposit"]);
  });
});
