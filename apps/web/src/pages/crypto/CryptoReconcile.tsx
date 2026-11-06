import type { CryptoReconcile as Report } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
  const undo = useCryptoMutation((txnIds: string[]) =>
    api.post("/api/crypto/reconcile/undo", { walletId: w.walletId, txnIds }),
  );
  const move = useCryptoMutation(
    (moves: { txnId: string; toTxnId: string | null; toWalletId: string }[]) =>
      api.post("/api/crypto/reconcile/crosschain", { moves }),
  );
  const error = dedupe.error ?? link.error ?? opening.error ?? move.error;
  const why =
    w.kind === "exchange"
      ? w.synced
        ? "This exchange syncs with its API, so the gap is usually history from before what the exchange reports, or an imported row recorded differently. Look at its transactions around that date, or add an opening balance."
        : "Exchanges keep their history off the blockchain. Connect the exchange's read-only API key on its wallet page (if it still runs), import older history, or add an opening balance."
      : w.synced
        ? "This wallet syncs its full history from the blockchain, so the gap is usually an imported row that doesn't match the chain (for example a swap recorded in the wrong wallet, see above)."
        : "This wallet isn't synced: connect its address (🔗 on the Wallets tab) and Muny pulls its whole history from the blockchain. Otherwise add the deposit by hand or an opening balance.";
  return (
    <Card id={`wallet-${w.walletId}`} className="scroll-mt-4 space-y-4">
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

      {w.missing.map((m) =>
        m.staleFixes.length > 0 ? (
          <div key={m.asset} className="space-y-2 text-sm">
            <p>
              <span className="font-medium">
                {fmtAmount(m.deficit, 8)} {m.asset} left by an earlier Reconcile fix.
              </span>{" "}
              A fix moved this {m.asset} out of {w.walletName}, but what it moved has since been
              replaced (for example by the blockchain's version), so the move now has nothing to
              move. Undoing it is safe.
            </p>
            <Button
              variant="secondary"
              disabled={undo.isPending}
              onClick={() => undo.mutate(m.staleFixes)}
            >
              Undo that fix
            </Button>
          </div>
        ) : (
          <div key={m.asset} className="space-y-2 text-sm">
            <p>
              <span className="font-medium">
                {fmtAmount(m.deficit, 8)} {m.asset} more left than arrived.
              </span>{" "}
              The balance first goes below zero on {dayLabel(m.firstAt)}, so a deposit before then
              is missing.{" "}
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
              <Button
                variant="ghost"
                disabled={opening.isPending}
                onClick={() => opening.mutate(m)}
              >
                Add an opening balance of {fmtAmount(m.deficit, 8)} {m.asset}
              </Button>
              <Link to="/crypto/wallets" className="self-center text-sm text-brand-600 underline">
                Import older history instead
              </Link>
            </div>
          </div>
        ),
      )}

      {w.siaSends.length > 0 && <SiaSends sends={w.siaSends} />}
      {w.mismatches.map((x) => (
        <Mismatch
          key={x.asset}
          walletId={w.walletId}
          m={x}
          imported={w.importedWithHash}
          exchange={!w.chain}
          chainKey={w.chain}
          evm={!!w.chain && EVM_CHAINS.get(w.chain) === x.asset}
        />
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

/**
 * Siacoin sends the import doesn't have: a move between the wallet's own
 * addresses looks the same as a payment, so the user says which.
 */
function SiaSends({ sends }: { sends: Report["wallets"][number]["siaSends"] }) {
  const own = useCryptoMutation((txnId: string) =>
    api.post<{ added: number }>("/api/crypto/reconcile/sia-own", { txnId }),
  );
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
      <p>
        <span className="font-medium">
          {sends.length === 1
            ? "A send your import doesn't have."
            : "Sends your import doesn't have."}
        </span>{" "}
        The Sia wallet moves coins between its own addresses (it shows them as 0 SC), which looks
        the same on the blockchain as paying someone. If your Sia app shows this as 0 SC, it went to
        another of your addresses: Muny adds that address and reads the wallet again.
      </p>
      <ul className="space-y-1">
        {sends.map((s) => (
          <li key={s.txnId} className="flex flex-wrap items-center gap-2">
            <span>
              {dayLabel(s.at)}: −{fmtAmount(s.amount, 8)} SC
            </span>
            <Button
              variant="secondary"
              disabled={own.isPending}
              onClick={() => own.mutate(s.txnId)}
            >
              {own.isPending ? "Reading the wallet again…" : "It went to another of my addresses"}
            </Button>
          </li>
        ))}
      </ul>
      {own.error && <p className="text-xs text-red-600">{own.error.message}</p>}
    </div>
  );
}

/** Synced wallet vs. its blockchain: explain the gap and offer the fitting fix. */
/** EVM chains and their own coin (the compare tool checks only that coin). */
const EVM_CHAINS = new Map([
  ["eth", "ETH"],
  ["base", "ETH"],
  ["op", "ETH"],
  ["arb", "ETH"],
  ["polygon", "POL"],
  ["gnosis", "XDAI"],
]);

type Kept = {
  txnId: string;
  at: number;
  asset: string;
  amount: string;
  direction: "in" | "out";
};

/** Imported rows the chain doesn't have, kept as they were: decide about each. */
function KeptRows({ rows }: { rows: Kept[] }) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const del = useCryptoMutation((id: string) => api.delete(`/api/crypto/txns/${id}`));
  const left = rows.filter((r) => !gone.has(r.txnId));
  if (!left.length) return null;
  return (
    <div className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/30">
      <p>
        The blockchain doesn&apos;t have{" "}
        {left.length === 1 ? "this imported row" : "these imported rows"}, so{" "}
        {left.length === 1 ? "it was" : "they were"} kept as imported. If{" "}
        {left.length === 1 ? "it" : "one"} never happened on this address, delete it:
      </p>
      <ul>
        {left.map((r) => (
          <li key={r.txnId} className="flex flex-wrap items-center gap-2">
            <span>
              {dayLabel(r.at)}: {r.direction === "out" ? "−" : "+"}
              {fmtAmount(r.amount, 8)} {r.asset}
            </span>
            <button
              type="button"
              disabled={del.isPending}
              onClick={() =>
                window.confirm("Delete this imported transaction?") &&
                del.mutate(r.txnId, { onSuccess: () => setGone((g) => new Set(g).add(r.txnId)) })
              }
              className="text-xs text-red-600 hover:underline"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {del.error && <p className="text-xs text-red-600">{del.error.message}</p>}
    </div>
  );
}

interface TxnDiff {
  txHash: string | null;
  at: number;
  chain: string;
  muny: string;
}

function Mismatch({
  walletId,
  m,
  imported,
  evm,
  exchange,
  chainKey,
}: {
  walletId: string;
  m: MismatchT;
  imported: number;
  evm: boolean;
  exchange: boolean;
  chainKey: string | null;
}) {
  const siaFind = useCryptoMutation(() =>
    api.post<{ checked: number; added: number }>("/api/crypto/reconcile/sia-addresses", {
      walletId,
    }),
  );
  const compare = useCryptoMutation(() =>
    api.post<{ asset: string; diffs: TxnDiff[] }>("/api/crypto/reconcile/compare", { walletId }),
  );
  const correct = useCryptoMutation((d: TxnDiff) =>
    api.post("/api/crypto/reconcile/correct", { walletId, asset: m.asset, ...d }),
  );
  const [fixed, setFixed] = useState<Set<string>>(new Set());
  const chain = useCryptoMutation(() =>
    api.post<{ replaced: number; added: number; relinked: number; kept: Kept[] }>(
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
  const closeIt = useCryptoMutation((v: { at?: number; toTxnId?: string }) =>
    api.post("/api/crypto/reconcile/closed", {
      walletId,
      asset: m.asset,
      amount: m.diff,
      ...v,
    }),
  );
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const [closedOn, setClosedOn] = useState(() =>
    isoDay((m.closed?.lastAt ?? Date.now()) + 86_400_000),
  );
  const more = !m.diff.startsWith("-");
  const gap = fmtAmount(m.diff.replace(/^-/, ""), 8);
  const error =
    remove.error ??
    adjust.error ??
    once.error ??
    chain.error ??
    compare.error ??
    correct.error ??
    closeIt.error;
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-medium">
          {m.asset}: {exchange ? "the exchange reports" : "the blockchain shows"}{" "}
          {fmtAmount(m.onChain, 8)}, Muny has {fmtAmount(m.computed, 8)}
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
      {chainKey === "sc" && (
        <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p>
            <span className="font-medium">This wallet probably has more addresses.</span> The Sia
            app makes a new address every time you press Receive, and Muny only reads the ones it
            knows. Each sync looks up your imported Siacoin transactions on SiaScan and adds the
            addresses they reveal: where deposits arrived, what sends spent from, and where their
            change went. You can also run it now.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={siaFind.isPending} onClick={() => siaFind.mutate(undefined)}>
              {siaFind.isPending ? "Looking them up…" : "Find my other addresses"}
            </Button>
            {siaFind.data && (
              <span className="text-xs text-slate-500">
                {siaFind.data.added
                  ? `Added ${siaFind.data.added} ${siaFind.data.added === 1 ? "address" : "addresses"} and synced again.`
                  : `Checked ${siaFind.data.checked} imported ${siaFind.data.checked === 1 ? "deposit" : "deposits"}: no new address found. Add them by hand (“change” on the wallet page; in the Sia app, Receive lists your addresses).`}
              </span>
            )}
          </div>
          {siaFind.error && <p className="text-xs text-red-600">{siaFind.error.message}</p>}
        </div>
      )}
      {more && m.closed && (
        <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p>
            <span className="font-medium">The blockchain no longer has this account.</span> It was
            closed (on Stellar, merging an account sends everything in it to another account and
            removes it), or the address isn&apos;t right. Your history ends on{" "}
            {dayLabel(m.closed.lastAt)} with {gap} {m.asset} still here, so the move that emptied it
            is missing. Where did it go?
          </p>
          {m.closed.suggestions.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-slate-500">
                Deposits in your other wallets after that, of about that amount:
              </p>
              <div className="flex flex-wrap gap-2">
                {m.closed.suggestions.map((s) => (
                  <Button
                    key={s.txnId}
                    variant="secondary"
                    disabled={closeIt.isPending}
                    onClick={() => closeIt.mutate({ toTxnId: s.txnId })}
                  >
                    To {s.fromWalletName}: {fmtAmount(s.amount, 8)} {m.asset} on {dayLabel(s.at)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-500">
              <span className="sr-only">Date it left</span>
              <input
                type="date"
                value={closedOn}
                min={isoDay(m.closed.lastAt)}
                onChange={(e) => setClosedOn(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <Button
              variant="secondary"
              disabled={closeIt.isPending || !closedOn}
              onClick={() =>
                closeIt.mutate({
                  at: Math.max(Date.parse(`${closedOn}T12:00:00Z`), (m.closed?.lastAt ?? 0) + 1000),
                })
              }
            >
              Record {gap} {m.asset} as sent out of your wallets on this day
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            If it went to a wallet of yours that isn&apos;t in Muny yet, add that wallet first and
            it shows up above. The added row is marked &quot;Added in Reconcile&quot; and can be
            deleted from Transactions.
          </p>
        </div>
      )}
      {more && !m.closed && chainKey !== "sc" && !m.rewardsTwice && m.extra.length === 0 && (
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
            wallet adds up to its on-chain balance. Links to your other wallets, tags and USD values
            are kept; rows the chain doesn&apos;t have stay as imported.
          </p>
          <Button disabled={chain.isPending} onClick={() => chain.mutate(undefined)}>
            {chain.isPending ? "Re-reading the blockchain…" : "Use the blockchain's version"}
          </Button>
          {chain.data && chain.data.kept.length > 0 && <KeptRows rows={chain.data.kept} />}
        </div>
      )}
      {evm && !m.rewardsTwice && (
        <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
          <p>
            Compare {m.asset} with the blockchain transaction by transaction to see exactly which
            ones Muny records differently (uses a few requests to Blockscout).
          </p>
          {!compare.data && (
            <Button
              variant="secondary"
              disabled={compare.isPending}
              onClick={() => compare.mutate(undefined)}
            >
              {compare.isPending ? "Comparing…" : "Find the transactions that differ"}
            </Button>
          )}
          {compare.data && compare.data.diffs.length === 0 && (
            <p className="text-slate-500">
              Every transaction matches the chain. The difference may come from rows without a
              transaction (added by hand or imported without a hash).
            </p>
          )}
          {compare.data && compare.data.diffs.length > 0 && (
            <ul className="space-y-1">
              {compare.data.diffs.map((d) => {
                const key = `${d.txHash ?? "none"}:${d.at}`;
                return (
                  <li
                    key={key}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-1 dark:border-slate-700"
                  >
                    <span>
                      {dayLabel(d.at)}{" "}
                      <span className="font-mono text-xs text-slate-500">
                        {d.txHash ? `${d.txHash.slice(0, 8)}…` : "no transaction (e.g. a reward)"}
                      </span>
                      : chain {fmtAmount(d.chain, 8)}, Muny {fmtAmount(d.muny, 8)}{" "}
                      {compare.data?.asset}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={correct.isPending || fixed.has(key)}
                      onClick={() =>
                        correct.mutate(d, { onSuccess: () => setFixed((s) => new Set(s).add(key)) })
                      }
                    >
                      {fixed.has(key) ? "Corrected" : "Use the chain's amount"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
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
  // Opened from a wallet's Troubleshoot button: bring its card into view once loaded.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (d && id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [d]);
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
