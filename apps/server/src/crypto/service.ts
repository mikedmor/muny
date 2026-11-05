import { createHash } from "node:crypto";
import {
  addDec,
  assetName,
  FIAT,
  isZeroDec,
  type ParsedCryptoTxn,
  parseKoinlyCsv,
  subDec,
  valueCents,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  CryptoBalance,
  CryptoImportPreview,
  CryptoImportResult,
  CryptoTxn,
  CryptoTxnPage,
  CryptoTxnQuery,
  CryptoWallet,
  CryptoWalletKind,
} from "@muny/shared";
import { and, desc, eq, gte, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { getCryptoSettings } from "./prices.js";
import { isQueued, isSyncing, readCursor } from "./sync.js";

/** Assets the user hid (spam tokens): left out of holdings and warnings. */
const hiddenAssets = (db: Db) => new Set(getCryptoSettings(db as MunyDb).hiddenAssets);

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

const w = schema.cryptoWallets;
const t = schema.cryptoTxns;

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

type Row = typeof t.$inferSelect;

/** Net quantity per (wallet, asset): received − sent − fees. */
export function balancesByWallet(db: Db): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const bump = (walletId: string, asset: string | null, amount: string | null, sign: 1 | -1) => {
    if (!asset || isZeroDec(amount)) return;
    const m = out.get(walletId) ?? new Map<string, string>();
    const cur = m.get(asset) ?? "0";
    m.set(asset, sign === 1 ? addDec(cur, amount as string) : subDec(cur, amount as string));
    out.set(walletId, m);
  };
  for (const r of db
    .select({
      walletId: t.walletId,
      sentAsset: t.sentAsset,
      sentAmount: t.sentAmount,
      receivedAsset: t.receivedAsset,
      receivedAmount: t.receivedAmount,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
    })
    .from(t)
    .all()) {
    bump(r.walletId, r.receivedAsset, r.receivedAmount, 1);
    bump(r.walletId, r.sentAsset, r.sentAmount, -1);
    bump(r.walletId, r.feeAsset, r.feeAmount, -1);
  }
  return out;
}

/** Current USD price per asset (decimal string), from the newest stored daily price. */
export function latestPrices(db: Db): Map<string, { usd: string; date: string }> {
  const rows = db.all<{ asset: string; usd: string; date: string }>(sql`
    select p.asset as asset, p.usd as usd, p.date as date from crypto_prices p
     where p.date = (select max(q.date) from crypto_prices q where q.asset = p.asset)
  `);
  const m = new Map(rows.map((r) => [r.asset, { usd: r.usd, date: r.date }]));
  m.set("USD", { usd: "1", date: "" });
  return m;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export function listWallets(db: Db): CryptoWallet[] {
  const balances = balancesByWallet(db);
  const hidden = hiddenAssets(db);
  const prices = latestPrices(db);
  const counts = new Map(
    db
      .all<{ id: string; n: number; last: number | null }>(
        sql`select wallet_id as id, count(*) as n, max(at) as last from crypto_txns group by wallet_id`,
      )
      .map((r) => [r.id, r]),
  );
  return db
    .select()
    .from(w)
    .orderBy(w.name)
    .all()
    .map((r) => {
      const bal: CryptoBalance[] = [...(balances.get(r.id) ?? new Map()).entries()]
        // Negative balances mean missing history; they show as warnings instead.
        .filter(
          ([asset, amount]) => !isZeroDec(amount) && !amount.startsWith("-") && !hidden.has(asset),
        )
        .map(([asset, amount]) => {
          const p = prices.get(asset);
          return { asset, amount, valueCents: p ? valueCents(amount, p.usd) : null };
        })
        .sort((a, b) => (b.valueCents ?? -1) - (a.valueCents ?? -1));
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        chain: r.chain,
        sourceHint: r.sourceHint,
        syncEnabled: r.syncEnabled,
        status: r.status,
        lastSyncAt: r.lastSyncAt ? r.lastSyncAt.getTime() : null,
        lastError: r.lastError,
        txnCount: Number(counts.get(r.id)?.n ?? 0),
        lastTxnAt: counts.get(r.id)?.last ?? null,
        balances: bal,
        valueCents: bal.reduce((s, b) => s + Math.max(0, b.valueCents ?? 0), 0),
        onChain: r.sourceEnc ? (readCursor(r.syncCursor)?.balances ?? null) : null,
        syncing: isSyncing(r.id),
        queued: isQueued(r.id),
      };
    });
}

export function createWallet(
  db: Db,
  input: { name: string; kind: CryptoWalletKind; chain?: string | null },
): string {
  const id = newId();
  db.insert(w)
    .values({ id, name: input.name.trim(), kind: input.kind, chain: input.chain ?? null })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export function toTxn(r: Row, walletName: string, pairWallet: string | null): CryptoTxn {
  return {
    id: r.id,
    walletId: r.walletId,
    walletName,
    at: r.at,
    type: r.type,
    label: r.label,
    sentAsset: r.sentAsset,
    sentAmount: r.sentAmount,
    receivedAsset: r.receivedAsset,
    receivedAmount: r.receivedAmount,
    feeAsset: r.feeAsset,
    feeAmount: r.feeAmount,
    valueCents: r.valueCents,
    feeValueCents: r.feeValueCents,
    txHash: r.txHash,
    description: r.description,
    source: r.source,
    transferPairId: r.transferPairId,
    transferWalletName: pairWallet,
  };
}

export function listTxns(db: Db, q: CryptoTxnQuery): CryptoTxnPage {
  const conds: (SQL | undefined)[] = [];
  if (q.walletId) conds.push(eq(t.walletId, q.walletId));
  if (q.type) conds.push(eq(t.type, q.type));
  if (q.label) conds.push(q.label === "none" ? sql`${t.label} is null` : eq(t.label, q.label));
  if (q.asset)
    conds.push(or(eq(t.sentAsset, q.asset), eq(t.receivedAsset, q.asset), eq(t.feeAsset, q.asset)));
  if (q.from) conds.push(gte(t.at, Date.parse(`${q.from}T00:00:00Z`)));
  if (q.to) conds.push(lte(t.at, Date.parse(`${q.to}T23:59:59.999Z`)));
  const where = and(...conds);
  const total = db.select({ n: sql<number>`count(*)` }).from(t).where(where).get()?.n ?? 0;
  const limit = Math.min(q.limit ?? 50, 500);
  const offset = q.offset ?? 0;
  const rows = db
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.at), desc(t.id))
    .limit(limit)
    .offset(offset)
    .all();
  const names = new Map(
    db
      .select({ id: w.id, name: w.name })
      .from(w)
      .all()
      .map((x) => [x.id, x.name]),
  );
  const pairIds = rows.map((r) => r.transferPairId).filter((x): x is string => !!x);
  const pairWallet = new Map(
    pairIds.length
      ? db
          .select({ id: t.id, walletId: t.walletId })
          .from(t)
          .where(inArray(t.id, pairIds))
          .all()
          .map((p) => [p.id, names.get(p.walletId) ?? null])
      : [],
  );
  return {
    items: rows.map((r) =>
      toTxn(
        r,
        names.get(r.walletId) ?? "",
        r.transferPairId ? (pairWallet.get(r.transferPairId) ?? null) : null,
      ),
    ),
    total: Number(total),
    offset,
    limit,
  };
}

// ---------------------------------------------------------------------------
// Koinly import
// ---------------------------------------------------------------------------

/** Stable id for an imported row: same file content → same id → no duplicates. */
function externalId(p: ParsedCryptoTxn) {
  const parts = [
    p.at,
    p.type,
    p.wallet.toLowerCase(),
    p.label,
    p.sentAsset,
    p.sentAmount,
    p.receivedAsset,
    p.receivedAmount,
    p.feeAsset,
    p.feeAmount,
    p.txHash,
    p.transferKey ? (p.sentAmount ? "out" : "in") : "",
  ];
  return `koinly:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function walletByName(db: Db) {
  return new Map(
    db
      .select({ id: w.id, name: w.name })
      .from(w)
      .all()
      .map((r) => [r.name.toLowerCase(), r.id]),
  );
}

export function previewKoinly(db: Db, csv: string): CryptoImportPreview {
  const parsed = parseKoinlyCsv(csv);
  const existing = walletByName(db);
  let duplicates = 0;
  for (const p of parsed.txns) {
    const walletId = existing.get(p.wallet.toLowerCase());
    if (
      walletId &&
      db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.walletId, walletId), eq(t.externalId, externalId(p))))
        .get()
    )
      duplicates++;
  }
  const perWallet = new Map<string, number>();
  for (const p of parsed.txns) perWallet.set(p.wallet, (perWallet.get(p.wallet) ?? 0) + 1);
  const times = parsed.txns.map((p) => p.at);
  return {
    txns: parsed.txns.length - duplicates,
    duplicates,
    errors: parsed.errors,
    wallets: parsed.wallets.map((x) => ({
      name: x.name,
      kind: x.kind,
      exists: existing.has(x.name.toLowerCase()),
      txns: perWallet.get(x.name) ?? 0,
    })),
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
  };
}

export function importKoinly(tx: Tx, csv: string): CryptoImportResult {
  const parsed = parseKoinlyCsv(csv);
  const ids = walletByName(tx);
  let walletsCreated = 0;
  for (const x of parsed.wallets) {
    if (ids.has(x.name.toLowerCase())) continue;
    ids.set(x.name.toLowerCase(), createWallet(tx, { name: x.name, kind: x.kind }));
    walletsCreated++;
  }
  let imported = 0;
  let duplicates = 0;
  const byTransfer = new Map<string, string[]>();
  for (const p of parsed.txns) {
    const walletId = ids.get(p.wallet.toLowerCase()) as string;
    const id = newId();
    const res = tx
      .insert(t)
      .values({
        id,
        walletId,
        at: p.at,
        type: p.type,
        label: p.label,
        sentAsset: p.sentAsset,
        sentAmount: p.sentAmount,
        receivedAsset: p.receivedAsset,
        receivedAmount: p.receivedAmount,
        feeAsset: p.feeAsset,
        feeAmount: p.feeAmount,
        valueCents: p.valueCents,
        feeValueCents: p.feeValueCents,
        importedCostBasisCents: p.importedCostBasisCents,
        importedGainCents: p.importedGainCents,
        txHash: p.txHash,
        description: p.description,
        externalId: externalId(p),
        source: "import",
      })
      .onConflictDoNothing({ target: [t.walletId, t.externalId] })
      .run();
    if (res.changes === 0) {
      duplicates++;
      continue;
    }
    imported++;
    if (p.transferKey)
      byTransfer.set(p.transferKey, [...(byTransfer.get(p.transferKey) ?? []), id]);
  }
  // Link the two sides of each transfer.
  for (const [a, b] of byTransfer.values()) {
    if (!a || !b) continue;
    tx.update(t).set({ transferPairId: b }).where(eq(t.id, a)).run();
    tx.update(t).set({ transferPairId: a }).where(eq(t.id, b)).run();
  }
  return { imported, duplicates, walletsCreated, errors: parsed.errors };
}

// ---------------------------------------------------------------------------
// Overview (dashboard)
// ---------------------------------------------------------------------------

export function cryptoOverview(
  db: Db,
  opts: {
    pricesEnabled: boolean;
    pricesUpdatedAt: number | null;
    change24h: Record<string, number>;
  },
): Omit<import("@muny/shared").CryptoOverview, "pricesRefreshing" | "syncing" | "walletsSyncedAt"> {
  const balances = balancesByWallet(db);
  const prices = latestPrices(db);
  const hidden = hiddenAssets(db);
  const names = new Map(
    db
      .select({ id: w.id, name: w.name })
      .from(w)
      .all()
      .map((x) => [x.id, x.name]),
  );

  const missingHistory: { asset: string; walletName: string; amount: string }[] = [];
  const perAsset = new Map<
    string,
    { amount: string; wallets: { walletId: string; walletName: string; amount: string }[] }
  >();
  for (const [walletId, m] of balances)
    for (const [asset, amount] of m) {
      if (isZeroDec(amount) || hidden.has(asset)) continue;
      if (amount.startsWith("-")) {
        // Fiat deposits from a bank are often missing from exports; not a crypto problem.
        if (FIAT.has(asset)) continue;
        missingHistory.push({ asset, walletName: names.get(walletId) ?? "", amount });
        continue;
      }
      const cur = perAsset.get(asset) ?? { amount: "0", wallets: [] };
      cur.amount = addDec(cur.amount, amount);
      cur.wallets.push({ walletId, walletName: names.get(walletId) ?? "", amount });
      perAsset.set(asset, cur);
    }
  const holdings = [...perAsset.entries()]
    .filter(([, h]) => !isZeroDec(h.amount))
    .map(([asset, h]) => {
      const p = prices.get(asset);
      return {
        asset,
        name: assetName(asset),
        amount: h.amount,
        price: p?.usd ?? null,
        valueCents: p ? valueCents(h.amount, p.usd) : null,
        change24hPct: opts.change24h[asset] ?? null,
        allocationPct: 0,
        wallets: h.wallets.sort((a, b) => a.walletName.localeCompare(b.walletName)),
      };
    });
  const total = holdings.reduce((s, h) => s + Math.max(0, h.valueCents ?? 0), 0);
  for (const h of holdings)
    h.allocationPct = total > 0 ? (Math.max(0, h.valueCents ?? 0) / total) * 100 : 0;
  holdings.sort(
    (a, b) => (b.valueCents ?? -1) - (a.valueCents ?? -1) || a.asset.localeCompare(b.asset),
  );

  // Value history: walk transactions forward, valuing holdings on each priced day.
  const priceRows = db
    .select({
      asset: schema.cryptoPrices.asset,
      date: schema.cryptoPrices.date,
      usd: schema.cryptoPrices.usd,
    })
    .from(schema.cryptoPrices)
    .all();
  const byDate = new Map<string, Map<string, string>>();
  for (const r of priceRows) {
    const m = byDate.get(r.date) ?? new Map<string, string>();
    m.set(r.asset, r.usd);
    byDate.set(r.date, m);
  }
  const dates = [...byDate.keys()].sort();
  const txns = db
    .select({
      at: t.at,
      sentAsset: t.sentAsset,
      sentAmount: t.sentAmount,
      receivedAsset: t.receivedAsset,
      receivedAmount: t.receivedAmount,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
    })
    .from(t)
    .orderBy(t.at)
    .all();
  const held = new Map<string, string>();
  const lastPrice = new Map<string, string>();
  const history: { date: string; valueCents: number }[] = [];
  let i = 0;
  for (const d of dates) {
    const endOfDay = Date.parse(`${d}T23:59:59.999Z`);
    while (i < txns.length && (txns[i]?.at ?? 0) <= endOfDay) {
      const x = txns[i++] as (typeof txns)[number];
      const bump = (a: string | null, amt: string | null, sign: 1 | -1) => {
        if (!a || isZeroDec(amt)) return;
        const cur = held.get(a) ?? "0";
        held.set(a, sign === 1 ? addDec(cur, amt as string) : subDec(cur, amt as string));
      };
      bump(x.receivedAsset, x.receivedAmount, 1);
      bump(x.sentAsset, x.sentAmount, -1);
      bump(x.feeAsset, x.feeAmount, -1);
    }
    for (const [a, usd] of byDate.get(d) ?? []) lastPrice.set(a, usd);
    let v = 0;
    for (const [a, amt] of held) {
      if (isZeroDec(amt)) continue;
      const usd = a === "USD" ? "1" : lastPrice.get(a);
      if (usd) v += Math.max(0, valueCents(amt, usd));
    }
    history.push({ date: d, valueCents: v });
  }

  return {
    totalValueCents: total,
    unpricedAssets: holdings.filter((h) => h.price === null).map((h) => h.asset),
    missingHistory,
    holdings,
    history,
    pricesEnabled: opts.pricesEnabled,
    pricesUpdatedAt: opts.pricesUpdatedAt,
    walletCount: names.size,
    txnCount: Number(db.select({ n: sql<number>`count(*)` }).from(t).get()?.n ?? 0),
  };
}
