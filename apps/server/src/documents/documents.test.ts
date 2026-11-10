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

  it("keeps folders you make, and uploads into whichever folder you're in", async () => {
    const { client } = await makeSignedInApp({ env: { MUNY_SECRET_KEY: SECRET } });
    const made = await client.post("/api/documents/folders", { path: " Home/Insurance " });
    expect(made.json()).toEqual({ path: "Home / Insurance", folders: ["Home / Insurance"] });
    expect((await client.post("/api/documents/folders", { path: " / " })).statusCode).toBe(400);
    expect((await client.get("/api/documents/folders")).json()).toEqual({
      folders: ["Home / Insurance"],
    });

    // Any folder, the ones statements file themselves in too.
    const up = await client.post("/api/documents", {
      name: "letter.pdf",
      mime: "application/pdf",
      dataBase64: fakePdf.toString("base64"),
      folder: "Loans / Seaview",
    });
    expect(up.json<DocumentInfo>()).toMatchObject({ kind: "other", folder: "Loans / Seaview" });

    // A contract in a Contracts folder of your own stays there.
    const c = await client.post("/api/documents", {
      name: "c.pdf",
      mime: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4\n% another synthetic file\n%%EOF").toString("base64"),
      folder: "Contracts / Boat",
      kind: "contract",
      accountId: null,
    });
    expect(c.json<DocumentInfo>()).toMatchObject({ kind: "contract", folder: "Contracts / Boat" });

    // Only an empty folder can go.
    await client.post("/api/documents/folders", { path: "Loans / Seaview / Letters" });
    expect(
      (await client.delete("/api/documents/folders?path=Loans%20%2F%20Seaview")).statusCode,
    ).toBe(409);
    const gone = await client.delete("/api/documents/folders?path=Home%20%2F%20Insurance");
    expect(gone.json()).toEqual({ folders: ["Loans / Seaview / Letters"] });
  });
});
