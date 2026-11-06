import {
  CRYPTO_SYNC_CHAINS,
  type CryptoImportPreview,
  type CryptoImportResult,
  type CryptoSyncChain,
  type CryptoSyncResult,
  type CryptoWallet,
  type CryptoWalletKind,
  cryptoExchange,
  detectCryptoChains,
  formatMoney,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Modal, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useCryptoMutation, useCryptoWallets } from "../../lib/queries.js";
import { ago, agoTime, CryptoHeader, dayLabel, fmtAmount } from "./common.js";
import { Receive } from "./ReceiveDialog.js";

/** Wallets & exchanges, Koinly-style: balance, transactions, status; add or import. */

const KIND_LABEL: Record<CryptoWalletKind, string> = {
  blockchain: "Wallet (synced)",
  exchange: "Exchange",
  manual: "Wallet",
};

export function ImportKoinly({ onDone }: { onDone: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<CryptoImportPreview | null>(null);
  const [result, setResult] = useState<CryptoImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Koinly wallet name → Muny wallet id, or "new". */
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [replace, setReplace] = useState(false);
  const wallets = useCryptoWallets();
  const commit = useCryptoMutation(() =>
    api.post<CryptoImportResult & { replaced?: number; duplicatesRemoved?: number }>(
      "/api/crypto/import/commit",
      { format: "koinly", content, mapping, replace },
    ),
  );
  const showPreview = (p: CryptoImportPreview) => {
    setPreview(p);
    setMapping(Object.fromEntries(p.wallets.map((x) => [x.name, x.suggestedWalletId ?? "new"])));
    // The full export covers every year: replacing earlier Koinly rows is the clean way.
    setReplace(p.full);
  };
  const replacing = preview
    ? preview.wallets.reduce(
        (n, x) => n + (mapping[x.name] === x.suggestedWalletId ? x.alreadyImported : 0),
        0,
      )
    : 0;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    setResult(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const text = await file.text();
      setContent(text);
      showPreview(
        await api.post<CryptoImportPreview>("/api/crypto/import/preview", {
          format: "koinly",
          content: text,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file");
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Imported <span className="font-semibold">{result.imported}</span> transactions
          {result.walletsCreated > 0 && ` into ${result.walletsCreated} new wallets`}
          {result.duplicates > 0 && ` (${result.duplicates} were already in Muny)`}.
          {(result as { replaced?: number }).replaced
            ? ` Replaced ${(result as { replaced?: number }).replaced} earlier rows.`
            : ""}
        </p>
        <div className="flex justify-end gap-2">
          <Link to="/crypto/transactions">
            <Button variant="secondary">See transactions</Button>
          </Link>
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Best: in Koinly, open <span className="font-medium">Transactions</span> and export them all
        (every year, any plan). Koinly&apos;s yearly{" "}
        <span className="font-medium">Transaction History</span> report from Tax reports works too.
        Re-importing a file never creates duplicates.
      </p>
      <label className="block">
        <span className="sr-only">Koinly CSV file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void pick(e.target.files?.[0])}
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
        />
      </label>
      {busy && <p className="text-sm text-slate-500">Reading {fileName}…</p>}
      {error && <Alert>{error}</Alert>}
      {preview && (
        <div className="space-y-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
          <p>
            <span className="font-semibold">{preview.txns}</span> new transactions
            {preview.from &&
              preview.to &&
              ` from ${dayLabel(preview.from)} to ${dayLabel(preview.to)}`}
            {preview.duplicates > 0 && `; ${preview.duplicates} already imported`}.
          </p>
          <div className="space-y-1">
            <p className="font-medium">Where each Koinly wallet goes</p>
            <p className="text-xs text-slate-500">
              Matched by name (word order doesn&apos;t matter). Pick another wallet if Muny guessed
              wrong, or create a new one.
            </p>
            <ul className="divide-y divide-slate-200 dark:divide-slate-700">
              {preview.wallets.map((w) => (
                <li
                  key={w.name}
                  className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{w.name}</span>{" "}
                    <span className="text-xs text-slate-500">{w.txns} transactions</span>
                  </span>
                  <select
                    aria-label={`Muny wallet for ${w.name}`}
                    value={mapping[w.name] ?? "new"}
                    onChange={(e) => setMapping((m) => ({ ...m, [w.name]: e.target.value }))}
                    className="max-w-[16rem] rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="new">
                      New {w.kind === "exchange" ? "exchange" : "wallet"}:{" "}
                      {w.name.replace(/\s*\[Pool\]$/i, "")}
                    </option>
                    <option value="skip">Skip (don&apos;t import this wallet)</option>
                    {(wallets.data ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
              className="mt-1 accent-brand-600"
            />
            <span>
              Replace what I imported from Koinly before in these wallets
              <span className="block text-xs text-slate-500">
                {preview.full
                  ? "Recommended: this export has every year, so it supersedes earlier Koinly files. "
                  : ""}
                {replacing > 0 &&
                  `${replacing} earlier Koinly rows and any Reconcile fixes made on top of them are replaced. `}
                Synced blockchain transactions and ones you added by hand stay; synced copies of
                imported rows are removed afterwards.
              </span>
            </span>
          </label>
          {preview.errors.length > 0 && (
            <Alert>
              {preview.errors.length} rows couldn&apos;t be read (first: line{" "}
              {preview.errors[0]?.line}, {preview.errors[0]?.message}). The rest will import.
            </Alert>
          )}
        </div>
      )}
      {commit.error && <Alert>{commit.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={!preview || preview.txns === 0 || commit.isPending}
          onClick={() => commit.mutate(undefined, { onSuccess: setResult })}
        >
          {commit.isPending ? "Importing…" : `Import ${preview?.txns ?? ""} transactions`}
        </Button>
      </div>
    </div>
  );
}

type ChainKey = CryptoSyncChain;

/** Where each coin's data comes from (shown in the privacy note). */
const VIA: Record<ChainKey, string> = {
  btc: "mempool.space",
  ltc: "litecoinspace.org",
  doge: "BlockCypher",
  zec: "the Blockbook server set in Settings",
  sc: "SiaScan",
  atom: "a public Cosmos node",
  trx: "TronGrid",
  eth: "Blockscout",
  polygon: "Blockscout",
  base: "Blockscout",
  arb: "Blockscout",
  op: "Blockscout",
  gnosis: "Blockscout",
  ada: "Koios",
  algo: "AlgoNode",
  xlm: "Stellar's Horizon",
};

const chainInfo = (k: ChainKey) =>
  CRYPTO_SYNC_CHAINS.find((c) => c.key === k) ?? CRYPTO_SYNC_CHAINS[0];

/**
 * Coin + address. Pasting an address picks the coin from its format; the
 * provider behind each coin is Muny's business.
 */
function SourceFields({
  chain,
  setChain,
  source,
  setSource,
}: {
  chain: ChainKey;
  setChain: (c: ChainKey) => void;
  source: string;
  setSource: (s: string) => void;
}) {
  const info = chainInfo(chain);
  const detected = detectCryptoChains(source);
  const paste = (v: string) => {
    setSource(v);
    const d = detectCryptoChains(v);
    if (d.length && !d.includes(chain)) setChain(d[0] as ChainKey);
  };
  return (
    <>
      {chain === "sc" ? (
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium">
            Addresses (one per line, or separated by commas)
          </span>
          <textarea
            rows={6}
            placeholder={info.placeholder}
            autoComplete="off"
            spellCheck={false}
            value={source}
            onChange={(e) => paste(e.target.value)}
            onPaste={(e) => {
              // Anything with addresses in it (a copied list, JSON…): keep just the addresses.
              const found = e.clipboardData.getData("text").match(/\b[0-9a-fA-F]{76}\b/g);
              if (!found?.length) return;
              e.preventDefault();
              const all = new Set([
                ...source.split(/[\s,;]+/).filter(Boolean),
                ...found.map((a) => a.toLowerCase()),
              ]);
              paste([...all].join("\n"));
            }}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <span className="text-xs text-slate-500">
            {source.split(/[\s,;]+/).filter(Boolean).length} addresses. One is enough to start: each
            sync finds the wallet's other addresses from your imported Sia transactions. You can
            also paste any text that lists addresses; Muny keeps just the addresses. Never paste the
            seed.
          </span>
        </label>
      ) : (
        <Field
          label="Public address or extended public key"
          placeholder={info.placeholder}
          autoComplete="off"
          spellCheck={false}
          value={source}
          onChange={(e) => paste(e.target.value.trim())}
          className="sm:col-span-2"
        />
      )}
      <SelectField
        label="Coin"
        value={chain}
        onChange={(e) => setChain(e.target.value as ChainKey)}
      >
        {CRYPTO_SYNC_CHAINS.map((c) => (
          <option key={c.key} value={c.key}>
            {c.name} ({c.coin})
          </option>
        ))}
      </SelectField>
      <p className="self-end pb-2 text-xs text-slate-500">
        {source && detected.length === 0
          ? "Muny doesn't recognise this format yet; check the coin."
          : detected.length > 1 && info.evm
            ? "This address works on Ethereum and its sister networks; add one wallet per network you use."
            : detected.length === 1
              ? `Recognised as a ${info.name} address.`
              : null}
      </p>
      <p className="text-xs text-slate-500 sm:col-span-2">
        Public addresses or keys only; never a seed phrase or private key. Muny stores it encrypted
        and asks {VIA[chain]} (a public blockchain service) for its transactions once a day when you
        open Crypto, or when you press Sync. That service sees the address; nobody can move funds
        with it.
        {chain === "ada" && " A stake address (stake1…) covers every address in the wallet."}
        {["btc", "ltc", "doge", "zec"].includes(chain) &&
          " An xpub/zpub covers every address in the wallet: Muny works out the addresses itself and only looks those up."}
      </p>
    </>
  );
}

function AddWallet({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CryptoWalletKind>("blockchain");
  const [chain, setChain] = useState<ChainKey>("btc");
  const [source, setSource] = useState("");
  const add = useCryptoMutation((body: object) => api.post("/api/crypto/wallets", body));
  const synced = kind === "blockchain";
  const fallbackName = synced ? `${chainInfo(chain).name} wallet` : "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim() || fallbackName;
    add.mutate(synced ? { name: n, kind, chain, source } : { name: n, kind }, {
      onSuccess: onDone,
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="What are you adding?"
          value={kind}
          onChange={(e) => setKind(e.target.value as CryptoWalletKind)}
        >
          <option value="blockchain">A wallet (sync it from the blockchain)</option>
          <option value="exchange">An exchange</option>
          <option value="manual">Something else (add transactions by hand or file)</option>
        </SelectField>
        <Field
          label="Name"
          placeholder={fallbackName || "e.g. Paper wallet"}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {synced && (
          <SourceFields chain={chain} setChain={setChain} source={source} setSource={setSource} />
        )}
      </div>
      {kind === "exchange" && (
        <p className="text-xs text-slate-500">
          Exchange sync with a read-only API key is coming. For now, import your exchange history
          from a file (Koinly CSV) or add transactions by hand.
        </p>
      )}
      {kind === "manual" && (
        <p className="text-xs text-slate-500">
          Add transactions by hand or import a file into this wallet.
        </p>
      )}
      {add.error && <Alert>{add.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={(synced ? !source : !name.trim()) || add.isPending}>
          {synced ? "Add and sync" : "Add"}
        </Button>
      </div>
    </form>
  );
}

/** Attach (or replace) the address an existing wallet syncs from, e.g. one imported from Koinly. */
export function ConnectWallet({ w, onDone }: { w: CryptoWallet; onDone: () => void }) {
  const known = CRYPTO_SYNC_CHAINS.find((c) => c.key === w.chain)?.key;
  // Unknown: guess from the coins it holds (e.g. an imported "ADA Exodus").
  const held = new Set(w.balances.map((b) => b.asset));
  const guess = CRYPTO_SYNC_CHAINS.find(
    (c) => held.has(c.coin) || new RegExp(`\\b${c.coin}\\b`, "i").test(w.name),
  )?.key;
  const [chain, setChain] = useState<ChainKey>(known ?? guess ?? "btc");
  const [source, setSource] = useState("");
  const put = useCryptoMutation((body: object) =>
    api.put(`/api/crypto/wallets/${w.id}/source`, body),
  );
  const remove = useCryptoMutation(() => api.delete(`/api/crypto/wallets/${w.id}/source`));
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        put.mutate({ chain, source }, { onSuccess: onDone });
      }}
    >
      {w.txnCount > 0 && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {w.name} already has {w.txnCount} transactions. Synced ones that match them (same
          transaction hash, or same amount within two hours) are skipped, so nothing is counted
          twice.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <SourceFields chain={chain} setChain={setChain} source={source} setSource={setSource} />
      </div>
      {(put.error || remove.error) && <Alert>{(put.error ?? remove.error)?.message}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        {w.sourceHint && (
          <Button
            variant="ghost"
            className="mr-auto text-red-600"
            onClick={() => remove.mutate(undefined, { onSuccess: onDone })}
          >
            Stop syncing
          </Button>
        )}
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!source || put.isPending}>
          {w.sourceHint ? "Replace and sync" : "Connect and sync"}
        </Button>
      </div>
    </form>
  );
}

/** Where the chain's balance differs from the transactions (missing or extra history). */
export function mismatches(w: CryptoWallet): string[] {
  if (!w.onChain || w.syncing) return [];
  const mine = new Map(w.balances.map((b) => [b.asset, b.amount]));
  // Cash (USD…) isn't synced (bank deposits aren't in exchange history), as in Reconcile.
  const cash = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SGD"]);
  const norm = (x: string | undefined) =>
    (x ?? "0").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  // Differences under 0.000001 are rounding between exports and exchanges.
  return w.onChain
    .filter(
      (c) =>
        !cash.has(c.asset) &&
        norm(mine.get(c.asset)) !== norm(c.amount) &&
        Math.abs(Number(mine.get(c.asset) ?? 0) - Number(c.amount)) >= 0.000001,
    )
    .map((c) => `${fmtAmount(c.amount, 6)} ${c.asset}`);
}

export function SyncChip({ w }: { w: CryptoWallet }) {
  if (w.syncing)
    return (
      <span className="self-center whitespace-nowrap rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700 dark:bg-brand-700/20 dark:text-brand-500">
        Syncing…
      </span>
    );
  if (w.queued)
    return (
      <span className="self-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        Waiting to sync
      </span>
    );
  if (!w.sourceHint)
    return (
      <span className="self-center whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        File / manual
      </span>
    );
  return (
    <span
      title={w.lastError ?? undefined}
      className={cx(
        "self-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs",
        w.status === "error"
          ? "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200"
          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
      )}
    >
      {w.status === "error"
        ? "Sync failed"
        : w.status === "never"
          ? "Not synced yet"
          : `Synced ${agoTime(w.lastSyncAt)}`}
    </span>
  );
}

function WalletRow({
  w,
  onConnect,
  dim,
}: {
  w: CryptoWallet;
  onConnect: () => void;
  dim?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const sync = useCryptoMutation(() =>
    api.post<CryptoSyncResult>(`/api/crypto/wallets/${w.id}/sync`),
  );
  const diff = mismatches(w);
  const [name, setName] = useState(w.name);
  const rename = useCryptoMutation((n: string) =>
    api.patch(`/api/crypto/wallets/${w.id}`, { name: n }),
  );
  const del = useCryptoMutation(() => api.delete(`/api/crypto/wallets/${w.id}`));
  const [open, setOpen] = useState(false);
  const [receiving, setReceiving] = useState(false);
  return (
    <li
      className={cx(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_7rem_24rem]",
        dim && "opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <WalletIcon name={w.name} chain={w.chain} kind={w.kind} />
        <span className="min-w-0">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                rename.mutate(name, { onSuccess: () => setRenaming(false) });
              }}
            >
              <input
                // biome-ignore lint/a11y/noAutofocus: opened by the rename button
                autoFocus
                aria-label="Wallet name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setRenaming(false)}
                className="w-full rounded border border-brand-500 bg-white px-2 py-0.5 text-sm dark:bg-slate-950"
              />
            </form>
          ) : (
            <Link
              to="/crypto/wallets/$walletId"
              params={{ walletId: w.id }}
              className="block truncate font-medium hover:underline"
            >
              {w.name}
            </Link>
          )}
          <span className="block truncate text-xs text-slate-500">
            {KIND_LABEL[w.kind]}
            {cryptoExchange(w.exchange)?.status === "closed" && (
              <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                closed
              </span>
            )}
            {w.sourceHint && <span className="ml-1 font-mono">{w.sourceHint}</span>}
            {w.balances.length === 1 &&
              ` · ${fmtAmount(w.balances[0]?.amount, 4)} ${w.balances[0]?.asset}`}
            {w.balances.length > 1 && ` · ${w.balances.length} coins`}
          </span>
          {w.status === "ok" && w.lastError && !w.syncing && (
            <span className="block text-xs text-slate-500">{w.lastError}</span>
          )}
          {w.status === "error" && w.lastError && !w.syncing && (
            <span className="block text-xs text-red-600 dark:text-red-400">{w.lastError}</span>
          )}
          {sync.error && (
            <span className="block text-xs text-red-600 dark:text-red-400">
              {sync.error.message}
            </span>
          )}
          {diff.length > 0 && (
            <span className="block text-xs text-amber-700 dark:text-amber-400">
              {w.chain ? "The blockchain shows" : "The exchange reports"} {diff.join(", ")}.{" "}
              <Link to="/crypto/reconcile" className="underline">
                Find out why
              </Link>
            </span>
          )}
        </span>
      </span>
      <span className="text-right tabular-nums sm:text-right">
        {w.balances.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`coins-${w.id}`}
            aria-label={`${open ? "Hide" : "Show"} coins in ${w.name}`}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 rounded px-1 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <span
              className={cx("text-xs text-slate-400 transition-transform", open && "rotate-180")}
            >
              ▾
            </span>
            {w.valueCents > 0 ? (
              formatMoney(w.valueCents)
            ) : (
              <span className="text-slate-400">$0</span>
            )}
          </button>
        ) : (
          <span className="text-slate-400">$0</span>
        )}
      </span>
      <span className="hidden text-right text-sm sm:block">
        <span className="block tabular-nums">{w.txnCount}</span>
        <span className="text-xs text-slate-500">Last {ago(w.lastTxnAt)}</span>
      </span>
      <span className="col-span-2 flex flex-wrap items-center justify-end gap-1 sm:col-span-1">
        <SyncChip w={w} />
        {w.sourceHint ? (
          <Button
            variant="ghost"
            aria-label={`Sync ${w.name} now`}
            title="Sync now"
            disabled={w.syncing || w.queued || sync.isPending}
            onClick={() => sync.mutate(undefined)}
          >
            <span className={cx("inline-block", (w.syncing || sync.isPending) && "animate-spin")}>
              ↻
            </span>
          </Button>
        ) : null}
        {w.sourceHint && w.chain && (
          <Button
            variant="ghost"
            onClick={() => setReceiving(true)}
            aria-label={`Receive into ${w.name}`}
            title="Receive: address and QR code"
          >
            ⤓
          </Button>
        )}
        {w.kind !== "exchange" && (
          <Button
            variant="ghost"
            onClick={onConnect}
            aria-label={`${w.sourceHint ? "Change sync address for" : "Sync"} ${w.name} from the blockchain`}
            title={w.sourceHint ? "Sync address" : "Sync from the blockchain"}
          >
            {w.sourceHint ? "⚙" : "🔗"}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setRenaming(true)} aria-label={`Rename ${w.name}`}>
          ✎
        </Button>
        <Button
          variant="ghost"
          className="text-red-600"
          aria-label={`Delete ${w.name}`}
          onClick={() => {
            if (window.confirm(`Delete ${w.name} and its ${w.txnCount} transactions?`))
              del.mutate(undefined);
          }}
        >
          🗑
        </Button>
      </span>
      <Modal open={receiving} onClose={() => setReceiving(false)} title={`Receive into ${w.name}`}>
        {receiving && <Receive id={w.id} />}
      </Modal>
      {open && (
        <div id={`coins-${w.id}`} className="col-span-full mt-2">
          <table className="w-full text-sm sm:ml-12 sm:w-[calc(100%-3rem)] sm:max-w-xl">
            <caption className="sr-only">Coins in {w.name}</caption>
            <thead>
              <tr className="text-xs text-slate-500">
                <th className="py-1 text-left font-medium">Coin</th>
                <th className="py-1 text-right font-medium">Balance</th>
                <th className="py-1 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {w.balances.map((b) => (
                <tr key={b.asset}>
                  <td className="py-1.5">
                    <Link
                      to="/crypto/transactions"
                      search={{ walletId: w.id, asset: b.asset }}
                      className="flex items-center gap-2 hover:underline"
                    >
                      <CoinIcon asset={b.asset} size="sm" />
                      <span className="font-medium">{b.asset}</span>
                    </Link>
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {fmtAmount(b.amount)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {b.valueCents !== null ? (
                      formatMoney(b.valueCents)
                    ) : (
                      <span className="text-slate-400">no price</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

export function CryptoWallets() {
  const wallets = useCryptoWallets();
  const [modal, setModal] = useState<"import" | "add" | null>(null);
  const [connect, setConnect] = useState<CryptoWallet | null>(null);
  const syncAll = useCryptoMutation(() => api.post("/api/crypto/sync"));
  const anySynced = (wallets.data ?? []).some((w) => w.sourceHint);
  const anySyncing = (wallets.data ?? []).some((w) => w.syncing || w.queued);
  const [find, setFind] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const matching = (wallets.data ?? []).filter((w) =>
    w.name.toLowerCase().includes(find.toLowerCase()),
  );
  const list = matching.filter((w) => !w.archived);
  const archived = matching.filter((w) => w.archived);
  const total = (wallets.data ?? []).reduce((s, w) => s + w.valueCents, 0);
  return (
    <>
      <CryptoHeader
        actions={
          <div className="flex flex-wrap gap-2">
            {anySynced && (
              <Button
                variant="secondary"
                disabled={anySyncing || syncAll.isPending}
                onClick={() => syncAll.mutate(undefined)}
              >
                {anySyncing ? "Syncing…" : "↻ Sync all"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setModal("import")}>
              ⤒ Import file
            </Button>
            <Button onClick={() => setModal("add")}>+ Add</Button>
          </div>
        }
      />
      {wallets.isError && <Alert>{wallets.error.message}</Alert>}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find wallet"
          aria-label="Find wallet"
          className="w-64 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        {total > 0 && <span className="text-sm text-slate-500">Total {formatMoney(total)}</span>}
      </div>
      <Card className="p-0">
        <div className="hidden grid-cols-[minmax(0,1fr)_9rem_7rem_24rem] gap-x-4 border-b border-slate-200 px-4 py-2.5 text-xs font-medium text-slate-500 sm:grid dark:border-slate-800">
          <span>Wallet</span>
          <span className="text-right">Balance</span>
          <span className="text-right">Transactions</span>
          <span className="text-right">Status</span>
        </div>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {list.map((w) => (
            <WalletRow key={w.id} w={w} onConnect={() => setConnect(w)} />
          ))}
          {archived.length > 0 && (
            <li className="px-4 py-2 text-xs text-slate-500">
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                className="hover:underline"
              >
                {archived.length} archived {archived.length === 1 ? "wallet" : "wallets"} ·{" "}
                <span className="text-brand-600">{showArchived ? "Hide" : "Show"}</span>
              </button>
            </li>
          )}
          {showArchived &&
            archived.map((w) => <WalletRow key={w.id} w={w} dim onConnect={() => setConnect(w)} />)}
          {wallets.isSuccess && list.length === 0 && archived.length === 0 && (
            <li className="px-4 py-8 text-center text-sm text-slate-500">
              {find
                ? "No wallet matches."
                : "No wallets yet. Add a wallet to sync it from the blockchain, or import your Koinly history."}
            </li>
          )}
        </ul>
      </Card>
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal === "import" ? "Import Koinly history" : "Add a wallet"}
      >
        {modal === "import" && <ImportKoinly onDone={() => setModal(null)} />}
        {modal === "add" && <AddWallet onDone={() => setModal(null)} />}
      </Modal>
      <Modal
        open={connect !== null}
        onClose={() => setConnect(null)}
        title={connect ? `Sync ${connect.name} from the blockchain` : ""}
      >
        {connect && <ConnectWallet w={connect} onDone={() => setConnect(null)} />}
      </Modal>
    </>
  );
}
