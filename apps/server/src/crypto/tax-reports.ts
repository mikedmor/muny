import { FIAT, fromFixed, type Gain, toFixed, valueCents } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoTaxDoc, CryptoTaxReportKind } from "@muny/shared";
import { and, eq } from "drizzle-orm";
import { decryptBytes, encryptBytes } from "../lib/crypto.js";
import { getCryptoSettings } from "./prices.js";
import { runLedger } from "./tax.js";

/**
 * A tax year's crypto reports as CSV (Koinly's report menu), from the tax
 * ledger, plus the exchanges' 1099-DA forms (stored encrypted). Read-only
 * except for the forms. Not tax advice: figures for tax software or an
 * accountant.
 */

const d = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString().slice(0, 10));
const usd = (cents: number | null) =>
  cents === null
    ? ""
    : `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
/** One CSV cell; text that a spreadsheet would run as a formula is defused. */
const cell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s)) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (head: string[], rows: (string | number | null)[][]) =>
  `${[head, ...rows].map((r) => r.map(cell).join(",")).join("\n")}\n`;

const yearBounds = (year: number) => ({
  start: Date.UTC(year, 0, 1),
  end: Date.UTC(year + 1, 0, 1),
});

/** Form 8949 box for a sale: from the exchange's 1099-DA for that year, if any. */
function boxFor(g: Gain, docs: Map<string, boolean>): string {
  const long = g.term === "long";
  const reported = g.walletId ? docs.get(g.walletId) : undefined;
  if (reported === true) return long ? "J" : "G";
  if (reported === false) return long ? "K" : "H";
  return long ? "L" : "I";
}

export function cryptoTaxCsv(db: MunyDb, year: number, kind: CryptoTaxReportKind): string {
  const { start, end } = yearBounds(year);
  const inYear = (at: number) => at >= start && at < end;
  const names = new Map(
    db
      .select({ id: schema.cryptoWallets.id, name: schema.cryptoWallets.name })
      .from(schema.cryptoWallets)
      .all()
      .map((w) => [w.id, w.name]),
  );
  const wallet = (id: string | null) => (id ? (names.get(id) ?? "") : "");

  if (kind === "holdings-start" || kind === "holdings-end") {
    const at = kind === "holdings-start" ? start : end;
    const { lots, priceOn } = runLedger(db, at);
    const hidden = new Set(getCryptoSettings(db).hiddenAssets);
    const rows: (string | number | null)[][] = [];
    for (const [asset, q] of lots) {
      if (hidden.has(asset) || FIAT.has(asset)) continue;
      const amount = q.reduce((s, l) => s + l.amount, 0n);
      if (amount <= 0n) continue;
      const price = priceOn(asset, at - 1);
      const cost = Number(q.reduce((s, l) => s + l.cost, 0n));
      rows.push([
        asset,
        fromFixed(amount),
        usd(cost),
        price ?? "",
        price ? usd(valueCents(fromFixed(amount), price)) : "",
      ]);
    }
    return csv(
      ["Asset", "Amount", "Cost basis (USD)", `Price on ${d(at - 1)} (USD)`, "Value (USD)"],
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  }

  const { rows, gains, flows, priceOn } = runLedger(db);
  if (kind === "capital-gains" || kind === "form-8949") {
    const docs = new Map(
      db
        .select({ w: schema.cryptoTaxDocs.walletId, b: schema.cryptoTaxDocs.basisReported })
        .from(schema.cryptoTaxDocs)
        .where(eq(schema.cryptoTaxDocs.year, year))
        .all()
        .map((x) => [x.w, x.b]),
    );
    const sales = gains.filter((g) => inYear(g.at) && g.kind !== "lost");
    if (kind === "capital-gains")
      return csv(
        [
          "Date sold",
          "Date acquired",
          "Asset",
          "Amount",
          "Proceeds (USD)",
          "Cost basis (USD)",
          "Gain (USD)",
          "Term",
          "Kind",
          "Wallet",
          "Missing cost",
        ],
        sales.map((g) => [
          d(g.at),
          g.acquiredAt !== null && g.acquiredAt === g.acquiredLast
            ? d(g.acquiredAt)
            : g.acquiredAt === null
              ? ""
              : "Various",
          g.asset,
          g.amount,
          usd(g.proceedsCents),
          usd(g.costCents),
          usd(g.gainCents),
          g.term === "long" ? "Long term" : "Short term",
          g.kind,
          wallet(g.walletId),
          g.missingCost ? "yes" : "",
        ]),
      );
    const lines = sales
      .map((g) => ({ g, box: boxFor(g, docs) }))
      .sort((a, b) =>
        a.g.term === b.g.term
          ? a.box.localeCompare(b.box) || a.g.at - b.g.at
          : a.g.term === "short"
            ? -1
            : 1,
      );
    return csv(
      [
        "Part",
        "Box",
        "(a) Description",
        "(b) Date acquired",
        "(c) Date sold or disposed of",
        "(d) Proceeds",
        "(e) Cost or other basis",
        "(h) Gain or (loss)",
      ],
      lines.map(({ g, box }) => [
        g.term === "long" ? "II (long term)" : "I (short term)",
        box,
        `${g.amount} ${g.asset}`,
        g.acquiredAt === null ? "" : g.acquiredAt === g.acquiredLast ? d(g.acquiredAt) : "VARIOUS",
        d(g.at),
        usd(g.proceedsCents),
        usd(g.costCents),
        usd(g.gainCents),
      ]),
    );
  }
  if (kind === "income" || kind === "expenses" || kind === "gifts") {
    const want = kind === "income" ? "income" : kind === "expenses" ? "expense" : "gift";
    return csv(
      ["Date", "Asset", "Amount", "Value (USD)", "Tag", "Wallet"],
      flows
        .filter((f) => f.kind === want && inYear(f.at))
        .map((f) => [
          d(f.at),
          f.asset,
          f.amount,
          usd(f.valueCents),
          f.label ?? "",
          wallet(f.walletId),
        ]),
    );
  }
  if (kind === "balances") {
    const bal = new Map<string, bigint>();
    for (const r of rows) {
      if (r.at >= end) continue;
      const add = (a: string | null, n: string | null, sign: 1n | -1n) => {
        if (!a || !n) return;
        const k = `${r.walletId}|${a}`;
        bal.set(k, (bal.get(k) ?? 0n) + sign * toFixed(n));
      };
      add(r.receivedAsset, r.receivedAmount, 1n);
      add(r.sentAsset, r.sentAmount, -1n);
      add(r.feeAsset, r.feeAmount, -1n);
    }
    const out: (string | number | null)[][] = [];
    for (const [k, v] of bal) {
      if (v === 0n) continue;
      const [w, a] = k.split("|") as [string, string];
      const price = FIAT.has(a) ? "1" : priceOn(a, end - 1);
      out.push([wallet(w), a, fromFixed(v), price ? usd(valueCents(fromFixed(v), price)) : ""]);
    }
    return csv(
      ["Wallet", "Asset", `Balance on ${d(end - 1)}`, "Value (USD)"],
      out.sort((x, y) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`)),
    );
  }
  // Transaction history.
  return csv(
    [
      "Date",
      "Type",
      "Tag",
      "Wallet",
      "Sent",
      "Sent asset",
      "Received",
      "Received asset",
      "Fee",
      "Fee asset",
      "Value (USD)",
      "Transaction hash",
      "Notes",
    ],
    rows
      .filter((r) => inYear(r.at))
      .sort((a, b) => a.at - b.at)
      .map((r) => [
        new Date(r.at).toISOString(),
        r.type,
        r.label ?? "",
        wallet(r.walletId),
        r.sentAmount,
        r.sentAsset,
        r.receivedAmount,
        r.receivedAsset,
        r.feeAmount,
        r.feeAsset,
        usd(r.valueCents),
        r.txHash,
        r.description,
      ]),
  );
}

// ---- 1099-DA forms ------------------------------------------------------------

const MAX_DOC = 10 * 1024 * 1024;

export function listTaxDocs(db: MunyDb, year: number): CryptoTaxDoc[] {
  return db
    .select({
      id: schema.cryptoTaxDocs.id,
      walletId: schema.cryptoTaxDocs.walletId,
      year: schema.cryptoTaxDocs.year,
      filename: schema.cryptoTaxDocs.filename,
      size: schema.cryptoTaxDocs.size,
      basisReported: schema.cryptoTaxDocs.basisReported,
      uploadedAt: schema.cryptoTaxDocs.uploadedAt,
    })
    .from(schema.cryptoTaxDocs)
    .where(eq(schema.cryptoTaxDocs.year, year))
    .all();
}

export function saveTaxDoc(
  db: MunyDb,
  secret: Buffer | undefined,
  input: {
    walletId: string;
    year: number;
    filename: string;
    contentType: string;
    base64: string;
    basisReported: boolean;
  },
) {
  if (!secret) throw new Error("Set MUNY_SECRET_KEY first: tax forms are stored encrypted.");
  const data = Buffer.from(input.base64, "base64");
  if (!data.length) throw new Error("The file is empty");
  if (data.length > MAX_DOC) throw new Error("The file is larger than 10 MB");
  const pdf = data.subarray(0, 5).toString("latin1") === "%PDF-";
  const image = /^image\/(png|jpeg)$/.test(input.contentType);
  if (!pdf && !image) throw new Error("Upload the form as a PDF (or a PNG/JPEG photo)");
  const id = newId();
  db.insert(schema.cryptoTaxDocs)
    .values({
      id,
      walletId: input.walletId,
      year: input.year,
      filename: input.filename.replace(/[^\w .()-]/g, "_").slice(0, 120) || "1099-DA.pdf",
      contentType: pdf ? "application/pdf" : input.contentType,
      size: data.length,
      basisReported: input.basisReported,
      data: encryptBytes(secret, data),
      uploadedAt: Date.now(),
    })
    .run();
  return { id };
}

export function readTaxDoc(db: MunyDb, secret: Buffer | undefined, id: string) {
  if (!secret) throw new Error("MUNY_SECRET_KEY is not set");
  const r = db.select().from(schema.cryptoTaxDocs).where(eq(schema.cryptoTaxDocs.id, id)).get();
  if (!r) return null;
  return { filename: r.filename, contentType: r.contentType, body: decryptBytes(secret, r.data) };
}

export function updateTaxDoc(db: MunyDb, id: string, basisReported: boolean) {
  return db
    .update(schema.cryptoTaxDocs)
    .set({ basisReported })
    .where(eq(schema.cryptoTaxDocs.id, id))
    .run().changes;
}

export function deleteTaxDoc(db: MunyDb, id: string) {
  return db
    .delete(schema.cryptoTaxDocs)
    .where(and(eq(schema.cryptoTaxDocs.id, id)))
    .run().changes;
}

// ---------------------------------------------------------------------------
// Exchanges you've marked as not sending a 1099-DA for a year (to-do list only;
// sales with no form already go in Form 8949 box I/L).
// ---------------------------------------------------------------------------

const NOT_RECEIVED_KEY = "crypto.taxdocs.notReceived";

function notReceivedAll(db: MunyDb): Record<string, string[]> {
  return (
    (db
      .select({ value: schema.appSettings.value })
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, NOT_RECEIVED_KEY))
      .get()?.value as Record<string, string[]> | undefined) ?? {}
  );
}

export function listNotReceived(db: MunyDb, year: number): string[] {
  return notReceivedAll(db)[String(year)] ?? [];
}

export function setNotReceived(db: MunyDb, year: number, walletId: string, on: boolean): string[] {
  const all = notReceivedAll(db);
  const cur = new Set(all[String(year)] ?? []);
  if (on) cur.add(walletId);
  else cur.delete(walletId);
  all[String(year)] = [...cur];
  db.insert(schema.appSettings)
    .values({ key: NOT_RECEIVED_KEY, value: all })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: all } })
    .run();
  return all[String(year)] ?? [];
}
