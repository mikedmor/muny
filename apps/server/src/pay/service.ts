import {
  employerKey,
  latestPeriod,
  payBreakdown,
  readAdpStub,
  readW2,
  stubProblems,
  w2Check,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  PayDeposit,
  PayLine,
  PayStubInfo,
  PayStubRead,
  PayUploadResult,
  PayYear,
  W2Boxes,
  W2Info,
  W2Read,
} from "@muny/shared";
import { and, eq, getTableColumns, gte, lte, sql } from "drizzle-orm";
import { decryptBytes, encryptBytes } from "../lib/crypto.js";
import { pdfItems } from "../loans/statements.js";

/**
 * Pay (D-093): pay stubs and W-2s you upload, read into gross pay, taxes,
 * deductions and where net pay went. Files are kept encrypted; only the
 * numbers, line names and an account's last 4 digits are stored in the clear.
 * Deposits are matched to bank transactions when the year is shown.
 */

const MAX_FILE = 10 * 1024 * 1024;

export class PayError extends Error {}

/** Everything but the file, so listing doesn't decrypt or load PDFs. */
const { data: _stubFile, size: _stubSize, ...stubCols } = getTableColumns(schema.payStubs);

type StubRow = {
  id: string;
  employer: string | null;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  grossCents: number;
  netCents: number;
  ytdGrossCents: number | null;
  federalTaxableCents: number | null;
  lines: unknown[];
  deposits: unknown[];
  checkCents: number;
  filename: string;
  uploadedAt: number;
};

const asRead = (r: StubRow): PayStubRead => ({
  employer: r.employer,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  payDate: r.payDate,
  grossCents: r.grossCents,
  netCents: r.netCents,
  ytdGrossCents: r.ytdGrossCents,
  federalTaxableCents: r.federalTaxableCents,
  lines: r.lines as PayLine[],
  deposits: r.deposits as PayStubRead["deposits"],
  checkCents: r.checkCents,
});

const w2Cols = {
  id: schema.w2Forms.id,
  year: schema.w2Forms.year,
  employer: schema.w2Forms.employer,
  boxes: schema.w2Forms.boxes,
  box12: schema.w2Forms.box12,
  summary: schema.w2Forms.summary,
  filename: schema.w2Forms.filename,
  uploadedAt: schema.w2Forms.uploadedAt,
};

type W2Row = {
  id: string;
  year: number;
  employer: string | null;
  boxes: Record<string, unknown>;
  box12: unknown[];
  summary: Record<string, unknown>;
  filename: string;
  uploadedAt: number;
};

const asW2 = (r: W2Row): W2Read => ({
  year: r.year,
  employer: r.employer,
  boxes: r.boxes as unknown as W2Boxes,
  box12: r.box12 as W2Read["box12"],
  summary: r.summary as unknown as W2Read["summary"],
});

const niceDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const cleanName = (s: string) => s.replace(/[^\w .()-]/g, "_").slice(0, 120) || "document.pdf";

/**
 * Read an uploaded PDF: one or more ADP pay stubs (a page each), or a W-2.
 * Stubs or W-2s already added are skipped; nothing new is an error.
 */
export async function uploadPayDocument(
  db: MunyDb,
  secret: Buffer | undefined,
  input: { filename: string; base64: string },
): Promise<PayUploadResult[]> {
  if (!secret)
    throw new PayError("Set MUNY_SECRET_KEY first: pay stubs and W-2s are stored encrypted.");
  const data = Buffer.from(input.base64, "base64");
  if (!data.length) throw new PayError("The file is empty.");
  if (data.length > MAX_FILE) throw new PayError("The file is larger than 10 MB.");
  if (data.subarray(0, 5).toString("latin1") !== "%PDF-")
    throw new PayError("Upload the PDF you downloaded from your payroll site.");
  let pages: Awaited<ReturnType<typeof pdfItems>>;
  try {
    pages = await pdfItems(new Uint8Array(data));
  } catch {
    throw new PayError("Muny couldn't open that PDF.");
  }
  if (!pages.some((p) => p.length))
    throw new PayError(
      "This PDF has no text (it may be a scan). Download it from your payroll site instead.",
    );

  const filename = cleanName(input.filename);
  const stored = encryptBytes(secret, data);
  const now = Date.now();
  const stubs = pages.map((p) => readAdpStub(p)).filter((s): s is PayStubRead => !!s);
  if (stubs.length) {
    const out: PayUploadResult[] = [];
    const skipped: string[] = [];
    for (const s of stubs) {
      const same = db
        .select({ id: schema.payStubs.id, employer: schema.payStubs.employer })
        .from(schema.payStubs)
        .where(
          and(
            eq(schema.payStubs.payDate, s.payDate),
            eq(schema.payStubs.grossCents, s.grossCents),
            eq(schema.payStubs.netCents, s.netCents),
          ),
        )
        .all()
        .some((r) => employerKey(r.employer) === employerKey(s.employer));
      if (same) {
        skipped.push(niceDate(s.payDate));
        continue;
      }
      const id = newId();
      db.insert(schema.payStubs)
        .values({
          id,
          employer: s.employer,
          payDate: s.payDate,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          grossCents: s.grossCents,
          netCents: s.netCents,
          ytdGrossCents: s.ytdGrossCents,
          federalTaxableCents: s.federalTaxableCents,
          lines: s.lines,
          deposits: s.deposits,
          checkCents: s.checkCents,
          filename,
          size: data.length,
          data: stored,
          uploadedAt: now,
        })
        .run();
      out.push({
        kind: "stub",
        id,
        label: `Pay stub for ${niceDate(s.payDate)}`,
        problems: stubProblems(s),
      });
    }
    if (!out.length)
      throw new PayError(
        `You already added the pay stub${skipped.length > 1 ? "s" : ""} for ${skipped.join(", ")}.`,
      );
    return out;
  }

  const w2 = pages.map((p) => readW2(p)).find((w): w is W2Read => !!w);
  if (w2) {
    const dup = db
      .select({ employer: schema.w2Forms.employer, boxes: schema.w2Forms.boxes })
      .from(schema.w2Forms)
      .where(eq(schema.w2Forms.year, w2.year))
      .all()
      .some(
        (r) =>
          employerKey(r.employer) === employerKey(w2.employer) &&
          (r.boxes as unknown as W2Boxes).wagesCents === w2.boxes.wagesCents,
      );
    if (dup) throw new PayError(`You already added this ${w2.year} W-2.`);
    const id = newId();
    db.insert(schema.w2Forms)
      .values({
        id,
        year: w2.year,
        employer: w2.employer,
        boxes: w2.boxes as unknown as Record<string, unknown>,
        box12: w2.box12,
        summary: w2.summary as unknown as Record<string, unknown>,
        filename,
        size: data.length,
        data: stored,
        uploadedAt: now,
      })
      .run();
    return [{ kind: "w2", id, label: `${w2.year} W-2`, problems: [] }];
  }

  throw new PayError(
    "Muny reads ADP earnings statements and W-2s, and this doesn't look like either.",
  );
}

const shift = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

/**
 * The bank deposit each part of net pay became: the same amount, into an
 * account ending in the same 4 digits when Muny knows them, within a few days
 * of the pay date. Each transaction is used once, closest date first.
 */
function matchDeposits(db: MunyDb, stubs: StubRow[]): Map<string, PayDeposit[]> {
  const out = new Map<string, PayDeposit[]>();
  if (!stubs.length) return out;
  const dates = stubs.map((s) => s.payDate).sort();
  const t = schema.transactions;
  const candidates = db
    .select({
      id: t.id,
      date: t.postedDate,
      cents: t.amountCents,
      accountName: schema.accounts.name,
      mask: schema.accounts.mask,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .where(
      and(
        gte(t.postedDate, shift(dates[0] as string, -4)),
        lte(t.postedDate, shift(dates[dates.length - 1] as string, 6)),
        sql`${t.amountCents} > 0`,
      ),
    )
    .all();
  const used = new Set<string>();
  for (const s of [...stubs].sort((a, b) => a.payDate.localeCompare(b.payDate))) {
    const lo = shift(s.payDate, -4);
    const hi = shift(s.payDate, 6);
    const days = (d: string) => Math.abs(Date.parse(d) - Date.parse(s.payDate));
    out.set(
      s.id,
      (s.deposits as PayStubRead["deposits"]).map((d) => {
        const fits = candidates
          .filter((c) => !used.has(c.id) && c.cents === d.cents && c.date >= lo && c.date <= hi)
          .filter((c) => !d.last4 || !c.mask || c.mask.slice(-4) === d.last4)
          .sort((a, b) => {
            const masked = Number(!!(d.last4 && b.mask)) - Number(!!(d.last4 && a.mask));
            return masked || days(a.date) - days(b.date);
          });
        const hit = fits[0];
        if (hit) used.add(hit.id);
        return {
          cents: d.cents,
          last4: d.last4,
          transaction: hit ? { id: hit.id, date: hit.date, accountName: hit.accountName } : null,
        };
      }),
    );
  }
  return out;
}

export function payYears(db: MunyDb): number[] {
  const stubYears = db
    .select({ y: sql<string>`distinct substr(${schema.payStubs.payDate}, 1, 4)` })
    .from(schema.payStubs)
    .all()
    .map((r) => Number(r.y));
  const w2Years = db
    .select({ y: schema.w2Forms.year })
    .from(schema.w2Forms)
    .all()
    .map((r) => r.y);
  return [...new Set([...stubYears, ...w2Years])].filter(Number.isInteger).sort((a, b) => b - a);
}

/** Everything the Pay page shows for a year. */
export function payYear(db: MunyDb, year: number): PayYear {
  const stubRows = db
    .select(stubCols)
    .from(schema.payStubs)
    .where(sql`substr(${schema.payStubs.payDate}, 1, 4) = ${String(year)}`)
    .all() as StubRow[];
  const reads = stubRows.map(asRead);
  const w2Rows = db
    .select(w2Cols)
    .from(schema.w2Forms)
    .where(eq(schema.w2Forms.year, year))
    .all() as W2Row[];
  const deposits = matchDeposits(db, stubRows);
  const stubs: PayStubInfo[] = stubRows
    .map((r, n) => ({
      ...(reads[n] as PayStubRead),
      id: r.id,
      filename: r.filename,
      uploadedAt: r.uploadedAt,
      deposits: deposits.get(r.id) ?? [],
      problems: stubProblems(reads[n] as PayStubRead),
    }))
    .sort((a, b) => b.payDate.localeCompare(a.payDate));
  const w2s: W2Info[] = w2Rows.map((r) => {
    const w = asW2(r);
    return {
      ...w,
      id: r.id,
      filename: r.filename,
      uploadedAt: r.uploadedAt,
      check: w2Check(w, reads),
    };
  });
  return {
    year,
    years: payYears(db),
    breakdown: payBreakdown(year, reads, w2Rows.map(asW2)),
    latest: latestPeriod(reads),
    stubs,
    w2s,
  };
}

export function readPayFile(
  db: MunyDb,
  secret: Buffer | undefined,
  kind: "stub" | "w2",
  id: string,
): { filename: string; body: Buffer } | null {
  if (!secret) throw new PayError("MUNY_SECRET_KEY is not set");
  const table = kind === "stub" ? schema.payStubs : schema.w2Forms;
  const r = db
    .select({ filename: table.filename, data: table.data })
    .from(table)
    .where(eq(table.id, id))
    .get();
  return r ? { filename: r.filename, body: decryptBytes(secret, r.data) } : null;
}

export function deletePayDocument(db: MunyDb, kind: "stub" | "w2", id: string): number {
  const table = kind === "stub" ? schema.payStubs : schema.w2Forms;
  return db.delete(table).where(eq(table.id, id)).run().changes;
}

/** Pay stubs and W-2s as entries on the Documents page. */
export function payDocumentList(db: MunyDb) {
  const stubs = db
    .select({
      id: schema.payStubs.id,
      payDate: schema.payStubs.payDate,
      employer: schema.payStubs.employer,
      filename: schema.payStubs.filename,
      size: schema.payStubs.size,
      uploadedAt: schema.payStubs.uploadedAt,
    })
    .from(schema.payStubs)
    .all();
  const w2s = db
    .select({
      id: schema.w2Forms.id,
      year: schema.w2Forms.year,
      employer: schema.w2Forms.employer,
      filename: schema.w2Forms.filename,
      size: schema.w2Forms.size,
      uploadedAt: schema.w2Forms.uploadedAt,
    })
    .from(schema.w2Forms)
    .all();
  return { stubs, w2s };
}
