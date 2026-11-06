import { type MunyDb, newId, schema } from "@muny/db";
import type { SavingsBucketInput, SavingsBuckets } from "@muny/shared";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";

/**
 * Categories inside one savings account. Some banks let you
 * split a cash account into categories, but report one balance; moves show
 * up as "<Category> Deposit CASH_CATEGORY" / "<Category> Withdrawal
 * CASH_CATEGORY". You enter each category's balance once; Muny follows its
 * moves from then on. What's left is unassigned.
 */

const MOVE = /^(.+?)\s+(withdrawal|deposit)\s+cash_category/i;

export function bucketsFor(db: MunyDb, accountId: string): SavingsBuckets | null {
  const acc = listAccounts(db, accountId)[0];
  if (!acc) return null;
  const t = schema.transactions;
  const moves = db
    .select({ date: t.postedDate, raw: t.rawDescription, amount: t.amountCents })
    .from(t)
    .where(and(eq(t.accountId, accountId), like(t.rawDescription, "%CASH_CATEGORY%")))
    .all()
    .map((m) => ({ ...m, name: MOVE.exec(m.raw)?.[1]?.trim() ?? null }));
  const rows = db
    .select()
    .from(schema.savingsBuckets)
    .where(eq(schema.savingsBuckets.accountId, accountId))
    .orderBy(asc(schema.savingsBuckets.sortOrder))
    .all();
  const buckets = rows.map((b) => {
    const moved = moves
      .filter((m) => m.date > b.asOf && m.name?.toLowerCase() === b.name.toLowerCase())
      .reduce((s, m) => s + m.amount, 0);
    return {
      id: b.id,
      name: b.name,
      balanceCents: b.balanceCents + moved,
      enteredCents: b.balanceCents,
      asOf: b.asOf,
      goalCents: b.goalCents,
    };
  });
  const have = new Set(rows.map((b) => b.name.toLowerCase()));
  const suggestions = [
    ...new Set(
      moves.map((m) => m.name).filter((n): n is string => !!n && !have.has(n.toLowerCase())),
    ),
  ];
  const balance = acc.balanceCents;
  return {
    accountBalanceCents: balance,
    buckets,
    unassignedCents: balance - buckets.reduce((s, b) => s + b.balanceCents, 0),
    suggestions,
  };
}

/** Replace an account's categories. A changed balance counts from today. */
export function setBuckets(
  db: MunyDb,
  accountId: string,
  list: SavingsBucketInput[],
  today = localToday(),
): boolean {
  const current = bucketsFor(db, accountId);
  if (!current) return false;
  const byId = new Map(current.buckets.map((b) => [b.id, b]));
  db.delete(schema.savingsBuckets).where(eq(schema.savingsBuckets.accountId, accountId)).run();
  list.forEach((b, i) => {
    const old = b.id ? byId.get(b.id) : undefined;
    // Unchanged balance: keep counting moves from when it was entered.
    const same = old && old.balanceCents === b.balanceCents && old.name === b.name.trim();
    db.insert(schema.savingsBuckets)
      .values({
        id: old?.id ?? newId(),
        accountId,
        name: b.name.trim(),
        balanceCents: same ? old.enteredCents : b.balanceCents,
        asOf: same ? old.asOf : today,
        goalCents: b.goalCents ?? null,
        sortOrder: i,
      })
      .run();
  });
  return true;
}

/**
 * Moves between categories inside one account aren't spending or income:
 * file them as internal transfers (unless you categorized one yourself).
 */
export function markCategoryMoves(db: MunyDb): number {
  // Once over everything (imports from other apps come in as hand-edited), then only untouched ones.
  const FLAG = "savings.categoryMovesMarked";
  const first = !db.select().from(schema.appSettings).where(eq(schema.appSettings.key, FLAG)).get();
  const internal = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(sql`lower(${schema.categories.name}) = 'internal transfer'`)
    .get()?.id;
  if (!internal) return 0;
  const t = schema.transactions;
  const n = db
    .update(t)
    .set({ categoryId: internal })
    .where(
      and(
        like(t.rawDescription, "%CASH_CATEGORY%"),
        first ? undefined : eq(t.userModified, false),
        sql`(${t.categoryId} is null or ${t.categoryId} <> ${internal})`,
      ),
    )
    .run().changes;
  if (first)
    db.insert(schema.appSettings).values({ key: FLAG, value: true }).onConflictDoNothing().run();
  return n;
}
