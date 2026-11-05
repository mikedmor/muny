import {
  addDec,
  CHAINS,
  type ChainKey,
  FIAT,
  isZeroDec,
  normDec,
  subDec,
  toFixed,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoReconcile, CryptoTransferSuggestion } from "@muny/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { decryptJson } from "../lib/crypto.js";
import { closeAmountsSql, normHashSql } from "./match.js";
import { getCryptoSettings } from "./prices.js";
import { readCursor } from "./sync.js";

/**
 * Reconcile: find why a wallet's balance is wrong, and offer fixes.
 *
 * - Same address in several wallets (e.g. Koinly made one wallet per token):
 *   each syncs the whole address, so everything is counted again. Fix: merge.
 * - Synced transactions that repeat imported ones (Koinly rows without a
 *   matching hash, or slightly different times). Fix: remove the synced copies
 *   (imported rows keep their prices and labels).
 * - Missing history: more left a wallet than arrived. Suggest the matching
 *   withdrawal from another wallet (link as a transfer), or add an opening
 *   balance.
 * - On-chain balance differs from the transactions for any other reason.
 *
 * Fiat (USD on exchanges) is not flagged: deposits from a bank are often not
 * in crypto exports and don't matter for crypto taxes.
 */

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
const w = schema.cryptoWallets;
const t = schema.cryptoTxns;
const DAY = 86_400_000;
/** How far apart an imported row and its synced copy may be. */
const DUP_WINDOW = 2 * DAY;
/** How long before history goes missing a matching withdrawal is looked for. */
const LINK_WINDOW = 120 * DAY;

/** Rows of a synced wallet that repeat an imported (or manual) row. */
function duplicateSyncRows(db: MunyDb | Tx, walletId: string): string[] {
  return db
    .all<{ id: string }>(sql`
      select distinct s.id from crypto_txns s
      join crypto_txns i on i.wallet_id = s.wallet_id and i.source <> 'sync'
      where s.wallet_id = ${walletId} and s.source = 'sync' and (
        (s.tx_hash is not null and s.tx_hash <> ''
          and ${normHashSql("i.tx_hash")} = ${normHashSql("s.tx_hash")}
          and (i.received_asset is s.received_asset or i.sent_asset is s.sent_asset))
        or (abs(i.at - s.at) <= ${DUP_WINDOW} and (
          (s.received_asset is not null and i.received_asset = s.received_asset
            and ${closeAmountsSql("i.received_amount", "s.received_amount")})
          or (s.sent_asset is not null and i.sent_asset = s.sent_asset
            and ${closeAmountsSql("i.sent_amount", "s.sent_amount")})))
      )`)
    .map((r) => r.id);
}

export function reconcileReport(db: MunyDb, secretKey: Buffer | undefined): CryptoReconcile {
  const hidden = new Set(getCryptoSettings(db).hiddenAssets);
  const wallets = db.select().from(w).orderBy(w.name).all();
  const names = new Map(wallets.map((x) => [x.id, x.name]));

  // Same address in several wallets.
  const bySource = new Map<string, typeof wallets>();
  if (secretKey)
    for (const x of wallets) {
      if (!x.sourceEnc || !x.chain) continue;
      let src: string;
      try {
        src = decryptJson<string>(secretKey, x.sourceEnc);
      } catch {
        continue;
      }
      const k = `${x.chain}:${src.toLowerCase()}`;
      bySource.set(k, [...(bySource.get(k) ?? []), x]);
    }
  const counts = new Map(
    db
      .all<{ id: string; n: number }>(
        sql`select wallet_id as id, count(*) as n from crypto_txns group by wallet_id`,
      )
      .map((r) => [r.id, Number(r.n)]),
  );
  const sameAddress = [...bySource.entries()]
    .filter(([, ws]) => ws.length > 1)
    .map(([k, ws]) => {
      const chain = k.split(":")[0] as ChainKey;
      return {
        chain,
        chainName: CHAINS[chain]?.name ?? chain,
        wallets: ws.map((x) => ({ id: x.id, name: x.name, txnCount: counts.get(x.id) ?? 0 })),
      };
    });

  // Running balances per wallet and asset, oldest first.
  const rows = db
    .select({
      id: t.id,
      walletId: t.walletId,
      at: t.at,
      type: t.type,
      sentAsset: t.sentAsset,
      sentAmount: t.sentAmount,
      receivedAsset: t.receivedAsset,
      receivedAmount: t.receivedAmount,
      feeAsset: t.feeAsset,
      feeAmount: t.feeAmount,
      transferPairId: t.transferPairId,
      source: t.source,
    })
    .from(t)
    .orderBy(t.at)
    .all();
  const run = new Map<string, { bal: string; firstNegAt: number | null }>();
  const bump = (
    walletId: string,
    asset: string | null,
    amt: string | null,
    sign: 1 | -1,
    at: number,
  ) => {
    if (!asset || isZeroDec(amt)) return;
    const k = `${walletId}|${asset}`;
    const r = run.get(k) ?? { bal: "0", firstNegAt: null };
    r.bal = sign === 1 ? addDec(r.bal, amt as string) : subDec(r.bal, amt as string);
    if (r.firstNegAt === null && r.bal.startsWith("-")) r.firstNegAt = at;
    run.set(k, r);
  };
  for (const r of rows) {
    bump(r.walletId, r.receivedAsset, r.receivedAmount, 1, r.at);
    bump(r.walletId, r.sentAsset, r.sentAmount, -1, r.at);
    bump(r.walletId, r.feeAsset, r.feeAmount, -1, r.at);
  }

  const report: CryptoReconcile["wallets"] = [];
  for (const x of wallets) {
    const missing: CryptoReconcile["wallets"][number]["missing"] = [];
    const computed = new Map<string, string>();
    for (const [k, r] of run) {
      const [wid, asset] = k.split("|") as [string, string];
      if (wid !== x.id) continue;
      computed.set(asset, r.bal);
      if (!r.bal.startsWith("-") || FIAT.has(asset) || hidden.has(asset)) continue;
      const deficit = normDec(r.bal.slice(1));
      const firstAt = r.firstNegAt ?? 0;
      missing.push({
        asset,
        deficit,
        firstAt,
        suggestions: suggest(x.id, asset, deficit, firstAt),
      });
    }
    const mismatches: CryptoReconcile["wallets"][number]["mismatches"] = [];
    const chain = x.sourceEnc ? readCursor(x.syncCursor)?.balances : null;
    if (chain && x.status === "ok")
      for (const c of chain) {
        if (hidden.has(c.asset)) continue;
        const mine = computed.get(c.asset) ?? "0";
        if (normDec(mine) === normDec(c.amount)) continue;
        mismatches.push({
          asset: c.asset,
          onChain: c.amount,
          computed: mine,
          diff: subDec(mine, c.amount),
        });
      }
    const dupes = x.sourceEnc ? duplicateSyncRows(db, x.id) : [];
    const crossChain = crossChainFor(x.id);
    if (missing.length || mismatches.length || dupes.length || crossChain.length)
      report.push({
        walletId: x.id,
        walletName: x.name,
        kind: x.kind,
        synced: !!x.sourceEnc,
        missing,
        mismatches,
        duplicates: dupes.length,
        crossChain,
      });
  }

  /**
   * Cross-chain swaps: Koinly records the coin received by a swap (e.g. Exodus's
   * built-in exchange, ETH → ADA) in the wallet the swap started from, but it
   * actually arrived in the wallet on the other chain, where sync recorded it
   * again. Match an imported receive here with a synced deposit of the same
   * coin and amount (within 1%) in another wallet within a day, when this
   * wallet never received that coin on-chain.
   */
  function crossChainFor(walletId: string): CryptoReconcile["wallets"][number]["crossChain"] {
    const syncedHere = new Set(
      rows
        .filter((r) => r.walletId === walletId && r.source === "sync")
        .map((r) => r.receivedAsset),
    );
    const out: CryptoReconcile["wallets"][number]["crossChain"] = [];
    const used = new Set<string>();
    for (const r of rows) {
      if (r.walletId !== walletId || r.source === "sync" || !r.receivedAsset || !r.receivedAmount)
        continue;
      if (r.transferPairId || syncedHere.has(r.receivedAsset)) continue;
      const want = Number(r.receivedAmount);
      const d = rows.find(
        (o) =>
          o.walletId !== walletId &&
          o.source === "sync" &&
          o.type === "deposit" &&
          !o.transferPairId &&
          !used.has(o.id) &&
          o.receivedAsset === r.receivedAsset &&
          Math.abs(o.at - r.at) <= DAY &&
          Math.abs(Number(o.receivedAmount) - want) <= want * 0.01,
      );
      if (d) {
        used.add(d.id);
        out.push({
          txnId: r.id,
          asset: r.receivedAsset,
          amount: r.receivedAmount,
          at: r.at,
          toWalletId: d.walletId,
          toWalletName: names.get(d.walletId) ?? "",
          toTxnId: d.id,
        });
        continue;
      }
      // No deposit anywhere: the swap may have paid out straight to another
      // wallet or exchange (e.g. a Coinbase deposit address), which then lacks
      // exactly this amount from just after the swap.
      for (const [k, b] of run) {
        const [wid, asset] = k.split("|") as [string, string];
        if (wid === walletId || asset !== r.receivedAsset || !b.bal.startsWith("-")) continue;
        if (
          b.firstNegAt === null ||
          b.firstNegAt < r.at - 3_600_000 ||
          b.firstNegAt > r.at + 3 * DAY
        )
          continue;
        const deficit = Number(b.bal.slice(1));
        if (Math.abs(deficit - want) > want * 0.01 || used.has(k)) continue;
        used.add(k);
        out.push({
          txnId: r.id,
          asset: r.receivedAsset,
          amount: r.receivedAmount,
          at: r.at,
          toWalletId: wid,
          toWalletName: names.get(wid) ?? "",
          toTxnId: null,
        });
        break;
      }
    }
    return out;
  }

  function suggest(
    walletId: string,
    asset: string,
    deficit: string,
    firstAt: number,
  ): CryptoTransferSuggestion[] {
    const need = toFixed(deficit);
    return rows
      .filter(
        (r) =>
          r.walletId !== walletId &&
          r.sentAsset === asset &&
          !r.transferPairId &&
          r.type !== "trade" &&
          r.at <= firstAt + DAY &&
          r.at >= firstAt - LINK_WINDOW &&
          // At least half of what's missing, at most 20× it.
          toFixed(r.sentAmount ?? "0") * 2n >= need &&
          toFixed(r.sentAmount ?? "0") <= need * 20n,
      )
      .map((r) => ({
        txnId: r.id,
        fromWalletId: r.walletId,
        fromWalletName: names.get(r.walletId) ?? "",
        at: r.at,
        amount: r.sentAmount as string,
      }))
      .sort((a, b) => Math.abs(a.at - firstAt) - Math.abs(b.at - firstAt))
      .slice(0, 3);
  }

  return { sameAddress, wallets: report };
}

// --- Fixes --------------------------------------------------------------------

/**
 * Merge wallets that sync the same address: imported and manual transactions
 * move into `into`; the others' synced copies go with them; then synced rows
 * that repeat imported ones are removed.
 */
export function mergeWallets(db: MunyDb, into: string, from: string[]) {
  return db.transaction((tx) => {
    const ids = from.filter((id) => id !== into);
    if (!tx.select({ id: w.id }).from(w).where(eq(w.id, into)).get())
      throw new Error("Wallet not found");
    const moved = tx
      .update(t)
      .set({ walletId: into })
      .where(and(inArray(t.walletId, ids), ne(t.source, "sync")))
      .run().changes;
    tx.delete(w).where(inArray(w.id, ids)).run();
    const dupes = duplicateSyncRows(tx, into);
    if (dupes.length) tx.delete(t).where(inArray(t.id, dupes)).run();
    return { moved, removedDuplicates: dupes.length, walletsRemoved: ids.length };
  });
}

/**
 * Move a cross-chain swap's proceeds to the wallet they arrived in: a transfer
 * out of this wallet, linked to the synced deposit there (which then stops
 * counting as income).
 */
export function moveCrossChain(
  db: MunyDb,
  txnId: string,
  to: { toTxnId: string | null; toWalletId: string },
) {
  return db.transaction((tx) => {
    const src = tx.select().from(t).where(eq(t.id, txnId)).get();
    if (!src?.receivedAsset || !src.receivedAmount || src.transferPairId)
      throw new Error("That transaction can't be moved");
    if (to.toWalletId === src.walletId) throw new Error("Pick another wallet");
    let dst = to.toTxnId ? tx.select().from(t).where(eq(t.id, to.toTxnId)).get() : undefined;
    if (to.toTxnId && (!dst || dst.transferPairId || dst.receivedAsset !== src.receivedAsset))
      throw new Error("Those transactions don't match");
    if (!dst) {
      // Paid straight into the other wallet: record its receiving side.
      if (!tx.select({ id: w.id }).from(w).where(eq(w.id, to.toWalletId)).get())
        throw new Error("Wallet not found");
      const inId = newId();
      tx.insert(t)
        .values({
          id: inId,
          walletId: to.toWalletId,
          at: src.at + 1000,
          type: "transfer",
          receivedAsset: src.receivedAsset,
          receivedAmount: src.receivedAmount,
          description: "Added in Reconcile: swap proceeds paid into this wallet",
          externalId: `manual:${inId}`,
          source: "manual",
        })
        .run();
      dst = tx.select().from(t).where(eq(t.id, inId)).get();
    }
    if (!dst) throw new Error("Couldn't record the receiving side");
    const id = newId();
    tx.insert(t)
      .values({
        id,
        walletId: src.walletId,
        at: src.at + 1000,
        type: "transfer",
        sentAsset: src.receivedAsset,
        sentAmount: src.receivedAmount,
        description: "Added in Reconcile: swap proceeds arrived in another wallet",
        externalId: `manual:${id}`,
        source: "manual",
        transferPairId: dst.id,
      })
      .run();
    tx.update(t)
      .set({ type: "transfer", label: null, transferPairId: id })
      .where(eq(t.id, dst.id))
      .run();
    return { id };
  });
}

/** Remove a synced wallet's rows that repeat imported ones. */
export function removeDuplicates(db: MunyDb, walletId: string) {
  const dupes = duplicateSyncRows(db, walletId);
  if (dupes.length) db.delete(t).where(inArray(t.id, dupes)).run();
  return { removed: dupes.length };
}

/** Record the receiving side of another wallet's withdrawal, linked as a transfer. */
export function linkTransfer(db: MunyDb, walletId: string, txnId: string) {
  return db.transaction((tx) => {
    const src = tx.select().from(t).where(eq(t.id, txnId)).get();
    if (!src?.sentAsset || !src.sentAmount || src.transferPairId)
      throw new Error("That transaction can't be linked");
    if (src.walletId === walletId) throw new Error("Pick a withdrawal from another wallet");
    const id = newId();
    tx.insert(t)
      .values({
        id,
        walletId,
        at: src.at,
        type: "transfer",
        receivedAsset: src.sentAsset,
        receivedAmount: src.sentAmount,
        txHash: src.txHash,
        description: "Added in Reconcile: received from another wallet",
        externalId: `manual:${id}`,
        source: "manual",
        transferPairId: src.id,
      })
      .run();
    tx.update(t)
      .set({ type: "transfer", label: null, transferPairId: id })
      .where(eq(t.id, src.id))
      .run();
    return { id };
  });
}

/** An opening balance just before history goes missing. */
export function addOpeningBalance(
  db: MunyDb,
  input: { walletId: string; asset: string; amount: string; at: number },
) {
  const id = newId();
  db.insert(t)
    .values({
      id,
      walletId: input.walletId,
      at: Math.max(0, input.at - 1000),
      type: "deposit",
      receivedAsset: input.asset,
      receivedAmount: normDec(input.amount),
      description: "Opening balance (added in Reconcile: earlier history is missing)",
      externalId: `manual:${id}`,
      source: "manual",
    })
    .run();
  return { id };
}
