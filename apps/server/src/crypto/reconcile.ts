import {
  addDec,
  CHAINS,
  type ChainKey,
  FIAT,
  fromFixed,
  isZeroDec,
  normDec,
  subDec,
  toFixed,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CryptoReconcile, CryptoTransferSuggestion } from "@muny/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { decryptJson } from "../lib/crypto.js";
import { balanceChanges, type ChainBalanceChange } from "./chains/blockscout.js";
import { rewardWithdrawals } from "./chains/cardano.js";
import { closeAmountsSql, normHash, normHashSql } from "./match.js";
import { getCryptoSettings } from "./prices.js";
import {
  fetchFullHistory,
  readCursor,
  type SyncDeps,
  setRewardsFromImport,
  syncWallet,
  walletCtx,
} from "./sync.js";

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
      label: t.label,
      txHash: t.txHash,
      description: t.description,
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
      // A Reconcile move out of this wallet with nothing coming in to move:
      // the imported row it was built on was replaced since.
      const staleFixes = rows
        .filter(
          (r) =>
            r.walletId === x.id &&
            r.source === "manual" &&
            r.sentAsset === asset &&
            /^Added in Reconcile/.test(r.description ?? "") &&
            !rows.some(
              (o) =>
                o.walletId === x.id && o.receivedAsset === asset && o.id !== r.id && o.at <= r.at,
            ),
        )
        .map((r) => r.id);
      missing.push({
        asset,
        deficit,
        firstAt,
        staleFixes,
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
        const diff = subDec(mine, c.amount);
        mismatches.push({
          asset: c.asset,
          onChain: c.amount,
          computed: mine,
          diff,
          ...(() => {
            const twice = diff.startsWith("-") ? null : rewardsTwice(x.id, c.asset, diff);
            return {
              rewardsTwice: twice ? { synced: twice, chain: x.chain } : null,
              extra: twice || diff.startsWith("-") ? [] : explainExtra(x.id, c.asset, diff),
            };
          })(),
          staking: rows.some(
            (r) =>
              r.walletId === x.id &&
              r.receivedAsset === c.asset &&
              /staking|reward/.test(r.label ?? ""),
          ),
        });
      }
    const dupes = x.sourceEnc ? duplicateSyncRows(db, x.id) : [];
    const crossChain = crossChainFor(x.id);
    if (missing.length || mismatches.length || dupes.length || crossChain.length)
      report.push({
        walletId: x.id,
        walletName: x.name,
        kind: x.kind,
        chain: x.chain,
        synced: !!x.sourceEnc,
        missing,
        mismatches,
        duplicates: dupes.length,
        importedWithHash:
          x.sourceEnc && !(x.status === "ok" && x.lastError)
            ? rows.filter((r) => r.walletId === x.id && r.source === "import" && r.txHash).length
            : 0,
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

  /**
   * Muny has `diff` more than the chain: find unmatched deposits that add up
   * to exactly that (within 0.05%, for rounded exports). Imported rows are
   * tried first (Koinly often records reward withdrawals as new deposits),
   * then synced ones. At most 4 rows from the 30 most recent candidates.
   */
  /** Count of synced staking rewards when, together, they equal the surplus. */
  function rewardsTwice(walletId: string, asset: string, diff: string): number | null {
    const rewards = rows.filter(
      (r) =>
        r.walletId === walletId &&
        r.source === "sync" &&
        r.label === "staking" &&
        r.receivedAsset === asset,
    );
    if (rewards.length < 2) return null;
    const sum = rewards.reduce((s, r) => s + toFixed(r.receivedAmount ?? "0"), 0n);
    const target = toFixed(diff);
    const tol = target / 2000n;
    return sum - target <= tol && target - sum <= tol ? rewards.length : null;
  }

  function explainExtra(walletId: string, asset: string, diff: string) {
    const target = toFixed(diff);
    const tol = target / 2000n;
    const pick = (src: (s: string) => boolean) =>
      rows
        .filter(
          (r) =>
            r.walletId === walletId &&
            src(r.source) &&
            r.receivedAsset === asset &&
            !r.transferPairId &&
            r.type === "deposit" &&
            !r.sentAsset,
        )
        .slice(-30);
    for (const cands of [pick((s) => s !== "sync"), pick((s) => s === "sync")]) {
      const v = cands.map((r) => toFixed(r.receivedAmount ?? "0"));
      const n = cands.length;
      const hit = (idx: number[]) => {
        const sum = idx.reduce((s, i) => s + (v[i] as bigint), 0n);
        return sum - target <= tol && target - sum <= tol;
      };
      let found: number[] | null = null;
      for (let a = 0; a < n && !found; a++) {
        if (hit([a])) found = [a];
        for (let b = a + 1; b < n && !found; b++) {
          if (hit([a, b])) found = [a, b];
          for (let c = b + 1; c < n && !found; c++) {
            if (hit([a, b, c])) found = [a, b, c];
            for (let d = c + 1; d < n && !found; d++) if (hit([a, b, c, d])) found = [a, b, c, d];
          }
        }
      }
      if (found)
        return found.map((i) => {
          const r = cands[i] as (typeof cands)[number];
          return {
            txnId: r.id,
            at: r.at,
            amount: r.receivedAmount as string,
            source: r.source,
            label: r.label,
          };
        });
    }
    return [];
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

/**
 * Use the blockchain's version of a synced wallet's imported transactions:
 * imported rows that carry a transaction hash are replaced by what the chain
 * says (a full resync of the wallet), so the wallet adds up to its on-chain
 * balance by construction. Links to other wallets (transfers) are kept by
 * re-linking the synced rows of the same transaction. Imported USD values
 * and labels on those rows go; daily prices fill in values.
 */
export async function preferChain(db: MunyDb, walletId: string, deps: SyncDeps) {
  const wallet = db.select().from(w).where(eq(w.id, walletId)).get();
  if (!wallet?.sourceEnc) throw new Error("This wallet isn't synced from a blockchain");
  const rowsWithHash = db
    .select()
    .from(t)
    .where(
      and(
        eq(t.walletId, walletId),
        eq(t.source, "import"),
        sql`${t.txHash} is not null and ${t.txHash} <> ''`,
      ),
    )
    .all();
  if (!rowsWithHash.length) throw new Error("No imported transactions with a hash in this wallet");
  // Safety: only replace what the chain service actually has. Closed accounts
  // (e.g. a merged Stellar account) or pruned nodes return little or nothing.
  const fetched = await fetchFullHistory(db, walletId, deps);
  const onChain = new Set(fetched.mapped.map((m) => normHash(m.txHash || "")));
  const missing = rowsWithHash.filter((r) => !onChain.has(normHash(r.txHash as string)));
  if (missing.length > 0)
    throw new Error(
      `The blockchain service doesn't have ${missing.length} of this wallet's ${rowsWithHash.length} imported transactions${fetched.notice ? ` (${fetched.notice.split(":")[0]})` : ""}, so nothing was changed.`,
    );
  // Remember transfer partners in other wallets, per transaction and direction.
  const links = rowsWithHash
    .filter((r) => r.transferPairId)
    .map((r) => ({
      hash: normHash(r.txHash as string),
      partner: r.transferPairId as string,
      dir: r.sentAsset ? ("out" as const) : ("in" as const),
      asset: (r.sentAsset ?? r.receivedAsset) as string,
    }));
  db.transaction((tx) => {
    // Fixes Reconcile made on top of imported rows go with them.
    undoReconcileRows(tx as unknown as MunyDb, walletId);
    tx.delete(t)
      .where(
        inArray(
          t.id,
          rowsWithHash.map((r) => r.id),
        ),
      )
      .run();
    // Re-read the whole history from the chain.
    tx.update(w).set({ syncCursor: null }).where(eq(w.id, walletId)).run();
  });
  const res = await syncWallet(db, walletId, deps);
  let relinked = 0;
  db.transaction((tx) => {
    for (const l of links) {
      const mine = tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.walletId, walletId),
            eq(t.source, "sync"),
            sql`${t.transferPairId} is null`,
            sql`${normHashSql("tx_hash")} = ${l.hash}`,
            l.dir === "out" ? eq(t.sentAsset, l.asset) : eq(t.receivedAsset, l.asset),
          ),
        )
        .get();
      const partner = tx.select().from(t).where(eq(t.id, l.partner)).get();
      if (!mine || !partner || partner.transferPairId) continue;
      tx.update(t)
        .set({ type: "transfer", label: null, transferPairId: partner.id })
        .where(eq(t.id, mine.id))
        .run();
      tx.update(t)
        .set({ type: "transfer", label: null, transferPairId: mine.id })
        .where(eq(t.id, partner.id))
        .run();
      relinked++;
    }
  });
  return { replaced: rowsWithHash.length, added: res.added, relinked };
}

/**
 * Remove rows Reconcile added (moves, links, opening balances) in a wallet,
 * or just the given ones, and turn their partners back into plain deposits
 * or withdrawals.
 */
export function undoReconcileRows(db: MunyDb, walletId: string, ids?: string[]) {
  const rowsToUndo = db
    .select({ id: t.id, pair: t.transferPairId })
    .from(t)
    .where(
      and(
        eq(t.walletId, walletId),
        eq(t.source, "manual"),
        sql`(${t.description} like 'Added in Reconcile%' or ${t.description} like 'Opening balance (added in Reconcile%')`,
        ids ? inArray(t.id, ids) : undefined,
      ),
    )
    .all();
  if (!rowsToUndo.length) return { undone: 0 };
  db.delete(t)
    .where(
      inArray(
        t.id,
        rowsToUndo.map((r) => r.id),
      ),
    )
    .run();
  db.run(sql`
    update crypto_txns set type = case when sent_asset is null then 'deposit' else 'withdrawal' end
     where type = 'transfer' and transfer_pair_id is null`);
  return { undone: rowsToUndo.length };
}

export interface TxnDifference {
  txHash: string | null;
  at: number;
  /** What the chain says the transaction did to the balance. */
  chain: string;
  /** What Muny's rows for it add up to. */
  muny: string;
}

/**
 * Compare a synced EVM wallet with the chain transaction by transaction (for
 * its native coin) and list where they differ.
 */
export async function compareWithChain(db: MunyDb, walletId: string, deps: SyncDeps) {
  const wallet = db.select().from(w).where(eq(w.id, walletId)).get();
  if (!wallet?.sourceEnc || !wallet.chain)
    throw new Error("This wallet isn't synced from a blockchain");
  const info = CHAINS[wallet.chain as ChainKey];
  if (info?.provider !== "blockscout")
    throw new Error(
      "Comparing transaction by transaction works for Ethereum-style wallets for now",
    );
  const changes = await balanceChanges(walletCtx(db, wallet, deps));
  const asset = info.asset;
  const chainBy = new Map<string, { at: number; v: bigint }>();
  const noHash: ChainBalanceChange[] = [];
  for (const c of changes) {
    if (!c.txHash) {
      noHash.push(c);
      continue;
    }
    const k = normHash(c.txHash);
    const cur = chainBy.get(k) ?? { at: c.at, v: 0n };
    cur.v += toFixed(c.delta);
    chainBy.set(k, cur);
  }
  const munyBy = new Map<string, { at: number; v: bigint }>();
  for (const r of db.select().from(t).where(eq(t.walletId, walletId)).all()) {
    const v =
      (r.receivedAsset === asset ? toFixed(r.receivedAmount ?? "0") : 0n) -
      (r.sentAsset === asset ? toFixed(r.sentAmount ?? "0") : 0n) -
      (r.feeAsset === asset ? toFixed(r.feeAmount ?? "0") : 0n);
    if (v === 0n) continue;
    const k = r.txHash ? normHash(r.txHash) : `row:${r.id}`;
    const cur = munyBy.get(k) ?? { at: r.at, v: 0n };
    cur.v += v;
    munyBy.set(k, cur);
  }
  const diffs: TxnDifference[] = [];
  for (const k of new Set([...chainBy.keys(), ...munyBy.keys()])) {
    const c = chainBy.get(k);
    const m = munyBy.get(k);
    if ((c?.v ?? 0n) === (m?.v ?? 0n)) continue;
    diffs.push({
      txHash: k.startsWith("row:") ? null : k,
      at: c?.at ?? m?.at ?? 0,
      chain: fromFixed(c?.v ?? 0n),
      muny: fromFixed(m?.v ?? 0n),
    });
  }
  for (const c of noHash) diffs.push({ txHash: null, at: c.at, chain: c.delta, muny: "0" });
  diffs.sort((a, b) => a.at - b.at);
  return { asset, diffs };
}

/** Add a correction so a transaction counts what the chain says it did. */
export function correctToChain(
  db: MunyDb,
  input: {
    walletId: string;
    asset: string;
    txHash: string | null;
    at: number;
    chain: string;
    muny: string;
  },
) {
  const diff = toFixed(input.chain) - toFixed(input.muny);
  if (diff === 0n) return { id: null };
  const id = newId();
  const amount = fromFixed(diff < 0n ? -diff : diff);
  db.insert(t)
    .values({
      id,
      walletId: input.walletId,
      at: input.at,
      type: diff > 0n ? "deposit" : "withdrawal",
      ...(diff > 0n
        ? { receivedAsset: input.asset, receivedAmount: amount }
        : { sentAsset: input.asset, sentAmount: amount }),
      txHash: input.txHash,
      description: "Added in Reconcile: correction to match the blockchain for this transaction",
      externalId: `manual:${id}`,
      source: "manual",
    })
    .run();
  return { id };
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

/** Remove rows Reconcile found counted twice (only from this wallet). */
export function removeRows(db: MunyDb, walletId: string, txnIds: string[]) {
  const n = db
    .delete(t)
    .where(and(eq(t.walletId, walletId), inArray(t.id, txnIds), sql`${t.transferPairId} is null`))
    .run().changes;
  return { removed: n };
}

/** Add what the chain has and Muny doesn't, as staking rewards or a plain adjustment. */
export function addAdjustment(
  db: MunyDb,
  input: { walletId: string; asset: string; amount: string; staking: boolean },
) {
  const id = newId();
  db.insert(t)
    .values({
      id,
      walletId: input.walletId,
      at: Date.now(),
      type: "deposit",
      label: input.staking ? "staking" : null,
      receivedAsset: input.asset,
      receivedAmount: normDec(input.amount),
      description: input.staking
        ? "Added in Reconcile: staking rewards the blockchain shows but history doesn't"
        : "Added in Reconcile: balance adjustment to match the blockchain",
      externalId: `manual:${id}`,
      source: "manual",
    })
    .run();
  return { id };
}

/**
 * Staking rewards counted twice. "imported": drop the synced per-epoch rewards
 * and stop syncing them for this wallet. "synced" (Cardano): keep per-epoch
 * rewards and take the withdrawn rewards out of the imported deposits that
 * withdrew them (found by looking the transactions up on the chain).
 */
export async function countRewardsOnce(
  db: MunyDb,
  walletId: string,
  keep: "imported" | "synced",
  deps: SyncDeps,
) {
  const wallet = db.select().from(w).where(eq(w.id, walletId)).get();
  if (!wallet) throw new Error("Wallet not found");
  if (keep === "imported") {
    const n = db
      .delete(t)
      .where(and(eq(t.walletId, walletId), eq(t.source, "sync"), eq(t.label, "staking")))
      .run().changes;
    setRewardsFromImport(db, walletId, true);
    return { removedRewards: n, adjusted: 0 };
  }
  if (wallet.chain !== "ada")
    throw new Error("Only Cardano wallets can keep per-epoch rewards this way");
  setRewardsFromImport(db, walletId, false);
  const deposits = db
    .select()
    .from(t)
    .where(
      and(
        eq(t.walletId, walletId),
        ne(t.source, "sync"),
        eq(t.type, "deposit"),
        eq(t.receivedAsset, "ADA"),
        sql`${t.txHash} is not null and ${t.txHash} <> ''`,
      ),
    )
    .all();
  const withdrawn = await rewardWithdrawals(
    walletCtx(db, wallet, deps),
    deposits.map((d) => normHash(d.txHash as string)),
  );
  let adjusted = 0;
  db.transaction((tx) => {
    for (const d of deposits) {
      const wd = withdrawn.get(normHash(d.txHash as string));
      if (!wd) continue;
      const left = toFixed(d.receivedAmount ?? "0") - toFixed(wd);
      adjusted++;
      if (left <= 0n) {
        tx.delete(t).where(eq(t.id, d.id)).run();
        continue;
      }
      // Keep the rest (e.g. a returned staking deposit); scale its value to match.
      const amount = fromFixed(left);
      const scale = (c: number | null) =>
        c === null ? null : Number((BigInt(c) * left) / toFixed(d.receivedAmount ?? "1"));
      tx.update(t)
        .set({
          receivedAmount: amount,
          valueCents: scale(d.valueCents),
          description: [
            d.description,
            "Reward withdrawal taken out in Reconcile (counted when earned)",
          ]
            .filter(Boolean)
            .join(" · "),
        })
        .where(eq(t.id, d.id))
        .run();
    }
  });
  return { removedRewards: 0, adjusted };
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
