import {
  addDec,
  type BrokerageFile,
  type BrokeragePosition,
  fifoCost,
  parseBrokerageCsv,
  sameShares,
  toFixed,
  valueCents,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  CostSource,
  InvestAccount,
  InvestImportPreview,
  InvestImportResult,
  InvestPosition,
  InvestSummary,
  InvestTxn,
  SecurityKind,
} from "@muny/shared";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { localToday } from "../lib/dates.js";
import type { ConnectionInfo, InvestmentSync } from "../sync/types.js";
import { historyBySecurity } from "./history.js";

type Db = Pick<MunyDb, "select" | "insert" | "update" | "delete">;

const investmentAccounts = (db: Db) =>
  db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      institutionName: schema.accounts.institutionName,
      mask: schema.accounts.mask,
      hidden: schema.accounts.hidden,
      currentBalanceCents: schema.accounts.currentBalanceCents,
      provider: schema.connections.provider,
    })
    .from(schema.accounts)
    .leftJoin(schema.connections, eq(schema.connections.id, schema.accounts.connectionId))
    .where(eq(schema.accounts.type, "investment"))
    .all();

export function investSummary(db: Db, today = localToday()): InvestSummary {
  const accts = investmentAccounts(db).filter((a) => !a.hidden);
  const ids = accts.map((a) => a.id);
  const h = schema.investmentHoldings;
  const s = schema.securities;
  const rows = ids.length
    ? db
        .select({
          accountId: h.accountId,
          securityId: h.securityId,
          quantity: h.quantity,
          price: h.price,
          valueCents: h.valueCents,
          costBasisCents: h.costBasisCents,
          asOf: h.asOf,
          source: h.source,
          symbol: s.symbol,
          name: s.name,
          type: s.type,
        })
        .from(h)
        .innerJoin(s, eq(s.id, h.securityId))
        .where(inArray(h.accountId, ids))
        .all()
        .map((x) => ({
          ...x,
          costSource: (x.costBasisCents === null ? null : "broker") as CostSource,
        }))
    : [];

  // Brokers that don't report cost: what you entered, else the trades (when they explain every share).
  const missing = rows.filter((x) => x.costBasisCents === null && x.type !== "cash");
  if (missing.length) {
    const entered = new Map(
      db
        .select()
        .from(schema.holdingCosts)
        .where(inArray(schema.holdingCosts.accountId, ids))
        .all()
        .map((c) => [`${c.accountId}|${c.securityId}`, c.costBasisCents]),
    );
    const t = schema.investmentTxns;
    const trades = db
      .select({
        accountId: t.accountId,
        securityId: t.securityId,
        date: t.date,
        type: t.type,
        quantity: t.quantity,
        amountCents: t.amountCents,
      })
      .from(t)
      .where(
        and(
          inArray(t.accountId, ids),
          inArray(
            t.securityId,
            missing.map((x) => x.securityId),
          ),
        ),
      )
      .all();
    for (const x of missing) {
      const mine = entered.get(`${x.accountId}|${x.securityId}`);
      if (mine !== undefined) {
        x.costBasisCents = mine;
        x.costSource = "entered";
        continue;
      }
      const fifo = fifoCost(
        trades.filter((y) => y.accountId === x.accountId && y.securityId === x.securityId),
      );
      if (fifo && fifo.costCents > 0 && sameShares(fifo.quantity, x.quantity)) {
        x.costBasisCents = fifo.costCents;
        x.costSource = "trades";
      }
    }
  }

  const nameOf = new Map(accts.map((a) => [a.id, a.name]));
  const positions = new Map<string, InvestPosition>();
  const accounts: InvestAccount[] = accts.map((a) => {
    const mine = rows.filter((r) => r.accountId === a.id);
    const value = mine.reduce((t, r) => t + r.valueCents, 0);
    const cash = mine.filter((r) => r.type === "cash").reduce((t, r) => t + r.valueCents, 0);
    const invested = mine.filter((r) => r.type !== "cash");
    const known = invested.every((r) => r.costBasisCents !== null);
    const cost = invested.reduce((t, r) => t + (r.costBasisCents ?? 0), 0);
    return {
      id: a.id,
      name: a.name,
      institutionName: a.institutionName,
      mask: a.mask,
      // No holdings yet (e.g. a Plaid account before the investments sync): its balance.
      valueCents: mine.length ? value : (a.currentBalanceCents ?? 0),
      cashCents: cash,
      costBasisCents: invested.length && known ? cost : null,
      gainCents: invested.length && known ? value - cash - cost : null,
      holdings: invested.length,
      asOf: mine.reduce<string | null>((m, r) => (m && m > r.asOf ? m : r.asOf), null),
      source: mine[0]?.source ?? null,
      provider: a.provider ?? null,
    };
  });

  for (const r of rows) {
    const p = positions.get(r.securityId) ?? {
      securityId: r.securityId,
      symbol: r.symbol,
      name: r.name,
      type: r.type as SecurityKind,
      quantity: "0",
      price: r.price,
      valueCents: 0,
      costBasisCents: 0,
      gainCents: 0,
      accounts: [],
    };
    p.quantity = addDec(p.quantity, r.quantity);
    p.valueCents += r.valueCents;
    p.price = p.price ?? r.price;
    p.costBasisCents =
      r.type === "cash"
        ? p.valueCents
        : p.costBasisCents === null || r.costBasisCents === null
          ? null
          : p.costBasisCents + r.costBasisCents;
    p.accounts.push({
      accountId: r.accountId,
      accountName: nameOf.get(r.accountId) ?? "",
      quantity: r.quantity,
      valueCents: r.valueCents,
      costBasisCents: r.type === "cash" ? null : r.costBasisCents,
      costSource: r.type === "cash" ? null : r.costSource,
    });
    positions.set(r.securityId, p);
  }
  for (const p of positions.values())
    p.gainCents = p.costBasisCents === null ? null : p.valueCents - p.costBasisCents;
  const list = [...positions.values()].sort((a, b) => b.valueCents - a.valueCents);

  const alloc = new Map<SecurityKind, number>();
  for (const p of list) alloc.set(p.type, (alloc.get(p.type) ?? 0) + p.valueCents);
  // Accounts with a balance but no holdings yet still count (as "other").
  const bare = accounts.filter((a) => a.holdings === 0 && a.cashCents === 0 && a.valueCents);
  for (const a of bare) alloc.set("other", (alloc.get("other") ?? 0) + a.valueCents);

  const invested = list.filter((p) => p.type !== "cash");
  const withCost = invested.filter((p) => p.costBasisCents !== null);

  // Value over time: each account's recorded balances, carried forward.
  const snaps = ids.length
    ? db
        .select()
        .from(schema.balanceSnapshots)
        .where(inArray(schema.balanceSnapshots.accountId, ids))
        .orderBy(schema.balanceSnapshots.date)
        .all()
    : [];
  const dates = [...new Set(snaps.map((x) => x.date))].sort();
  const last = new Map<string, number>();
  const history = dates.map((date) => {
    for (const x of snaps) if (x.date === date) last.set(x.accountId, x.balanceCents);
    return { date, valueCents: [...last.values()].reduce((t, v) => t + v, 0) };
  });

  const yearAgo = new Date(`${today}T00:00:00Z`);
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const t = schema.investmentTxns;
  const income = ids.length
    ? (db
        .select({ cents: sql<number>`coalesce(sum(${t.amountCents}), 0)` })
        .from(t)
        .where(
          and(
            inArray(t.accountId, ids),
            inArray(t.type, ["dividend", "interest"]),
            gte(t.date, yearAgo.toISOString().slice(0, 10)),
          ),
        )
        .get()?.cents ?? 0)
    : 0;

  return {
    valueCents: accounts.reduce((t, a) => t + a.valueCents, 0),
    cashCents: accounts.reduce((t, a) => t + a.cashCents, 0),
    costBasisCents: withCost.reduce((t, p) => t + (p.costBasisCents ?? 0), 0),
    gainCents: withCost.reduce((t, p) => t + (p.gainCents ?? 0), 0),
    unknownCostValueCents: invested
      .filter((p) => p.costBasisCents === null)
      .reduce((t, p) => t + p.valueCents, 0),
    accounts: accounts.sort((a, b) => b.valueCents - a.valueCents),
    positions: list,
    allocation: [...alloc]
      .map(([type, valueCents]) => ({ type, valueCents }))
      .sort((a, b) => b.valueCents - a.valueCents),
    history,
    incomeLast12Cents: Number(income),
    historyBySecurity: historyBySecurity(
      db as MunyDb,
      ids,
      history,
      list
        .filter((p) => p.type !== "cash" && p.valueCents > 0)
        .slice(0, 7)
        .map((p) => ({ securityId: p.securityId, symbol: p.symbol })),
    ),
    estimatedUntil: snaps
      .filter((x) => x.estimated)
      .reduce<string | null>((m, x) => (m && m > x.date ? m : x.date), null),
  };
}

export function listInvestTxns(
  db: Db,
  q: { accountId?: string; before?: string; limit?: number } = {},
): InvestTxn[] {
  const t = schema.investmentTxns;
  const s = schema.securities;
  const conds = [
    q.accountId ? eq(t.accountId, q.accountId) : undefined,
    q.before ? lt(t.date, q.before) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select({
      id: t.id,
      accountId: t.accountId,
      accountName: schema.accounts.name,
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
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(s, eq(s.id, t.securityId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(t.date), desc(t.createdAt))
    .limit(Math.min(q.limit ?? 200, 1000))
    .all();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function read(content: string): BrokerageFile {
  return parseBrokerageCsv(content);
}

/** The existing investment account a file's account most likely is. */
function matchAccount(
  db: Db,
  broker: string,
  ref: { mask: string | null; label: string },
): string | null {
  const accts = investmentAccounts(db);
  if (ref.mask) {
    const byMask = accts.filter(
      (a) =>
        a.mask && (a.mask.endsWith(ref.mask as string) || (ref.mask as string).endsWith(a.mask)),
    );
    if (byMask.length === 1) return byMask[0]?.id ?? null;
  }
  const sameBroker = accts.filter((a) =>
    (a.institutionName ?? a.name).toLowerCase().includes(broker.toLowerCase()),
  );
  return sameBroker.length === 1 && !ref.mask ? (sameBroker[0]?.id ?? null) : null;
}

export function previewInvestImport(db: Db, content: string): InvestImportPreview {
  const f = read(content);
  const dates = f.activity.map((a) => a.date).sort();
  return {
    broker: f.broker,
    accounts: f.accounts.map((a) => ({
      ref: a.ref,
      label: a.label,
      mask: a.mask,
      positions: f.positions.filter((p) => p.accountRef === a.ref).length,
      activity: f.activity.filter((x) => x.accountRef === a.ref).length,
      valueCents: f.positions
        .filter((p) => p.accountRef === a.ref)
        .reduce((t, p) => t + p.valueCents, 0),
      matchId: matchAccount(db, f.broker, a),
    })),
    positions: f.positions.length,
    activity: f.activity.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    skipped: f.skipped.length,
  };
}

/** Find a security by ticker, or add it. */
export function securityFor(
  db: Db,
  p: { symbol: string; name: string; type: SecurityKind },
  /** The broker says what it is (positions): correct a guess made from history. */
  refine = false,
): string {
  const symbol = p.symbol.toUpperCase();
  const found = db
    .select({ id: schema.securities.id, type: schema.securities.type })
    .from(schema.securities)
    .where(eq(schema.securities.symbol, symbol))
    .get();
  if (found) {
    if (refine && found.type !== p.type)
      db.update(schema.securities)
        .set({ type: p.type, ...(p.name ? { name: p.name.slice(0, 200) } : {}) })
        .where(eq(schema.securities.id, found.id))
        .run();
    return found.id;
  }
  const id = newId();
  db.insert(schema.securities)
    .values({ id, symbol, name: p.name.slice(0, 200) || symbol, type: p.type })
    .run();
  return id;
}

/** Replace an account's holdings with what the broker reports, and record its value. */
export function setHoldings(
  db: Db,
  accountId: string,
  list: Omit<BrokeragePosition, "accountRef">[],
  source: "plaid" | "import",
  asOf: string,
) {
  db.delete(schema.investmentHoldings)
    .where(eq(schema.investmentHoldings.accountId, accountId))
    .run();
  const merged = new Map<string, (typeof list)[number] & { securityId: string }>();
  for (const p of list) {
    const securityId = securityFor(db, p, true);
    const prev = merged.get(securityId);
    merged.set(
      securityId,
      prev
        ? {
            ...prev,
            quantity: addDec(prev.quantity, p.quantity),
            valueCents: prev.valueCents + p.valueCents,
            costBasisCents:
              prev.costBasisCents === null || p.costBasisCents === null
                ? null
                : prev.costBasisCents + p.costBasisCents,
          }
        : { ...p, securityId },
    );
  }
  for (const p of merged.values()) {
    db.insert(schema.investmentHoldings)
      .values({
        accountId,
        securityId: p.securityId,
        quantity: p.quantity,
        price: p.price,
        valueCents: p.valueCents,
        costBasisCents: p.costBasisCents,
        asOf,
        source,
      })
      .run();
    if (p.price && p.type !== "cash" && toFixed(p.price) > 0n)
      db.insert(schema.securityPrices)
        .values({ securityId: p.securityId, date: asOf, close: p.price, source })
        .onConflictDoUpdate({
          target: [schema.securityPrices.securityId, schema.securityPrices.date],
          set: { close: p.price, source },
        })
        .run();
  }
  const total = [...merged.values()].reduce((t, p) => t + p.valueCents, 0);
  db.update(schema.accounts)
    .set({ currentBalanceCents: total, balanceSource: "reported" })
    .where(eq(schema.accounts.id, accountId))
    .run();
  db.insert(schema.balanceSnapshots)
    .values({ accountId, date: asOf, balanceCents: total })
    .onConflictDoUpdate({
      target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
      set: { balanceCents: total, estimated: false },
    })
    .run();
  return merged.size;
}

export function importInvestFile(
  db: Db,
  content: string,
  targets: Record<string, string>,
  today = localToday(),
): InvestImportResult {
  const f = read(content);
  let accountsCreated = 0;
  let holdingsUpdated = 0;
  let added = 0;
  let duplicates = 0;
  for (const ref of f.accounts) {
    let accountId = targets[ref.ref];
    if (!accountId) continue; // skipped by the user
    if (accountId === "new") {
      let conn = db
        .select({ id: schema.connections.id })
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.provider, "file"),
            eq(schema.connections.institutionName, f.broker),
          ),
        )
        .get()?.id;
      if (!conn) {
        conn = newId();
        db.insert(schema.connections)
          .values({ id: conn, provider: "file", institutionName: f.broker })
          .run();
      }
      accountId = newId();
      db.insert(schema.accounts)
        .values({
          id: accountId,
          connectionId: conn,
          name: ref.label && ref.label !== f.broker ? `${f.broker} ${ref.label}` : f.broker,
          institutionName: f.broker,
          mask: ref.mask,
          type: "investment",
          balanceSource: "reported",
          currentBalanceCents: 0,
        })
        .run();
      accountsCreated++;
    } else {
      const ok = db
        .select({ type: schema.accounts.type })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (ok?.type !== "investment") throw new Error("Pick an investment account");
    }

    const pos = f.positions.filter((p) => p.accountRef === ref.ref);
    if (pos.length) {
      setHoldings(db, accountId, pos, "import", today);
      holdingsUpdated++;
    }
    for (const a of f.activity.filter((x) => x.accountRef === ref.ref)) {
      const securityId = a.symbol
        ? securityFor(db, { symbol: a.symbol, name: a.name ?? a.symbol, type: "equity" })
        : null;
      const r = db
        .insert(schema.investmentTxns)
        .values({
          id: newId(),
          accountId,
          securityId,
          date: a.date,
          type: a.type,
          quantity: a.quantity,
          price: a.price,
          amountCents: a.amountCents,
          feesCents: a.feesCents,
          description: a.description,
          externalId: a.externalId,
          source: "import",
        })
        .onConflictDoNothing()
        .run();
      if (r.changes) added++;
      else duplicates++;
    }
  }
  return { accountsCreated, holdingsUpdated, added, duplicates };
}

// ---------------------------------------------------------------------------
// Bank-sync providers (Plaid Investments)
// ---------------------------------------------------------------------------

/** The date to fetch history from: a month before the newest synced row (null: everything). */
export function investSyncSince(db: Db, connectionId: string): string | null {
  const t = schema.investmentTxns;
  const row = db
    .select({ last: sql<string | null>`max(${t.date})` })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .where(and(eq(schema.accounts.connectionId, connectionId), eq(t.source, "plaid")))
    .get();
  if (!row?.last) return null;
  const d = new Date(`${row.last}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

/**
 * Store a provider's holdings and history for a connection's linked accounts.
 * The account's reported balance is the truth for its value: any part of it
 * not in a holding is cash.
 */
export function applyInvestmentSync(
  db: Db,
  connectionId: string,
  info: ConnectionInfo,
  inv: InvestmentSync,
  today = localToday(),
): { accounts: number; added: number } {
  const linked = db
    .select({ id: schema.accounts.id, ref: schema.accounts.providerAccountRef })
    .from(schema.accounts)
    .where(eq(schema.accounts.connectionId, connectionId))
    .all();
  const idOf = new Map(linked.filter((a) => a.ref).map((a) => [a.ref as string, a.id]));
  let accounts = 0;
  for (const pa of info.accounts) {
    const accountId = idOf.get(pa.ref);
    if (!accountId || pa.type !== "investment") continue;
    const list: Omit<BrokeragePosition, "accountRef">[] = inv.holdings
      .filter((h) => h.accountRef === pa.ref)
      .map(({ accountRef: _, ...h }) => h);
    const held = list.reduce((t, h) => t + h.valueCents, 0);
    const cash = pa.balanceCents === null ? 0 : pa.balanceCents - held;
    if (cash > 0)
      list.push({
        symbol: "CASH",
        name: "Cash",
        type: "cash",
        quantity: `${Math.floor(cash / 100)}.${String(cash % 100).padStart(2, "0")}`,
        price: "1",
        valueCents: cash,
        costBasisCents: cash,
      });
    if (!list.length) continue;
    setHoldings(db, accountId, list, "plaid", today);
    accounts++;
  }
  let added = 0;
  for (const t of inv.txns) {
    const accountId = idOf.get(t.accountRef);
    if (!accountId) continue;
    const securityId = t.symbol
      ? securityFor(db, { symbol: t.symbol, name: t.name ?? t.symbol, type: "equity" })
      : null;
    const r = db
      .insert(schema.investmentTxns)
      .values({
        id: newId(),
        accountId,
        securityId,
        date: t.date,
        type: t.type,
        quantity: t.quantity,
        price: t.price,
        amountCents: t.amountCents,
        feesCents: t.feesCents,
        description: t.description,
        externalId: `plaid:${t.ref}`,
        source: "plaid",
      })
      .onConflictDoNothing()
      .run();
    if (r.changes) added++;
  }
  return { accounts, added };
}

/** Enter (or clear, with null) what you paid for a holding, as a total or per share. */
export function setHoldingCost(
  db: Db,
  accountId: string,
  securityId: string,
  input: { totalCents: number } | { perShare: string } | null,
): boolean {
  const held = db
    .select({ quantity: schema.investmentHoldings.quantity })
    .from(schema.investmentHoldings)
    .where(
      and(
        eq(schema.investmentHoldings.accountId, accountId),
        eq(schema.investmentHoldings.securityId, securityId),
      ),
    )
    .get();
  if (!held) return false;
  const k = schema.holdingCosts;
  if (input === null) {
    db.delete(k)
      .where(and(eq(k.accountId, accountId), eq(k.securityId, securityId)))
      .run();
    return true;
  }
  const cents =
    "totalCents" in input ? input.totalCents : valueCents(held.quantity, input.perShare);
  db.insert(k)
    .values({ accountId, securityId, costBasisCents: cents })
    .onConflictDoUpdate({ target: [k.accountId, k.securityId], set: { costBasisCents: cents } })
    .run();
  return true;
}
