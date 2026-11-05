import { type MunyDb, schema } from "@muny/db";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

/**
 * Merchant memory: categorize new transactions the way you've categorized that
 * merchant before (Rocket Money-style auto-categorization). Runs after rules,
 * which always win, and only fills in transactions that are still
 * uncategorized (never transfers or splits).
 *
 * A merchant's category is the one you last set by hand on one of its
 * transactions; failing that, the category it clearly uses in your history
 * (at least MIN_HISTORY categorized transactions, SHARE of them the same).
 */

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

const MIN_HISTORY = 3;
const SHARE = 0.8;

/** Remember a hand-picked category for the merchants of these transactions. */
export function rememberCategory(db: Db, txnIds: string[], categoryId: string | null) {
  if (!categoryId || txnIds.length === 0) return;
  const t = schema.transactions;
  for (let i = 0; i < txnIds.length; i += 500) {
    const payeeIds = [
      ...new Set(
        db
          .select({ p: t.payeeId })
          .from(t)
          .where(and(inArray(t.id, txnIds.slice(i, i + 500)), isNotNull(t.payeeId)))
          .all()
          .map((r) => r.p as string),
      ),
    ];
    if (payeeIds.length)
      db.update(schema.payees)
        .set({ defaultCategoryId: categoryId })
        .where(inArray(schema.payees.id, payeeIds))
        .run();
  }
}

/** The remembered or clearly-usual category for each payee id given. */
export function merchantCategories(db: Db, payeeIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (payeeIds.length === 0) return out;
  const p = schema.payees;
  const missing: string[] = [];
  for (let i = 0; i < payeeIds.length; i += 500) {
    for (const r of db
      .select({ id: p.id, cat: p.defaultCategoryId })
      .from(p)
      .where(inArray(p.id, payeeIds.slice(i, i + 500)))
      .all()) {
      if (r.cat) out.set(r.id, r.cat);
      else missing.push(r.id);
    }
  }
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    const rows = db.all<{ p: string; c: string; n: number }>(sql`
      select t.payee_id as p, t.category_id as c, count(*) as n
        from transactions t
       where t.payee_id in (${sql.join(
         chunk.map((id) => sql`${id}`),
         sql`, `,
       )})
         and t.category_id is not null and t.hidden = 0 and t.transfer_pair_id is null
         and not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
       group by t.payee_id, t.category_id
    `);
    const byPayee = new Map<string, { c: string; n: number }[]>();
    for (const r of rows)
      byPayee.set(r.p, [...(byPayee.get(r.p) ?? []), { c: r.c, n: Number(r.n) }]);
    for (const [payee, cats] of byPayee) {
      const total = cats.reduce((s, x) => s + x.n, 0);
      const top = cats.sort((a, b) => b.n - a.n)[0];
      if (top && total >= MIN_HISTORY && top.n / total >= SHARE) out.set(payee, top.c);
    }
  }
  return out;
}

/** Fill in categories for uncategorized transactions from merchant memory. */
export function applyMerchantMemory(db: Db, ids: string[]): number {
  if (ids.length === 0) return 0;
  const t = schema.transactions;
  let changed = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = db
      .select({ id: t.id, payeeId: t.payeeId })
      .from(t)
      .where(
        and(
          inArray(t.id, ids.slice(i, i + 500)),
          isNull(t.categoryId),
          isNull(t.transferPairId),
          isNotNull(t.payeeId),
          sql`not exists (select 1 from transaction_splits s where s.transaction_id = ${t.id})`,
        ),
      )
      .all();
    const cats = merchantCategories(db, [...new Set(rows.map((r) => r.payeeId as string))]);
    for (const r of rows) {
      const c = cats.get(r.payeeId as string);
      if (!c) continue;
      changed += db.update(t).set({ categoryId: c }).where(eq(t.id, r.id)).run().changes;
    }
  }
  return changed;
}
