import { createHash } from "node:crypto";
import { type MunyDb, newId, schema } from "@muny/db";
import { CRYPTO_TAX_REPORTS, type DocumentInfo } from "@muny/shared";
import { desc, eq, sql } from "drizzle-orm";
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

/** Statements file themselves by where they came from; uploads go where you put them. */
function folderOf(r: typeof schema.documents.$inferSelect) {
  if (r.kind === "loan_statement") return `Loans / ${r.lender ?? "Statements"}`;
  if (r.kind === "card_statement") return `Credit cards / ${r.lender ?? "Statements"}`;
  return r.folder?.trim() || "Uploads";
}

const info = (r: typeof schema.documents.$inferSelect): DocumentInfo => ({
  id: r.id,
  kind: r.kind,
  folder: folderOf(r),
  href: `/api/documents/${r.id}/file`,
  downloadHref: `/api/documents/${r.id}/file?download=1`,
  stored: true,
  name: r.name,
  mime: r.mime,
  sizeBytes: r.sizeBytes,
  lender: r.lender,
  documentDate: r.documentDate,
  notes: r.notes,
  createdAt: r.createdAt.getTime(),
});

/** Tax forms kept with Crypto, and the tax reports Muny makes, for each year with data. */
function taxDocuments(db: MunyDb): DocumentInfo[] {
  const out: DocumentInfo[] = [];
  const wallet = new Map(
    db
      .select({ id: schema.cryptoWallets.id, name: schema.cryptoWallets.name })
      .from(schema.cryptoWallets)
      .all()
      .map((w) => [w.id, w.name]),
  );
  for (const d of db
    .select({
      id: schema.cryptoTaxDocs.id,
      walletId: schema.cryptoTaxDocs.walletId,
      year: schema.cryptoTaxDocs.year,
      kind: schema.cryptoTaxDocs.kind,
      filename: schema.cryptoTaxDocs.filename,
      contentType: schema.cryptoTaxDocs.contentType,
      size: schema.cryptoTaxDocs.size,
      uploadedAt: schema.cryptoTaxDocs.uploadedAt,
    })
    .from(schema.cryptoTaxDocs)
    .all())
    out.push({
      id: `taxdoc:${d.id}`,
      kind: "tax_form",
      folder: `Taxes / ${d.year} / Forms`,
      href: `/api/crypto/tax/docs/${d.id}/file`,
      downloadHref: `/api/crypto/tax/docs/${d.id}/file`,
      stored: false,
      name: d.filename,
      mime: d.contentType,
      sizeBytes: d.size,
      lender: wallet.get(d.walletId) ?? null,
      documentDate: `${d.year}-12-31`,
      notes: `${d.kind} from ${wallet.get(d.walletId) ?? "an exchange"}`,
      createdAt: d.uploadedAt,
    });
  const yearsOf = (rows: { y: string | number | null }[]) =>
    rows.map((r) => Number(r.y)).filter((y) => Number.isInteger(y) && y > 1990);
  const thisYear = new Date().getFullYear();
  const txnYears = yearsOf(
    db
      .select({ y: sql<string>`distinct substr(${schema.transactions.postedDate}, 1, 4)` })
      .from(schema.transactions)
      .all(),
  );
  const cryptoYears = yearsOf(
    db
      .select({
        y: sql<string>`distinct strftime('%Y', ${schema.cryptoTxns.at} / 1000, 'unixepoch')`,
      })
      .from(schema.cryptoTxns)
      .all(),
  );
  const report = (year: number, key: string, name: string, href: string, notes: string) => ({
    id: `report:${key}`,
    kind: "report" as const,
    folder: `Taxes / ${year} / Reports`,
    href,
    downloadHref: href,
    stored: false,
    name,
    mime: "text/csv",
    sizeBytes: 0,
    lender: null,
    documentDate: year === thisYear ? null : `${year}-12-31`,
    notes,
    createdAt: Date.now(),
  });
  for (const y of txnYears)
    out.push(
      report(
        y,
        `tax-${y}`,
        `Tax summary ${y}.csv`,
        `/api/tax/${y}/export.csv`,
        "Made from your transactions when you open it",
      ),
    );
  for (const y of cryptoYears)
    for (const [kind, label] of CRYPTO_TAX_REPORTS)
      out.push(
        report(
          y,
          `crypto-${kind}-${y}`,
          `Crypto ${label.toLowerCase()} ${y}.csv`,
          `/api/crypto/tax/${y}/report/${kind}`,
          "Made from your crypto history when you open it",
        ),
      );
  return out;
}

export function listDocuments(db: MunyDb): DocumentInfo[] {
  return [
    ...db.select().from(schema.documents).orderBy(desc(schema.documents.createdAt)).all().map(info),
    ...taxDocuments(db),
  ].sort(
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
    kind?: "loan_statement" | "card_statement" | "other";
    lender?: string | null;
    documentDate?: string | null;
    notes?: string | null;
    folder?: string | null;
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
    folder: input.folder?.trim() || null,
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
  patch: {
    name?: string;
    notes?: string | null;
    documentDate?: string | null;
    folder?: string | null;
  },
) {
  return (
    db.update(schema.documents).set(patch).where(eq(schema.documents.id, id)).run().changes > 0
  );
}

export function deleteDocument(db: MunyDb, id: string) {
  return db.delete(schema.documents).where(eq(schema.documents.id, id)).run().changes > 0;
}
