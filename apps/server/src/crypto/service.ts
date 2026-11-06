import { createHash } from "node:crypto";
import {
  addDec,
  assetName,
  FIAT,
  fromFixed,
  isZeroDec,
  normDec,
  type ParsedCryptoTxn,
  parseAnyKoinlyCsv,
  subDec,
  taxLedger,
  toFixed,
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
  CryptoTxnType,
  CryptoWallet,
  CryptoWalletKind,
} from "@muny/shared";
import { guessCryptoExchange, reconcileKey, US_PER_WALLET_FROM } from "@muny/shared";
import { and, desc, eq, gte, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { normHash, normHashSql, ROUNDING_TEXT } from "./match.js";
import { getCryptoSettings } from "./prices.js";
import { enrichment, removeDuplicates } from "./reconcile.js";
import { chainVersion, isQueued, isSyncing, readCursor } from "./sync.js";

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
        onChain: r.sourceEnc
          ? (readCursor(r.syncCursor)?.balances.filter((b) => !hidden.has(b.asset)) ?? null)
          : null,
        hiddenBalances: (() => {
          const mine = balances.get(r.id) ?? new Map<string, string>();
          const chain = r.sourceEnc ? (readCursor(r.syncCursor)?.balances ?? []) : [];
          return [...hidden]
            .map((asset) => ({
              asset,
              amount: chain.find((b) => b.asset === asset)?.amount ?? mine.get(asset) ?? "0",
            }))
            .filter((b) => !isZeroDec(b.amount) && !b.amount.startsWith("-"));
        })(),
        syncing: isSyncing(r.id),
        queued: isQueued(r.id),
        createdAt: r.createdAt.getTime(),
        notes: r.notes,
        exchange: r.exchange,
        archived: r.archived,
      };
    });
}

export function createWallet(
  db: Db,
  input: { name: string; kind: CryptoWalletKind; chain?: string | null },
): string {
  const id = newId();
  db.insert(w)
    .values({
      id,
      name: input.name.trim(),
      kind: input.kind,
      chain: input.chain ?? null,
      exchange: input.kind === "exchange" ? guessCryptoExchange(input.name) : null,
    })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

type WalletInfo = { name: string; chain: string | null; kind: CryptoWalletKind };

export function toTxn(
  r: Row,
  walletName: string,
  pairWallet: string | null,
  extra?: {
    wallet?: WalletInfo;
    pair?: { row: Row; wallet: WalletInfo } | null;
  },
): CryptoTxn {
  const p = extra?.pair;
  return {
    walletChain: extra?.wallet?.chain ?? null,
    walletKind: extra?.wallet?.kind ?? "manual",
    transfer: p
      ? {
          walletId: p.row.walletId,
          walletName: p.wallet.name,
          walletChain: p.wallet.chain,
          walletKind: p.wallet.kind,
          asset: p.row.receivedAsset ?? p.row.sentAsset,
          amount: p.row.receivedAmount ?? p.row.sentAmount,
          feeAsset: p.row.feeAsset,
          feeAmount: p.row.feeAmount,
          valueCents: p.row.valueCents,
        }
      : null,
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
    counterparty: r.counterparty,
    missingHistory: [],
    possibleDuplicate: null,
    deletable: r.source !== "sync",
    importedCostBasisCents: r.importedCostBasisCents,
    importedGainCents: r.importedGainCents,
    source: r.source,
    transferPairId: r.transferPairId,
    transferWalletName: pairWallet,
  };
}

export function listTxns(db: Db, q: CryptoTxnQuery): CryptoTxnPage {
  const conds: (SQL | undefined)[] = [];
  const walletIds = (q.walletId ?? "").split(",").filter(Boolean);
  if (walletIds.length) conds.push(inArray(t.walletId, walletIds));
  const missing = missingHistory(db);
  if (q.warnings === "missing") conds.push(inArray(t.id, [...missing.keys()]));
  const dupes = possibleDuplicates(db);
  if (q.warnings === "duplicates") conds.push(inArray(t.id, [...dupes.keys()]));
  if (q.type) conds.push(eq(t.type, q.type));
  if (q.label) conds.push(q.label === "none" ? sql`${t.label} is null` : eq(t.label, q.label));
  if (q.asset)
    conds.push(or(eq(t.sentAsset, q.asset), eq(t.receivedAsset, q.asset), eq(t.feeAsset, q.asset)));
  if (q.from) conds.push(gte(t.at, Date.parse(`${q.from}T00:00:00Z`)));
  if (q.to) conds.push(lte(t.at, Date.parse(`${q.to}T23:59:59.999Z`)));
  // A transfer between shown wallets shows once (from its sending side), as Koinly does.
  conds.push(
    walletIds.length
      ? sql`not (${t.type} = 'transfer' and ${t.transferPairId} is not null and ${t.sentAsset} is null
          and exists (select 1 from crypto_txns p where p.id = ${t.transferPairId}
            and p.wallet_id in (${sql.join(
              walletIds.map((id) => sql`${id}`),
              sql`, `,
            )})))`
      : sql`not (${t.type} = 'transfer' and ${t.transferPairId} is not null and ${t.sentAsset} is null)`,
  );
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
  const wallets = new Map(
    db
      .select({ id: w.id, name: w.name, chain: w.chain, kind: w.kind })
      .from(w)
      .all()
      .map((x) => [x.id, x]),
  );
  const pairIds = rows.map((r) => r.transferPairId).filter((x): x is string => !!x);
  const pairs = new Map(
    pairIds.length
      ? db
          .select()
          .from(t)
          .where(inArray(t.id, pairIds))
          .all()
          .map((p) => [p.id, p])
      : [],
  );
  // Rows without a USD value (synced, added by hand): that day's price.
  const priceOn = dailyPrices(
    db,
    [...rows, ...pairs.values()].flatMap((r) => [r.receivedAsset ?? r.sentAsset, r.feeAsset]),
  );
  const priced = (r: Row): Row => {
    const asset = r.receivedAsset ?? r.sentAsset;
    const amount = r.receivedAmount ?? r.sentAmount;
    const at = (a: string | null, n: string | null) => {
      const usd = a && n ? priceOn(a, r.at) : null;
      return usd ? valueCents(n as string, usd) : null;
    };
    return {
      ...r,
      valueCents: r.valueCents ?? at(asset, amount),
      feeValueCents: r.feeValueCents ?? at(r.feeAsset, r.feeAmount),
    };
  };
  for (const [k, v] of pairs) pairs.set(k, priced(v));
  return {
    items: rows.map(priced).map((r) => {
      const pr = r.transferPairId ? pairs.get(r.transferPairId) : undefined;
      const pw = pr ? wallets.get(pr.walletId) : undefined;
      return {
        ...toTxn(r, wallets.get(r.walletId)?.name ?? "", pw?.name ?? null, {
          wallet: wallets.get(r.walletId),
          pair: pr && pw ? { row: pr, wallet: pw } : null,
        }),
        missingHistory: missing.get(r.id) ?? (pr ? (missing.get(pr.id) ?? []) : []),
        possibleDuplicate: (() => {
          const d = dupes.get(r.id) ?? (pr ? dupes.get(pr.id) : undefined);
          return d
            ? {
                id: d.id,
                at: d.at,
                walletName: wallets.get(d.walletId)?.name ?? "",
                otherWallet: d.otherWalletId ? (wallets.get(d.otherWalletId)?.name ?? null) : null,
              }
            : null;
        })(),
      };
    }),
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

/** Wallet name → comparable key: word order, case and "[Pool]" don't matter. */
const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\[pool\]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/** Koinly wallet name → the Muny wallet it most likely is. */
function suggestWallets(db: Db, names: string[]): Map<string, string | null> {
  const byKey = new Map<string, string>();
  for (const x of db.select({ id: w.id, name: w.name }).from(w).all())
    byKey.set(nameKey(x.name), x.id);
  return new Map(names.map((n) => [n, byKey.get(nameKey(n)) ?? null]));
}

export interface KoinlyImportOptions {
  /** Koinly wallet name → Muny wallet id, or "new" to create one. */
  mapping?: Record<string, string>;
  /** Replace Koinly rows already imported into the target wallets. */
  replace?: boolean;
}

export function previewKoinly(db: Db, csv: string): CryptoImportPreview {
  const parsed = parseAnyKoinlyCsv(csv);
  const suggested = suggestWallets(
    db,
    parsed.wallets.map((x) => x.name),
  );
  const imported = new Map(
    db
      .all<{ id: string; n: number }>(
        sql`select wallet_id as id, count(*) as n from crypto_txns where source = 'import' group by wallet_id`,
      )
      .map((r) => [r.id, Number(r.n)]),
  );
  let duplicates = 0;
  for (const p of parsed.txns) {
    const walletId = suggested.get(p.wallet);
    if (
      walletId &&
      db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.walletId, walletId), eq(t.externalId, p.externalId ?? externalId(p))))
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
    wallets: parsed.wallets.map((x) => {
      const id = suggested.get(x.name) ?? null;
      return {
        name: x.name,
        kind: x.kind,
        exists: !!id,
        txns: perWallet.get(x.name) ?? 0,
        suggestedWalletId: id,
        alreadyImported: id ? (imported.get(id) ?? 0) : 0,
      };
    }),
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    full: parsed.full,
  };
}

/**
 * Clear a wallet's earlier Koinly rows (and fixes Reconcile added on top of
 * them) before a fresh import. Synced rows stay; anything they were linked to
 * is unlinked and turned back into a plain deposit or withdrawal.
 */
function clearImported(tx: Tx, walletIds: string[]) {
  if (!walletIds.length) return 0;
  const n = tx
    .delete(t)
    .where(
      and(
        inArray(t.walletId, walletIds),
        or(
          eq(t.source, "import"),
          and(
            eq(t.source, "manual"),
            sql`(${t.description} like 'Added in Reconcile%' or ${t.description} like 'Opening balance (added in Reconcile%')`,
          ),
        ),
      ),
    )
    .run().changes;
  // Rows whose transfer partner just went away (the FK unlinks them).
  tx.run(sql`
    update crypto_txns set type = case when sent_asset is null then 'deposit' else 'withdrawal' end
     where type = 'transfer' and transfer_pair_id is null`);
  return n;
}

export function importKoinly(
  tx: Tx,
  csv: string,
  opts: KoinlyImportOptions = {},
): CryptoImportResult & { replaced: number; duplicatesRemoved: number } {
  const parsed = parseAnyKoinlyCsv(csv);
  const suggested = suggestWallets(
    tx,
    parsed.wallets.map((x) => x.name),
  );
  const ids = new Map<string, string>();
  let walletsCreated = 0;
  for (const x of parsed.wallets) {
    const chosen = opts.mapping?.[x.name] ?? suggested.get(x.name) ?? "new";
    if (chosen === "skip") continue;
    if (chosen !== "new" && tx.select({ id: w.id }).from(w).where(eq(w.id, chosen)).get()) {
      ids.set(x.name, chosen);
      continue;
    }
    // Pool wallets with no match of their own go with their main wallet.
    const created = createWallet(tx, {
      name: x.name.replace(/\s*\[pool\]\s*$/i, ""),
      kind: x.kind,
    });
    ids.set(x.name, created);
    walletsCreated++;
  }
  const targets = [...new Set(ids.values())];
  const replaced = opts.replace ? clearImported(tx, targets) : 0;

  let imported = 0;
  let duplicates = 0;
  const byTransfer = new Map<string, string[]>();
  // Koinly ids of synced rows that took an imported row's place (for relinking).
  const koinlyExt = new Map<string, string>();
  const onChainVersion = chainVersion(tx as unknown as MunyDb);
  for (const p of parsed.txns) {
    const walletId = ids.get(p.wallet);
    if (!walletId) continue; // skipped wallet
    // A wallet on the blockchain's version: the synced row stays, and gets
    // the import's tag, notes, values and address.
    if (onChainVersion.has(walletId) && p.txHash) {
      const s = tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.walletId, walletId),
            eq(t.source, "sync"),
            sql`${normHashSql("tx_hash")} = ${normHash(p.txHash)}`,
            p.sentAsset
              ? eq(t.sentAsset, p.sentAsset)
              : p.receivedAsset
                ? eq(t.receivedAsset, p.receivedAsset)
                : sql`${t.sentAsset} is null and ${t.receivedAsset} is null`,
          ),
        )
        .get();
      if (s) {
        const set = enrichment(s, { ...p, counterparty: p.counterparty ?? null });
        if (Object.keys(set).length) tx.update(t).set(set).where(eq(t.id, s.id)).run();
        duplicates++;
        if (p.transferKey && !s.transferPairId) {
          byTransfer.set(p.transferKey, [...(byTransfer.get(p.transferKey) ?? []), s.id]);
          koinlyExt.set(s.id, p.externalId ?? externalId(p));
        }
        continue;
      }
    }
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
        counterparty: p.counterparty ?? null,
        externalId: p.externalId ?? externalId(p),
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
    if (!a || !b) {
      if (!a) continue;
      // The other side's wallet was skipped: link to that side if it's already
      // in Muny (the full export gives both sides stable ids: …:out / …:in).
      const ext =
        koinlyExt.get(a) ?? tx.select({ ext: t.externalId }).from(t).where(eq(t.id, a)).get()?.ext;
      const otherExt = ext?.endsWith(":out")
        ? ext.replace(/:out$/, ":in")
        : ext?.endsWith(":in")
          ? ext.replace(/:in$/, ":out")
          : null;
      const other = otherExt
        ? tx
            .select({ id: t.id })
            .from(t)
            .where(and(eq(t.externalId, otherExt), sql`${t.transferPairId} is null`))
            .get()
        : undefined;
      if (other) {
        tx.update(t)
          .set({ type: "transfer", label: null, transferPairId: other.id })
          .where(eq(t.id, a))
          .run();
        tx.update(t).set({ type: "transfer", transferPairId: a }).where(eq(t.id, other.id)).run();
      } else
        tx.update(t)
          .set({ type: sql`case when ${t.sentAsset} is null then 'deposit' else 'withdrawal' end` })
          .where(eq(t.id, a))
          .run();
      continue;
    }
    tx.update(t).set({ type: "transfer", label: null, transferPairId: b }).where(eq(t.id, a)).run();
    tx.update(t).set({ type: "transfer", label: null, transferPairId: a }).where(eq(t.id, b)).run();
  }
  // Synced rows that repeat what was just imported go (imports keep prices and labels).
  let duplicatesRemoved = 0;
  for (const walletId of targets) {
    const synced = tx.select({ s: w.sourceEnc }).from(w).where(eq(w.id, walletId)).get()?.s;
    if (synced) duplicatesRemoved += removeDuplicates(tx as unknown as MunyDb, walletId).removed;
  }
  return {
    imported,
    duplicates,
    walletsCreated,
    errors: parsed.errors,
    replaced,
    duplicatesRemoved,
  };
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
    mcap?: Record<string, number>;
  },
): Omit<import("@muny/shared").CryptoOverview, "pricesRefreshing" | "syncing" | "walletsSyncedAt"> {
  const balances = balancesByWallet(db);
  // Daily prices per asset (oldest first), for cost basis fallbacks and sparklines.
  const daily = loadDaily(db);
  const priceOn = priceLookup(daily);

  // What held coins cost, by the chosen method (the same engine as gains and taxes).
  const costMethod = getCryptoSettings(db as MunyDb).costMethod;
  const costScopeFrom =
    getCryptoSettings(db as MunyDb).costScope === "us" ? US_PER_WALLET_FROM : undefined;
  const ledger = taxLedger(
    db
      .select({
        id: t.id,
        walletId: t.walletId,
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
      .map((r) => ({ ...r, paired: !!r.pair, pairId: r.pair })),
    {
      skip: FIAT,
      method: costMethod,
      perWalletFrom: costScopeFrom,
      valueAt: (asset, amount, at) => {
        const usd = priceOn(asset, at);
        return usd ? valueCents(amount, usd) : null;
      },
    },
  );
  const cost = new Map(
    [...ledger.lots].map(([asset, q]) => [
      asset,
      {
        amount: q.reduce((s, l) => s + l.amount, 0n),
        costCents: Number(q.reduce((s, l) => s + l.cost, 0n)),
        missing: q.some((l) => !l.known),
      },
    ]),
  );
  const prices = latestPrices(db);
  const hidden = hiddenAssets(db);
  const ignoredKeys = new Set(getCryptoSettings(db as MunyDb).ignored);
  const info = new Map(
    db
      .select({ id: w.id, name: w.name, kind: w.kind, chain: w.chain, archived: w.archived })
      .from(w)
      .all()
      .map((x) => [x.id, x]),
  );
  const names = new Map([...info].map(([id, x]) => [id, x.name]));

  const missingHistory: { asset: string; walletName: string; amount: string }[] = [];
  type HoldingWallet = import("@muny/shared").CryptoHolding["wallets"][number];
  const perAsset = new Map<string, { amount: string; wallets: HoldingWallet[] }>();
  /** Wallets that once held a coin and are now empty (listed under the coin, at 0). */
  const emptied = new Map<string, string[]>();
  const walletEntry = (walletId: string, asset: string, amount: string): HoldingWallet => {
    const x = info.get(walletId);
    const p = prices.get(asset);
    return {
      walletId,
      walletName: x?.name ?? "",
      walletKind: x?.kind ?? "manual",
      chain: x?.chain ?? null,
      amount,
      valueCents: p ? valueCents(amount, p.usd) : null,
    };
  };
  for (const [walletId, m] of balances)
    for (const [asset, amount] of m) {
      if (hidden.has(asset)) continue;
      if (isZeroDec(amount)) {
        emptied.set(asset, [...(emptied.get(asset) ?? []), walletId]);
        continue;
      }
      if (amount.startsWith("-")) {
        // Fiat deposits from a bank are often missing from exports; not a crypto problem.
        if (FIAT.has(asset)) continue;
        // Rounding dust isn't missing history (the same rule as Reconcile and
        // the transaction warnings, so the alert and Reconcile always agree).
        if (toFixed(amount.slice(1)) < DUST_FIXED) continue;
        if (ignoredKeys.has(reconcileKey("missing", walletId, asset, normDec(amount.slice(1)))))
          continue;
        missingHistory.push({ asset, walletName: names.get(walletId) ?? "", amount });
        continue;
      }
      const cur = perAsset.get(asset) ?? { amount: "0", wallets: [] };
      cur.amount = addDec(cur.amount, amount);
      cur.wallets.push(walletEntry(walletId, asset, amount));
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
        ...(() => {
          const c = cost.get(asset);
          if (!c || FIAT.has(asset)) return { costCents: null, costIncomplete: true };
          // Fewer coins in the cost pool than held means some history is missing.
          const held = toFixed(h.amount);
          return {
            costCents: c.costCents,
            costIncomplete: c.missing || c.amount * 1000n < held * 999n,
          };
        })(),
        marketCapUsd: opts.mcap?.[asset] ?? null,
        spark: (daily.get(asset) ?? []).slice(-30).map((p) => Number(p.usd)),
        wallets: [
          ...h.wallets.sort(
            (a, b) =>
              (b.valueCents ?? 0) - (a.valueCents ?? 0) ||
              Number(b.amount) - Number(a.amount) ||
              a.walletName.localeCompare(b.walletName),
          ),
          ...(emptied.get(asset) ?? [])
            .map((id) => walletEntry(id, asset, "0"))
            .sort((a, b) => a.walletName.localeCompare(b.walletName)),
        ],
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
  const history: { date: string; valueCents: number; costCents: number }[] = [];
  const { costAt } = taxLedger(
    db
      .select({
        id: t.id,
        walletId: t.walletId,
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
      .map((r) => ({ ...r, paired: !!r.pair, pairId: r.pair })),
    {
      skip: new Set([...FIAT, ...hidden]),
      method: costMethod,
      perWalletFrom: costScopeFrom,
      valueAt: (asset, amount, at) => {
        const usd = priceOn(asset, at);
        return usd ? valueCents(amount, usd) : null;
      },
      snapshots: dates.map((d) => Date.parse(`${d}T23:59:59.999Z`)),
    },
  );
  // The largest holdings today get their own series in the chart; the rest are "Other".
  const topAssets = holdings
    .filter((h) => (h.valueCents ?? 0) > 0)
    .slice(0, 7)
    .map((h) => h.asset);
  const seriesOf = new Map<string, number[]>(topAssets.map((a) => [a, []]));
  const otherValues: number[] = [];
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
    let named = 0;
    for (const a of topAssets) (seriesOf.get(a) as number[]).push(0);
    for (const [a, amt] of held) {
      if (isZeroDec(amt)) continue;
      const usd = a === "USD" ? "1" : lastPrice.get(a);
      if (!usd) continue;
      const cents = Math.max(0, valueCents(amt, usd));
      v += cents;
      const list = seriesOf.get(a);
      if (list) {
        list[list.length - 1] = cents;
        named += cents;
      }
    }
    otherValues.push(v - named);
    history.push({ date: d, valueCents: v, costCents: costAt[history.length] ?? 0 });
  }

  return {
    totalValueCents: total,
    // Rounding dust (under 0.000001) isn't worth a price warning.
    unpricedAssets: holdings
      .filter((h) => h.price === null && toFixed(h.amount) >= DUST_FIXED)
      .map((h) => h.asset),
    missingHistory,
    holdings,
    history,
    historyByAsset: [
      ...topAssets.map((asset) => ({ asset, values: seriesOf.get(asset) ?? [] })),
      ...(otherValues.some((x) => x > 0) ? [{ asset: "Other", values: otherValues }] : []),
    ],
    pricesEnabled: opts.pricesEnabled,
    pricesUpdatedAt: opts.pricesUpdatedAt,
    walletCount: names.size,
    txnCount: Number(db.select({ n: sql<number>`count(*)` }).from(t).get()?.n ?? 0),
  };
}

/** A wallet with its transaction counts by type. */
export function walletDetail(db: Db, id: string): import("@muny/shared").CryptoWalletDetail | null {
  const wallet = listWallets(db).find((x) => x.id === id);
  if (!wallet) return null;
  const counts = { total: 0, deposit: 0, withdrawal: 0, trade: 0, transfer: 0 };
  for (const r of db.all<{ type: CryptoTxnType; n: number }>(
    sql`select type, count(*) as n from crypto_txns where wallet_id = ${id} group by type`,
  )) {
    counts[r.type] = Number(r.n);
    counts.total += Number(r.n);
  }
  return { ...wallet, counts };
}

/** The wallet's sync attempts, newest first. */
export function syncHistory(db: Db, walletId: string): import("@muny/shared").CryptoSyncRun[] {
  return db
    .select()
    .from(schema.cryptoSyncRuns)
    .where(eq(schema.cryptoSyncRuns.walletId, walletId))
    .orderBy(desc(schema.cryptoSyncRuns.startedAt))
    .limit(100)
    .all()
    .map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status,
      added: r.added,
      duplicates: r.duplicates,
      message: r.message,
    }));
}

type Daily = Map<string, { date: string; usd: string }[]>;

/** Daily USD prices per asset, oldest first (all assets, or just these). */
export function loadDaily(db: Db, assets?: (string | null)[]): Daily {
  const want = assets ? [...new Set(assets.filter((a): a is string => !!a))] : null;
  const daily: Daily = new Map();
  if (want && !want.length) return daily;
  for (const r of db
    .select({
      asset: schema.cryptoPrices.asset,
      date: schema.cryptoPrices.date,
      usd: schema.cryptoPrices.usd,
    })
    .from(schema.cryptoPrices)
    .where(want ? inArray(schema.cryptoPrices.asset, want) : undefined)
    .orderBy(schema.cryptoPrices.date)
    .all()) {
    const list = daily.get(r.asset) ?? [];
    list.push({ date: r.date, usd: r.usd });
    daily.set(r.asset, list);
  }
  return daily;
}

/** The USD price of an asset on the day of `at` (or the closest day before). */
export function priceLookup(daily: Daily) {
  return (asset: string, at: number): string | null => {
    const list = daily.get(asset);
    if (!list?.length) return null;
    const d = new Date(at).toISOString().slice(0, 10);
    let lo = 0;
    let hi = list.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as { date: string }).date <= d) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Before the first known day: use it if within a week.
    if (best < 0) {
      const first = list[0] as { date: string; usd: string };
      return Date.parse(`${first.date}T00:00:00Z`) - at <= 7 * 86_400_000 ? first.usd : null;
    }
    return (list[best] as { usd: string }).usd;
  };
}

/** Price lookup for just these assets. */
function dailyPrices(db: Db, assets: (string | null)[]) {
  return priceLookup(loadDaily(db, assets));
}

/**
 * Transactions that send more of a coin than the wallet had at the time:
 * the purchase history before them is missing (tax reports need it), as
 * Koinly warns. Per wallet and coin, in time order, arrivals first within
 * the same moment. Transaction id → what was missing.
 */
const DUST_FIXED = toFixed(ROUNDING_TEXT);

export function missingHistory(db: Db): Map<string, { asset: string; amount: string }[]> {
  const hidden = hiddenAssets(db);
  const rows = db
    .select({
      id: t.id,
      walletId: t.walletId,
      sentAsset: t.sentAsset,
      sentAmount: t.sentAmount,
      receivedAsset: t.receivedAsset,
      receivedAmount: t.receivedAmount,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
    })
    .from(t)
    .orderBy(
      t.at,
      sql`case when ${t.sentAsset} is null and ${t.feeAsset} is null then 0 else 1 end`,
      t.id,
    )
    .all();
  const bal = new Map<string, bigint>();
  const out = new Map<string, { asset: string; amount: string }[]>();
  const skip = (a: string) => FIAT.has(a) || hidden.has(a);
  for (const r of rows) {
    if (r.receivedAsset && r.receivedAmount && !skip(r.receivedAsset)) {
      const k = `${r.walletId}|${r.receivedAsset}`;
      bal.set(k, (bal.get(k) ?? 0n) + toFixed(r.receivedAmount));
    }
    const spent = new Map<string, bigint>();
    if (r.sentAsset && r.sentAmount) spent.set(r.sentAsset, toFixed(r.sentAmount));
    if (r.feeAsset && r.feeAmount)
      spent.set(r.feeAsset, (spent.get(r.feeAsset) ?? 0n) + toFixed(r.feeAmount));
    for (const [asset, n] of spent) {
      if (skip(asset) || n <= 0n) continue;
      const k = `${r.walletId}|${asset}`;
      const had = bal.get(k) ?? 0n;
      const short = had >= n ? 0n : had > 0n ? n - had : n;
      bal.set(k, had - n);
      // Rounding dust isn't missing history.
      if (short >= DUST_FIXED)
        out.set(r.id, [...(out.get(r.id) ?? []), { asset, amount: fromFixed(short) }]);
    }
  }
  return out;
}

/** A possible other side of a transfer, for "Mark as transfer". */
export interface TransferMatch {
  id: string;
  walletId: string;
  walletName: string;
  at: number;
  asset: string;
  amount: string;
}

/**
 * Sends (for a deposit) or receipts (for a withdrawal) of the same coin in
 * your other wallets, not linked yet, within 3 days and of about the amount
 * (what left can be up to half again more: fees).
 */
export function transferMatches(db: Db, id: string): TransferMatch[] {
  const r = db.select().from(t).where(eq(t.id, id)).get();
  if (!r || r.transferPairId) return [];
  const incoming = !!r.receivedAsset && !r.sentAsset;
  const outgoing = !!r.sentAsset && !r.receivedAsset;
  if (!incoming && !outgoing) return [];
  const asset = (incoming ? r.receivedAsset : r.sentAsset) as string;
  const mine = toFixed((incoming ? r.receivedAmount : r.sentAmount) ?? "0");
  const day = 86_400_000;
  const names = new Map(
    db
      .select({ id: w.id, name: w.name })
      .from(w)
      .all()
      .map((x) => [x.id, x.name]),
  );
  return db
    .select()
    .from(t)
    .where(
      and(
        sql`${t.walletId} <> ${r.walletId}`,
        sql`${t.transferPairId} is null`,
        gte(t.at, r.at - 3 * day),
        lte(t.at, r.at + 3 * day),
        incoming
          ? and(eq(t.sentAsset, asset), sql`${t.receivedAsset} is null`)
          : and(eq(t.receivedAsset, asset), sql`${t.sentAsset} is null`),
      ),
    )
    .all()
    .filter((o) => {
      const theirs = toFixed((incoming ? o.sentAmount : o.receivedAmount) ?? "0");
      const fee = o.feeAsset === asset && o.feeAmount ? toFixed(o.feeAmount) : 0n;
      const [sent, got] = incoming ? [theirs + fee, mine] : [mine, theirs];
      return got > 0n && sent >= got && sent * 2n <= got * 3n;
    })
    .sort((a, b) => Math.abs(a.at - r.at) - Math.abs(b.at - r.at))
    .slice(0, 10)
    .map((o) => ({
      id: o.id,
      walletId: o.walletId,
      walletName: names.get(o.walletId) ?? "",
      at: o.at,
      asset,
      amount: (incoming ? o.sentAmount : o.receivedAmount) as string,
    }));
}

/** Link a send and a receipt in two of your wallets as one transfer. */
export function linkAsTransfer(db: Db, id: string, otherId: string) {
  return db.transaction((tx) => {
    const a = tx.select().from(t).where(eq(t.id, id)).get();
    const b = tx.select().from(t).where(eq(t.id, otherId)).get();
    if (!a || !b) throw new Error("Transaction not found");
    if (a.transferPairId || b.transferPairId) throw new Error("Already part of a transfer");
    if (a.walletId === b.walletId) throw new Error("Pick a transaction in another wallet");
    const [out, inn] = a.sentAsset ? [a, b] : [b, a];
    if (
      !out.sentAsset ||
      out.receivedAsset ||
      !inn.receivedAsset ||
      inn.sentAsset ||
      out.sentAsset !== inn.receivedAsset
    )
      throw new Error("A transfer needs a send and a receipt of the same coin");
    for (const [x, pair] of [
      [out, inn],
      [inn, out],
    ] as const)
      tx.update(t)
        .set({ type: "transfer", label: null, transferPairId: pair.id, userModified: true })
        .where(eq(t.id, x.id))
        .run();
    return { ok: true };
  });
}

/** Undo a transfer link: both sides become a plain deposit and withdrawal again. */
export function unlinkTransfer(db: Db, id: string) {
  return db.transaction((tx) => {
    const a = tx.select().from(t).where(eq(t.id, id)).get();
    if (!a?.transferPairId) throw new Error("This isn't a transfer between your wallets");
    for (const x of [a.id, a.transferPairId])
      tx.update(t)
        .set({
          transferPairId: null,
          type: sql`case when ${t.sentAsset} is null then 'deposit' when ${t.receivedAsset} is null then 'withdrawal' else 'trade' end`,
          userModified: true,
        })
        .where(eq(t.id, x))
        .run();
    return { ok: true };
  });
}

/** Pairs you said aren't duplicates ("a|b", ids sorted). */
const NOT_DUPLICATES = "crypto.not_duplicates";
function notDuplicates(db: Db): Set<string> {
  const v = db
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, NOT_DUPLICATES))
    .get()?.value as string[] | undefined;
  return new Set(v ?? []);
}
export function markNotDuplicate(db: Db, a: string, b: string) {
  const value = [...notDuplicates(db).add([a, b].sort().join("|"))];
  db.insert(schema.appSettings)
    .values({ key: NOT_DUPLICATES, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

type DupeOf = { id: string; at: number; walletId: string; otherWalletId: string | null };

/**
 * Rows that look recorded twice: the same coin and the same total (within
 * 0.1%) leaving, or arriving in, the same wallet within 10 minutes, unless
 * both have different transaction hashes, both came from the chain, or
 * both are rewards or other income.
 * Exports sometimes hold one transfer twice, once with the fee split out.
 * Row id → the row it may repeat (and that row's transfer partner wallet).
 */
export function possibleDuplicates(db: Db): Map<string, DupeOf> {
  const rows = db
    .select({
      id: t.id,
      walletId: t.walletId,
      at: t.at,
      source: t.source,
      txHash: t.txHash,
      sentAsset: t.sentAsset,
      sentAmount: t.sentAmount,
      receivedAsset: t.receivedAsset,
      receivedAmount: t.receivedAmount,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
      pair: t.transferPairId,
      label: t.label,
    })
    .from(t)
    .orderBy(t.at)
    .all();
  type R = (typeof rows)[number];
  // Rewards often arrive as several equal payouts minutes apart (e.g. an
  // exchange's learn-and-earn lessons): not duplicates.
  const INCOME = new Set(["reward", "staking", "airdrop", "mining", "income", "fee_refund"]);
  const walletOf = new Map(rows.map((r) => [r.id, r.walletId]));
  const groups = new Map<string, { r: R; total: bigint }[]>();
  for (const r of rows) {
    const out = !!r.sentAsset && !r.receivedAsset;
    const inn = !!r.receivedAsset && !r.sentAsset;
    if (!out && !inn) continue;
    const asset = (out ? r.sentAsset : r.receivedAsset) as string;
    if (FIAT.has(asset)) continue;
    let total = toFixed((out ? r.sentAmount : r.receivedAmount) ?? "0");
    if (out && r.feeAsset === asset && r.feeAmount) total += toFixed(r.feeAmount);
    if (total <= 0n) continue;
    const k = `${r.walletId}|${out ? "out" : "in"}|${asset}`;
    const list = groups.get(k) ?? [];
    list.push({ r, total });
    groups.set(k, list);
  }
  const dismissed = notDuplicates(db);
  const found = new Map<string, DupeOf>();
  const WINDOW = 10 * 60_000;
  const note = (x: R, y: R) => {
    if (!found.has(x.id))
      found.set(x.id, {
        id: y.id,
        at: y.at,
        walletId: y.walletId,
        otherWalletId: y.pair ? (walletOf.get(y.pair) ?? null) : null,
      });
  };
  for (const list of groups.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as { r: R; total: bigint };
        const b = list[j] as { r: R; total: bigint };
        if (b.r.at - a.r.at > WINDOW) break;
        if (a.r.source === "sync" && b.r.source === "sync") continue;
        if (INCOME.has(a.r.label ?? "") && INCOME.has(b.r.label ?? "")) continue;
        if (a.r.txHash && b.r.txHash && normHash(a.r.txHash) !== normHash(b.r.txHash)) continue;
        const big = a.total > b.total ? a.total : b.total;
        const diff = a.total > b.total ? a.total - b.total : b.total - a.total;
        if (diff * 1000n > big) continue;
        if (dismissed.has([a.r.id, b.r.id].sort().join("|"))) continue;
        note(a.r, b.r);
        note(b.r, a.r);
      }
  return found;
}

/**
 * Delete an imported or hand-added row (a synced one would come back). A
 * transfer goes with its other side when that side isn't synced; otherwise
 * the other side becomes a plain deposit or withdrawal.
 */
export function deleteTxn(db: Db, id: string) {
  return db.transaction((tx) => {
    const r = tx.select().from(t).where(eq(t.id, id)).get();
    if (!r) throw new Error("Transaction not found");
    if (r.source === "sync")
      throw new Error("Synced transactions come back from the blockchain; tag or link it instead");
    const pair = r.transferPairId
      ? tx.select().from(t).where(eq(t.id, r.transferPairId)).get()
      : undefined;
    const ids = pair && pair.source !== "sync" ? [r.id, pair.id] : [r.id];
    if (pair && pair.source === "sync")
      tx.update(t)
        .set({ transferPairId: null, type: pair.sentAsset ? "withdrawal" : "deposit" })
        .where(eq(t.id, pair.id))
        .run();
    tx.update(t).set({ transferPairId: null }).where(inArray(t.id, ids)).run();
    tx.delete(t).where(inArray(t.id, ids)).run();
    return { deleted: ids.length };
  });
}

/**
 * A closed exchange kept what was on it: record each coin still there as a
 * "lost" withdrawal on that day (a loss, not a sale). Deleting those rows
 * undoes it.
 */
export function markRemainingLost(
  db: Db,
  walletId: string,
  at: number,
  reason: "closed" | "access" = "closed",
) {
  const wallet = db.select().from(w).where(eq(w.id, walletId)).get();
  if (!wallet) throw new Error("Wallet not found");
  const left = [...(balancesByWallet(db).get(walletId) ?? new Map<string, string>())].filter(
    ([, amount]) => !isZeroDec(amount) && !amount.startsWith("-"),
  );
  const hidden = hiddenAssets(db);
  let coins = 0;
  for (const [asset, amount] of left) {
    if (hidden.has(asset)) continue;
    const id = newId();
    db.insert(t)
      .values({
        id,
        walletId,
        at,
        type: "withdrawal",
        label: "lost",
        sentAsset: asset,
        sentAmount: amount,
        description:
          reason === "access"
            ? `Lost: no longer have access to ${wallet.name}`
            : `Lost: still on ${wallet.name} when it closed`,
        externalId: `manual:${id}`,
        source: "manual",
      })
      .run();
    coins++;
  }
  return { coins };
}

/** NFTs held in synced wallets (as of each wallet's last sync). */
export function listNfts(db: Db): import("@muny/shared").CryptoNft[] {
  const out: import("@muny/shared").CryptoNft[] = [];
  for (const r of db.select().from(w).all()) {
    const c = readCursor(r.syncCursor);
    for (const n of c?.nfts ?? [])
      out.push({
        walletId: r.id,
        walletName: r.name,
        chain: r.chain,
        ...n,
      });
  }
  return out;
}

export interface TxnEdit {
  at?: number;
  sentAsset?: string | null;
  sentAmount?: string | null;
  receivedAsset?: string | null;
  receivedAmount?: string | null;
  feeAsset?: string | null;
  feeAmount?: string | null;
  valueCents?: number | null;
}

/**
 * Change a transaction's date, amounts, coins, fee or USD value. Its type
 * follows: sent and received is a trade, received a deposit, sent (or only a
 * fee) a withdrawal. One side of a transfer between your wallets keeps its
 * link: only its own side, fee and date change.
 */
export function editTxn(db: Db, id: string, e: TxnEdit) {
  const r = db.select().from(t).where(eq(t.id, id)).get();
  if (!r) throw new Error("Transaction not found");
  const next = { ...r, ...e };
  const has = (asset: string | null | undefined, amount: string | null | undefined) =>
    !!asset && !!amount && !isZeroDec(amount);
  if (r.transferPairId) {
    const out = !!r.sentAsset;
    if (out ? e.receivedAsset || e.receivedAmount : e.sentAsset || e.sentAmount)
      throw new Error(
        "This is one side of a transfer: edit this wallet's side (or unlink it first)",
      );
    if (out ? !has(next.sentAsset, next.sentAmount) : !has(next.receivedAsset, next.receivedAmount))
      throw new Error("A transfer needs an amount");
  }
  const sent = has(next.sentAsset, next.sentAmount);
  const got = has(next.receivedAsset, next.receivedAmount);
  const fee = has(next.feeAsset, next.feeAmount);
  if (!sent && !got && !fee) throw new Error("Enter what was sent, received or paid as a fee");
  const type = r.transferPairId
    ? "transfer"
    : sent && got
      ? "trade"
      : got
        ? "deposit"
        : "withdrawal";
  db.update(t)
    .set({
      at: next.at,
      type,
      sentAsset: sent ? next.sentAsset : null,
      sentAmount: sent ? normDec(next.sentAmount as string) : null,
      receivedAsset: got ? next.receivedAsset : null,
      receivedAmount: got ? normDec(next.receivedAmount as string) : null,
      feeAsset: fee ? next.feeAsset : null,
      feeAmount: fee ? normDec(next.feeAmount as string) : null,
      valueCents: next.valueCents,
      // A tag that no longer fits (income on a withdrawal…) goes.
      ...(type === "trade" || type === "transfer" ? { label: null } : {}),
      userModified: true,
    })
    .where(eq(t.id, id))
    .run();
  return { ok: true, type };
}
