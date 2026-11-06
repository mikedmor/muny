import { randomBytes } from "node:crypto";
import { schema } from "@muny/db";
import type { CryptoTaxDoc, CryptoWallet } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic history and a made-up "PDF".
describe("crypto tax reports and 1099-DA forms", () => {
  it("writes the year's gains and Form 8949 lines; a 1099-DA sets the box; forms are encrypted", async () => {
    const { client, db } = await makeSignedInApp({
      env: { MUNY_SECRET_KEY: randomBytes(32).toString("base64") },
    });
    const ex = (
      await client.post("/api/crypto/wallets", { name: "Coinbase", kind: "exchange" })
    ).json<CryptoWallet>();
    const row = (id: string, at: number, v: Record<string, unknown>) =>
      db
        .insert(schema.cryptoTxns)
        .values({
          id,
          walletId: ex.id,
          at,
          externalId: `x:${id}`,
          source: "import",
          type: "trade",
          ...v,
        } as never)
        .run();
    row("b1", Date.UTC(2023, 0, 10), {
      sentAsset: "USD",
      sentAmount: "100",
      receivedAsset: "BTC",
      receivedAmount: "1",
      valueCents: 10_000,
    });
    row("b2", Date.UTC(2025, 2, 1), {
      sentAsset: "USD",
      sentAmount: "300",
      receivedAsset: "BTC",
      receivedAmount: "1",
      valueCents: 30_000,
    });
    row("s1", Date.UTC(2025, 5, 1), {
      sentAsset: "BTC",
      sentAmount: "1.5",
      receivedAsset: "USD",
      receivedAmount: "600",
      valueCents: 60_000,
    });

    const gains = (await client.get("/api/crypto/tax/2025/report/capital-gains")).body;
    expect(gains.split("\n")[0]).toMatch(/^Date sold,Date acquired,Asset,Amount/);
    expect(gains).toContain("2025-06-01,2023-01-10,BTC,1,400.00,100.00,300.00,Long term");
    expect(gains).toContain("2025-06-01,2025-03-01,BTC,0.5,200.00,150.00,50.00,Short term");

    let f8949 = (await client.get("/api/crypto/tax/2025/report/form-8949")).body;
    expect(f8949).toContain("I (short term),I,0.5 BTC");
    expect(f8949).toContain("II (long term),L,1 BTC");

    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(64)]);
    const up = await client.post("/api/crypto/tax/2025/docs", {
      walletId: ex.id,
      filename: "1099-DA.pdf",
      contentType: "application/pdf",
      base64: pdf.toString("base64"),
      basisReported: true,
    });
    expect(up.statusCode).toBe(200);
    f8949 = (await client.get("/api/crypto/tax/2025/report/form-8949")).body;
    expect(f8949).toContain("I (short term),G,0.5 BTC");
    expect(f8949).toContain("II (long term),J,1 BTC");

    // Stored encrypted; comes back as uploaded.
    const stored = db.select().from(schema.cryptoTaxDocs).get();
    expect(stored?.data.includes(Buffer.from("%PDF"))).toBe(false);
    const docs = (await client.get("/api/crypto/tax/2025/docs")).json<CryptoTaxDoc[]>();
    const file = await client.get(`/api/crypto/tax/docs/${docs[0]?.id}/file`);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(Buffer.from(file.rawPayload).equals(pdf)).toBe(true);

    // Not a PDF: refused.
    const bad = await client.post("/api/crypto/tax/2025/docs", {
      walletId: ex.id,
      filename: "x.exe",
      contentType: "application/octet-stream",
      base64: Buffer.from("MZ...").toString("base64"),
      basisReported: true,
    });
    expect(bad.statusCode).toBe(400);
  });
});
