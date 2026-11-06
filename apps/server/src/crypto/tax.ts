import {
  assetName,
  FIAT,
  fromFixed,
  isLongTerm,
  longTermFrom,
  taxLedger,
  valueCents,
} from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { CryptoTaxReport } from "@muny/shared";
import { getCryptoSettings } from "./prices.js";
import { latestPrices, loadDaily, priceLookup } from "./service.js";

/**
 * The tax view of all crypto: FIFO lots with their acquisition dates
 * (@muny/core taxLedger), the range's flows (in, out, income, expenses,
 * fees) and realized gains, the tax year's gains by term, and what's held
 * split into short and long term with when each lot matures. Read-only.
 */
/** All crypto transactions run through the tax ledger (optionally only those before `until`). */
export function runLedger(db: MunyDb, until?: number) {
  const t = schema.cryptoTxns;
  const rows = db
    .select({
      id: t.id,
      walletId: t.walletId,
      txHash: t.txHash,
      description: t.description,
      at: t.at,
      type: t.type,
      label: t.label,
      sentAsset: t.sentAsset,
      sentAmount: t.sentAmount,
      receivedAsset: t.receivedAsset,
      receivedAmount: t.receivedAmount,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
      valueCents: t.valueCents,
      feeValueCents: t.feeValueCents,
      pair: t.transferPairId,
    })
    .from(t)
    .all()
    .filter((r) => until === undefined || r.at < until);
  const priceOn = priceLookup(loadDaily(db));
  const ledger = taxLedger(
    rows.map((r) => ({ ...r, paired: !!r.pair })),
    {
      skip: FIAT,
      method: getCryptoSettings(db).costMethod,
      valueAt: (asset, amount, at) => {
        const usd = priceOn(asset, at);
        return usd ? valueCents(amount, usd) : null;
      },
    },
  );
  return { rows, priceOn, ...ledger };
}

export function cryptoTax(db: MunyDb, range: { from?: number; to?: number }): CryptoTaxReport {
  const { rows, lots, gains: allGains, flows } = runLedger(db);
  // Lost coins are reported with gifts and donations, not as capital gains.
  const gains = allGains.filter((g) => g.kind !== "lost");

  const now = Date.now();
  const to = range.to ?? now;
  const from = range.from ?? 0;
  const inRange = (at: number) => at >= from && at <= to;
  const sum = (kind: string) =>
    flows
      .filter((f) => f.kind === kind && inRange(f.at))
      .reduce((s, f) => s + (f.valueCents ?? 0), 0);
  const realizedCents = gains.filter((g) => inRange(g.at)).reduce((s, g) => s + g.gainCents, 0);

  const year = new Date(to).getUTCFullYear();
  const yStart = Date.UTC(year, 0, 1);
  const yEnd = Date.UTC(year + 1, 0, 1) - 1;
  const realized = {
    short: { profitCents: 0, lossCents: 0 },
    long: { profitCents: 0, lossCents: 0 },
  };
  for (const g of gains) {
    if (g.at < yStart || g.at > yEnd) continue;
    const r = realized[g.term];
    if (g.gainCents >= 0) r.profitCents += g.gainCents;
    else r.lossCents += g.gainCents;
  }

  const prices = latestPrices(db);
  const hidden = new Set(getCryptoSettings(db).hiddenAssets);
  const assets: CryptoTaxReport["assets"] = [];
  for (const [asset, q] of lots) {
    if (hidden.has(asset) || FIAT.has(asset)) continue;
    const total = q.reduce((s, l) => s + l.amount, 0n);
    if (total <= 0n) continue;
    const usd = prices.get(asset)?.usd ?? null;
    const value = (amount: bigint) => (usd ? valueCents(fromFixed(amount), usd) : null);
    const part = (long: boolean) => {
      const sel = q.filter((l) => isLongTerm(l.acquiredAt, now) === long);
      const amount = sel.reduce((s, l) => s + l.amount, 0n);
      return {
        amount: fromFixed(amount),
        costCents: Number(sel.reduce((s, l) => s + l.cost, 0n)),
        valueCents: value(amount),
      };
    };
    assets.push({
      asset,
      name: assetName(asset),
      amount: fromFixed(total),
      priceUsd: usd,
      valueCents: value(total),
      short: part(false),
      long: part(true),
      lots: q.map((l) => ({
        acquiredAt: l.acquiredAt,
        amount: fromFixed(l.amount),
        costCents: Number(l.cost),
        longFrom: longTermFrom(l.acquiredAt),
      })),
      missingCost: q.some((l) => !l.known),
    });
  }
  assets.sort((a, b) => (b.valueCents ?? -1) - (a.valueCents ?? -1));

  // Long-term share of today's value at the end of each of the next 12 months.
  const maturity: CryptoTaxReport["maturity"] = [];
  const totalValue = assets.reduce((s, a) => s + (a.valueCents ?? 0), 0);
  for (let m = 0; m <= 12; m++) {
    const d = new Date(now);
    const at = m === 0 ? now : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1);
    let long = 0;
    for (const a of assets) {
      if (!a.priceUsd) continue;
      for (const l of a.lots) if (l.longFrom <= at) long += valueCents(l.amount, a.priceUsd);
    }
    maturity.push({ at, longPct: totalValue > 0 ? Math.min(100, (long / totalValue) * 100) : 0 });
  }

  return {
    from,
    to,
    txnCount: rows.filter((r) => inRange(r.at)).length,
    summary: {
      inCents: sum("in"),
      outCents: sum("out"),
      incomeCents: sum("income"),
      expensesCents: sum("expense"),
      feesCents: sum("fee"),
      giftsCents: sum("gift"),
      realizedCents,
    },
    counts: {
      total: rows.filter((r) => inRange(r.at)).length,
      deposit: rows.filter((r) => inRange(r.at) && r.type === "deposit").length,
      withdrawal: rows.filter((r) => inRange(r.at) && r.type === "withdrawal").length,
      trade: rows.filter((r) => inRange(r.at) && r.type === "trade").length,
      transfer: rows.filter((r) => inRange(r.at) && r.type === "transfer").length,
    },
    year,
    realized,
    assets,
    maturity,
  };
}
