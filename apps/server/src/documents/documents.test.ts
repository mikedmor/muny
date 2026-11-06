import type { DocumentInfo } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { makeSignedInApp } from "../test-utils.js";

// Synthetic file content only.
const SECRET = "a".repeat(64);
const fakePdf = Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF");

describe("documents", () => {
  it("keeps a file once, encrypted, and gives it back", async () => {
    const { client, db } = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET } });
    const up = (name: string) =>
      client.post("/api/documents", {
        name,
        mime: "application/pdf",
        dataBase64: fakePdf.toString("base64"),
        notes: "Car title",
      });
    const first = await up("title.pdf");
    expect(first.statusCode).toBe(200);
    const doc = first.json<DocumentInfo>();
    expect((await up("again.pdf")).json<DocumentInfo>().id).toBe(doc.id);
    expect((await client.get("/api/documents")).json<DocumentInfo[]>()).toHaveLength(1);

    // Stored encrypted.
    const raw = db.$client.prepare("select data, encrypted from documents").get() as {
      data: Buffer;
      encrypted: number;
    };
    expect(raw.encrypted).toBe(1);
    expect(raw.data.includes(Buffer.from("synthetic"))).toBe(false);

    const file = await client.get(`/api/documents/${doc.id}/file?download=1`);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(String(file.headers["content-disposition"])).toContain("attachment");
    expect(file.rawPayload.equals(fakePdf)).toBe(true);

    // Not what it says it is.
    const bad = await client.post("/api/documents", {
      name: "x.png",
      mime: "image/png",
      dataBase64: fakePdf.toString("base64"),
    });
    expect(bad.statusCode).toBe(400);

    expect((await client.delete(`/api/documents/${doc.id}`)).statusCode).toBe(200);
    expect((await client.get("/api/documents")).json<DocumentInfo[]>()).toEqual([]);
  });
});
