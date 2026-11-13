import { formatMoney } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../../components/ui.js";

/** Shared bits for the Stocks pages: the section tabs and money helpers. */

const TABS = [
  ["/stocks", "Dashboard"],
  ["/stocks/transactions", "Transactions"],
  ["/stocks/reconcile", "Reconcile"],
  ["/stocks/settings", "Settings"],
] as const;

export function StocksHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Stocks" actions={actions} />
      <nav
        aria-label="Stocks sections"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 [scrollbar-width:none] dark:border-slate-800 [&::-webkit-scrollbar]:hidden"
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

/** Signed money with a real minus sign. */
export const money = (c: number) => (c < 0 ? `−${formatMoney(-c)}` : formatMoney(c));

export const tone = (c: number) =>
  c > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : c < 0
      ? "text-red-600 dark:text-red-400"
      : "text-slate-500";

/** YYYY-MM-DD as a short local date. */
export const day = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

// Exact share counts (18 decimals), as the server keeps them.
const SCALE = 10n ** 18n;
export function fx(s: string | null | undefined): bigint {
  if (!s) return 0n;
  const neg = s.startsWith("-");
  const [w = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(w || "0") * SCALE + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
  return neg ? -v : v;
}
