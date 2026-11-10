import { createHash } from "node:crypto";
import { type MunyDb, newId, schema } from "@muny/db";
import { CRYPTO_TAX_REPORTS, type DocumentInfo } from "@muny/shared";
import { desc, eq, getTableColumns, sql } from "drizzle-orm";
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

type DocumentRow = Omit<typeof schema.documents.$inferSelect, "data">;

/** Everything about a document but the file, so listing doesn't load every PDF. */
const { data: _file, ...withoutFile } = getTableColumns(schema.documents);

/** Statements file themselves by where they came from; uploads go where you put them. */
function folderOf(r: DocumentRow) {
  if (r.kind === "loan_statement") return `Loans / ${r.lender ?? "Statements"}`;
  if (r.kind === "card_statement") return `Credit cards / ${r.lender ?? "Statements"}`;
  if (r.kind === "contract") return r.folder?.trim() || "Contracts";
  return r.folder?.trim() || "Uploads";
}

const info = (r: DocumentRow): DocumentInfo => ({
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
  accountId: r.accountId,
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
      accountId: null,
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
    accountId: null,
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

const FOLDERS_KEY = "documents.folders";
const MAX_FOLDERS = 500;

/** "Home/ Insurance " -> "Home / Insurance": the form folders are kept in. */
export const cleanFolder = (s: string) =>
  s
    .split("/")
    .map((p) => p.replace(/\p{Cc}/gu, "").trim())
    .filter(Boolean)
    .join(" / ");

/** Folders you made, kept even while they're empty. */
export function documentFolders(db: MunyDb): string[] {
  const row = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, FOLDERS_KEY))
    .get();
  return Array.isArray(row?.value)
    ? (row.value as unknown[]).filter((v) => typeof v === "string")
    : [];
}

function saveFolders(db: MunyDb, folders: string[]) {
  const value = [...new Set(folders)].sort((a, b) => a.localeCompare(b));
  db.insert(schema.appSettings)
    .values({ key: FOLDERS_KEY, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
  return value;
}

const inside = (folder: string, path: string) => folder === path || folder.startsWith(`${path} /`);

export function addFolder(db: MunyDb, path: string): string[] {
  const now = documentFolders(db);
  if (now.length >= MAX_FOLDERS) throw new Error("That's as many folders as Muny keeps.");
  return now.includes(path) ? now : saveFolders(db, [...now, path]);
}

/** Forget a folder and the ones inside it. False if documents are still in it. */
export function removeFolder(db: MunyDb, path: string): string[] | null {
  if (listDocuments(db).some((d) => inside(d.folder, path))) return null;
  return saveFolders(
    db,
    documentFolders(db).filter((f) => !inside(f, path)),
  );
}

export function listDocuments(db: MunyDb): DocumentInfo[] {
  const reviews = new Map(
    db
      .select({ id: schema.documentReviews.documentId, status: schema.documentReviews.status })
      .from(schema.documentReviews)
      .all()
      .map((r) => [r.id, r.status]),
  );
  return [
    ...db
      .select(withoutFile)
      .from(schema.documents)
      .orderBy(desc(schema.documents.createdAt))
      .all()
      .map((r) => ({ ...info(r), review: reviews.get(r.id) })),
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
    kind?: "loan_statement" | "card_statement" | "contract" | "other";
    lender?: string | null;
    documentDate?: string | null;
    notes?: string | null;
    folder?: string | null;
    accountId?: string | null;
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
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.folder ? { folder: input.folder } : {}),
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
    accountId: input.accountId ?? null,
    encrypted: !!secret,
    data: secret ? encryptBytes(secret, input.bytes) : input.bytes,
  };
  db.insert(schema.documents).values(row).run();
  return info({ ...row, createdAt: new Date() });
}

/** A document's details, without opening the file. */
export function documentInfo(db: MunyDb, id: string): DocumentInfo | null {
  const r = db.select(withoutFile).from(schema.documents).where(eq(schema.documents.id, id)).get();
  return r ? info(r) : null;
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
