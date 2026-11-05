import { CRYPTO_LABELS, type CryptoTxn, type CryptoTxnType, formatMoney } from "@muny/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Modal, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useCryptoMutation, useCryptoTxns, useCryptoWallets } from "../../lib/queries.js";
import {
  CryptoHeader,
  explorerTxUrl,
  fmtAmount,
  guessChain,
  LABELS,
  labelName,
  shortHash,
  when,
} from "./common.js";

/** Crypto transactions, Koinly-style: grouped by day, sent → received, labels, filters. */

export interface CryptoTxnSearch {
  walletId?: string;
  asset?: string;
  type?: CryptoTxnType;
  label?: string;
  from?: string;
  to?: string;
  page?: number;
}

const TYPE_LABEL: Record<CryptoTxnType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  trade: "Trade",
  transfer: "Transfer",
};
const PAGE = 25;

function title(t: CryptoTxn) {
  if (t.label) return labelName(t.label) as string;
  if (t.type === "trade")
    return t.sentAsset === "USD" ? "Buy" : t.receivedAsset === "USD" ? "Sell" : "Exchange";
  if (t.type === "transfer")
    return t.sentAmount ? "Send (to own wallet)" : "Receive (from own wallet)";
  return t.type === "deposit" ? "Receive" : "Send";
}

/** One side of a transaction: wallet, coin and amount, or "outside". */
function Side({
  amount,
  asset,
  wallet,
  chain,
  kind,
  sign,
  value,
}: {
  amount: string | null;
  asset: string | null;
  wallet?: string | null;
  chain?: string | null;
  kind?: string;
  sign: "+" | "-";
  value?: number | null;
}) {
  const out = sign === "-";
  if (!amount || !asset)
    return (
      <span className={cx("flex items-center gap-2 text-xs text-slate-400", out && "justify-end")}>
        {wallet ? (
          <>
            <WalletIcon name={wallet} chain={chain} kind={kind} size="sm" />
            {wallet}
          </>
        ) : (
          <span className="rounded-full border border-dashed border-slate-300 px-2 py-1 dark:border-slate-700">
            outside your wallets
          </span>
        )}
      </span>
    );
  return (
    <span className={cx("flex items-center gap-2", out && "flex-row-reverse text-right")}>
      <CoinIcon asset={asset} size="sm" />
      <span className="min-w-0">
        {wallet && <span className="block truncate text-xs text-slate-500">{wallet}</span>}
        <span
          className={cx(
            "font-mono text-sm tabular-nums",
            !out ? "text-emerald-700 dark:text-emerald-400" : "",
          )}
        >
          {out ? "−" : "+"} {fmtAmount(amount)}{" "}
          <span className="font-sans font-medium">{asset}</span>
        </span>
        {value !== null && value !== undefined && (
          <span className="block text-xs text-slate-500">≈ {formatMoney(value)}</span>
        )}
      </span>
    </span>
  );
}

/** Fee as a share of what was sent, when both are the same coin. */
function feePct(t: CryptoTxn): string | null {
  if (!t.feeAmount || !t.sentAmount || t.feeAsset !== t.sentAsset) return null;
  const pct = (Number(t.feeAmount) / Number(t.sentAmount)) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return pct < 0.01 ? "< 0.01% fee" : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% fee`;
}

function TxnRow({ t }: { t: CryptoTxn }) {
  const [editing, setEditing] = useState(false);
  const relabel = useCryptoMutation((label: string | null) =>
    api.patch(`/api/crypto/txns/${t.id}`, { label }),
  );
  const del = useCryptoMutation(() => api.delete(`/api/crypto/txns/${t.id}`));
  const me = { wallet: t.walletName, chain: t.walletChain, kind: t.walletKind };
  const other = t.transfer
    ? { wallet: t.transfer.walletName, chain: t.transfer.walletChain, kind: t.transfer.walletKind }
    : null;
  // A fee-only row (a failed call, a token approval, a staking action).
  const feeOnly = !t.sentAmount && !t.receivedAmount && !!t.feeAmount;
  const incoming = !t.sentAmount && !!t.receivedAmount;
  // Left = where it came from, right = where it went.
  const left = feeOnly
    ? { ...me, amount: t.feeAmount, asset: t.feeAsset, value: t.feeValueCents }
    : t.type === "transfer" && incoming && other
      ? {
          ...other,
          amount: t.transfer?.amount ?? null,
          asset: t.transfer?.asset ?? null,
          value: t.valueCents,
        }
      : incoming
        ? { wallet: null, chain: null, kind: undefined, amount: null, asset: null, value: null }
        : { ...me, amount: t.sentAmount, asset: t.sentAsset, value: t.valueCents };
  const right = feeOnly
    ? { wallet: null, chain: null, kind: undefined, amount: null, asset: null, value: null }
    : t.type === "transfer" && !incoming && other
      ? {
          ...other,
          amount: t.transfer?.amount ?? null,
          asset: t.transfer?.asset ?? null,
          value: null,
        }
      : t.receivedAmount
        ? {
            ...me,
            amount: t.receivedAmount,
            asset: t.receivedAsset,
            value: t.sentAmount ? null : t.valueCents,
          }
        : { wallet: null, chain: null, kind: undefined, amount: null, asset: null, value: null };
  const link = explorerTxUrl(
    guessChain(t.walletChain ?? t.transfer?.walletChain, t.walletName, t.feeAsset),
    t.txHash,
  );
  const pct = feePct(t);
  const heading = feeOnly ? "Fee" : title(t);
  return (
    <li className="grid grid-cols-1 items-center gap-3 px-4 py-3 md:grid-cols-[12rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)_11rem]">
      <span className="flex items-center gap-3">
        <span className="relative">
          <WalletIcon name={t.walletName} chain={t.walletChain} kind={t.walletKind} />
          {other && (
            <span className="absolute -right-1.5 -bottom-1.5 rounded-full ring-2 ring-white dark:ring-slate-900">
              <WalletIcon name={other.wallet} chain={other.chain} kind={other.kind} size="sm" />
            </span>
          )}
        </span>
        <span>
          <span className="block text-sm font-medium">{heading}</span>
          <span className="text-xs text-slate-500">
            {when(t.at)} · {feeOnly ? "Network fee" : TYPE_LABEL[t.type]}
          </span>
        </span>
      </span>
      <span className="md:justify-self-end">
        <Side {...left} sign="-" />
        {!feeOnly && t.feeAmount && (
          <span className="block text-right text-xs text-slate-500">
            fee {fmtAmount(t.feeAmount)} {t.feeAsset}
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cx(
          "hidden text-lg md:block",
          t.type === "transfer" ? "text-brand-600" : incoming ? "text-emerald-600" : "text-red-500",
        )}
      >
        {t.type === "transfer" ? "»" : "→"}
      </span>
      <span>
        {feeOnly ? (
          <span className="text-xs text-slate-500">paid to the network</span>
        ) : (
          <Side {...right} sign="+" />
        )}
      </span>
      <span className="flex flex-wrap items-center justify-end gap-1">
        {t.txHash &&
          (link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              title="Open in a block explorer"
              className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-500 hover:border-brand-500 hover:text-brand-600 dark:border-slate-700"
            >
              ↗ {shortHash(t.txHash)}
            </a>
          ) : (
            <span className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-xs text-slate-500 dark:border-slate-700">
              {shortHash(t.txHash)}
            </span>
          ))}
        {pct && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800">
            {pct}
          </span>
        )}
        {editing ? (
          <select
            // biome-ignore lint/a11y/noAutofocus: opened by the label button
            autoFocus
            aria-label="Label"
            value={t.label ?? ""}
            onChange={(e) =>
              relabel.mutate(e.target.value || null, { onSuccess: () => setEditing(false) })
            }
            onBlur={() => setEditing(false)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">No label</option>
            {CRYPTO_LABELS.map((l) => (
              <option key={l} value={l}>
                {LABELS[l]}
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-brand-500 dark:border-slate-700 dark:text-slate-300"
          >
            {labelName(t.label) ?? "+ label"}
          </button>
        )}
        {t.source === "manual" && (
          <Button
            variant="ghost"
            className="text-red-600"
            aria-label="Delete transaction"
            onClick={() => window.confirm("Delete this transaction?") && del.mutate(undefined)}
          >
            🗑
          </Button>
        )}
      </span>
    </li>
  );
}

function AddTxn({ onDone, defaultWallet }: { onDone: () => void; defaultWallet?: string }) {
  const wallets = useCryptoWallets();
  const [walletId, setWalletId] = useState(defaultWallet ?? "");
  const [type, setType] = useState<"deposit" | "withdrawal" | "trade">("deposit");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
  const [label, setLabel] = useState("");
  const [sent, setSent] = useState({ amount: "", asset: "" });
  const [recv, setRecv] = useState({ amount: "", asset: "" });
  const [fee, setFee] = useState({ amount: "", asset: "" });
  const add = useCryptoMutation((body: object) => api.post("/api/crypto/txns", body));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(
      {
        walletId,
        at: new Date(date).getTime(),
        type,
        label: label || null,
        ...(type !== "deposit" ? { sentAmount: sent.amount, sentAsset: sent.asset } : {}),
        ...(type !== "withdrawal"
          ? { receivedAmount: recv.amount, receivedAsset: recv.asset }
          : {}),
        ...(fee.amount ? { feeAmount: fee.amount, feeAsset: fee.asset } : {}),
      },
      { onSuccess: onDone },
    );
  };
  const pair = (
    label: string,
    v: { amount: string; asset: string },
    set: (x: { amount: string; asset: string }) => void,
  ) => (
    <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
      <Field
        label={label}
        inputMode="decimal"
        value={v.amount}
        onChange={(e) => set({ ...v, amount: e.target.value })}
      />
      <Field
        label="Coin"
        placeholder="BTC"
        value={v.asset}
        onChange={(e) => set({ ...v, asset: e.target.value.toUpperCase() })}
      />
    </div>
  );
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Wallet" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
          <option value="">Choose…</option>
          {wallets.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          <option value="deposit">Deposit (received)</option>
          <option value="withdrawal">Withdrawal (sent)</option>
          <option value="trade">Trade (sent and received)</option>
        </SelectField>
        <Field
          label="Date & time"
          type="datetime-local"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <SelectField label="Label" value={label} onChange={(e) => setLabel(e.target.value)}>
          <option value="">None</option>
          {CRYPTO_LABELS.map((l) => (
            <option key={l} value={l}>
              {LABELS[l]}
            </option>
          ))}
        </SelectField>
      </div>
      {type !== "deposit" && pair("Sent amount", sent, setSent)}
      {type !== "withdrawal" && pair("Received amount", recv, setRecv)}
      {pair("Fee (optional)", fee, setFee)}
      {add.error && <Alert>{add.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!walletId || add.isPending}>
          Add transaction
        </Button>
      </div>
    </form>
  );
}

export function CryptoTransactions() {
  const search = useSearch({ strict: false }) as CryptoTxnSearch;
  const navigate = useNavigate();
  const set = (patch: Partial<CryptoTxnSearch>) =>
    void navigate({
      to: "/crypto/transactions",
      search: Object.fromEntries(
        Object.entries({ ...search, page: undefined, ...patch }).filter(
          ([, v]) => v !== undefined && v !== "",
        ),
      ) as CryptoTxnSearch,
      replace: true,
    });
  const page = search.page ?? 0;
  const txns = useCryptoTxns({
    walletId: search.walletId,
    asset: search.asset,
    type: search.type,
    label: search.label,
    from: search.from,
    to: search.to,
    offset: page * PAGE,
    limit: PAGE,
  });
  const wallets = useCryptoWallets();
  const [adding, setAdding] = useState(false);
  const items = txns.data?.items ?? [];
  const pages = Math.ceil((txns.data?.total ?? 0) / PAGE);
  const days: { day: string; items: CryptoTxn[] }[] = [];
  for (const t of items) {
    const d = new Date(t.at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const last = days[days.length - 1];
    if (last?.day === d) last.items.push(t);
    else days.push({ day: d, items: [t] });
  }
  const assets = [
    ...new Set((wallets.data ?? []).flatMap((w) => w.balances.map((b) => b.asset))),
  ].sort();
  const sel =
    "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";
  const active = !!(
    search.walletId ||
    search.asset ||
    search.type ||
    search.label ||
    search.from ||
    search.to
  );

  return (
    <>
      <CryptoHeader actions={<Button onClick={() => setAdding(true)}>+ Add</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <select
          aria-label="Wallet"
          value={search.walletId ?? ""}
          onChange={(e) => set({ walletId: e.target.value })}
          className={sel}
        >
          <option value="">All wallets</option>
          {wallets.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Currency"
          list="crypto-assets"
          placeholder="All currencies"
          value={search.asset ?? ""}
          onChange={(e) => set({ asset: e.target.value.toUpperCase() })}
          className={cx(sel, "w-36")}
        />
        <datalist id="crypto-assets">
          {assets.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <select
          aria-label="Type"
          value={search.type ?? ""}
          onChange={(e) => set({ type: (e.target.value || undefined) as CryptoTxnType })}
          className={sel}
        >
          <option value="">All types</option>
          {(Object.keys(TYPE_LABEL) as CryptoTxnType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select
          aria-label="Label"
          value={search.label ?? ""}
          onChange={(e) => set({ label: e.target.value })}
          className={sel}
        >
          <option value="">All labels</option>
          <option value="none">No label</option>
          {CRYPTO_LABELS.map((l) => (
            <option key={l} value={l}>
              {LABELS[l]}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="From"
          value={search.from ?? ""}
          onChange={(e) => set({ from: e.target.value })}
          className={sel}
        />
        <input
          type="date"
          aria-label="To"
          value={search.to ?? ""}
          onChange={(e) => set({ to: e.target.value })}
          className={sel}
        />
        {active && (
          <Button
            variant="ghost"
            onClick={() => void navigate({ to: "/crypto/transactions", search: {}, replace: true })}
          >
            Clear
          </Button>
        )}
      </div>
      {txns.isError && <Alert>{txns.error.message}</Alert>}
      <div className="space-y-4">
        {days.map((d) => (
          <section key={d.day}>
            <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {d.day}
            </h2>
            <Card className="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {d.items.map((t) => (
                  <TxnRow key={t.id} t={t} />
                ))}
              </ul>
            </Card>
          </section>
        ))}
        {txns.isSuccess && items.length === 0 && (
          <Card className="text-center text-sm text-slate-500">
            No transactions{active ? " match these filters" : " yet"}.
          </Card>
        )}
      </div>
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>
            {txns.data?.total} transactions · page {page + 1} of {pages}
          </span>
          <span className="flex gap-1">
            <Button
              variant="secondary"
              disabled={page === 0}
              onClick={() => set({ page: page - 1 || undefined })}
            >
              ‹ Newer
            </Button>
            <Button
              variant="secondary"
              disabled={page + 1 >= pages}
              onClick={() => set({ page: page + 1 })}
            >
              Older ›
            </Button>
          </span>
        </div>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a crypto transaction">
        {adding && <AddTxn onDone={() => setAdding(false)} defaultWallet={search.walletId} />}
      </Modal>
    </>
  );
}
