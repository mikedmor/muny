import { toFixed, valueCents } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { InvestTxnKind, InvestTxnPage, TaxTreatment } from "@muny/shared";
import { and, desc, eq, gte, like, lte, or, type SQL, sql } from "drizzle-orm";
import { securityFor } from "./service.js";

/**
 * The Stocks → Transactions page: every trade, dividend and transfer, with
 * filters; trades you add yourself (to fill in history a broker didn't send);
 * and each account's tax treatment.
 */

export interface TxnFilter {
  accountId?: string;
  securityId?: string;
  type?: InvestTxnKind;
  from?: string;
  to?: string;
  q?: string;
  offset?: number;
  limit?: number;
}

export function pageInvestTxns(db: MunyDb, f: TxnFilter): InvestTxnPage {
  const t = schema.investmentTxns;
  const s = schema.securities;
  const a = schema.accounts;
  const search = f.q?.trim().toLowerCase();
  const conds = [
    f.accountId ? eq(t.accountId, f.accountId) : undefined,
    f.securityId ? eq(t.securityId, f.securityId) : undefined,
    f.type ? eq(t.type, f.type) : undefined,
    f.from ? gte(t.date, f.from) : undefined,
    f.to ? lte(t.date, f.to) : undefined,
    search
      ? or(
          like(sql`lower(${s.symbol})`, `%${search}%`),
          like(sql`lower(${s.name})`, `%${search}%`),
          like(sql`lower(${t.description})`, `%${search}%`),
        )
      : undefined,
  ].filter((c): c is SQL => c !== undefined);
  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(f.limit ?? 50, 500);
  const offset = f.offset ?? 0;
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .innerJoin(a, eq(a.id, t.accountId))
      .leftJoin(s, eq(s.id, t.securityId))
      .where(where)
      .get()?.n ?? 0;
  const items = db
    .select({
      id: t.id,
      accountId: t.accountId,
      accountName: a.name,
      date: t.date,
      type: t.type,
      symbol: s.symbol,
      securityName: s.name,
      quantity: t.quantity,
      price: t.price,
      amountCents: t.amountCents,
      feesCents: t.feesCents,
      description: t.description,
      source: t.source,
    })
    .from(t)
    .innerJoin(a, eq(a.id, t.accountId))
    .leftJoin(s, eq(s.id, t.securityId))
    .where(where)
    .orderBy(desc(t.date), desc(t.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
  return { items, total: Number(total), offset, limit };
}

export class TxnError extends Error {}

/** Which way the money goes for each kind (the amount you enter is always positive). */
const MONEY_OUT = new Set<InvestTxnKind>(["buy", "fee", "tax", "withdrawal"]);
const NO_MONEY = new Set<InvestTxnKind>(["split", "transfer_in", "transfer_out"]);
const SHARES = new Set<InvestTxnKind>(["buy", "sell", "split", "transfer_in", "transfer_out"]);

export interface ManualTxn {
  accountId: string;
  type: InvestTxnKind;
  date: string;
  symbol?: string;
  quantity?: string;
  price?: string;
  /** What changed hands, positive: a buy's total cost (fees included), a sale's net proceeds, a dividend. */
  totalCents?: number;
  feesCents?: number;
  description?: string;
}

export function addInvestTxn(db: MunyDb, m: ManualTxn): { id: string } {
  const acct = db
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, m.accountId))
    .get();
  if (acct?.type !== "investment") throw new TxnError("Choose one of your investment accounts.");
  const symbol = m.symbol?.trim().toUpperCase();
  if (SHARES.has(m.type) || m.type === "dividend") {
    if (!symbol) throw new TxnError("Enter the ticker.");
  }
  if (SHARES.has(m.type) && (!m.quantity || toFixed(m.quantity) <= 0n))
    throw new TxnError("Enter how many shares.");
  let total = m.totalCents;
  if (total === undefined && m.quantity && m.price) {
    const gross = valueCents(m.quantity, m.price);
    const fees = m.feesCents ?? 0;
    total = m.type === "buy" ? gross + fees : m.type === "sell" ? Math.max(0, gross - fees) : gross;
  }
  if (!NO_MONEY.has(m.type) && (total === undefined || total < 0))
    throw new TxnError("Enter the amount.");
  const amountCents = NO_MONEY.has(m.type)
    ? 0
    : MONEY_OUT.has(m.type)
      ? -(total ?? 0)
      : (total ?? 0);
  const securityId = symbol ? securityFor(db, { symbol, name: symbol, type: "equity" }) : null;
  const id = newId();
  db.insert(schema.investmentTxns)
    .values({
      id,
      accountId: m.accountId,
      securityId,
      date: m.date,
      type: m.type,
      quantity: m.quantity ?? null,
      price: m.price ?? null,
      amountCents,
      feesCents: m.feesCents ?? 0,
      description: m.description?.slice(0, 200) || null,
      externalId: `manual:${id}`,
      source: "manual",
    })
    .run();
  return { id };
}

/** Remove a trade you added or imported (a synced one would only come back). */
export function deleteInvestTxn(db: MunyDb, id: string): "ok" | "missing" | "synced" {
  const row = db
    .select({ source: schema.investmentTxns.source })
    .from(schema.investmentTxns)
    .where(eq(schema.investmentTxns.id, id))
    .get();
  if (!row) return "missing";
  if (row.source === "plaid") return "synced";
  db.delete(schema.investmentTxns).where(eq(schema.investmentTxns.id, id)).run();
  return "ok";
}

/** Set (or clear back to Muny's guess) how an investment account is taxed. */
export function setTaxTreatment(db: MunyDb, accountId: string, t: TaxTreatment | null): boolean {
  return (
    db
      .update(schema.accounts)
      .set({ taxTreatment: t })
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.type, "investment")))
      .run().changes > 0
  );
}
