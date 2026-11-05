import { CRYPTO_LABELS, type CryptoTxn, type CryptoTxnType, formatMoney } from "@muny/shared";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { CoinIcon, WalletIcon } from "../../components/coins.js";
import { Modal, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  useCryptoMutation,
  useCryptoTransferMatches,
  useCryptoTxns,
  useCryptoWallets,
} from "../../lib/queries.js";
import {
  CryptoHeader,
  dayLabel,
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
  /** One wallet id, or several separated by commas. */
  walletId?: string;
  warnings?: "missing";
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
  return TYPE_LABEL[t.type];
}

/** Exact decimal a + sign·b (amounts are decimal strings; no floats). */
function addAmounts(a: string, b: string, sign: 1n | -1n = 1n): string {
  const S = 18;
  const f = (s: string) => {
    const neg = s.startsWith("-");
    const [w = "0", d = ""] = (neg ? s.slice(1) : s).split(".");
    const v = BigInt(w + d.padEnd(S, "0").slice(0, S));
    return neg ? -v : v;
  };
  const sum = f(a) + sign * f(b);
  const n = (sum < 0n ? -sum : sum).toString().padStart(S + 1, "0");
  const frac = n.slice(-S).replace(/0+$/, "");
  return `${sum < 0n ? "-" : ""}${n.slice(0, -S)}${frac ? `.${frac}` : ""}`;
}

interface SideData {
  wallet: string | null;
  chain: string | null;
  kind?: string;
  amount: string | null;
  asset: string | null;
  value: number | null;
  /** Outside your wallets: the other address, when known. */
  address?: string | null;
}
const NOWHERE: SideData = { wallet: null, chain: null, amount: null, asset: null, value: null };

/** One side of a transaction: wallet, coin and amount, or the address outside. */
function Side({
  amount,
  asset,
  wallet,
  chain,
  kind,
  address,
  value,
  sign,
}: SideData & { sign: "+" | "-" }) {
  const out = sign === "-";
  if (!amount || !asset)
    return (
      <span className={cx("flex items-center gap-2 text-xs text-slate-400", out && "justify-end")}>
        {wallet ? (
          <>
            <WalletIcon name={wallet} chain={chain} kind={kind} size="sm" />
            {wallet}
          </>
        ) : address ? (
          <span
            title={address}
            className="rounded-md bg-emerald-50 px-2 py-1 font-mono text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
          >
            {address.startsWith("0x") ? "0x" : ""}
            {shortHash(address)}
          </span>
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
        {value !== null && (
          <span className="block text-xs text-slate-500">≈ {formatMoney(value)}</span>
        )}
      </span>
    </span>
  );
}

type Who = { wallet: string | null; chain: string | null; kind?: string };

/**
 * Both sides of a row the way Koinly shows them: what left (including the fee
 * when it's the same coin), what arrived, and the fee as a share of what
 * arrived (a transfer) or of what was sent.
 */
function sides(t: CryptoTxn): {
  out: SideData;
  in: SideData;
  fee: { asset: string; amount: string; pct: string | null; sameCoin: boolean } | null;
  feeOnly: boolean;
  sender: Who;
  receiver: Who | null;
} {
  const me: Who = { wallet: t.walletName, chain: t.walletChain, kind: t.walletKind };
  const fee = t.feeAmount && t.feeAsset ? { asset: t.feeAsset, amount: t.feeAmount } : null;
  // A fee-only row (a failed call, a token approval, a staking action).
  if (!t.sentAmount && !t.receivedAmount && fee)
    return {
      out: { ...me, ...fee, value: t.feeValueCents },
      in: NOWHERE,
      fee: null,
      feeOnly: true,
      sender: me,
      receiver: null,
    };
  const p = t.transfer;
  const other: Who | null = p
    ? { wallet: p.walletName, chain: p.walletChain, kind: p.walletKind }
    : null;
  const partner = p && other && t.type === "transfer" ? { p, other } : null;
  // Out: what this row sent, or (a transfer seen from its receiving side) what the other side sent.
  const outRaw = t.sentAmount
    ? { ...me, asset: t.sentAsset, amount: t.sentAmount, value: t.valueCents, fee }
    : partner
      ? {
          ...partner.other,
          asset: partner.p.asset,
          amount: partner.p.amount,
          value: partner.p.valueCents,
          fee:
            partner.p.feeAmount && partner.p.feeAsset
              ? { asset: partner.p.feeAsset, amount: partner.p.feeAmount }
              : null,
        }
      : null;
  const inRaw = t.receivedAmount
    ? { ...me, asset: t.receivedAsset, amount: t.receivedAmount, value: t.valueCents }
    : partner
      ? {
          ...partner.other,
          asset: partner.p.asset,
          amount: partner.p.amount,
          value: partner.p.valueCents,
        }
      : null;
  const f = outRaw?.fee ?? null;
  const sameCoin = !!(f && outRaw?.amount && f.asset === outRaw.asset);
  const out: SideData = outRaw
    ? {
        ...outRaw,
        amount:
          sameCoin && outRaw.amount && f ? addAmounts(outRaw.amount, f.amount) : outRaw.amount,
        // A transfer's value can come from either side.
        value: outRaw.value ?? (t.type !== "trade" ? (inRaw?.value ?? null) : null),
      }
    : { ...NOWHERE, address: t.counterparty };
  const inn: SideData = inRaw
    ? {
        ...inRaw,
        // A trade's value sits on what was sent.
        value: t.type === "trade" && outRaw ? null : (inRaw.value ?? outRaw?.value ?? null),
      }
    : { ...NOWHERE, address: t.counterparty };
  // What was lost on the way: the fee, or (a transfer) everything that didn't arrive.
  let lost = sameCoin && f ? f.amount : null;
  if (out.amount && inRaw?.amount && out.asset && inRaw.asset === out.asset) {
    const gap = addAmounts(out.amount, inRaw.amount, -1n);
    lost = gap.startsWith("-") || !/[1-9]/.test(gap) ? lost : gap;
  }
  let pct: string | null = null;
  if (lost && out.amount) {
    const base = inRaw?.asset === out.asset && inRaw?.amount ? inRaw.amount : outRaw?.amount;
    // A percentage for display only.
    const x = (Number(lost) / Number(base)) * 100;
    if (Number.isFinite(x) && x > 0)
      pct = x < 0.01 ? "< 0.01% fee" : `${x < 10 ? x.toFixed(2) : x.toFixed(0)}% fee`;
  }
  const shownFee =
    lost && out.asset
      ? { asset: out.asset, amount: lost, pct, sameCoin: true }
      : f
        ? { ...f, pct: null, sameCoin: false }
        : null;
  return {
    out,
    in: inn,
    fee: shownFee,
    feeOnly: false,
    sender: outRaw ? { wallet: outRaw.wallet, chain: outRaw.chain, kind: outRaw.kind } : me,
    receiver:
      outRaw && inRaw && outRaw.wallet !== inRaw.wallet
        ? { wallet: inRaw.wallet, chain: inRaw.chain, kind: inRaw.kind }
        : null,
  };
}

/** Tags offered first, by direction (as Koinly's menu). */
const IN_TAGS = ["reward", "airdrop", "income"];
const OUT_TAGS = ["cost", "gift", "lost"];

const SOURCE_LABEL: Record<string, string> = {
  sync: "Synced",
  import: "Imported",
  manual: "Added by hand",
};

/** The title's menu: tag it, untag it, or turn it into / out of a transfer. */
function TagMenu({
  t,
  onClose,
  onMarkTransfer,
}: {
  t: CryptoTxn;
  onClose: () => void;
  onMarkTransfer: () => void;
}) {
  const [more, setMore] = useState(false);
  const relabel = useCryptoMutation((label: string | null) =>
    api.patch(`/api/crypto/txns/${t.id}`, { label }),
  );
  const unlink = useCryptoMutation(() => api.post(`/api/crypto/txns/${t.id}/unlink`));
  const incoming = !!t.receivedAmount && !t.sentAmount;
  const first = incoming ? IN_TAGS : OUT_TAGS;
  const rest = CRYPTO_LABELS.filter((l) => !first.includes(l));
  const pick = (label: string | null) => relabel.mutate(label, { onSuccess: onClose });
  const item =
    "block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800";
  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 z-10 cursor-default"
        onClick={onClose}
      />
      <div
        role="menu"
        className="absolute top-full left-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      >
        {t.type !== "transfer" && t.type !== "trade" && (
          <>
            {(more ? [...first, ...rest] : first).map((l) => (
              <button
                key={l}
                type="button"
                role="menuitem"
                className={cx(item, t.label === l && "font-semibold")}
                onClick={() => pick(l)}
              >
                Tag as <span className="font-semibold">{LABELS[l]}</span>
              </button>
            ))}
            {!more && (
              <button type="button" role="menuitem" className={item} onClick={() => setMore(true)}>
                More tags ›
              </button>
            )}
            {t.label && (
              <button type="button" role="menuitem" className={item} onClick={() => pick(null)}>
                Remove tag
              </button>
            )}
            <hr className="my-1 border-slate-200 dark:border-slate-700" />
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                onClose();
                onMarkTransfer();
              }}
            >
              Mark as <span className="font-semibold">Transfer</span>
            </button>
          </>
        )}
        {t.type === "transfer" && t.transferPairId && (
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={unlink.isPending}
            onClick={() => unlink.mutate(undefined, { onSuccess: onClose })}
          >
            Not a transfer: split into a deposit and a withdrawal
          </button>
        )}
        {t.type === "trade" && (
          <p className="px-3 py-1.5 text-xs text-slate-500">Trades have no tags.</p>
        )}
        {(relabel.error ?? unlink.error) && (
          <p className="px-3 py-1.5 text-xs text-red-600">
            {(relabel.error ?? unlink.error)?.message}
          </p>
        )}
      </div>
    </>
  );
}

/** Link a deposit or withdrawal with its other side in another wallet. */
function MarkTransfer({ t, onDone }: { t: CryptoTxn; onDone: () => void }) {
  const matches = useCryptoTransferMatches(t.id, true);
  const link = useCryptoMutation((otherId: string) =>
    api.post(`/api/crypto/txns/${t.id}/link`, { otherId }),
  );
  const incoming = !!t.receivedAmount;
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <p className="font-medium">
        {incoming ? "Where did it come from?" : "Where did it go?"}{" "}
        <span className="font-normal text-slate-500">
          {incoming ? "Sends" : "Receipts"} of {t.receivedAsset ?? t.sentAsset} in your other
          wallets within 3 days:
        </span>
      </p>
      {matches.isLoading && <p className="text-slate-500">Looking…</p>}
      {matches.data?.length === 0 && (
        <p className="text-slate-500">
          None found. Add the other wallet (or its transactions) first, then try again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {matches.data?.map((m) => (
          <Button
            key={m.id}
            variant="secondary"
            disabled={link.isPending}
            onClick={() => link.mutate(m.id, { onSuccess: onDone })}
          >
            {m.walletName}: {incoming ? "−" : "+"}
            {fmtAmount(m.amount)} {m.asset} on {dayLabel(m.at)} {when(m.at)}
          </Button>
        ))}
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {link.error && <p className="text-xs text-red-600">{link.error.message}</p>}
    </div>
  );
}

/** Expanded row: where it came from and went, amounts per wallet, value, fee, notes. */
function Details({
  t,
  s,
  link,
  heading,
}: {
  t: CryptoTxn;
  s: ReturnType<typeof sides>;
  link: string | null;
  heading: string;
}) {
  const [notes, setNotes] = useState(t.description ?? "");
  const saveNotes = useCryptoMutation((d: string) =>
    api.patch(`/api/crypto/txns/${t.id}`, { description: d || null }),
  );
  const del = useCryptoMutation(() => api.delete(`/api/crypto/txns/${t.id}`));
  const place = (x: SideData) => x.wallet ?? x.address ?? "Outside your wallets";
  const value = s.out.value ?? s.in.value;
  const line = (x: SideData, sign: "+" | "-", own: boolean) =>
    x.amount && x.asset ? (
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="flex items-center gap-2">
          <span className={sign === "+" ? "text-emerald-600" : "text-red-500"}>
            {sign === "+" ? "+" : "−"}
          </span>
          <CoinIcon asset={x.asset} size="sm" />
          <span className="font-mono tabular-nums">{fmtAmount(x.amount, 18)}</span>
          <span className="font-medium">{x.asset}</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          {x.wallet}
          {own && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
              {SOURCE_LABEL[t.source] ?? t.source}
            </span>
          )}
        </span>
      </div>
    ) : null;
  const mineIsOut = !!t.sentAmount || (!t.receivedAmount && !!t.feeAmount);
  return (
    <div className="grid gap-4 border-t border-slate-100 bg-slate-50/60 px-4 py-4 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] dark:border-slate-800 dark:bg-slate-900/40">
      <div className="space-y-3">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="text-lg font-semibold">{heading}</span>
          <span className="text-xs text-slate-500">
            {new Date(t.at).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "medium",
            })}
          </span>
        </p>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">Transaction</dt>
            <dd className="font-mono text-xs break-all">
              {t.txHash ? (
                link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand-600 hover:underline"
                  >
                    {shortHash(t.txHash)} ↗
                  </a>
                ) : (
                  shortHash(t.txHash)
                )
              ) : (
                <span className="font-sans text-slate-400">none</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">From</dt>
            <dd className="text-xs break-all" title={s.out.address ?? undefined}>
              {s.feeOnly ? place(s.out) : place(s.out)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">To</dt>
            <dd className="text-xs break-all" title={s.in.address ?? undefined}>
              {s.feeOnly ? "The network (fee)" : place(s.in)}
            </dd>
          </div>
        </dl>
        <label className="block">
          <span className="text-xs text-slate-500">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (t.description ?? "") && saveNotes.mutate(notes)}
            rows={2}
            maxLength={500}
            placeholder="Add a note…"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        {t.source === "manual" && (
          <Button
            variant="ghost"
            className="text-red-600"
            onClick={() => window.confirm("Delete this transaction?") && del.mutate(undefined)}
          >
            Delete transaction
          </Button>
        )}
      </div>
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950">
        {line(s.out, "-", mineIsOut)}
        {!s.feeOnly && line(s.in, "+", !mineIsOut)}
        <dl className="mt-1 divide-y divide-slate-100 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          <div className="flex justify-between py-1.5">
            <dt className="text-slate-500">Value then</dt>
            <dd className="tabular-nums">{value !== null ? formatMoney(value) : "no price"}</dd>
          </div>
          {s.fee && (
            <div className="flex justify-between py-1.5">
              <dt className="text-slate-500">Fee</dt>
              <dd className="tabular-nums">
                {t.feeValueCents !== null && t.feeAsset === s.fee.asset && (
                  <span className="mr-2 text-xs text-slate-500">
                    {formatMoney(t.feeValueCents)}
                  </span>
                )}
                {fmtAmount(s.fee.amount, 18)} {s.fee.asset}
              </dd>
            </div>
          )}
          {t.importedCostBasisCents !== null && (
            <div className="flex justify-between py-1.5">
              <dt className="text-slate-500">Cost basis (from Koinly)</dt>
              <dd className="tabular-nums">{formatMoney(t.importedCostBasisCents)}</dd>
            </div>
          )}
          {t.importedGainCents !== null && (
            <div className="flex justify-between py-1.5">
              <dt className="text-slate-500">Gain (from Koinly)</dt>
              <dd className="tabular-nums">{formatMoney(t.importedGainCents)}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

function TxnRow({ t }: { t: CryptoTxn }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [marking, setMarking] = useState(false);
  const s = sides(t);
  const incoming = !t.sentAmount && !!t.receivedAmount;
  const link = explorerTxUrl(
    guessChain(t.walletChain ?? t.transfer?.walletChain, t.walletName, t.feeAsset),
    t.txHash,
  );
  const heading = s.feeOnly ? "Fee" : title(t);
  const missingWallet =
    t.sentAmount || t.feeAmount ? t.walletId : (t.transfer?.walletId ?? t.walletId);
  return (
    <li>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the Details button does the same from the keyboard */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <div
        className="grid cursor-pointer grid-cols-1 items-center gap-3 px-4 py-3 hover:bg-slate-50 md:grid-cols-[12rem_minmax(0,1fr)_1.5rem_minmax(0,1fr)_11rem] dark:hover:bg-slate-900/40"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button,a,select,input,textarea,[role=menu]"))
            setOpen((o) => !o);
        }}
      >
        <span className="flex items-center gap-3">
          <span className="relative">
            <WalletIcon name={s.sender.wallet ?? ""} chain={s.sender.chain} kind={s.sender.kind} />
            {s.receiver && (
              <span className="absolute -right-1.5 -bottom-1.5 rounded-full ring-2 ring-white dark:ring-slate-900">
                <WalletIcon
                  name={s.receiver.wallet ?? ""}
                  chain={s.receiver.chain}
                  kind={s.receiver.kind}
                  size="sm"
                />
              </span>
            )}
          </span>
          <span className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
              className="block text-left text-sm font-medium hover:text-brand-600"
            >
              {heading} <span className="text-xs text-slate-400">▾</span>
            </button>
            <span className="text-xs text-slate-500">
              {when(t.at)}
              {s.feeOnly ? " · Network fee" : t.label ? ` · ${TYPE_LABEL[t.type]}` : ""}
            </span>
            {menu && (
              <TagMenu
                t={t}
                onClose={() => setMenu(false)}
                onMarkTransfer={() => setMarking(true)}
              />
            )}
          </span>
        </span>
        <span className="md:justify-self-end">
          <Side {...s.out} sign="-" />
        </span>
        <span
          aria-hidden="true"
          className={cx(
            "hidden text-lg md:block",
            t.type === "transfer"
              ? "text-brand-600"
              : incoming
                ? "text-emerald-600"
                : "text-red-500",
          )}
        >
          {t.type === "transfer" ? "»" : "→"}
        </span>
        <span>
          {s.feeOnly ? (
            <span className="text-xs text-slate-500">paid to the network</span>
          ) : (
            <Side {...s.in} sign="+" />
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
          {s.fee && (s.fee.pct || !s.fee.sameCoin) && (
            <span
              title={`Fee: ${fmtAmount(s.fee.amount)} ${s.fee.asset}`}
              className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800"
            >
              <span className="flex size-4 overflow-hidden rounded-full [&>*]:size-4! [&>*]:ring-0">
                <CoinIcon asset={s.fee.asset} size="sm" />
              </span>
              {s.fee.pct ?? `${fmtAmount(s.fee.amount)} ${s.fee.asset} fee`}
            </span>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((o) => !o)}
            className="rounded px-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            {open ? "▴" : "▾"}
          </button>
        </span>
      </div>
      {t.missingHistory.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 px-4 pb-2 text-xs text-red-600 dark:text-red-400">
          <span>
            ⚠ Missing purchase history for{" "}
            {t.missingHistory.map((m) => `${fmtAmount(m.amount)} ${m.asset}`).join(", ")}
          </span>
          <span className="text-slate-400">·</span>
          <Link
            to="/crypto/transactions"
            search={{
              walletId: missingWallet,
              asset: t.missingHistory[0]?.asset,
              to: new Date(t.at).toISOString().slice(0, 10),
            }}
            className="text-brand-600 hover:underline"
          >
            View earlier transactions
          </Link>
          <span className="text-slate-400">·</span>
          <Link
            to="/crypto/reconcile"
            hash={`wallet-${missingWallet}`}
            className="text-brand-600 hover:underline"
          >
            Fix in Reconcile
          </Link>
        </p>
      )}
      {marking && (
        <div className="px-4 pb-3">
          <MarkTransfer t={t} onDone={() => setMarking(false)} />
        </div>
      )}
      {open && <Details t={t} s={s} link={link} heading={heading} />}
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

/** Pick any number of wallets (none = all), Koinly-style chips. */
function WalletPicker({
  wallets,
  selected,
  onChange,
}: {
  wallets: { id: string; name: string; chain: string | null; kind: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const chosen = wallets.filter((w) => selected.includes(w.id));
  const shown = wallets.filter((w) => w.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="relative">
      <div className="flex min-h-[2.5rem] min-w-[14rem] max-w-xl flex-wrap items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950">
        {chosen.map((w) => (
          <span
            key={w.id}
            className="flex items-center gap-1 rounded-md bg-brand-600 py-0.5 pr-1 pl-1.5 text-xs text-white"
          >
            {w.name}
            <button
              type="button"
              aria-label={`Remove ${w.name}`}
              onClick={() => toggle(w.id)}
              className="px-0.5 opacity-80 hover:opacity-100"
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex-1 py-1 text-left text-slate-500"
        >
          {chosen.length ? "Add wallet…" : "All wallets"} ▾
        </button>
      </div>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full left-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <input
              // biome-ignore lint/a11y/noAutofocus: opened by the button
              autoFocus
              aria-label="Find a wallet"
              placeholder="Find a wallet"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="mb-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <ul className="max-h-72 overflow-y-auto">
              {shown.map((w) => (
                <li key={w.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
                    <input
                      type="checkbox"
                      checked={selected.includes(w.id)}
                      onChange={() => toggle(w.id)}
                    />
                    <WalletIcon name={w.name} chain={w.chain} kind={w.kind} size="sm" />
                    {w.name}
                  </label>
                </li>
              ))}
            </ul>
            {selected.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="mt-1 text-xs text-brand-600 hover:underline"
              >
                All wallets
              </button>
            )}
          </div>
        </>
      )}
    </div>
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
    warnings: search.warnings,
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
    search.warnings ||
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
        <WalletPicker
          wallets={wallets.data ?? []}
          selected={(search.walletId ?? "").split(",").filter(Boolean)}
          onChange={(ids) => set({ walletId: ids.join(",") })}
        />
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
        <select
          aria-label="Warnings"
          value={search.warnings ?? ""}
          onChange={(e) => set({ warnings: (e.target.value || undefined) as "missing" })}
          className={sel}
        >
          <option value="">All warnings</option>
          <option value="missing">Missing purchase history</option>
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
