import { createHash } from "node:crypto";
import { type MunyDb, newId, schema } from "@muny/db";
import type { DocumentInfo } from "@muny/shared";
import { desc, eq } from "drizzle-orm";
import { decryptBytes, encryptBytes } from "../lib/crypto.js";

/**
 * Documents kept in Muny: loan statements (saved when imported) and files you
 * upload. Stored in the database (so backups include them), encrypted with
 * MUNY_SECRET_KEY when it's set. The same file is kept once.
 */

export const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

const info = (r: typeof schema.documents.$inferSelect): DocumentInfo => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  mime: r.mime,
  sizeBytes: r.sizeBytes,
  lender: r.lender,
  documentDate: r.documentDate,
  notes: r.notes,
  createdAt: r.createdAt.getTime(),
});

export function listDocuments(db: MunyDb): DocumentInfo[] {
  return db
    .select()
    .from(schema.documents)
    .orderBy(desc(schema.documents.createdAt))
    .all()
    .map(info)
    .sort(
      (a, b) =>
        (b.documentDate ?? "").localeCompare(a.documentDate ?? "") || b.createdAt - a.createdAt,
    );
}

/** Keep a file (or update the details of the same file kept before). */
export function saveDocument(
  db: MunyDb,
  secret: Buffer | undefined,
  input: {
    name: string;
    mime: string;
    bytes: Buffer;
    kind?: "loan_statement" | "other";
    lender?: string | null;
    documentDate?: string | null;
    notes?: string | null;
  },
): DocumentInfo {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  // A safe file name: no path or reserved characters, no control characters.
  const name =
    [...input.name]
      .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
      .join("")
      .slice(0, 120) || "document";
  const existing = db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.sha256, sha256))
    .get();
  if (existing) {
    const patch = {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.lender ? { lender: input.lender } : {}),
      ...(input.documentDate ? { documentDate: input.documentDate } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };
    if (Object.keys(patch).length)
      db.update(schema.documents).set(patch).where(eq(schema.documents.id, existing.id)).run();
    return info({ ...existing, ...patch });
  }
  const row = {
    id: newId(),
    kind: input.kind ?? ("other" as const),
    name,
    mime: input.mime,
    sizeBytes: input.bytes.length,
    sha256,
    lender: input.lender ?? null,
    documentDate: input.documentDate ?? null,
    notes: input.notes ?? null,
    encrypted: !!secret,
    data: secret ? encryptBytes(secret, input.bytes) : input.bytes,
  };
  db.insert(schema.documents).values(row).run();
  return info({ ...row, createdAt: new Date() });
}

export function readDocument(
  db: MunyDb,
  secret: Buffer | undefined,
  id: string,
): { info: DocumentInfo; bytes: Buffer } | null {
  const r = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
  if (!r) return null;
  if (r.encrypted && !secret) throw new Error("MUNY_SECRET_KEY is needed to open this document.");
  return { info: info(r), bytes: r.encrypted && secret ? decryptBytes(secret, r.data) : r.data };
}

export function updateDocument(
  db: MunyDb,
  id: string,
  patch: { name?: string; notes?: string | null; documentDate?: string | null },
) {
  return (
    db.update(schema.documents).set(patch).where(eq(schema.documents.id, id)).run().changes > 0
  );
}

export function deleteDocument(db: MunyDb, id: string) {
  return db.delete(schema.documents).where(eq(schema.documents.id, id)).run().changes > 0;
}
