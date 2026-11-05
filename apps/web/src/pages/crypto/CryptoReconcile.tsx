import type { CryptoReconcile as Report } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SelectField } from "../../components/forms.js";
import { Alert, Button, Card } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  useCryptoMutation,
  useCryptoOverview,
  useCryptoReconcile,
  useCryptoSettings,
} from "../../lib/queries.js";
import { CryptoHeader, dayLabel, fmtAmount } from "./common.js";

/**
 * Reconcile: why balances are off, and one-click fixes. Every fix is a normal,
 * visible change (merged wallets, removed duplicate rows, added transactions
 * marked "Added in Reconcile"), recorded in the audit log.
 */

function SameAddress({ group }: { group: Report["sameAddress"][number] }) {
  // Keep the wallet with the most transactions by default.
  const best = [...group.wallets].sort((a, b) => b.txnCount - a.txnCount)[0];
  const [into, setInto] = useState(best?.id ?? "");
  const merge = useCryptoMutation(() =>
    api.post<{ moved: number; removedDuplicates: number }>("/api/crypto/reconcile/merge", {
      into,
      from: group.wallets.map((w) => w.id).filter((id) => id !== into),
    }),
  );
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">
        {group.wallets.length} wallets sync the same {group.chainName} address
      </h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {group.wallets.map((w) => w.name).join(", ")} all sync one address, so every transaction on
        it is counted {group.wallets.length} times. This often happens when Koinly kept one wallet
        per token. Merging keeps one wallet: imported and hand-added transactions move into it, and
        copies that repeat each other are removed.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField label="Keep" value={into} onChange={(e) => setInto(e.target.value)}>
          {group.wallets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.txnCount} transactions)
            </option>
          ))}
        </SelectField>
        <Button disabled={merge.isPending} onClick={() => merge.mutate(undefined)}>
          {merge.isPending ? "Merging…" : `Merge ${group.wallets.length} wallets`}
        </Button>
      </div>
      {merge.error && <Alert>{merge.error.message}</Alert>}
    </Card>
  );
}

function WalletIssues({ w }: { w: Report["wallets"][number] }) {
  const dedupe = useCryptoMutation(() =>
    api.post<{ removed: number }>("/api/crypto/reconcile/duplicates", { walletId: w.walletId }),
  );
  const link = useCryptoMutation((txnId: string) =>
    api.post("/api/crypto/reconcile/link", { walletId: w.walletId, txnId }),
  );
  const opening = useCryptoMutation((m: Report["wallets"][number]["missing"][number]) =>
    api.post("/api/crypto/reconcile/opening", {
      walletId: w.walletId,
      asset: m.asset,
      amount: m.deficit,
      at: m.firstAt,
    }),
  );
  const move = useCryptoMutation(
    (moves: { txnId: string; toTxnId: string | null; toWalletId: string }[]) =>
      api.post("/api/crypto/reconcile/crosschain", { moves }),
  );
  const error = dedupe.error ?? link.error ?? opening.error ?? move.error;
  const why =
    w.kind === "exchange"
      ? "Exchanges keep their history off the blockchain, so it can't be synced from there: it needs the exchange's own history (exchange sync is coming), an older import, or an opening balance."
      : w.synced
        ? "This wallet syncs its full history from the blockchain, so the gap is usually an imported row that doesn't match the chain (for example a swap recorded in the wrong wallet, see above)."
        : "This wallet isn't synced: connect its address (🔗 on the Wallets tab) and Muny pulls its whole history from the blockchain. Otherwise add the deposit by hand or an opening balance.";
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{w.walletName}</h3>
        <Link
          to="/crypto/transactions"
          search={{ walletId: w.walletId }}
          className="text-sm text-brand-600 underline"
        >
          See its transactions
        </Link>
      </div>

      {w.duplicates > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
          <span>
            <span className="font-medium">{w.duplicates} synced transactions</span> repeat ones you
            imported (same hash, or same amount within two days), so they count twice. The imported
            ones keep their prices and labels.
          </span>
          <Button
            variant="secondary"
            disabled={dedupe.isPending}
            onClick={() => dedupe.mutate(undefined)}
          >
            Remove the synced copies
          </Button>
        </div>
      )}

      {w.crossChain.length > 0 && (
        <div className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Swaps recorded in the wrong wallet.</span> Koinly puts the
            coin you got from a cross-chain swap (like Exodus&apos;s built-in exchange) in the
            wallet you swapped from, but it arrived in your wallet on the other chain, where it was
            synced too. Moving it there counts it once, as a transfer.
          </p>
          <ul className="space-y-1">
            {w.crossChain.map((c) => (
              <li
                key={c.txnId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
              >
                <span>
                  {fmtAmount(c.amount, 8)} {c.asset} on {dayLabel(c.at)}{" "}
                  {c.toTxnId ? "arrived in" : "was paid straight into"}{" "}
                  <span className="font-medium">{c.toWalletName}</span>
                  {!c.toTxnId && (
                    <span className="text-slate-500">
                      {" "}
                      (it's missing exactly that much from then)
                    </span>
                  )}
                </span>
                <Button
                  variant="secondary"
                  disabled={move.isPending}
                  onClick={() =>
                    move.mutate([{ txnId: c.txnId, toTxnId: c.toTxnId, toWalletId: c.toWalletId }])
                  }
                >
                  Move there
                </Button>
              </li>
            ))}
          </ul>
          {w.crossChain.length > 1 && (
            <Button
              disabled={move.isPending}
              onClick={() =>
                move.mutate(
                  w.crossChain.map((c) => ({
                    txnId: c.txnId,
                    toTxnId: c.toTxnId,
                    toWalletId: c.toWalletId,
                  })),
                )
              }
            >
              Move all {w.crossChain.length}
            </Button>
          )}
        </div>
      )}

      {w.missing.map((m) => (
        <div key={m.asset} className="space-y-2 text-sm">
          <p>
            <span className="font-medium">
              {fmtAmount(m.deficit, 8)} {m.asset} more left than arrived.
            </span>{" "}
            The balance first goes below zero on {dayLabel(m.firstAt)}, so a deposit before then is
            missing.{" "}
            {w.kind !== "exchange" && !w.synced && !SYNCABLE.has(m.asset)
              ? `Muny can't sync ${m.asset} from a blockchain (no public service for it), so add an opening balance or hide the coin.`
              : why}
          </p>
          {m.suggestions.length > 0 && (
            <ul className="space-y-1">
              {m.suggestions.map((s) => (
                <li
                  key={s.txnId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
                >
                  <span>
                    Possible match: {fmtAmount(s.amount, 8)} {m.asset} sent from{" "}
                    <span className="font-medium">{s.fromWalletName}</span> on {dayLabel(s.at)}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={link.isPending}
                    onClick={() => link.mutate(s.txnId)}
                  >
                    It arrived here
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={opening.isPending} onClick={() => opening.mutate(m)}>
              Add an opening balance of {fmtAmount(m.deficit, 8)} {m.asset}
            </Button>
            <Link to="/crypto/wallets" className="self-center text-sm text-brand-600 underline">
              Import older history instead
            </Link>
          </div>
        </div>
      ))}

      {w.mismatches.map((x) => (
        <Mismatch key={x.asset} walletId={w.walletId} m={x} imported={w.importedWithHash} />
      ))}
      {error && <Alert>{error.message}</Alert>}
    </Card>
  );
}

const SYNCABLE = new Set<string>([
  "BTC",
  "ETH",
  "ADA",
  "ALGO",
  "XLM",
  "ATOM",
  "TRX",
  "LTC",
  "DOGE",
  "POL",
  "XDAI",
]);

type MismatchT = Report["wallets"][number]["mismatches"][number];

/** Synced wallet vs. its blockchain: explain the gap and offer the fitting fix. */
function Mismatch({ walletId, m, imported }: { walletId: string; m: MismatchT; imported: number }) {
  const chain = useCryptoMutation(() =>
    api.post<{ replaced: number; added: number; relinked: number }>(
      "/api/crypto/reconcile/prefer-chain",
      { walletId },
    ),
  );
  const remove = useCryptoMutation(() =>
    api.post("/api/crypto/reconcile/remove", { walletId, txnIds: m.extra.map((e) => e.txnId) }),
  );
  const adjust = useCryptoMutation((staking: boolean) =>
    api.post("/api/crypto/reconcile/adjust", {
      walletId,
      asset: m.asset,
      amount: m.diff.replace(/^-/, ""),
      staking,
    }),
  );
  const once = useCryptoMutation((keep: "imported" | "synced") =>
    api.post<{ removedRewards: number; adjusted: number }>("/api/crypto/reconcile/rewards", {
      walletId,
      keep,
    }),
  );
  const more = !m.diff.startsWith("-");
  const gap = fmtAmount(m.diff.replace(/^-/, ""), 8);
  const error = remove.error ?? adjust.error ?? once.error ?? chain.error;
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-medium">
          {m.asset}: the blockchain shows {fmtAmount(m.onChain, 8)}, Muny has{" "}
          {fmtAmount(m.computed, 8)}
        </span>{" "}
        ({gap} {more ? "more" : "less"} in Muny).
      </p>
      {more && m.rewardsTwice && (
        <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p>
            <span className="font-medium">Staking rewards are counted twice.</span> The{" "}
            {m.rewardsTwice.synced} rewards Muny synced (one per{" "}
            {m.rewardsTwice.chain === "ada" ? "5-day epoch" : "payout"}) add up to exactly the
            difference, so your import has them too: Koinly records rewards when you withdraw them,
            as ordinary deposits. Keep one version:
          </p>
          <div className="flex flex-wrap gap-2">
            {m.rewardsTwice.chain === "ada" && (
              <Button disabled={once.isPending} onClick={() => once.mutate("synced")}>
                Keep per-epoch rewards (recommended)
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={once.isPending}
              onClick={() => once.mutate("imported")}
            >
              Keep the imported version
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            {m.rewardsTwice.chain === "ada" &&
              "Per-epoch: each reward is income when earned, at that day's price; Muny looks up the withdrawal transactions on Cardano and takes the withdrawn rewards out of the imported deposits (anything else in them, like a returned staking deposit, stays). "}
            Imported: Muny removes its synced rewards and stops adding them for this wallet; rewards
            count as income when withdrawn.
          </p>
        </div>
      )}
      {more && !m.rewardsTwice && m.extra.length > 0 && (
        <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p>
            {m.extra.length === 1 ? "This deposit adds" : `These ${m.extra.length} deposits add`} up
            to exactly the difference, so {m.extra.length === 1 ? "it's" : "they're"} most likely
            counted twice.
            {m.extra.some((e) => e.source === "import") &&
              m.staking &&
              " Koinly records withdrawing staking rewards as a new deposit, but Muny already counts each reward when it's earned."}
          </p>
          <ul className="text-slate-600 dark:text-slate-300">
            {m.extra.map((e) => (
              <li key={e.txnId}>
                {dayLabel(e.at)}: {fmtAmount(e.amount, 8)} {m.asset}
                {e.label ? ` (${e.label})` : ""}, {e.source === "sync" ? "synced" : "imported"}
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            disabled={remove.isPending}
            onClick={() => remove.mutate(undefined)}
          >
            Remove {m.extra.length === 1 ? "it" : "them"}
          </Button>
        </div>
      )}
      {more && !m.rewardsTwice && m.extra.length === 0 && (
        <p className="text-slate-500">
          No set of deposits adds up to the difference. Look for a withdrawal that&apos;s missing,
          or a deposit recorded twice with different amounts, in its transactions.
        </p>
      )}
      {!more && (
        <div className="space-y-2">
          <p className="text-slate-500">
            Some history is missing: the blockchain service may not keep old transactions, or
            deposits came before this address was synced.{" "}
            {m.staking && "For a staking wallet this is usually rewards that were never recorded. "}
            You can add the difference so the balance matches.
          </p>
          <div className="flex flex-wrap gap-2">
            {m.staking && (
              <Button
                variant="secondary"
                disabled={adjust.isPending}
                onClick={() => adjust.mutate(true)}
              >
                Add {gap} {m.asset} as staking rewards
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={adjust.isPending}
              onClick={() => adjust.mutate(false)}
            >
              Add {gap} {m.asset} as a balance adjustment (not income)
            </Button>
          </div>
        </div>
      )}
      {imported > 0 && !m.rewardsTwice && (
        <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p>
            <span className="font-medium">Most reliable fix:</span> use the blockchain&apos;s
            version of this wallet&apos;s {imported} imported{" "}
            {imported === 1 ? "transaction" : "transactions"}. Exports sometimes split or round a
            transaction differently from what happened on-chain; built from the chain alone, the
            wallet adds up to its on-chain balance. Links to your other wallets are kept; imported
            USD values on those rows are replaced by daily prices.
          </p>
          <Button disabled={chain.isPending} onClick={() => chain.mutate(undefined)}>
            {chain.isPending ? "Re-reading the blockchain…" : "Use the blockchain's version"}
          </Button>
        </div>
      )}
      {error && <Alert>{error.message}</Alert>}
    </div>
  );
}

function Unpriced() {
  const o = useCryptoOverview();
  const s = useCryptoSettings();
  const save = useCryptoMutation((hiddenAssets: string[]) =>
    api.put("/api/crypto/settings", { hiddenAssets }),
  );
  const hidden = s.data?.hiddenAssets ?? [];
  const unpriced = o.data?.pricesEnabled ? (o.data.unpricedAssets ?? []) : [];
  if (!unpriced.length && !hidden.length) return null;
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">Coins without a price</h3>
      {unpriced.length > 0 && (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Most of these are airdropped spam tokens; hide them and they disappear from holdings and
            warnings. For a real coin, map it to its CoinGecko id in{" "}
            <Link to="/crypto/settings" className="text-brand-600 underline">
              Settings
            </Link>
            .
          </p>
          <ul className="flex flex-wrap gap-2">
            {unpriced.map((a) => (
              <li
                key={a}
                className="flex items-center gap-1 rounded-full border border-slate-200 py-0.5 pl-3 pr-1 text-sm dark:border-slate-700"
              >
                {a}
                <Button variant="ghost" onClick={() => save.mutate([...hidden, a])}>
                  Hide
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => save.mutate([...hidden, ...unpriced])}>
            Hide all {unpriced.length}
          </Button>
        </>
      )}
      {hidden.length > 0 && (
        <p className="text-sm text-slate-500">
          Hidden: {hidden.join(", ")}.{" "}
          <button
            type="button"
            className="text-brand-600 underline"
            onClick={() => save.mutate([])}
          >
            Show them again
          </button>
        </p>
      )}
    </Card>
  );
}

export function CryptoReconcile() {
  const r = useCryptoReconcile();
  const d = r.data;
  const clean = d && d.sameAddress.length === 0 && d.wallets.length === 0;
  return (
    <>
      <CryptoHeader />
      {r.isError && <Alert>{r.error.message}</Alert>}
      <div className="max-w-4xl space-y-4">
        {clean && (
          <Card className="text-center text-sm text-slate-600 dark:text-slate-300">
            Everything adds up: no duplicates, no missing history, and synced wallets match the
            blockchain.
          </Card>
        )}
        {d?.sameAddress.map((g) => (
          <SameAddress key={`${g.chain}:${g.wallets[0]?.id}`} group={g} />
        ))}
        {d?.wallets.map((w) => (
          <WalletIssues key={w.walletId} w={w} />
        ))}
        <Unpriced />
      </div>
    </>
  );
}
