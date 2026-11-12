import { descriptionShape } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import { MoneyParseError, parseAmount, type Transaction, type TransactionPage } from "@muny/shared";
import { and, desc, eq, inArray, isNull, like, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { BILL_CATEGORIES, BILL_SERIES, HOME_CATEGORIES } from "../budgets/service.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { rememberCategory } from "./memory.js";
import {
  applyTransferPairs,
  dismissTransfer,
  findTransferPairs,
  previewTransfers,
} from "./transfers.js";

const t = schema.transactions;
const MANUAL_PREFIX = "manual:";

const SYNC_SOURCES: Record<string, string> = {
  plaid: "Plaid",
  teller: "Teller",
  paypal: "PayPal",
  simplefin: "SimpleFIN",
};
const FILE_SOURCES: Record<string, string> = {
  csv: "CSV import",
  ofx: "OFX import",
  qfx: "QFX import",
  rocket_money: "Rocket Money import",
};

/** Where a transaction came from, in words, from how it was recorded. */
function sourceLabel(importHash: string, batchSource: string | undefined): string {
  if (importHash.startsWith(MANUAL_PREFIX)) return "Added by hand";
  if (importHash.startsWith("stmt:")) return "Statement upload";
  if (importHash.startsWith("email:")) return "Email";
  const provider = SYNC_SOURCES[importHash.split(":")[0] ?? ""];
  if (provider) return provider;
  return (batchSource && FILE_SOURCES[batchSource]) || "Imported file";
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const cents = z.number().int().safe();
const id = z.string().min(1).max(64);
const IdParams = z.object({ id });

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  accountId: id.optional(),
  categoryId: id.optional(),
  /** A budget row's transactions: earnings (income categories) or bills (recurring charges). */
  budgetRow: z.enum(["earnings", "home", "bills", "other"]).optional(),
  tagId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  hidden: z.enum(["exclude", "include", "only"]).default("exclude"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const CreateBody = z.object({
  accountId: id,
  postedDate: isoDate,
  amountCents: cents,
  description: z.string().trim().min(1, "Description is required").max(200),
  categoryId: id.nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

const UpdateBody = z.object({
  postedDate: isoDate.optional(),
  amountCents: cents.optional(),
  payeeName: z.string().trim().max(100).nullable().optional(),
  categoryId: id.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  hidden: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const SplitsBody = z.object({
  splits: z
    .array(
      z.object({
        categoryId: id.nullable(),
        amountCents: cents,
        notes: z.string().trim().max(500).nullish(),
      }),
    )
    .max(20),
});

const BulkBody = z.object({
  ids: z.array(id).min(1).max(1000),
  set: z
    .object({
      categoryId: id.nullable().optional(),
      hidden: z.boolean().optional(),
      addTag: z.string().trim().min(1).max(40).optional(),
    })
    .refine((s) => Object.keys(s).length > 0, "Nothing to update"),
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function buildFilters(q: z.infer<typeof ListQuery>): SQL | undefined {
  const conds: (SQL | undefined)[] = [];
  // A purchase's funding (bank withdrawal to PayPal) is shown with the purchase.
  conds.push(isNull(t.fundsTransactionId));
  if (q.accountId)
    conds.push(
      or(
        eq(t.accountId, q.accountId),
        sql`exists (select 1 from transactions f where f.funds_transaction_id = ${t.id} and f.account_id = ${q.accountId})`,
      ),
    );
  if (q.categoryId === "uncategorized") {
    // A matched transfer with no category counts as categorized (it's a transfer).
    conds.push(
      sql`${t.categoryId} is null and ${t.transferPairId} is null and not exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id})`,
    );
  } else if (q.categoryId) {
    conds.push(
      or(
        eq(t.categoryId, q.categoryId),
        sql`exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id} and s.category_id = ${q.categoryId})`,
      ),
    );
  }
  if (q.budgetRow === "earnings") {
    const income = sql`(select c.id from categories c join category_groups g on g.id = c.group_id where g.kind = 'income')`;
    conds.push(
      or(
        sql`${t.categoryId} in ${income}`,
        sql`exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id} and s.category_id in ${income})`,
      ),
    );
  }
  // Nothing in a home category: a recurring charge is a bill only then.
  const notHome = sql`coalesce(${t.categoryId}, '-') not in ${HOME_CATEGORIES} and not exists (select 1 from ${schema.transactionSplits} h where h.transaction_id = ${t.id} and h.category_id in ${HOME_CATEGORIES})`;
  if (q.budgetRow === "home") {
    conds.push(
      or(
        sql`${t.categoryId} in ${HOME_CATEGORIES}`,
        sql`exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id} and s.category_id in ${HOME_CATEGORIES})`,
      ),
    );
  }
  if (q.budgetRow === "bills") {
    conds.push(
      or(
        sql`${t.amountCents} < 0 and ${t.recurringSeriesId} in ${BILL_SERIES} and ${notHome}`,
        sql`${t.categoryId} in ${BILL_CATEGORIES}`,
        sql`exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id} and s.category_id in ${BILL_CATEGORIES})`,
      ),
    );
  }
  if (q.budgetRow === "other") {
    // Spending that isn't a bill: spending categories or uncategorized, not a bill.
    const spending = sql`(select c.id from categories c join category_groups g on g.id = c.group_id where g.kind = 'expense' and c.exclude_from_budget = 0)`;
    conds.push(
      sql`not (${t.amountCents} < 0 and coalesce(${t.recurringSeriesId}, '-') in ${BILL_SERIES} and ${notHome})`,
      or(
        sql`${t.categoryId} in ${spending} and ${t.categoryId} not in ${BILL_CATEGORIES} and ${t.categoryId} not in ${HOME_CATEGORIES}`,
        sql`${t.categoryId} is null and ${t.transferPairId} is null`,
        sql`exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id} and (s.category_id is null or (s.category_id in ${spending} and s.category_id not in ${BILL_CATEGORIES} and s.category_id not in ${HOME_CATEGORIES})))`,
      ),
    );
  }
  if (q.tagId) {
    conds.push(
      sql`exists (select 1 from ${schema.transactionTags} tt where tt.transaction_id = ${t.id} and tt.tag_id = ${q.tagId})`,
    );
  }
  if (q.from) conds.push(sql`${t.postedDate} >= ${q.from}`);
  if (q.to) conds.push(sql`${t.postedDate} <= ${q.to}`);
  if (q.hidden === "exclude") conds.push(eq(t.hidden, false));
  if (q.hidden === "only") conds.push(eq(t.hidden, true));
  if (q.q) {
    const pattern = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const text = or(
      sql`${t.rawDescription} like ${pattern} escape '\\'`,
      sql`${t.notes} like ${pattern} escape '\\'`,
      sql`${schema.payees.displayName} like ${pattern} escape '\\'`,
      // The bank's side of a PayPal purchase ("PAYPAL INST XFER ...").
      sql`exists (select 1 from transactions f where f.funds_transaction_id = ${t.id} and f.raw_description like ${pattern} escape '\\')`,
    );
    // "15.99" also matches transactions of that amount (either sign).
    let amount: number | undefined;
    try {
      amount = Math.abs(parseAmount(q.q));
    } catch (e) {
      if (!(e instanceof MoneyParseError)) throw e;
    }
    conds.push(
      amount !== undefined && amount > 0 ? or(text, sql`abs(${t.amountCents}) = ${amount}`) : text,
    );
  }
  return and(...conds);
}

export function queryTransactions(db: MunyDb, input: z.infer<typeof ListQuery>): TransactionPage {
  const where = buildFilters(input);
  const base = db
    .select({ id: t.id })
    .from(t)
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .where(where);

  const totals = db
    .select({ n: sql<number>`count(*)`, sum: sql<number>`coalesce(sum(${t.amountCents}), 0)` })
    .from(t)
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .where(where)
    .get();

  const ids = base
    .orderBy(desc(t.postedDate), desc(t.id))
    .limit(input.limit)
    .offset(input.offset)
    .all()
    .map((r) => r.id);

  return {
    items: loadTransactions(db, ids),
    total: Number(totals?.n ?? 0),
    sumCents: Number(totals?.sum ?? 0),
    offset: input.offset,
    limit: input.limit,
  };
}

/** Load full transaction DTOs for the given ids, preserving order. */
export function loadTransactions(db: MunyDb, ids: string[]): Transaction[] {
  if (ids.length === 0) return [];
  const groups = schema.categoryGroups;
  const splitCat = alias(schema.categories, "split_cat");
  const rows = db
    .select({
      t,
      accountName: schema.accounts.name,
      payeeName: schema.payees.displayName,
      categoryName: schema.categories.name,
      groupName: groups.name,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .leftJoin(groups, eq(groups.id, schema.categories.groupId))
    .where(inArray(t.id, ids))
    .all();

  const tagRows = db
    .select({ txnId: schema.transactionTags.transactionId, tag: schema.tags })
    .from(schema.transactionTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.transactionTags.tagId))
    .where(inArray(schema.transactionTags.transactionId, ids))
    .all();

  // Account names on the other side of transfers.
  const pairIds = rows.map((r) => r.t.transferPairId).filter((x): x is string => !!x);
  const pairAccount = new Map(
    pairIds.length
      ? db
          .select({ id: t.id, name: schema.accounts.name })
          .from(t)
          .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
          .where(inArray(t.id, pairIds))
          .all()
          .map((r) => [r.id, r.name])
      : [],
  );

  // Where PayPal purchases' money came from: the bank's side, else PayPal's funding.
  const funding = db
    .select({
      id: t.id,
      funds: t.fundsTransactionId,
      accountId: t.accountId,
      accountName: schema.accounts.name,
      date: t.postedDate,
      raw: t.rawDescription,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .where(inArray(t.fundsTransactionId, ids))
    .all();
  const fundedFrom = (r: typeof t.$inferSelect): Transaction["fundedFrom"] => {
    const mine = funding.filter((f) => f.funds === r.id);
    const f = mine.find((x) => x.accountId !== r.accountId) ?? mine[0];
    if (!f) return null;
    return {
      transactionId: f.id,
      accountName: f.accountId !== r.accountId ? f.accountName : null,
      date: f.date,
      description: f.raw,
    };
  };

  const batchIds = [...new Set(rows.map((r) => r.t.importBatchId).filter((x): x is string => !!x))];
  const batchSource = new Map(
    batchIds.length
      ? db
          .select({ id: schema.importBatches.id, source: schema.importBatches.source })
          .from(schema.importBatches)
          .where(inArray(schema.importBatches.id, batchIds))
          .all()
          .map((b) => [b.id, b.source])
      : [],
  );

  const seriesIds = [
    ...new Set(rows.map((r) => r.t.recurringSeriesId).filter((x): x is string => !!x)),
  ];
  const seriesName = new Map(
    seriesIds.length
      ? db
          .select({ id: schema.recurringSeries.id, name: schema.recurringSeries.name })
          .from(schema.recurringSeries)
          .where(inArray(schema.recurringSeries.id, seriesIds))
          .all()
          .map((r) => [r.id, r.name])
      : [],
  );

  const splitRows = db
    .select({ s: schema.transactionSplits, categoryName: splitCat.name })
    .from(schema.transactionSplits)
    .leftJoin(splitCat, eq(splitCat.id, schema.transactionSplits.categoryId))
    .where(inArray(schema.transactionSplits.transactionId, ids))
    .all();

  const byId = new Map(
    rows.map(({ t: r, accountName, payeeName, categoryName, groupName }) => [
      r.id,
      {
        id: r.id,
        accountId: r.accountId,
        accountName,
        postedDate: r.postedDate,
        amountCents: r.amountCents,
        currency: r.currency,
        description: payeeName ?? r.rawDescription,
        rawDescription: r.rawDescription,
        payeeId: r.payeeId,
        payeeName,
        categoryId: r.categoryId,
        categoryName,
        categoryGroupName: groupName,
        notes: r.notes,
        pending: r.pending,
        hidden: r.hidden,
        manual: r.importHash.startsWith(MANUAL_PREFIX),
        source: sourceLabel(
          r.importHash,
          r.importBatchId ? batchSource.get(r.importBatchId) : undefined,
        ),
        transferPairId: r.transferPairId,
        transferAccountName: r.transferPairId ? (pairAccount.get(r.transferPairId) ?? null) : null,
        fundedFrom: fundedFrom(r),
        recurringSeriesId: r.recurringSeriesId,
        recurringName: r.recurringSeriesId ? (seriesName.get(r.recurringSeriesId) ?? null) : null,
        tags: tagRows
          .filter((x) => x.txnId === r.id)
          .map(({ tag }) => ({ id: tag.id, name: tag.name, color: tag.color }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        splits: splitRows
          .filter((x) => x.s.transactionId === r.id)
          .map(({ s, categoryName: cn }) => ({
            id: s.id,
            categoryId: s.categoryId,
            categoryName: cn,
            amountCents: s.amountCents,
            notes: s.notes,
          })),
      } satisfies Transaction,
    ]),
  );
  return ids.map((i) => byId.get(i)).filter((x): x is Transaction => x !== undefined);
}

function getTransaction(db: MunyDb, txnId: string): Transaction {
  const txn = loadTransactions(db, [txnId])[0];
  if (!txn) throw notFound("Transaction not found");
  return txn;
}

// ---------------------------------------------------------------------------
// Helpers shared with importers
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

/** Find a payee by display name (case-insensitive) or create it. */
export function upsertPayee(tx: Tx | MunyDb, displayName: string): string {
  const existing = tx
    .select({ id: schema.payees.id })
    .from(schema.payees)
    .where(sql`lower(${schema.payees.displayName}) = lower(${displayName})`)
    .get();
  if (existing) return existing.id;
  const pid = newId();
  tx.insert(schema.payees).values({ id: pid, displayName }).run();
  return pid;
}

/**
 * The merchant earlier transactions with the same description shape have (the
 * most recent one's), so new charges keep the name you know them by, even if
 * you renamed it or the name cleanup changes. Built once per sync or import.
 */
export function payeesByShape(tx: Tx | MunyDb): (raw: string) => string | undefined {
  let byShape: Map<string, string> | null = null;
  return (raw) => {
    const shape = descriptionShape(raw);
    if (!shape) return undefined;
    if (!byShape) {
      byShape = new Map();
      const t = schema.transactions;
      for (const r of tx
        .select({ raw: t.rawDescription, payeeId: t.payeeId })
        .from(t)
        .where(sql`${t.payeeId} is not null`)
        .orderBy(t.postedDate)
        .all()) {
        const s = descriptionShape(r.raw);
        if (s && r.payeeId) byShape.set(s, r.payeeId);
      }
    }
    return byShape.get(shape);
  };
}

/** Find a tag by name (case-insensitive) or create it. */
export function upsertTag(tx: Tx | MunyDb, name: string): string {
  const existing = tx
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(sql`lower(${schema.tags.name}) = lower(${name})`)
    .get();
  if (existing) return existing.id;
  const tid = newId();
  tx.insert(schema.tags).values({ id: tid, name }).run();
  return tid;
}

function assertCategoryExists(db: MunyDb, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const c = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!c) throw badRequest("Unknown category", { categoryId });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Change many transactions at once, as the app's own bulk edit does. */
export function bulkUpdateTransactions(
  db: MunyDb,
  ids: string[],
  set: { categoryId?: string | null; hidden?: boolean; addTag?: string },
): number {
  return db.transaction((tx) => {
    const update: Partial<typeof t.$inferInsert> = {};
    if (set.categoryId !== undefined) {
      update.categoryId = set.categoryId;
      update.userModified = true;
    }
    if (set.hidden !== undefined) update.hidden = set.hidden;
    let n = 0;
    if (Object.keys(update).length) {
      n = tx.update(t).set(update).where(inArray(t.id, ids)).run().changes;
      if (set.categoryId !== undefined) {
        rememberCategory(tx, ids, set.categoryId);
        // Explicit recategorization replaces any splits.
        tx.delete(schema.transactionSplits)
          .where(inArray(schema.transactionSplits.transactionId, ids))
          .run();
      }
    }
    if (set.addTag) {
      const tagId = upsertTag(tx, set.addTag);
      for (const txnId of ids) {
        tx.insert(schema.transactionTags)
          .values({ transactionId: txnId, tagId })
          .onConflictDoNothing()
          .run();
      }
      n = Math.max(n, ids.length);
    }
    return n;
  });
}

export function registerTransactionRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId: string | undefined, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "transaction",
      entityId,
      details,
    });

  app.get("/api/transactions", async (req) => queryTransactions(db, parse(ListQuery, req.query)));

  app.get("/api/transactions/:id", async (req) =>
    getTransaction(db, parse(IdParams, req.params).id),
  );

  app.post("/api/transactions", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(CreateBody, req.body);
    const account = db
      .select({ currency: schema.accounts.currency })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, body.accountId))
      .get();
    if (!account) throw badRequest("Unknown account", { accountId: body.accountId });
    assertCategoryExists(db, body.categoryId);

    const txnId = newId();
    db.insert(t)
      .values({
        id: txnId,
        accountId: body.accountId,
        postedDate: body.postedDate,
        amountCents: body.amountCents,
        currency: account.currency,
        rawDescription: body.description,
        categoryId: body.categoryId ?? null,
        notes: body.notes || null,
        importHash: `${MANUAL_PREFIX}${txnId}`,
        userModified: true,
      })
      .run();
    log(user.id, "transaction.create", txnId);
    return reply.code(201).send(getTransaction(db, txnId));
  });

  app.patch("/api/transactions/:id", async (req) => {
    const user = requireUser(req);
    const { id: txnId } = parse(IdParams, req.params);
    const body = parse(UpdateBody, req.body);
    const current = getTransaction(db, txnId);
    if ((body.postedDate || body.amountCents !== undefined) && !current.manual) {
      throw badRequest("Date and amount can only be edited on manually entered transactions");
    }
    assertCategoryExists(db, body.categoryId);

    db.transaction((tx) => {
      const update: Partial<typeof t.$inferInsert> = {};
      if (body.postedDate) update.postedDate = body.postedDate;
      if (body.amountCents !== undefined) update.amountCents = body.amountCents;
      if (body.notes !== undefined) update.notes = body.notes || null;
      if (body.hidden !== undefined) update.hidden = body.hidden;
      if (body.categoryId !== undefined) {
        update.categoryId = body.categoryId;
        update.userModified = true;
      }
      if (body.payeeName === undefined) rememberCategory(tx, [txnId], body.categoryId ?? null);
      if (body.payeeName !== undefined) {
        update.payeeId = body.payeeName ? upsertPayee(tx, body.payeeName) : null;
        update.userModified = true;
      }
      if (Object.keys(update).length) tx.update(t).set(update).where(eq(t.id, txnId)).run();

      if (body.tags) {
        tx.delete(schema.transactionTags)
          .where(eq(schema.transactionTags.transactionId, txnId))
          .run();
        const tagIds = [...new Set(body.tags.map((name) => upsertTag(tx, name)))];
        for (const tagId of tagIds) {
          tx.insert(schema.transactionTags).values({ transactionId: txnId, tagId }).run();
        }
      }
    });
    log(user.id, "transaction.update", txnId, { fields: Object.keys(body) });
    return getTransaction(db, txnId);
  });

  /** Replace splits. Amounts must add up to the transaction amount; [] removes splits. */
  app.put("/api/transactions/:id/splits", async (req) => {
    const user = requireUser(req);
    const { id: txnId } = parse(IdParams, req.params);
    const { splits } = parse(SplitsBody, req.body);
    const current = getTransaction(db, txnId);
    if (splits.length === 1) throw badRequest("A split needs at least two parts");
    if (splits.length > 0) {
      const total = splits.reduce((s, x) => s + x.amountCents, 0);
      if (total !== current.amountCents) {
        throw badRequest("Split amounts must add up to the transaction amount", {
          expected: current.amountCents,
          actual: total,
        });
      }
      for (const s of splits) assertCategoryExists(db, s.categoryId);
    }
    db.transaction((tx) => {
      tx.delete(schema.transactionSplits)
        .where(eq(schema.transactionSplits.transactionId, txnId))
        .run();
      for (const s of splits) {
        tx.insert(schema.transactionSplits)
          .values({
            id: newId(),
            transactionId: txnId,
            categoryId: s.categoryId,
            amountCents: s.amountCents,
            notes: s.notes || null,
          })
          .run();
      }
      // A split transaction is categorized by its parts.
      if (splits.length > 0) {
        tx.update(t).set({ categoryId: null, userModified: true }).where(eq(t.id, txnId)).run();
      }
    });
    log(user.id, "transaction.splits", txnId, { parts: splits.length });
    return getTransaction(db, txnId);
  });

  app.delete("/api/transactions/:id", async (req) => {
    const user = requireUser(req);
    const { id: txnId } = parse(IdParams, req.params);
    const current = getTransaction(db, txnId);
    db.delete(t).where(eq(t.id, txnId)).run();
    log(user.id, "transaction.delete", txnId, {
      postedDate: current.postedDate,
      amountCents: current.amountCents,
      accountId: current.accountId,
    });
    return { ok: true };
  });

  app.post("/api/transactions/bulk", async (req) => {
    const user = requireUser(req);
    const { ids, set } = parse(BulkBody, req.body);
    assertCategoryExists(db, set.categoryId);
    const changed = bulkUpdateTransactions(db, ids, set);
    log(user.id, "transaction.bulk_update", undefined, { count: ids.length, set });
    return { updated: changed };
  });

  /** "Not a transfer": unpair, and don't pair these again. */
  app.delete("/api/transactions/:id/transfer", async (req) => {
    const user = requireUser(req);
    const { id: txnId } = parse(IdParams, req.params);
    getTransaction(db, txnId);
    db.transaction((tx) => dismissTransfer(tx, txnId));
    log(user.id, "transaction.not_transfer", txnId);
    return getTransaction(db, txnId);
  });

  app.post("/api/transfers/preview", async () => previewTransfers(db));

  app.post("/api/transfers/apply", async (req) => {
    const user = requireUser(req);
    const paired = db.transaction((tx) => applyTransferPairs(tx, findTransferPairs(tx)));
    log(user.id, "transfer.detect", undefined, { paired });
    return { paired };
  });

  app.get("/api/tags", async () => db.select().from(schema.tags).orderBy(schema.tags.name).all());

  app.get("/api/payees", async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    return db
      .select({ id: schema.payees.id, displayName: schema.payees.displayName })
      .from(schema.payees)
      .where(q ? like(schema.payees.displayName, `%${q}%`) : undefined)
      .orderBy(schema.payees.displayName)
      .limit(50)
      .all();
  });
}
