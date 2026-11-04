import { createHash } from "node:crypto";
import {
  isRocketMoneyCsv,
  normalizeDescription,
  type ParsedTransaction,
  type ParseResult,
  parseCsvRecords,
  parseRocketMoneyCsv,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  ImportCommitRequest,
  ImportFormat,
  ImportPreview,
  ImportPreviewAccount,
  ImportRequest,
  ImportResult,
} from "@muny/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { upsertPayee, upsertTag } from "../ledger/transactions.js";
import { badRequest } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function detectFormat(req: ImportRequest): ImportFormat {
  if (req.format) return req.format;
  const head = req.content.slice(0, 4000);
  if (/OFXHEADER|<OFX>/i.test(head)) return "ofx";
  const { headers } = parseCsvRecords(head.split(/\r?\n/)[0] ?? "");
  if (isRocketMoneyCsv(headers)) return "rocket_money";
  return "csv";
}

export function parseImport(req: ImportRequest): ParseResult {
  const format = detectFormat(req);
  switch (format) {
    case "rocket_money":
      return parseRocketMoneyCsv(req.content);
    default:
      throw badRequest(
        format === "csv"
          ? "This CSV format isn't supported yet. Rocket Money exports are supported; bank CSV/OFX import is coming next."
          : "OFX/QFX import is coming next.",
      );
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Rocket Money category names that map onto Muny defaults. */
const CATEGORY_ALIASES: Record<string, string> = {
  // Near-synonyms only. Broader Rocket Money categories (e.g. "Auto & Transport",
  // "Bills & Utilities") are kept as-is rather than squeezed into a narrower one.
  "internal transfers": "Internal Transfer",
  "savings transfer": "Savings",
  investment: "Investments",
  "credit card payments": "Credit Card Payment",
  income: "Other Income",
  paychecks: "Paycheck",
  reimbursement: "Refunds & Reimbursements",
  refunds: "Refunds & Reimbursements",
  shopping: "General Merchandise",
  "entertainment & rec.": "Entertainment",
  "software & tech": "Software & Apps",
  "family care": "Kids & Family",
  fees: "Fees & Charges",
  business: "Business Expenses",
  "home loan": "Rent & Mortgage",
  mortgage: "Rent & Mortgage",
  "loan payments": "Loan Payment",
  "restaurants & bars": "Dining & Drinks",
  "dining & drinks": "Dining & Drinks",
};

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function findMatchingAccount(
  existing: { id: string; name: string; institutionName: string | null; mask: string | null }[],
  a: { name: string; institutionName: string | null; mask: string | null },
) {
  // Same institution + last 4 is the strongest signal; then exact name (+institution).
  return (
    existing.find(
      (e) => a.mask && e.mask === a.mask && lc(e.institutionName) === lc(a.institutionName),
    ) ??
    existing.find(
      (e) =>
        lc(e.name) === lc(a.name) &&
        (!a.institutionName ||
          !e.institutionName ||
          lc(e.institutionName) === lc(a.institutionName)),
    ) ??
    null
  );
}

type CategoryIndex = Map<string, string>; // lowercased name -> id

function loadCategoryIndex(db: MunyDb): CategoryIndex {
  const idx: CategoryIndex = new Map();
  for (const c of db.select().from(schema.categories).all()) {
    if (!idx.has(lc(c.name))) idx.set(lc(c.name), c.id);
  }
  return idx;
}

function resolveCategoryName(idx: CategoryIndex, name: string): string | undefined {
  return idx.get(lc(name)) ?? idx.get(lc(CATEGORY_ALIASES[lc(name)]));
}

/**
 * Dedupe hash: account + date + amount + normalized description + the
 * occurrence number of that tuple within the file, so two identical $5
 * coffees on the same day both import, but re-importing the file doesn't.
 */
function computeHashes(
  txns: ParsedTransaction[],
  accountIdFor: (key: string) => string | undefined,
): (string | undefined)[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    const accountId = accountIdFor(t.accountKey);
    if (!accountId) return undefined;
    const base = [
      accountId,
      t.postedDate,
      t.amountCents,
      normalizeDescription(t.rawDescription),
    ].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
  });
}

function existingHashes(db: MunyDb, accountIds: string[]): Set<string> {
  if (accountIds.length === 0) return new Set();
  return new Set(
    db
      .select({ accountId: schema.transactions.accountId, h: schema.transactions.importHash })
      .from(schema.transactions)
      .where(inArray(schema.transactions.accountId, accountIds))
      .all()
      .map((r) => `${r.accountId}:${r.h}`),
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export function previewImport(db: MunyDb, req: ImportRequest): ImportPreview {
  const parsed = parseImport(req);
  const existing = db.select().from(schema.accounts).all();

  const accounts: ImportPreviewAccount[] = parsed.accounts.map((a) => {
    const txns = parsed.transactions.filter((t) => t.accountKey === a.key);
    const dates = txns.map((t) => t.postedDate).sort();
    const m = findMatchingAccount(existing, a);
    return {
      ...a,
      transactionCount: txns.length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      match: m ? { id: m.id, name: m.name } : null,
    };
  });

  const matchFor = new Map(accounts.map((a) => [a.key, a.match?.id]));
  const hashes = computeHashes(parsed.transactions, (k) => matchFor.get(k));
  const known = existingHashes(db, [
    ...new Set([...matchFor.values()].filter((x): x is string => !!x)),
  ]);
  const duplicateCount = parsed.transactions.filter((t, i) => {
    const h = hashes[i];
    const acc = matchFor.get(t.accountKey);
    return h && acc && known.has(`${acc}:${h}`);
  }).length;

  const idx = loadCategoryIndex(db);
  const newCategories = [
    ...new Set(
      parsed.transactions
        .map((t) => t.categoryName)
        .filter((c): c is string => !!c && !resolveCategoryName(idx, c)),
    ),
  ].sort();

  const dates = parsed.transactions.map((t) => t.postedDate).sort();
  return {
    format: parsed.format as ImportFormat,
    accounts,
    transactionCount: parsed.transactions.length,
    duplicateCount,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    newCategories,
    errors: parsed.errors.slice(0, 50),
    errorCount: parsed.errors.length,
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function categoryGroupFor(tx: Parameters<Parameters<MunyDb["transaction"]>[0]>[0], name: string) {
  const kind: "income" | "transfer" | "expense" =
    /income|paycheck|salary|interest|dividend|refund|reimburse/i.test(name)
      ? "income"
      : /transfer|credit card payment/i.test(name)
        ? "transfer"
        : "expense";
  // Prefer an existing group of the right kind for income/transfer; otherwise "Imported".
  if (kind !== "expense") {
    const g = tx
      .select({ id: schema.categoryGroups.id })
      .from(schema.categoryGroups)
      .where(eq(schema.categoryGroups.kind, kind))
      .get();
    if (g) return g.id;
  }
  const imported = tx
    .select({ id: schema.categoryGroups.id })
    .from(schema.categoryGroups)
    .where(sql`lower(${schema.categoryGroups.name}) = 'imported'`)
    .get();
  if (imported) return imported.id;
  const id = newId();
  const max = tx
    .select({ m: sql<number>`coalesce(max(${schema.categoryGroups.sortOrder}), -1)` })
    .from(schema.categoryGroups)
    .get();
  tx.insert(schema.categoryGroups)
    .values({ id, name: "Imported", kind: "expense", sortOrder: Number(max?.m ?? -1) + 1 })
    .run();
  return id;
}

export function commitImport(db: MunyDb, req: ImportCommitRequest, userId: string): ImportResult {
  const parsed = parseImport(req);
  const format = parsed.format as ImportFormat;

  return db.transaction((tx) => {
    // 1. Resolve target accounts.
    const accountIdFor = new Map<string, string>();
    let accountsCreated = 0;
    const connectionFor = new Map<string, string>();
    for (const a of parsed.accounts) {
      const target = req.accountMap[a.key] ?? "new";
      if (target === "skip") continue;
      if (target !== "new") {
        const exists = tx
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, target))
          .get();
        if (!exists) throw badRequest(`Unknown target account for "${a.name}"`);
        accountIdFor.set(a.key, target);
        continue;
      }
      const instKey = lc(a.institutionName);
      let connectionId = connectionFor.get(instKey);
      if (!connectionId) {
        connectionId = newId();
        tx.insert(schema.connections)
          .values({ id: connectionId, provider: "file", institutionName: a.institutionName })
          .run();
        connectionFor.set(instKey, connectionId);
      }
      const id = newId();
      tx.insert(schema.accounts)
        .values({
          id,
          connectionId,
          name: a.name,
          institutionName: a.institutionName,
          mask: a.mask,
          type: a.type,
          balanceSource: "computed",
        })
        .run();
      accountIdFor.set(a.key, id);
      accountsCreated++;
    }

    // 2. Categories.
    const idx = loadCategoryIndex(db);
    let categoriesCreated = 0;
    const categoryId = (name: string | null): string | null => {
      if (!name) return null;
      const found = resolveCategoryName(idx, name);
      if (found) return found;
      const id = newId();
      tx.insert(schema.categories)
        .values({ id, groupId: categoryGroupFor(tx, name), name: name.trim().slice(0, 60) })
        .run();
      idx.set(lc(name), id);
      categoriesCreated++;
      return id;
    };

    // 3. Transactions.
    const batchId = newId();
    tx.insert(schema.importBatches)
      .values({
        id: batchId,
        source: format,
        filename: req.filename.slice(0, 200),
        createdBy: userId,
      })
      .run();

    const hashes = computeHashes(parsed.transactions, (k) => accountIdFor.get(k));
    const payeeCache = new Map<string, string>();
    const tagCache = new Map<string, string>();
    let imported = 0;
    let duplicates = 0;
    let skipped = 0;

    parsed.transactions.forEach((t, i) => {
      const accountId = accountIdFor.get(t.accountKey);
      const importHash = hashes[i];
      if (!accountId || !importHash) {
        skipped++;
        return;
      }
      let payeeId: string | null = null;
      if (t.payeeName) {
        const k = lc(t.payeeName);
        payeeId = payeeCache.get(k) ?? upsertPayee(tx, t.payeeName.slice(0, 100));
        payeeCache.set(k, payeeId);
      }
      const id = newId();
      const res = tx
        .insert(schema.transactions)
        .values({
          id,
          accountId,
          postedDate: t.postedDate,
          authorizedDate: t.authorizedDate,
          amountCents: t.amountCents,
          rawDescription: t.rawDescription.slice(0, 500),
          payeeId,
          categoryId: categoryId(t.categoryName),
          notes: t.notes,
          hidden: t.hidden,
          providerTxnRef: t.providerTxnRef,
          importHash,
          importBatchId: batchId,
          // Categories from Rocket Money were chosen by the user; protect them from rules.
          userModified: format === "rocket_money" && t.categoryName !== null,
        })
        .onConflictDoNothing()
        .run();
      if (res.changes === 0) {
        duplicates++;
        return;
      }
      imported++;
      for (const tag of t.tags) {
        const k = lc(tag);
        const tagId = tagCache.get(k) ?? upsertTag(tx, tag.slice(0, 40));
        tagCache.set(k, tagId);
        tx.insert(schema.transactionTags)
          .values({ transactionId: id, tagId })
          .onConflictDoNothing()
          .run();
      }
    });

    tx.update(schema.importBatches)
      .set({
        rowsTotal: parsed.transactions.length + parsed.errors.length,
        rowsImported: imported,
        rowsDuplicate: duplicates,
        rowsFailed: parsed.errors.length,
      })
      .where(and(eq(schema.importBatches.id, batchId)))
      .run();

    return {
      batchId,
      imported,
      duplicates,
      skipped,
      failed: parsed.errors.length,
      accountsCreated,
      categoriesCreated,
    };
  });
}
