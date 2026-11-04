import { type MunyDb, schema } from "@muny/db";
import type { TransferPreview } from "@muny/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

/**
 * Transfer detection: money moving between two of the user's own accounts
 * shows up as two transactions with opposite amounts a few days apart.
 * Pairing them (transfer_pair_id) and categorizing them as transfers keeps
 * them out of spending and income.
 *
 * Opposite amounts alone are weak evidence (a $50 refund and a $50 payment
 * to a friend), so a pair also needs one of: transfer-ish wording, the other
 * account's name/institution/last 4 in the description, a transfer category
 * already set.
 */

export const MAX_DAYS = 4;

const WORDS =
  /\b(transfer|xfer|trnsfr|tfr|payment|pymt|pmt|autopay|auto pay|epay|e-payment|deposit|withdrawal|online banking|mobile banking|to (chk|sav|checking|savings|share)|from (chk|sav|checking|savings|share)|thank you|card ending|crd pmt|cardmember|zelle|venmo|paypal)\b/i;

interface Row {
  id: string;
  accountId: string;
  postedDate: string;
  amountCents: number;
  rawDescription: string;
  userModified: boolean;
  categoryId: string | null;
  categoryKind: string | null;
}

interface AccountInfo {
  id: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  type: string;
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

function mentions(desc: string, acc: AccountInfo): boolean {
  const d = desc.toLowerCase();
  if (acc.mask && d.includes(acc.mask)) return true;
  const inst = acc.institutionName?.toLowerCase().split(/\s+/)[0];
  if (inst && inst.length >= 4 && d.includes(inst)) return true;
  const name = acc.name.toLowerCase();
  return name.length >= 5 && d.includes(name);
}

const LIABILITY = new Set(["credit", "loan"]);

export function looksLikeTransfer(a: Row, b: Row, accA: AccountInfo, accB: AccountInfo): boolean {
  if (a.categoryKind === "transfer" || b.categoryKind === "transfer") return true;
  if (WORDS.test(a.rawDescription) || WORDS.test(b.rawDescription)) return true;
  if (mentions(a.rawDescription, accB) || mentions(b.rawDescription, accA)) return true;
  // Note: "money into a credit card" alone is NOT enough; card refunds look exactly like that.
  return false;
}

export interface TransferPair {
  out: Row;
  in: Row;
}

/**
 * Find new pairs. With `ids`, only pairs involving those transactions (e.g.
 * just imported) are considered; otherwise the whole ledger.
 */
export function findTransferPairs(db: Db, ids?: string[]): TransferPair[] {
  const t = schema.transactions;
  const c = schema.categories;
  const g = schema.categoryGroups;
  const all: Row[] = db
    .select({
      id: t.id,
      accountId: t.accountId,
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      rawDescription: t.rawDescription,
      userModified: t.userModified,
      categoryId: t.categoryId,
      categoryKind: g.kind,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(c, eq(c.id, t.categoryId))
    .leftJoin(g, eq(g.id, c.groupId))
    .where(
      and(
        isNull(t.transferPairId),
        eq(t.pending, false),
        eq(t.notTransfer, false),
        sql`${t.amountCents} <> 0`,
        sql`not exists (select 1 from ${schema.transactionSplits} s where s.transaction_id = ${t.id})`,
      ),
    )
    .all();
  const accounts = new Map(
    db
      .select({
        id: schema.accounts.id,
        name: schema.accounts.name,
        institutionName: schema.accounts.institutionName,
        mask: schema.accounts.mask,
        type: schema.accounts.type,
      })
      .from(schema.accounts)
      .all()
      .map((a) => [a.id, a]),
  );

  // Index by absolute amount. A transaction you deliberately filed under a
  // spending/income category (e.g. a transfer to a kid's account you count as
  // "Kids & Family") isn't a transfer candidate.
  const byAmount = new Map<number, Row[]>();
  for (const r of all) {
    if (r.userModified && r.categoryKind !== null && r.categoryKind !== "transfer") continue;
    const k = Math.abs(r.amountCents);
    byAmount.set(k, [...(byAmount.get(k) ?? []), r]);
  }
  const focus = ids ? new Set(ids) : null;
  const used = new Set<string>();
  const pairs: TransferPair[] = [];
  const eligible = [...byAmount.values()].flat();
  const candidates = eligible
    .filter((r) => r.amountCents < 0 && (!focus || focus.has(r.id)))
    .concat(focus ? eligible.filter((r) => r.amountCents > 0 && focus.has(r.id)) : [])
    .sort((x, y) => x.postedDate.localeCompare(y.postedDate) || x.id.localeCompare(y.id));

  for (const r of candidates) {
    if (used.has(r.id)) continue;
    const accR = accounts.get(r.accountId);
    if (!accR) continue;
    let best: { row: Row; gap: number } | null = null;
    for (const o of byAmount.get(Math.abs(r.amountCents)) ?? []) {
      if (o.id === r.id || used.has(o.id) || o.accountId === r.accountId) continue;
      if (o.amountCents !== -r.amountCents) continue;
      const gap = Math.abs(dayNum(o.postedDate) - dayNum(r.postedDate));
      if (gap > MAX_DAYS) continue;
      const accO = accounts.get(o.accountId);
      if (!accO || !looksLikeTransfer(r, o, accR, accO)) continue;
      if (!best || gap < best.gap) best = { row: o, gap };
    }
    if (!best) continue;
    used.add(r.id);
    used.add(best.row.id);
    pairs.push(r.amountCents < 0 ? { out: r, in: best.row } : { out: best.row, in: r });
  }
  return pairs;
}

function transferCategoryIds(db: Db) {
  const find = (name: string) =>
    db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(sql`lower(${schema.categories.name}) = ${name.toLowerCase()}`)
      .get()?.id ?? null;
  return { card: find("Credit Card Payment"), internal: find("Internal Transfer") };
}

/** Pair them and give uncategorized / non-transfer sides a transfer category (unless hand-edited). */
export function applyTransferPairs(tx: Tx, pairs: TransferPair[]): number {
  if (pairs.length === 0) return 0;
  const t = schema.transactions;
  const cats = transferCategoryIds(tx);
  const types = new Map(
    tx
      .select({ id: schema.accounts.id, type: schema.accounts.type })
      .from(schema.accounts)
      .all()
      .map((a) => [a.id, a.type]),
  );
  for (const p of pairs) {
    const toLiability = LIABILITY.has(types.get(p.in.accountId) ?? "");
    const categoryId = toLiability ? (cats.card ?? cats.internal) : cats.internal;
    for (const [self, other] of [
      [p.out, p.in],
      [p.in, p.out],
    ] as const) {
      const set: Partial<typeof t.$inferInsert> = { transferPairId: other.id };
      if (!self.userModified && self.categoryKind !== "transfer" && categoryId)
        set.categoryId = categoryId;
      tx.update(t).set(set).where(eq(t.id, self.id)).run();
    }
  }
  return pairs.length;
}

/** Detect + apply for the given (new) transactions; used after import and sync. */
export function linkTransfersFor(tx: Tx, ids: string[]): number {
  if (ids.length === 0) return 0;
  return applyTransferPairs(tx, findTransferPairs(tx, ids));
}

export function previewTransfers(db: Db): TransferPreview {
  const pairs = findTransferPairs(db);
  const names = new Map(
    db
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .all()
      .map((a) => [a.id, a.name]),
  );
  return {
    pairs: pairs.length,
    sample: pairs
      .slice(-15)
      .reverse()
      .map((p) => ({
        date: p.out.postedDate,
        amountCents: Math.abs(p.out.amountCents),
        from: names.get(p.out.accountId) ?? "?",
        to: names.get(p.in.accountId) ?? "?",
        description: p.out.rawDescription,
      })),
  };
}

/** Unpair and remember the user's call so detection won't pair them again. */
export function dismissTransfer(tx: Tx, txnId: string) {
  const t = schema.transactions;
  const row = tx.select({ pair: t.transferPairId }).from(t).where(eq(t.id, txnId)).get();
  const ids = [txnId, ...(row?.pair ? [row.pair] : [])];
  tx.update(t).set({ transferPairId: null, notTransfer: true }).where(inArray(t.id, ids)).run();
}
