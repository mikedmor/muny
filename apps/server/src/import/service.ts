import { createHash } from "node:crypto";
import {
  type BankCsvParse,
  cleanPayeeName,
  isOfx,
  isRocketMoneyCsv,
  normalizeDescription,
  type ParsedTransaction,
  type ParseResult,
  parseBankCsv,
  parseCsvRecords,
  parseOfx,
  parseRocketMoneyCsv,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  CsvPreviewInfo,
  ImportCommitRequest,
  ImportFormat,
  ImportPreview,
  ImportPreviewAccount,
  ImportRequest,
  ImportResult,
} from "@muny/shared";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { applyMerchantMemory } from "../ledger/memory.js";
import { upsertPayee, upsertTag } from "../ledger/transactions.js";
import { linkTransfersFor } from "../ledger/transfers.js";
import { badRequest } from "../lib/http.js";
import { rescanRecurring } from "../recurring/service.js";
import { runRulesOn } from "../rules/service.js";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function detectFormat(req: ImportRequest): ImportFormat {
  if (req.format) return req.format;
  if (isOfx(req.content)) return "ofx";
  const { headers } = parseCsvRecords(req.content.slice(0, 4000).split(/\r?\n/)[0] ?? "");
  if (isRocketMoneyCsv(headers)) return "rocket_money";
  return "csv";
}

interface Parsed extends ParseResult {
  csv: CsvPreviewInfo | null;
}

export function parseImport(req: ImportRequest): Parsed {
  const format = detectFormat(req);
  if (format === "rocket_money") return { ...parseRocketMoneyCsv(req.content), csv: null };
  if (format === "ofx") return { ...parseOfx(req.content), csv: null };

  const r: BankCsvParse = parseBankCsv(req.content, { filename: req.filename, mapping: req.csv });
  if (r.headers.length === 0) throw badRequest("This file is empty or isn't a CSV.");
  const { headers, sample, preset, mapping, ...rest } = r;
  return {
    ...rest,
    csv: {
      headers,
      sample,
      mapping,
      preset: preset && {
        id: preset.id,
        label: preset.label,
        institutionName: preset.institutionName,
        accountType: preset.accountType,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Category names (Rocket Money, bank CSVs) that map onto Muny defaults. */
const CATEGORY_ALIASES: Record<string, string> = {
  // Near-synonyms only. Broader categories (e.g. "Auto & Transport",
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
  // Chase credit card categories
  "food & drink": "Dining & Drinks",
  gas: "Gas & Fuel",
  "gifts & donations": "Gifts",
  "fees & adjustments": "Fees & Charges",
  travel: "Travel & Vacation",
  personal: "Personal Care",
};

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const firstWord = (s: string | null | undefined) => lc(s).split(/\s+/)[0] ?? "";

export function findMatchingAccount(
  existing: { id: string; name: string; institutionName: string | null; mask: string | null }[],
  a: { name: string; institutionName: string | null; mask: string | null },
) {
  // "Ally" and "Ally Bank" are the same institution.
  const sameInst = (x: string | null) =>
    !x || !a.institutionName || firstWord(x) === firstWord(a.institutionName);
  const sameMask = a.mask ? existing.filter((e) => e.mask === a.mask) : [];
  // Same institution + last 4 is the strongest signal; then exact name (+institution);
  // then last 4 alone if only one account has it (institution names vary by source).
  return (
    sameMask.find((e) => sameInst(e.institutionName)) ??
    existing.find((e) => lc(e.name) === lc(a.name) && sameInst(e.institutionName)) ??
    (sameMask.length === 1 ? sameMask[0] : null) ??
    null
  );
}

type CategoryIndex = Map<string, string>; // lowercased name -> id

function loadCategoryIndex(db: MunyDb | Tx): CategoryIndex {
  const idx: CategoryIndex = new Map();
  for (const c of db.select().from(schema.categories).all()) {
    if (!idx.has(lc(c.name))) idx.set(lc(c.name), c.id);
  }
  return idx;
}

function resolveCategoryName(idx: CategoryIndex, name: string): string | undefined {
  return idx.get(lc(name)) ?? idx.get(lc(CATEGORY_ALIASES[lc(name)]));
}

/** Rocket Money categories are the user's own and get created; bank categories only map. */
const createsCategories = (format: ImportFormat) => format === "rocket_money";

/**
 * Dedupe hash. With a bank transaction id (OFX FITID) that's the identity;
 * otherwise account + date + amount + normalized description + the occurrence
 * number of that tuple within the file, so two identical $5 coffees on the
 * same day both import, but re-importing the file doesn't.
 */
export function computeHashes(
  txns: DedupeInput[],
  accountIdFor: (key: string) => string | undefined,
): (string | undefined)[] {
  const seen = new Map<string, number>();
  return txns.map((t) => {
    const accountId = accountIdFor(t.accountKey);
    if (!accountId) return undefined;
    const base = t.providerTxnRef
      ? `${accountId}|ref|${t.providerTxnRef}`
      : [accountId, t.postedDate, t.amountCents, normalizeDescription(t.rawDescription)].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
  });
}

const NOISE = new Set(
  "pos debit credit card purchase payment ach web online recurring transfer from the and inc llc com www withdrawal deposit check visa mastercard id ppd ccd".split(
    " ",
  ),
);
function merchantWords(s: string): Set<string> {
  return new Set(
    normalizeDescription(s)
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !NOISE.has(w)),
  );
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const FUZZY_DAYS = 3;

/**
 * Which file transactions already exist in Muny. Three passes, each consuming
 * the existing rows it matches so one existing row can't hide two file rows:
 *  1. exact: same import hash or bank transaction id (re-importing a file)
 *  2. same account + amount + date (posted or transaction date): overlap with
 *     history from another source, e.g. a bank CSV covering months already
 *     imported from Rocket Money
 *  3. same amount within ±3 days and a shared merchant word (posting-date drift)
 */
export type DedupeInput = Pick<
  ParsedTransaction,
  | "accountKey"
  | "postedDate"
  | "authorizedDate"
  | "amountCents"
  | "rawDescription"
  | "providerTxnRef"
>;

/** Returns, per transaction, the id of the existing transaction it duplicates (or null). */
export function findDuplicates(
  db: MunyDb | Tx,
  txns: DedupeInput[],
  hashes: (string | undefined)[],
  accountIdFor: (key: string) => string | undefined,
  /** Only match rows that no provider has claimed yet (used by bank sync). */
  opts: { unreferencedOnly?: boolean } = {},
): (string | null)[] {
  const dup: (string | null)[] = txns.map(() => null);
  const accountIds = [...new Set(txns.map((t) => accountIdFor(t.accountKey)))].filter(
    (x): x is string => !!x,
  );
  if (accountIds.length === 0 || txns.length === 0) return dup;
  const dates = txns.flatMap((t) => [t.postedDate, t.authorizedDate ?? t.postedDate]).sort();
  const t = schema.transactions;
  const rows = db
    .select({
      id: t.id,
      accountId: t.accountId,
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      rawDescription: t.rawDescription,
      importHash: t.importHash,
      providerTxnRef: t.providerTxnRef,
    })
    .from(t)
    .where(
      and(
        inArray(t.accountId, accountIds),
        gte(t.postedDate, shiftDate(dates[0] ?? "", -FUZZY_DAYS)),
        lte(t.postedDate, shiftDate(dates[dates.length - 1] ?? "", FUZZY_DAYS)),
        opts.unreferencedOnly ? isNull(t.providerTxnRef) : undefined,
      ),
    )
    .all();

  const used = new Set<string>();
  const byHash = new Map(rows.map((r) => [`${r.accountId}:${r.importHash}`, r]));
  const byRef = new Map(
    rows.filter((r) => r.providerTxnRef).map((r) => [`${r.accountId}:${r.providerTxnRef}`, r]),
  );
  const byDayAmount = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.accountId}|${r.postedDate}|${r.amountCents}`;
    byDayAmount.set(k, [...(byDayAmount.get(k) ?? []), r]);
  }

  // Pass 1: exact.
  txns.forEach((tx, i) => {
    const acc = accountIdFor(tx.accountKey);
    if (!acc) return;
    const hit =
      byHash.get(`${acc}:${hashes[i]}`) ??
      (tx.providerTxnRef ? byRef.get(`${acc}:${tx.providerTxnRef}`) : undefined);
    if (hit && !used.has(hit.id)) {
      used.add(hit.id);
      dup[i] = hit.id;
    }
  });
  // Pass 2: same day + amount (sources disagree on posted vs transaction date).
  txns.forEach((tx, i) => {
    const acc = accountIdFor(tx.accountKey);
    if (dup[i] || !acc) return;
    for (const day of [tx.postedDate, tx.authorizedDate]) {
      const hit = day
        ? byDayAmount.get(`${acc}|${day}|${tx.amountCents}`)?.find((r) => !used.has(r.id))
        : undefined;
      if (hit) {
        used.add(hit.id);
        dup[i] = hit.id;
        break;
      }
    }
  });
  // Pass 3: nearby day + amount + a shared merchant word.
  txns.forEach((tx, i) => {
    const acc = accountIdFor(tx.accountKey);
    if (dup[i] || !acc) return;
    const words = merchantWords(tx.rawDescription);
    if (words.size === 0) return;
    for (let d = 1; d <= FUZZY_DAYS && !dup[i]; d++) {
      for (const day of [shiftDate(tx.postedDate, -d), shiftDate(tx.postedDate, d)]) {
        const hit = byDayAmount
          .get(`${acc}|${day}|${tx.amountCents}`)
          ?.find(
            (r) =>
              !used.has(r.id) && [...merchantWords(r.rawDescription)].some((w) => words.has(w)),
          );
        if (hit) {
          used.add(hit.id);
          dup[i] = hit.id;
          break;
        }
      }
    }
  });
  return dup;
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
      statementBalance: a.statementBalance ?? null,
      transactionCount: txns.length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      match: m ? { id: m.id, name: m.name } : null,
    };
  });

  const matchFor = new Map(accounts.map((a) => [a.key, a.match?.id]));
  const accountIdFor = (k: string) => matchFor.get(k);
  const hashes = computeHashes(parsed.transactions, accountIdFor);
  const duplicateCount = findDuplicates(db, parsed.transactions, hashes, accountIdFor).filter(
    Boolean,
  ).length;

  const idx = loadCategoryIndex(db);
  const newCategories = createsCategories(parsed.format)
    ? [
        ...new Set(
          parsed.transactions
            .map((t) => t.categoryName)
            .filter((c): c is string => !!c && !resolveCategoryName(idx, c)),
        ),
      ].sort()
    : [];

  const dates = parsed.transactions.map((t) => t.postedDate).sort();
  return {
    format: parsed.format,
    accounts,
    transactionCount: parsed.transactions.length,
    duplicateCount,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    newCategories,
    errors: parsed.errors.slice(0, 50),
    errorCount: parsed.errors.length,
    csv: parsed.csv,
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function categoryGroupFor(tx: Tx, name: string) {
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

/**
 * Make a computed account's balance equal `cents` as of `asOf` by shifting its
 * opening balance (transactions after `asOf` still count on top). Reported
 * accounts just take the value.
 */
function applyStatementBalance(tx: Tx, accountId: string, cents: number, asOf: string) {
  const acc = tx.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!acc) return;
  if (acc.balanceSource === "computed") {
    const row = tx
      .select({ s: sql<number>`coalesce(sum(${schema.transactions.amountCents}), 0)` })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, accountId),
          eq(schema.transactions.pending, false),
          lte(schema.transactions.postedDate, asOf),
        ),
      )
      .get();
    tx.update(schema.accounts)
      .set({ openingBalanceCents: cents - Number(row?.s ?? 0) })
      .where(eq(schema.accounts.id, accountId))
      .run();
  } else {
    tx.update(schema.accounts)
      .set({ currentBalanceCents: cents })
      .where(eq(schema.accounts.id, accountId))
      .run();
  }
  tx.insert(schema.balanceSnapshots)
    .values({ accountId, date: asOf, balanceCents: cents })
    .onConflictDoUpdate({
      target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
      set: { balanceCents: cents, estimated: false },
    })
    .run();
}

export function commitImport(db: MunyDb, req: ImportCommitRequest, userId: string): ImportResult {
  const parsed = parseImport(req);
  const format = parsed.format;
  if (parsed.transactions.length === 0 && parsed.accounts.length === 0) {
    throw badRequest(parsed.errors[0]?.message ?? "Nothing to import in this file.");
  }

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
    const idx = loadCategoryIndex(tx);
    let categoriesCreated = 0;
    const categoryId = (name: string | null): string | null => {
      if (!name) return null;
      const found = resolveCategoryName(idx, name);
      if (found) return found;
      if (!createsCategories(format)) return null;
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

    const lookup = (k: string) => accountIdFor.get(k);
    const hashes = computeHashes(parsed.transactions, lookup);
    const isDup = findDuplicates(tx, parsed.transactions, hashes, lookup);
    const payeeCache = new Map<string, string>();
    const tagCache = new Map<string, string>();
    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    const newIds: string[] = [];

    parsed.transactions.forEach((t, i) => {
      const accountId = accountIdFor.get(t.accountKey);
      const importHash = hashes[i];
      if (!accountId || !importHash) {
        skipped++;
        return;
      }
      if (isDup[i]) {
        duplicates++;
        return;
      }
      // The file's merchant name if it has one, else a cleaned-up bank description.
      const payeeName = t.payeeName ?? cleanPayeeName(t.rawDescription);
      let payeeId: string | null = null;
      if (payeeName) {
        const k = lc(payeeName);
        payeeId = payeeCache.get(k) ?? upsertPayee(tx, payeeName.slice(0, 100));
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
          notes: t.notes?.slice(0, 2000) ?? null,
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
      newIds.push(id);
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

    // 4. Rules (skip transactions whose category came from the user, e.g. Rocket Money).
    // Then transfers, then merchant memory for whatever is still uncategorized.
    const ruleChanges = runRulesOn(tx, newIds);
    linkTransfersFor(tx, newIds);
    const rulesApplied = ruleChanges + applyMerchantMemory(tx, newIds);
    if (newIds.length) rescanRecurring(tx);

    // 5. Statement balances (after transactions, so the math includes them).
    let balancesUpdated = 0;
    const apply = new Set(req.applyBalances ?? []);
    for (const a of parsed.accounts) {
      const accountId = accountIdFor.get(a.key);
      if (!accountId || !a.statementBalance || !apply.has(a.key)) continue;
      applyStatementBalance(tx, accountId, a.statementBalance.cents, a.statementBalance.asOf);
      balancesUpdated++;
    }

    tx.update(schema.importBatches)
      .set({
        rowsTotal: parsed.transactions.length + parsed.errors.length,
        rowsImported: imported,
        rowsDuplicate: duplicates,
        rowsFailed: parsed.errors.length,
      })
      .where(eq(schema.importBatches.id, batchId))
      .run();

    return {
      batchId,
      imported,
      duplicates,
      skipped,
      failed: parsed.errors.length,
      accountsCreated,
      categoriesCreated,
      balancesUpdated,
      rulesApplied,
    };
  });
}
