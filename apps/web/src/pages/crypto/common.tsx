import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "../../components/ui.js";

/** Shared bits for the Crypto pages (tabs, number formatting). */

const TABS = [
  ["/crypto", "Dashboard"],
  ["/crypto/wallets", "Wallets"],
  ["/crypto/transactions", "Transactions"],
  ["/crypto/reconcile", "Reconcile"],
  ["/crypto/settings", "Settings"],
] as const;

export function CryptoHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Crypto" actions={actions} />
      <nav
        aria-label="Crypto sections"
        className="mb-6 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map(([to, label]) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact: true }}
            className="-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            activeProps={{ className: "!border-brand-600 !text-brand-700 dark:!text-brand-500" }}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

/**
 * Format an exact decimal string for display without floats: group the whole
 * part and keep up to `maxDecimals` decimals (rounded half up, as Koinly shows them).
 */
export function fmtAmount(s: string | null | undefined, maxDecimals = 8): string {
  if (!s) return "0";
  const neg = s.startsWith("-");
  const [w0 = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  let whole = w0;
  let kept = frac.slice(0, maxDecimals);
  if (maxDecimals > 0 && (frac[maxDecimals] ?? "0") >= "5") {
    const up = (BigInt(whole + kept) + 1n).toString().padStart(maxDecimals + 1, "0");
    whole = up.slice(0, -maxDecimals);
    kept = up.slice(-maxDecimals);
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let f = kept.replace(/0+$/, "");
  // Tiny non-zero amounts: show enough digits to not read as zero.
  if (!f && /[1-9]/.test(frac) && whole === "0")
    f = frac.replace(/0+$/, "").slice(0, frac.search(/[1-9]/) + 2);
  return `${neg ? "-" : ""}${grouped}${f ? `.${f}` : ""}`;
}

export const when = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const dayLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
export function ago(ms: number | null) {
  if (!ms) return "never";
  const d = Math.round((Date.now() - ms) / 86_400_000);
  if (d < 1) return "today";
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export const LABELS: Record<string, string> = {
  reward: "Reward",
  staking: "Staking",
  airdrop: "Airdrop",
  mining: "Mining",
  income: "Income",
  gift: "Gift",
  donation: "Donation",
  lost: "Lost",
  cost: "Cost",
  fee_refund: "Fee refund",
};
export const labelName = (l: string | null) =>
  l ? (LABELS[l] ?? l.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())) : null;

/** USD price per unit from an exact decimal string: 2 decimals, more for coins under $1. */
export function fmtPrice(usd: string): string {
  const [whole = "0", frac = ""] = usd.split(".");
  const decimals = whole === "0" ? Math.max(4, frac.search(/[1-9]/) + 3) : 2;
  const f = frac.slice(0, decimals).padEnd(2, "0");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${f}`;
}

/** "just now", "12 min ago", "3 h ago", then days. */
export function agoTime(ms: number | null) {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return ago(ms);
}

/** Block explorer page for a transaction (opened only when the user clicks). */
const EXPLORERS: Record<string, (h: string) => string> = {
  btc: (h) => `https://mempool.space/tx/${h}`,
  ltc: (h) => `https://litecoinspace.org/tx/${h}`,
  doge: (h) => `https://blockchair.com/dogecoin/transaction/${h}`,
  zec: (h) => `https://blockchair.com/zcash/transaction/${h}`,
  eth: (h) => `https://etherscan.io/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  op: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  arb: (h) => `https://arbiscan.io/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  gnosis: (h) => `https://gnosisscan.io/tx/${h}`,
  ada: (h) => `https://cardanoscan.io/transaction/${h}`,
  algo: (h) => `https://allo.info/tx/${h}`,
  xlm: (h) => `https://stellar.expert/explorer/public/tx/${h}`,
  atom: (h) => `https://www.mintscan.io/cosmos/tx/${h}`,
  trx: (h) => `https://tronscan.org/#/transaction/${h}`,
};
const EVM = new Set(["eth", "base", "op", "arb", "polygon", "gnosis"]);

export function explorerTxUrl(
  chain: string | null | undefined,
  hash: string | null,
): string | null {
  if (!chain || !hash) return null;
  const f = EXPLORERS[chain];
  if (!f) return null;
  const h = EVM.has(chain) && !hash.startsWith("0x") ? `0x${hash}` : hash;
  return f(h);
}

export const shortHash = (h: string) => `${h.replace(/^0x/, "").slice(0, 4)}…${h.slice(-4)}`;

/** Native coin → chain, to guess where an imported wallet's transactions live. */
const COIN_CHAIN: Record<string, string> = {
  BTC: "btc",
  LTC: "ltc",
  DOGE: "doge",
  ZEC: "zec",
  ETH: "eth",
  ADA: "ada",
  ALGO: "algo",
  XLM: "xlm",
  ATOM: "atom",
  TRX: "trx",
  POL: "polygon",
  MATIC: "polygon",
};

/**
 * The chain a transaction is on: the wallet's (when synced), else guessed from
 * a coin in the wallet's name ("ETH Exodus"), else from the fee coin (gas).
 */
export function guessChain(
  chain: string | null | undefined,
  walletName: string,
  feeAsset: string | null,
): string | null {
  if (chain) return chain;
  const fromName = walletName
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((w) => COIN_CHAIN[w])
    .find(Boolean);
  return fromName ?? (feeAsset ? (COIN_CHAIN[feeAsset] ?? null) : null);
}

/**
 * A banner the viewer can dismiss (remembered in this browser). Include what
 * the banner says in the key (e.g. a count) so a new situation shows again.
 */
export function useDismissed(key: string): [boolean, () => void] {
  const k = `muny.dismissed.${key}`;
  // Dismissed in this visit (also when the browser won't store it).
  const [mem, setMem] = useState<Set<string>>(() => new Set());
  let stored = false;
  try {
    stored = localStorage.getItem(k) === "1";
  } catch {
    // Storage blocked: only this visit counts.
  }
  return [
    stored || mem.has(k),
    () => {
      setMem((m) => new Set(m).add(k));
      try {
        localStorage.setItem(k, "1");
      } catch {
        // Private window: dismissed for this visit only.
      }
    },
  ];
}

export function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dismiss"
      title="Dismiss"
      className="rounded px-1.5 text-lg leading-none opacity-60 hover:opacity-100"
    >
      ×
    </button>
  );
}
