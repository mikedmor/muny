import {
  addDaysIso,
  type Disposal,
  estimateWashSales,
  fromFixed,
  type LotTxn,
  longTermDate,
  lotCostCents,
  lotKey,
  type OpenLot,
  roundCents,
  runStockLots,
  sameShares,
  termOn,
  toFixed,
} from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import {
  type B1099Totals,
  guessTaxTreatment,
  type RealizedByTerm,
  type ReconcileReport,
  type ReconcileRow,
  type SecurityKind,
  type StockSale,
  type StockTaxAccount,
  type StockTaxAsset,
  type StockTaxReport,
  type StockTermPart,
  type TaxTerm,
  type TaxTreatment,
} from "@muny/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { localToday } from "../lib/dates.js";

/**
 * The tax side of stocks (D-088), read-only: lots from your trades (first in,
 * first out, per account), each sale's gain by holding period, wash sales
 * across all accounts, what's held short and long term, and how your trades
 * compare with what each broker reports. Only taxable accounts count toward
 * gains and dividends; IRAs and the like are listed as sheltered.
 */

const ONE = toFixed(1);

interface Acct {
  id: string;
  name: string;
  institutionName: string | null;
  mask: string | null;
  subtype: string | null;
  taxTreatment: TaxTreatment | null;
  currentBalanceCents: number | null;
}

export const treatmentOf = (a: Pick<Acct, "taxTreatment" | "subtype" | "name">): TaxTreatment =>
  a.taxTreatment ?? guessTaxTreatment(a.subtype, a.name);

/** Everything the tax views need, loaded once. */
function load(db: MunyDb) {
  const a = schema.accounts;
  const accts: Acct[] = db
    .select({
      id: a.id,
      name: a.name,
      institutionName: a.institutionName,
      mask: a.mask,
      subtype: a.subtype,
      taxTreatment: a.taxTreatment,
      currentBalanceCents: a.currentBalanceCents,
    })
    .from(a)
    .where(and(eq(a.type, "investment"), eq(a.hidden, false)))
    .all();
  const ids = accts.map((x) => x.id);
  const t = schema.investmentTxns;
  const s = schema.securities;
  const txns = ids.length
    ? db
        .select({
          id: t.id,
          accountId: t.accountId,
          securityId: t.securityId,
          date: t.date,
          type: t.type,
          quantity: t.quantity,
          amountCents: t.amountCents,
          symbol: s.symbol,
          name: s.name,
          secType: s.type,
        })
        .from(t)
        .innerJoin(s, eq(s.id, t.securityId))
        .where(and(inArray(t.accountId, ids), isNotNull(t.securityId)))
        .all()
    : [];
  const h = schema.investmentHoldings;
  const holdings = ids.length
    ? db
        .select({
          accountId: h.accountId,
          securityId: h.securityId,
          quantity: h.quantity,
          price: h.price,
          valueCents: h.valueCents,
          costBasisCents: h.costBasisCents,
          symbol: s.symbol,
          name: s.name,
          type: s.type,
        })
        .from(h)
        .innerJoin(s, eq(s.id, h.securityId))
        .where(inArray(h.accountId, ids))
        .all()
    : [];
  const entered = new Map(
    db
      .select()
      .from(schema.holdingCosts)
      .all()
      .map((c) => [lotKey(c.accountId, c.securityId), c.costBasisCents]),
  );
  const run = runStockLots(txns.filter((x) => x.secType !== "cash") as LotTxn[]);
  const buys = txns
    .filter((x) => x.type === "buy" && x.quantity)
    .map((x) => ({
      txnId: x.id,
      accountId: x.accountId,
      securityId: x.securityId as string,
      date: x.date,
      quantity: x.quantity as string,
    }));
  const wash = estimateWashSales(run.disposals, buys);
  const treat = new Map(accts.map((x) => [x.id, treatmentOf(x)]));
  const securities = new Map<string, { symbol: string; name: string; type: SecurityKind }>();
  for (const x of txns)
    securities.set(x.securityId as string, { symbol: x.symbol, name: x.name, type: x.secType });
  for (const x of holdings)
    securities.set(x.securityId, { symbol: x.symbol, name: x.name, type: x.type });
  return { accts, txns, holdings, entered, run, buys, wash, treat, securities };
}

/** Lots for one holding, lined up with what the broker reports holding now. */
function lotsForHolding(
  open: OpenLot[] | undefined,
  held: { quantity: string; costBasisCents: number | null },
): OpenLot[] {
  const lots = (open ?? []).map((l) => ({ ...l }));
  const want = toFixed(held.quantity);
  const have = lots.reduce((s, l) => s + l.q, 0n);
  if (sameShares(fromFixed(have), held.quantity)) return lots;
  if (have > want) {
    // The trades say more than the broker holds: a sale is missing; the oldest shares went first.
    let extra = have - want;
    while (extra > 0n && lots.length) {
      const l = lots[0] as OpenLot;
      if (l.q <= extra) {
        extra -= l.q;
        lots.shift();
      } else {
        if (l.cost !== null) l.cost -= (l.cost * extra) / l.q;
        l.q -= extra;
        extra = 0n;
      }
    }
    return lots;
  }
  // The broker holds more: shares bought before your history. Their cost is what's left of the broker's.
  const known = lots.every((l) => l.cost !== null);
  const lotCost = lots.reduce((s, l) => s + (l.cost ?? 0n), 0n);
  const rest =
    held.costBasisCents !== null && known ? BigInt(held.costBasisCents) * ONE - lotCost : null;
  lots.unshift({
    txnId: null,
    accountId: "",
    securityId: "",
    acquired: null,
    q: want - have,
    cost: rest !== null && rest >= 0n ? rest : null,
  });
  return lots;
}

const emptyPart = (): StockTermPart => ({ quantity: "0", costCents: 0, valueCents: 0 });

function maturityFrom(assets: StockTaxAsset[], today: string): StockTaxReport["maturity"] {
  const total = assets.reduce((s, a) => s + a.valueCents, 0);
  const out: StockTaxReport["maturity"] = [];
  const [y, m] = today.split("-").map(Number) as [number, number];
  for (let i = 0; i <= 12; i++) {
    const date = i === 0 ? today : new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10);
    let long = 0;
    for (const a of assets) {
      const held = toFixed(a.quantity);
      if (held <= 0n) continue;
      for (const l of a.lots)
        if (l.longFrom && l.longFrom <= date)
          long += Number((BigInt(a.valueCents) * toFixed(l.quantity)) / held);
    }
    out.push({ date, longPct: total > 0 ? Math.min(100, (long / total) * 100) : 0 });
  }
  return out;
}

export function stockTaxReport(db: MunyDb, year: number, today = localToday()): StockTaxReport {
  const d = load(db);
  const nameOf = new Map(d.accts.map((a) => [a.id, a.name]));
  const taxable = (accountId: string) => d.treat.get(accountId) === "taxable";

  // What's held in taxable accounts, split by holding period.
  const assets: StockTaxAsset[] = [];
  for (const h of d.holdings) {
    if (h.type === "cash" || !taxable(h.accountId)) continue;
    if (toFixed(h.quantity) <= 0n) continue;
    const key = lotKey(h.accountId, h.securityId);
    const cost = h.costBasisCents ?? d.entered.get(key) ?? null;
    const lots = lotsForHolding(d.run.open.get(key), {
      quantity: h.quantity,
      costBasisCents: cost,
    });
    const held = toFixed(h.quantity);
    const parts = { short: emptyPart(), long: emptyPart(), unknown: emptyPart() };
    let given = 0;
    const out = lots.map((l, i) => {
      const value =
        i === lots.length - 1 ? h.valueCents - given : Number((BigInt(h.valueCents) * l.q) / held);
      given += value;
      const term = termOn(l.acquired, today);
      const p = parts[term];
      p.quantity = fromFixed(toFixed(p.quantity) + l.q);
      p.costCents += lotCostCents(l) ?? 0;
      p.valueCents = (p.valueCents ?? 0) + value;
      return {
        accountId: h.accountId,
        accountName: nameOf.get(h.accountId) ?? "",
        acquired: l.acquired,
        quantity: fromFixed(l.q),
        costCents: lotCostCents(l),
        longFrom: l.acquired ? longTermDate(l.acquired) : null,
      };
    });
    const since = addDaysIso(today, -30);
    const recent = d.buys
      .filter((b) => b.securityId === h.securityId && b.date >= since && b.date <= today)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    assets.push({
      accountId: h.accountId,
      accountName: nameOf.get(h.accountId) ?? "",
      securityId: h.securityId,
      symbol: h.symbol,
      name: h.name,
      type: h.type as SecurityKind,
      quantity: h.quantity,
      price: h.price,
      valueCents: h.valueCents,
      short: parts.short,
      long: parts.long,
      unknown: parts.unknown,
      lots: out,
      missingCost: out.some((l) => l.costCents === null),
      washUntil: recent ? addDaysIso(recent.date, 30) : null,
      recentBuy: recent
        ? {
            date: recent.date,
            accountName: nameOf.get(recent.accountId) ?? "",
            treatment: d.treat.get(recent.accountId) ?? "taxable",
          }
        : null,
    });
  }
  assets.sort((a, b) => b.valueCents - a.valueCents);

  // This year's sales in taxable accounts.
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const realized: RealizedByTerm = {
    short: { profitCents: 0, lossCents: 0 },
    long: { profitCents: 0, lossCents: 0 },
    unknown: { profitCents: 0, lossCents: 0 },
  };
  const sales: StockSale[] = [];
  let washCents = 0;
  d.run.disposals.forEach((x, i) => {
    if (x.date < from || x.date > to || !taxable(x.accountId)) return;
    const sec = d.securities.get(x.securityId);
    const gain = x.costCents === null ? null : x.proceedsCents - x.costCents;
    const w = d.wash.cents[i] ?? 0;
    const repl = d.wash.replacementAccount[i];
    if (gain !== null) {
      const r = realized[x.term];
      if (gain >= 0) r.profitCents += gain;
      else r.lossCents += gain;
    }
    washCents += w;
    sales.push(saleOf(x, sec, nameOf.get(x.accountId) ?? "", gain, w, repl, d.treat));
  });
  sales.sort((a, b) => b.date.localeCompare(a.date));

  let dividendsCents = 0;
  let interestCents = 0;
  const bySymbol = new Map<string, number>();
  for (const x of d.txns) {
    if (x.date < from || x.date > to || !taxable(x.accountId)) continue;
    if (x.type === "dividend") {
      dividendsCents += x.amountCents;
      bySymbol.set(x.symbol, (bySymbol.get(x.symbol) ?? 0) + x.amountCents);
    } else if (x.type === "interest") interestCents += x.amountCents;
  }
  // Interest with no security (cash sweeps) is stored without one.
  const t = schema.investmentTxns;
  const ids = d.accts.filter((a) => taxable(a.id)).map((a) => a.id);
  if (ids.length)
    for (const x of db
      .select({ amountCents: t.amountCents, date: t.date, type: t.type, securityId: t.securityId })
      .from(t)
      .where(inArray(t.accountId, ids))
      .all())
      if (!x.securityId && x.type === "interest" && x.date >= from && x.date <= to)
        interestCents += x.amountCents;

  // Value per account (holdings, else the reported balance).
  const accountValue = new Map<string, number>();
  for (const h of d.holdings)
    accountValue.set(h.accountId, (accountValue.get(h.accountId) ?? 0) + h.valueCents);
  const accounts: StockTaxAccount[] = d.accts.map((a) => ({
    id: a.id,
    name: a.name,
    institutionName: a.institutionName,
    mask: a.mask,
    treatment: treatmentOf(a),
    guessed: a.taxTreatment === null,
    guess: guessTaxTreatment(a.subtype, a.name),
    valueCents: accountValue.get(a.id) ?? a.currentBalanceCents ?? 0,
  }));
  const sheltered = { deferredCents: 0, exemptCents: 0 };
  for (const a of accounts)
    if (a.treatment === "deferred") sheltered.deferredCents += a.valueCents;
    else if (a.treatment === "exempt") sheltered.exemptCents += a.valueCents;

  return {
    year,
    today,
    accounts,
    realized,
    washCents,
    sales,
    dividendsCents,
    interestCents,
    dividendsBySymbol: [...bySymbol]
      .map(([symbol, cents]) => ({ symbol, cents }))
      .sort((a, b) => b.cents - a.cents),
    assets,
    maturity: maturityFrom(assets, today),
    sheltered,
    needsReconcile: reconcileRows(d).filter((r) => r.status !== "ok" && r.treatment === "taxable")
      .length,
  };
}

function saleOf(
  x: Disposal,
  sec: { symbol: string; name: string } | undefined,
  accountName: string,
  gain: number | null,
  washCents: number,
  replacementAccount: string | null | undefined,
  treat: Map<string, TaxTreatment>,
): StockSale {
  return {
    txnId: x.txnId,
    date: x.date,
    accountId: x.accountId,
    accountName,
    securityId: x.securityId,
    symbol: sec?.symbol ?? "",
    name: sec?.name ?? "",
    quantity: fromFixed(x.q),
    proceedsCents: x.proceedsCents,
    costCents: x.costCents,
    gainCents: gain,
    term: x.term,
    acquired: x.acquired,
    various: x.various,
    washCents,
    washInRetirement:
      washCents > 0 && !!replacementAccount && treat.get(replacementAccount) !== "taxable",
  };
}

/** Muny's own sales for an account (or all taxable accounts) and year, by term, to compare with a 1099-B. */
export function munyTotals(
  db: MunyDb,
  year: number,
  accountId: string | null,
): Record<TaxTerm, B1099Totals> {
  const r = stockTaxReport(db, year);
  const out: Record<TaxTerm, B1099Totals> = {
    short: { proceedsCents: 0, costCents: 0, washCents: 0, gainCents: 0, count: 0 },
    long: { proceedsCents: 0, costCents: 0, washCents: 0, gainCents: 0, count: 0 },
    unknown: { proceedsCents: 0, costCents: 0, washCents: 0, gainCents: 0, count: 0 },
  };
  for (const s of r.sales) {
    if (accountId && s.accountId !== accountId) continue;
    const t = out[s.term];
    t.proceedsCents += s.proceedsCents;
    t.costCents += s.costCents ?? 0;
    t.washCents += s.washCents;
    t.gainCents += s.proceedsCents - (s.costCents ?? 0) + s.washCents;
    t.count++;
  }
  return out;
}

/** This year's sales from Muny's own lots, for every taxable account (the Form 8949 export uses them). */
export function salesFor(db: MunyDb, year: number): StockSale[] {
  return stockTaxReport(db, year).sales;
}

function reconcileRows(d: ReturnType<typeof load>): ReconcileRow[] {
  const nameOf = new Map(d.accts.map((a) => [a.id, a.name]));
  const keys = new Map<string, { accountId: string; securityId: string }>();
  for (const h of d.holdings) if (h.type !== "cash") keys.set(lotKey(h.accountId, h.securityId), h);
  for (const x of d.txns)
    if (
      x.secType !== "cash" &&
      ["buy", "sell", "split", "transfer_in", "transfer_out"].includes(x.type)
    )
      keys.set(lotKey(x.accountId, x.securityId as string), {
        accountId: x.accountId,
        securityId: x.securityId as string,
      });
  const held = new Map(d.holdings.map((h) => [lotKey(h.accountId, h.securityId), h]));
  const rows: ReconcileRow[] = [];
  for (const [key, { accountId, securityId }] of keys) {
    const h = held.get(key);
    const lots = d.run.open.get(key) ?? [];
    const mine = d.txns
      .filter(
        (x) =>
          x.accountId === accountId &&
          x.securityId === securityId &&
          ["buy", "sell", "split", "transfer_in", "transfer_out"].includes(x.type),
      )
      .map((x) => x.date)
      .sort();
    const tq = lots.reduce((s, l) => s + l.q, 0n);
    const hq = h && toFixed(h.quantity) > 0n ? h.quantity : null;
    const known = lots.every((l) => l.cost !== null);
    const tradesCost = known ? roundCents(lots.reduce((s, l) => s + (l.cost ?? 0n), 0n)) : null;
    const soldUnknown = d.run.disposals.some(
      (x) => x.accountId === accountId && x.securityId === securityId && x.costCents === null,
    );
    const brokerCost = h ? (h.costBasisCents ?? d.entered.get(key) ?? null) : null;
    const diff = (hq ? toFixed(hq) : 0n) - tq;
    const same = sameShares(fromFixed(tq), hq ?? "0");
    let status: ReconcileRow["status"];
    if (!hq) status = tq > 0n && !same ? "closed" : "ok";
    else if (!mine.length) status = "no_trades";
    else if (!same) status = diff > 0n ? "missing_buys" : "missing_sales";
    else if (
      brokerCost !== null &&
      tradesCost !== null &&
      Math.abs(brokerCost - tradesCost) > Math.max(100, brokerCost * 0.01)
    )
      status = "cost_differs";
    else status = "ok";
    const sec = d.securities.get(securityId);
    rows.push({
      accountId,
      accountName: nameOf.get(accountId) ?? "",
      treatment: d.treat.get(accountId) ?? "taxable",
      securityId,
      symbol: sec?.symbol ?? "",
      name: sec?.name ?? "",
      heldQuantity: hq,
      tradesQuantity: fromFixed(tq),
      differenceQuantity: fromFixed(diff),
      brokerCostCents: brokerCost,
      tradesCostCents: tradesCost,
      firstTrade: mine[0] ?? null,
      lastTrade: mine.at(-1) ?? null,
      trades: mine.length,
      unknownCost: !known || soldUnknown,
      status,
    });
  }
  const order: Record<ReconcileRow["status"], number> = {
    missing_buys: 0,
    missing_sales: 1,
    closed: 2,
    no_trades: 3,
    cost_differs: 4,
    ok: 5,
  };
  return rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      a.accountName.localeCompare(b.accountName) ||
      a.symbol.localeCompare(b.symbol),
  );
}

export function reconcileReport(db: MunyDb): ReconcileReport {
  const rows = reconcileRows(load(db));
  const ok = rows.filter((r) => r.status === "ok").length;
  return { rows, ok, problems: rows.length - ok };
}
