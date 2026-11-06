import {
  CRYPTO_EXCHANGES,
  type CryptoTxnType,
  type CryptoWallet,
  cryptoExchange,
  formatMoney,
} from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Modal } from "../../components/forms.js";
import { Alert, Button, Card, cx } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  useCryptoMutation,
  useCryptoSettings,
  useCryptoSyncRuns,
  useCryptoWallet,
} from "../../lib/queries.js";
import { AddTxn } from "./CryptoTransactions.js";
import { ConnectWallet, ImportKoinly, mismatches, SyncChip } from "./CryptoWallets.js";
import { agoTime, CryptoHeader, fmtAmount, when } from "./common.js";

/**
 * One wallet, Koinly-style: sync and import, sync history, what's in it, links
 * to its transactions by type, notes, and a way into Reconcile.
 */

const CHIPS: [CryptoTxnType | undefined, string, string][] = [
  [undefined, "transaction", "transactions"],
  ["deposit", "deposit", "deposits"],
  ["withdrawal", "withdrawal", "withdrawals"],
  ["trade", "trade", "trades"],
  ["transfer", "transfer", "transfers"],
];

function Notes({ id, notes }: { id: string; notes: string | null }) {
  const [v, setV] = useState(notes ?? "");
  useEffect(() => setV(notes ?? ""), [notes]);
  const save = useCryptoMutation((n: string) =>
    api.patch(`/api/crypto/wallets/${id}`, { notes: n || null }),
  );
  return (
    <label className="block">
      <span className="sr-only">Notes</span>
      <textarea
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== (notes ?? "") && save.mutate(v)}
        rows={3}
        placeholder="Add notes here…"
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
      />
      {save.isPending && <span className="text-xs text-slate-500">Saving…</span>}
    </label>
  );
}

function History({ id }: { id: string }) {
  const runs = useCryptoSyncRuns(id, true);
  if (runs.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!runs.data?.length) return <p className="text-sm text-slate-500">No syncs yet.</p>;
  return (
    <ul className="max-h-[60vh] divide-y divide-slate-200 overflow-y-auto text-sm dark:divide-slate-700">
      {runs.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
          <span>
            <span
              className={cx(
                "mr-2 rounded-full px-2 py-0.5 text-xs",
                r.status === "ok"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                  : "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
              )}
            >
              {r.status === "ok" ? "Synced" : "Failed"}
            </span>
            {when(r.startedAt)}
          </span>
          <span className="text-xs text-slate-500">
            {r.status === "ok"
              ? `${r.added} new${r.duplicates ? `, ${r.duplicates} already there` : ""} · ${Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))}s`
              : ""}
          </span>
          {r.message && <span className="block w-full text-xs text-slate-500">{r.message}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Which exchange this is, what Muny can do with it, and closing it out. */
function ExchangeCard({
  w,
  onConnect,
  onWithdrawal,
}: {
  w: CryptoWallet;
  onConnect: () => void;
  onWithdrawal: () => void;
}) {
  const ex = cryptoExchange(w.exchange);
  const patch = useCryptoMutation((body: object) => api.patch(`/api/crypto/wallets/${w.id}`, body));
  const lost = useCryptoMutation((at: number) =>
    api.post<{ coins: number }>(`/api/crypto/wallets/${w.id}/lost`, { at }),
  );
  const [lostOn, setLostOn] = useState(ex?.closedOn ?? new Date().toISOString().slice(0, 10));
  const holds = w.balances.length > 0;
  if (!ex)
    return (
      <Card className="space-y-2 text-sm">
        <p className="font-medium">Which exchange is this?</p>
        <p className="text-slate-500">
          Muny can then tell you whether it still runs and whether it can sync.
        </p>
        <select
          aria-label="Exchange"
          defaultValue=""
          onChange={(e) => e.target.value && patch.mutate({ exchange: e.target.value })}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        >
          <option value="">Choose…</option>
          {CRYPTO_EXCHANGES.map((x) => (
            <option key={x.key} value={x.key}>
              {x.name}
            </option>
          ))}
        </select>
      </Card>
    );
  return (
    <Card className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{ex.name}</span>
        <span
          className={cx(
            "rounded-full px-2 py-0.5 text-xs",
            ex.status === "active"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
              : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
          )}
        >
          {ex.status === "active"
            ? ex.sync === "api"
              ? "Active · can sync"
              : "Active · import only"
            : `Closed${ex.closedOn ? ` ${ex.closedOn.slice(0, 7)}` : ""}`}
        </span>
        {w.archived && (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-700">
            Archived
          </span>
        )}
      </div>
      <p className="text-slate-600 dark:text-slate-300">{ex.note}</p>
      <div className="flex flex-wrap gap-2">
        {ex.sync === "api" && (
          <Button variant={w.sourceHint ? "secondary" : "primary"} onClick={onConnect}>
            {w.sourceHint ? "Change API key" : "🔗 Sync with a read-only API key"}
          </Button>
        )}
        {ex.status === "closed" && (
          <Button variant="secondary" onClick={onWithdrawal}>
            Add the transfer out
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={patch.isPending}
          onClick={() => patch.mutate({ archived: !w.archived })}
        >
          {w.archived ? "Unarchive" : "Archive"}
        </Button>
      </div>
      {ex.status === "closed" && holds && (
        <div className="space-y-2 rounded-lg border border-amber-200 px-3 py-2 dark:border-amber-900">
          <p>
            Muny&apos;s history still has coins here. If you withdrew them, add that transfer out
            (or import it). If they were stuck when {ex.name} closed, mark them lost: one
            &quot;lost&quot; withdrawal per coin on that day, which counts as a loss rather than a
            sale. Deleting those rows undoes it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Lost on"
              value={lostOn}
              onChange={(e) => setLostOn(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <Button
              variant="secondary"
              disabled={lost.isPending || !lostOn}
              onClick={() =>
                window.confirm(`Record everything left on ${w.name} as lost on ${lostOn}?`) &&
                lost.mutate(Date.parse(`${lostOn}T12:00:00Z`))
              }
            >
              Mark what&apos;s left as lost
            </Button>
          </div>
        </div>
      )}
      {ex.status === "closed" && !holds && !w.archived && (
        <p className="text-xs text-slate-500">
          Nothing is left here, so it can be archived: its history stays, out of the way.
        </p>
      )}
      {(patch.error ?? lost.error) && <Alert>{(patch.error ?? lost.error)?.message}</Alert>}
    </Card>
  );
}

/**
 * A wallet you can't open any more (lost recovery phrase, old app or device):
 * record what's left as lost, and archive it.
 */
function LostAccessCard({ w, onClose }: { w: CryptoWallet; onClose: () => void }) {
  const patch = useCryptoMutation((body: object) => api.patch(`/api/crypto/wallets/${w.id}`, body));
  const lost = useCryptoMutation((at: number) =>
    api.post<{ coins: number }>(`/api/crypto/wallets/${w.id}/lost`, { at, reason: "access" }),
  );
  const [lostOn, setLostOn] = useState(new Date().toISOString().slice(0, 10));
  const holds = w.balances.length > 0;
  return (
    <Card className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">No longer have access</span>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:underline">
          Close
        </button>
      </div>
      {holds ? (
        <>
          <p className="text-slate-600 dark:text-slate-300">
            If you can&apos;t open this wallet any more (lost recovery phrase, an old app or
            device), what&apos;s in it is gone for good. Mark it lost: one &quot;lost&quot;
            withdrawal per coin on the day you lost access, which counts as a loss rather than a
            sale. Deleting those rows undoes it.
          </p>
          <p className="text-xs text-slate-500">
            Still holds {w.balances.map((b) => `${fmtAmount(b.amount)} ${b.asset}`).join(", ")}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Lost access on"
              value={lostOn}
              onChange={(e) => setLostOn(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <Button
              variant="secondary"
              disabled={lost.isPending || !lostOn}
              onClick={() =>
                window.confirm(`Record everything left in ${w.name} as lost on ${lostOn}?`) &&
                lost.mutate(Date.parse(`${lostOn}T12:00:00Z`))
              }
            >
              Mark what&apos;s left as lost
            </Button>
          </div>
        </>
      ) : (
        <p className="text-slate-600 dark:text-slate-300">
          Nothing is left in it{lost.data ? " now" : ""}. Archive it to keep its history out of the
          way: off the wallet list (under &quot;archived&quot;) and out of daily syncs.
        </p>
      )}
      <Button
        variant={holds ? "ghost" : "primary"}
        disabled={patch.isPending}
        onClick={() => patch.mutate({ archived: !w.archived })}
      >
        {w.archived ? "Unarchive" : "Archive this wallet"}
      </Button>
      {(patch.error ?? lost.error) && <Alert>{(patch.error ?? lost.error)?.message}</Alert>}
    </Card>
  );
}

interface ReceiveInfo {
  chain: string;
  chainName: string;
  coin: string;
  address: string | null;
  note: string | null;
}

/** The wallet's receive address with a QR code (drawn in the browser). */
function Receive({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["crypto", "receive", id],
    queryFn: () => api.get<ReceiveInfo>(`/api/crypto/wallets/${id}/receive`),
  });
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const address = q.data?.address;
  useEffect(() => {
    if (!address) return;
    let live = true;
    void QRCode.toDataURL(address, { margin: 1, width: 220 }).then((u) => live && setQr(u));
    return () => {
      live = false;
    };
  }, [address]);
  if (q.isError) return <Alert>{q.error.message}</Alert>;
  if (!q.data) return <p className="text-sm text-slate-500">Loading…</p>;
  const d = q.data;
  const evm = ["eth", "base", "op", "arb", "polygon", "gnosis"].includes(d.chain);
  return (
    <div className="space-y-4 text-center text-sm">
      <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
        <CoinIcon asset={d.coin} size="sm" />
        {d.chainName} network
      </span>
      {d.address ? (
        <>
          <p className="text-slate-500">
            Your {d.coin} address on {d.chainName}
          </p>
          <div className="flex items-center justify-center gap-2">
            <code className="break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs dark:bg-slate-800">
              {d.address}
            </code>
            <button
              type="button"
              aria-label="Copy address"
              onClick={() => {
                void navigator.clipboard?.writeText(d.address as string).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {qr && (
            <img
              src={qr}
              alt={`QR code for ${d.address}`}
              className="mx-auto rounded-lg bg-white p-2"
              width={220}
              height={220}
            />
          )}
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Send only {d.coin}
            {evm ? ` and ${d.chainName} tokens` : ""} on the {d.chainName} network to this address.
          </p>
        </>
      ) : null}
      {d.note && <p className="text-xs text-slate-500">{d.note}</p>}
    </div>
  );
}

/** Paste a read-only API key (stored encrypted; sent only to that exchange). */
function ConnectExchange({ w, onDone }: { w: CryptoWallet; onDone: () => void }) {
  const ex = cryptoExchange(w.exchange);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const save = useCryptoMutation(() =>
    api.put(`/api/crypto/wallets/${w.id}/exchange`, { exchange: w.exchange, key, secret }),
  );
  if (!ex?.setup) return null;
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      <p className="text-slate-600 dark:text-slate-300">
        {ex.setup.steps}{" "}
        <a
          href={ex.setup.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand-600 underline"
        >
          Open {ex.name} ↗
        </a>
      </p>
      <label className="block">
        <span className="text-xs text-slate-500">{ex.setup.keyLabel}</span>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-xs text-slate-500">{ex.setup.secretLabel}</span>
        <textarea
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          rows={w.exchange === "coinbase" ? 5 : 2}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <p className="text-xs text-slate-500">
        Muny stores the key encrypted on your server and sends it only to {ex.name}, to read
        balances and history. Give it read-only permissions: Muny never trades or moves money. The
        first sync runs in the background.
      </p>
      {save.error && <Alert>{save.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!key.trim() || !secret.trim() || save.isPending}>
          Save and sync
        </Button>
      </div>
    </form>
  );
}

export function CryptoWalletPage() {
  const { walletId } = useParams({ strict: false }) as { walletId: string };
  const q = useCryptoWallet(walletId);
  const settings = useCryptoSettings();
  const navigate = useNavigate();
  const [lostAccess, setLostAccess] = useState(false);
  const [modal, setModal] = useState<
    "import" | "connect" | "history" | "exchange" | "withdrawal" | "receive" | null
  >(null);
  const [showHidden, setShowHidden] = useState(false);
  const sync = useCryptoMutation(() => api.post(`/api/crypto/wallets/${walletId}/sync`));
  const hide = useCryptoMutation((hiddenAssets: string[]) =>
    api.put("/api/crypto/settings", { hiddenAssets }),
  );
  const w = q.data;
  const hidden = settings.data?.hiddenAssets ?? [];
  const diff = w ? mismatches(w) : [];
  return (
    <>
      <CryptoHeader />
      {q.isError && <Alert>{q.error.message}</Alert>}
      {w && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/crypto/wallets"
              aria-label="Back to wallets"
              className="text-2xl text-slate-400 hover:text-slate-600"
            >
              ‹
            </Link>
            <WalletIcon name={w.name} chain={w.chain} kind={w.kind} />
            <div>
              <h2 className="text-xl font-semibold">{w.name}</h2>
              <p className="text-xs text-slate-500">Added {agoTime(w.createdAt)}</p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {w.sourceHint && (
                  <Button
                    disabled={w.syncing || w.queued || sync.isPending}
                    onClick={() => sync.mutate(undefined)}
                  >
                    <span
                      className={cx(
                        "inline-block",
                        (w.syncing || sync.isPending) && "animate-spin",
                      )}
                    >
                      ↻
                    </span>{" "}
                    Sync now
                  </Button>
                )}
                {!w.sourceHint && w.kind !== "exchange" && (
                  <Button onClick={() => setModal("connect")}>🔗 Sync from the blockchain</Button>
                )}
                {w.sourceHint && w.chain && (
                  <Button variant="secondary" onClick={() => setModal("receive")}>
                    ⤓ Receive
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setModal("import")}>
                  ⤒ Import file
                </Button>
                {w.sourceHint && (
                  <Button variant="secondary" onClick={() => setModal("history")}>
                    View history
                  </Button>
                )}
                <Button
                  variant="secondary"
                  className={
                    diff.length || w.status === "error" ? "text-amber-700 dark:text-amber-400" : ""
                  }
                  onClick={() => navigate({ to: "/crypto/reconcile", hash: `wallet-${w.id}` })}
                >
                  ⚠ Troubleshoot
                </Button>
                {w.kind !== "exchange" && (
                  <Button variant="ghost" onClick={() => setLostAccess((v) => !v)}>
                    {w.archived ? "Archived" : "No longer have access"}
                  </Button>
                )}
              </div>

              <Card className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {w.sourceHint
                      ? w.syncEnabled
                        ? "Syncs once a day when you open Crypto"
                        : "Sync turned off"
                      : w.kind === "exchange"
                        ? "Exchange: history from imports"
                        : "Not synced: history from imports and transactions added by hand"}
                  </span>
                  <SyncChip w={w} />
                </div>
                {w.sourceHint && (
                  <p className="text-xs text-slate-500">
                    <span className="font-mono">{w.sourceHint}</span>
                    {w.lastSyncAt && ` · synced ${agoTime(w.lastSyncAt)}`}
                    {w.sourceHint && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => setModal("connect")}
                        >
                          change
                        </button>
                      </>
                    )}
                  </p>
                )}
                {w.lastError && !w.syncing && (
                  <p
                    className={cx(
                      "text-xs",
                      w.status === "error" ? "text-red-600 dark:text-red-400" : "text-slate-500",
                    )}
                  >
                    {w.lastError}
                  </p>
                )}
                {diff.length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {w.chain ? "The blockchain shows" : "The exchange reports"} {diff.join(", ")}.{" "}
                    <Link to="/crypto/reconcile" hash={`wallet-${w.id}`} className="underline">
                      Find out why
                    </Link>
                  </p>
                )}
              </Card>

              {w.kind !== "exchange" && lostAccess && (
                <LostAccessCard w={w} onClose={() => setLostAccess(false)} />
              )}
              {w.kind === "exchange" && (
                <ExchangeCard
                  w={w}
                  onConnect={() => setModal("exchange")}
                  onWithdrawal={() => setModal("withdrawal")}
                />
              )}

              <div className="flex flex-wrap gap-2">
                {CHIPS.map(([type, one, many]) => {
                  const n = type ? w.counts[type] : w.counts.total;
                  if (type && !n) return null;
                  return (
                    <Link
                      key={many}
                      to="/crypto/transactions"
                      search={{ walletId: w.id, ...(type ? { type } : {}) }}
                      className={cx(
                        "rounded-md px-2 py-1 text-xs font-medium",
                        type
                          ? "bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200"
                          : "bg-brand-600 text-white hover:bg-brand-700",
                      )}
                    >
                      {n} {n === 1 ? one : many}
                    </Link>
                  );
                })}
              </div>

              <Notes id={w.id} notes={w.notes} />
            </div>

            <Card className="p-0">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <h3 className="font-semibold">Holdings</h3>
                <span className="text-lg font-semibold tabular-nums">
                  {formatMoney(w.valueCents)}
                </span>
              </div>
              {w.balances.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500">
                  Nothing held right now.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <caption className="sr-only">Coins in {w.name}</caption>
                  <thead className="text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Coin</th>
                      <th className="px-2 py-2 text-right font-medium">Balance</th>
                      <th className="px-2 py-2 text-right font-medium">Value (USD)</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {w.balances.map((b) => (
                      <tr key={b.asset}>
                        <td className="px-4 py-2">
                          <Link
                            to="/crypto/transactions"
                            search={{ walletId: w.id, asset: b.asset }}
                            className="flex items-center gap-2 hover:underline"
                          >
                            <CoinIcon asset={b.asset} size="sm" />
                            <span className="font-medium">{b.asset}</span>
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">
                          {fmtAmount(b.amount)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {b.valueCents !== null ? (
                            formatMoney(b.valueCents)
                          ) : (
                            <span className="text-slate-400">no price</span>
                          )}
                        </td>
                        <td className="pr-3 text-right">
                          <button
                            type="button"
                            title={`Hide ${b.asset} everywhere (e.g. a spam token)`}
                            aria-label={`Hide ${b.asset}`}
                            onClick={() => hide.mutate([...hidden, b.asset])}
                            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          >
                            👁
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {w.hiddenBalances.length > 0 && (
                <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
                  <button
                    type="button"
                    aria-expanded={showHidden}
                    onClick={() => setShowHidden((v) => !v)}
                    className="hover:underline"
                  >
                    {w.hiddenBalances.length} hidden{" "}
                    {w.hiddenBalances.length === 1 ? "coin" : "coins"} ·{" "}
                    <span className="text-brand-600">{showHidden ? "Hide" : "Show"}</span>
                  </button>
                  {showHidden && (
                    <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                      {w.hiddenBalances.map((b) => (
                        <li key={b.asset} className="flex items-center gap-2 py-1.5 opacity-70">
                          <CoinIcon asset={b.asset} size="sm" />
                          <span className="font-medium">{b.asset}</span>
                          <span className="ml-auto font-mono tabular-nums">
                            {fmtAmount(b.amount)}
                          </span>
                          <button
                            type="button"
                            onClick={() => hide.mutate(hidden.filter((a) => a !== b.asset))}
                            className="rounded border border-slate-200 px-1.5 py-0.5 hover:border-brand-500 hover:text-brand-600 dark:border-slate-700"
                          >
                            Unhide
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={
          modal === "receive"
            ? `Receive into ${w?.name ?? ""}`
            : modal === "import"
              ? "Import Koinly history"
              : modal === "exchange"
                ? `Sync ${w?.name ?? ""} with a read-only API key`
                : modal === "withdrawal"
                  ? "Add the transfer out"
                  : modal === "history"
                    ? `Sync history: ${w?.name ?? ""}`
                    : `Sync ${w?.name ?? ""} from the blockchain`
        }
      >
        {modal === "import" && <ImportKoinly onDone={() => setModal(null)} />}
        {modal === "connect" && w && <ConnectWallet w={w} onDone={() => setModal(null)} />}
        {modal === "history" && <History id={walletId} />}
        {modal === "receive" && <Receive id={walletId} />}
        {modal === "exchange" && w && <ConnectExchange w={w} onDone={() => setModal(null)} />}
        {modal === "withdrawal" && (
          <AddTxn onDone={() => setModal(null)} defaultWallet={walletId} defaultType="withdrawal" />
        )}
      </Modal>
    </>
  );
}
