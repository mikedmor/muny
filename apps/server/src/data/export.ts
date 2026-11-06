import { type MunyDb, schema } from "@muny/db";
import { toDecimalString } from "@muny/shared";
import { asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { parse } from "../lib/http.js";
import { listRules } from "../rules/service.js";
import { VERSION } from "../version.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CsvQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: z.string().max(64).optional(),
  /** Only this category (including split parts in it). */
  categoryId: z.string().max(64).optional(),
  includeHidden: z.enum(["true", "false"]).default("true"),
});

/**
 * Quote a CSV cell. Text cells that a spreadsheet would treat as a formula
 * (=, +, -, @, tab, CR) get a leading apostrophe (CSV injection).
 */
function cell(v: string | number | boolean | null | undefined, text = true): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Every transaction (one row per split part) as CSV. */
export function transactionsCsv(db: MunyDb, q: z.infer<typeof CsvQuery>): string {
  const t = schema.transactions;
  // Categories used by split parts, for the category filter.
  const splitCats = new Map<string, Set<string>>();
  if (q.categoryId)
    for (const s of db.select().from(schema.transactionSplits).all())
      if (s.categoryId)
        splitCats.set(
          s.transactionId,
          (splitCats.get(s.transactionId) ?? new Set()).add(s.categoryId),
        );
  const rows = db
    .select({
      t,
      account: schema.accounts.name,
      payee: schema.payees.displayName,
      category: schema.categories.name,
      group: schema.categoryGroups.name,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .leftJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
    .orderBy(desc(t.postedDate), desc(t.id))
    .all()
    .filter(
      (r) =>
        (!q.from || r.t.postedDate >= q.from) &&
        (!q.to || r.t.postedDate <= q.to) &&
        (!q.accountId || r.t.accountId === q.accountId) &&
        (!q.categoryId ||
          r.t.categoryId === q.categoryId ||
          splitCats.get(r.t.id)?.has(q.categoryId)) &&
        (q.includeHidden === "true" || !r.t.hidden),
    );

  const tags = new Map<string, string[]>();
  for (const r of db
    .select({ id: schema.transactionTags.transactionId, name: schema.tags.name })
    .from(schema.transactionTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.transactionTags.tagId))
    .all()) {
    tags.set(r.id, [...(tags.get(r.id) ?? []), r.name]);
  }
  const splits = new Map<
    string,
    { amountCents: number; category: string | null; notes: string | null }[]
  >();
  for (const r of db
    .select({ s: schema.transactionSplits, category: schema.categories.name })
    .from(schema.transactionSplits)
    .leftJoin(schema.categories, eq(schema.categories.id, schema.transactionSplits.categoryId))
    .all()) {
    splits.set(r.s.transactionId, [
      ...(splits.get(r.s.transactionId) ?? []),
      { amountCents: r.s.amountCents, category: r.category, notes: r.s.notes },
    ]);
  }
  const groupOf = new Map(
    db
      .select({ name: schema.categories.name, group: schema.categoryGroups.name })
      .from(schema.categories)
      .innerJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
      .all()
      .map((r) => [r.name, r.group]),
  );

  const header = [
    "Date",
    "Account",
    "Payee",
    "Description",
    "Amount",
    "Currency",
    "Category",
    "Category Group",
    "Tags",
    "Notes",
    "Hidden",
    "Pending",
    "Split",
    "Transaction ID",
  ];
  const lines = [header.join(",")];
  for (const { t: r, account, payee, category, group } of rows) {
    const parts = splits.get(r.id);
    const base = (
      amountCents: number,
      cat: string | null,
      grp: string | null,
      notes: string | null,
      split: boolean,
    ) =>
      [
        cell(r.postedDate),
        cell(account),
        cell(payee),
        cell(r.rawDescription),
        cell(toDecimalString(amountCents, r.currency), false),
        cell(r.currency),
        cell(cat),
        cell(grp),
        cell((tags.get(r.id) ?? []).sort().join("; ")),
        cell(notes),
        cell(r.hidden ? "yes" : "no"),
        cell(r.pending ? "yes" : "no"),
        cell(split ? "yes" : "no"),
        cell(r.id),
      ].join(",");
    if (parts?.length) {
      for (const s of parts) {
        lines.push(
          base(
            s.amountCents,
            s.category,
            s.category ? (groupOf.get(s.category) ?? null) : null,
            s.notes ?? r.notes,
            true,
          ),
        );
      }
    } else {
      lines.push(base(r.amountCents, category, group, r.notes, false));
    }
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Everything a user would need to move to another tool (or back to Muny). */
export function fullExport(db: MunyDb) {
  return {
    format: "muny-export",
    formatVersion: 1,
    appVersion: VERSION,
    exportedAt: new Date().toISOString(),
    accounts: db.select().from(schema.accounts).orderBy(asc(schema.accounts.sortOrder)).all(),
    balanceSnapshots: db.select().from(schema.balanceSnapshots).all(),
    categoryGroups: db.select().from(schema.categoryGroups).all(),
    categories: db.select().from(schema.categories).all(),
    payees: db.select().from(schema.payees).all(),
    tags: db.select().from(schema.tags).all(),
    transactions: db
      .select()
      .from(schema.transactions)
      .orderBy(asc(schema.transactions.postedDate))
      .all(),
    transactionSplits: db.select().from(schema.transactionSplits).all(),
    transactionTags: db.select().from(schema.transactionTags).all(),
    rules: listRules(db),
    securities: db.select().from(schema.securities).all(),
    investmentHoldings: db.select().from(schema.investmentHoldings).all(),
    investmentTxns: db
      .select()
      .from(schema.investmentTxns)
      .orderBy(asc(schema.investmentTxns.date))
      .all(),
    // Deliberately excluded: users, sessions, audit log, provider credentials.
  };
}

export function registerExportRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/export/transactions.csv", async (req, reply) => {
    const user = requireUser(req);
    const q = parse(CsvQuery, req.query);
    const body = transactionsCsv(db, q);
    audit(db, { actorType: "user", actorId: user.id, action: "export.csv", details: q });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="muny-transactions-${today()}.csv"`)
      .header("cache-control", "no-store")
      .send(body);
  });

  app.get("/api/export/muny.json", async (req, reply) => {
    const user = requireUser(req);
    audit(db, { actorType: "user", actorId: user.id, action: "export.json" });
    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="muny-export-${today()}.json"`)
      .header("cache-control", "no-store")
      .send(JSON.stringify(fullExport(db), null, 2));
  });
}
