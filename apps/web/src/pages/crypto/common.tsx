import { Link } from "@tanstack/react-router";
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
        className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
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
 * part and keep up to `maxDecimals` decimals (truncated, never rounded up).
 */
export function fmtAmount(s: string | null | undefined, maxDecimals = 8): string {
  if (!s) return "0";
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let f = frac.slice(0, maxDecimals).replace(/0+$/, "");
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
