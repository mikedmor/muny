import { parse1099bCsv, parseTxf, read1099bSummary, summarize1099b } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import {
  type B1099Doc,
  type B1099Sale,
  type B1099Summary,
  boxTerm,
  FORM_8949_BOXES,
  type Form8949Box,
} from "@muny/shared";
import { and, eq } from "drizzle-orm";
import { decryptBytes, encryptBytes } from "../lib/crypto.js";
import { pdfLines } from "../loans/statements.js";
import { munyTotals, salesFor } from "./tax.js";

/**
 * 1099-B forms (D-088). The file is kept encrypted; a TXF or CSV export is
 * read sale by sale, a PDF only for its summary totals (when they add up),
 * and you can type the totals in. Each form belongs to one brokerage account
 * and tax year, and is compared with what Muny worked out for the same.
 */

const MAX_DOC = 10 * 1024 * 1024;

export class DocError extends Error {}

function format(data: Buffer, contentType: string, filename: string): B1099Doc["format"] {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (/^image\/(png|jpeg)$/.test(contentType)) return "image";
  const text = data.toString("utf8");
  if (/\.txf$/i.test(filename) || /^\s*V0\d\d/.test(text)) return "txf";
  return "csv";
}

export async function saveB1099(
  db: MunyDb,
  secret: Buffer | undefined,
  input: { accountId: string; year: number; filename: string; contentType: string; base64: string },
): Promise<{ id: string }> {
  if (!secret) throw new DocError("Set MUNY_SECRET_KEY first: tax forms are stored encrypted.");
  const acct = db
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, input.accountId))
    .get();
  if (acct?.type !== "investment") throw new DocError("Choose one of your investment accounts.");
  const data = Buffer.from(input.base64, "base64");
  if (!data.length) throw new DocError("The file is empty.");
  if (data.length > MAX_DOC) throw new DocError("The file is larger than 10 MB.");
  const fmt = format(data, input.contentType, input.filename);
  let sales: B1099Sale[] = [];
  let summary: B1099Summary = {};
  let summarySource: "sales" | "read" | null = null;
  if (fmt === "txf" || fmt === "csv") {
    const text = data.toString("utf8");
    const read = fmt === "txf" ? parseTxf(text) : parse1099bCsv(text);
    if (!read)
      throw new DocError(
        fmt === "txf"
          ? "That isn't a TXF file Muny can read."
          : "Muny couldn't find the columns it needs (a sale date and proceeds). Upload the TXF download or the PDF instead.",
      );
    if (!read.length) throw new DocError("There are no sales in this file.");
    sales = read;
    summary = summarize1099b(read);
    summarySource = "sales";
  } else if (fmt === "pdf") {
    try {
      summary = read1099bSummary(await pdfLines(new Uint8Array(data)));
      summarySource = Object.keys(summary).length ? "read" : null;
    } catch {
      // A PDF Muny can't read is still worth keeping; the totals can be typed in.
    }
  }
  const id = newId();
  db.insert(schema.stockTaxDocs)
    .values({
      id,
      accountId: input.accountId,
      year: input.year,
      filename: input.filename.replace(/[^\w .()-]/g, "_").slice(0, 120) || "1099-B",
      contentType:
        fmt === "pdf" ? "application/pdf" : fmt === "image" ? input.contentType : "text/plain",
      format: fmt,
      size: data.length,
      data: encryptBytes(secret, data),
      sales,
      summary,
      summarySource,
      uploadedAt: Date.now(),
    })
    .run();
  return { id };
}

export function listB1099(db: MunyDb, year: number): B1099Doc[] {
  const d = schema.stockTaxDocs;
  const rows = db
    .select({
      id: d.id,
      accountId: d.accountId,
      accountName: schema.accounts.name,
      year: d.year,
      filename: d.filename,
      format: d.format,
      size: d.size,
      uploadedAt: d.uploadedAt,
      sales: d.sales,
      summary: d.summary,
      summarySource: d.summarySource,
    })
    .from(d)
    .leftJoin(schema.accounts, eq(schema.accounts.id, d.accountId))
    .where(eq(d.year, year))
    .all();
  const totals = new Map<string | null, ReturnType<typeof munyTotals>>();
  return rows.map((r) => {
    if (!totals.has(r.accountId)) totals.set(r.accountId, munyTotals(db, year, r.accountId));
    return {
      id: r.id,
      accountId: r.accountId,
      accountName: r.accountName ?? null,
      year: r.year,
      filename: r.filename,
      format: r.format,
      size: r.size,
      uploadedAt: r.uploadedAt,
      saleCount: (r.sales as unknown[]).length,
      summary: r.summary as B1099Summary,
      summarySource: r.summarySource,
      muny: totals.get(r.accountId) as ReturnType<typeof munyTotals>,
    };
  });
}

export function readB1099File(db: MunyDb, secret: Buffer | undefined, id: string) {
  if (!secret) throw new DocError("MUNY_SECRET_KEY is not set");
  const r = db.select().from(schema.stockTaxDocs).where(eq(schema.stockTaxDocs.id, id)).get();
  if (!r) return null;
  return { filename: r.filename, contentType: r.contentType, body: decryptBytes(secret, r.data) };
}

/** Type in (or correct) the totals per box; an empty summary clears them. */
export function setB1099Summary(db: MunyDb, id: string, summary: B1099Summary): number {
  const clean: B1099Summary = {};
  for (const box of [...FORM_8949_BOXES, "?"] as const) {
    const t = summary[box];
    if (!t) continue;
    clean[box] = {
      proceedsCents: t.proceedsCents,
      costCents: t.costCents,
      washCents: Math.abs(t.washCents),
      gainCents: t.gainCents,
      count: t.count,
    };
  }
  return db
    .update(schema.stockTaxDocs)
    .set({ summary: clean, summarySource: Object.keys(clean).length ? "entered" : null })
    .where(eq(schema.stockTaxDocs.id, id))
    .run().changes;
}

export function deleteB1099(db: MunyDb, id: string): number {
  return db.delete(schema.stockTaxDocs).where(eq(schema.stockTaxDocs.id, id)).run().changes;
}

const dollars = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const mdY = (iso: string | null) =>
  iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "";

/** A guess at the box for Muny's own sales: brokers report cost for shares bought since 2011. */
function munyBox(term: "short" | "long" | "unknown", acquired: string | null): Form8949Box | "?" {
  if (term === "unknown") return "?";
  const covered = !!acquired && acquired >= "2011-01-01";
  return term === "short" ? (covered ? "A" : "B") : covered ? "D" : "E";
}

/**
 * Form 8949 lines for a tax year, for tax software or an accountant. A
 * 1099-B read sale by sale (TXF or CSV) is used for its account; other
 * taxable accounts use Muny's own sales (marked as estimates).
 */
export function form8949Csv(db: MunyDb, year: number): string {
  const docs = db
    .select({ accountId: schema.stockTaxDocs.accountId, sales: schema.stockTaxDocs.sales })
    .from(schema.stockTaxDocs)
    .where(and(eq(schema.stockTaxDocs.year, year)))
    .all()
    .filter((d) => (d.sales as unknown[]).length > 0);
  const fromForm = new Set(docs.map((d) => d.accountId));
  const names = new Map(
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .all()
      .map((a) => [a.id, a.name]),
  );
  const lines: string[][] = [];
  for (const d of docs)
    for (const s of d.sales as B1099Sale[])
      lines.push([
        s.box === "?" ? "" : boxTerm(s.box) === "short" ? "I" : "II",
        s.box === "?" ? "" : s.box,
        s.description,
        s.acquired ? mdY(s.acquired) : "VARIOUS",
        mdY(s.sold),
        dollars(s.proceedsCents),
        s.costCents === null ? "" : dollars(s.costCents),
        s.washCents ? "W" : "",
        s.washCents ? dollars(s.washCents) : "",
        dollars(s.proceedsCents - (s.costCents ?? 0) + s.washCents),
        names.get(d.accountId ?? "") ?? "",
        "1099-B",
      ]);
  for (const s of salesFor(db, year)) {
    if (fromForm.has(s.accountId)) continue;
    const box = munyBox(s.term, s.acquired);
    lines.push([
      box === "?" ? "" : s.term === "short" ? "I" : "II",
      box === "?" ? "" : box,
      `${s.quantity} sh. ${s.symbol}`,
      s.acquired ? mdY(s.acquired) : "VARIOUS",
      mdY(s.date),
      dollars(s.proceedsCents),
      s.costCents === null ? "" : dollars(s.costCents),
      s.washCents ? "W" : "",
      s.washCents ? dollars(s.washCents) : "",
      s.costCents === null ? "" : dollars(s.proceedsCents - s.costCents + s.washCents),
      s.accountName,
      "Muny estimate",
    ]);
  }
  lines.sort((a, b) => `${a[0]}${a[1]}${a[4]}`.localeCompare(`${b[0]}${b[1]}${b[4]}`));
  return [
    [
      "Part",
      "Box",
      "Description",
      "Date acquired",
      "Date sold",
      "Proceeds",
      "Cost basis",
      "Adjustment code",
      "Adjustment",
      "Gain or loss",
      "Account",
      "Source",
    ],
    ...lines,
  ]
    .map((r) => r.map(csvCell).join(","))
    .join("\n");
}
