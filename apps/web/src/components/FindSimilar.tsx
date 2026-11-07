import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { similarQuery } from "../lib/similar.js";
import { cx } from "./ui.js";

/**
 * A magnifying glass next to a transaction: opens Transactions filtered to
 * ones like it (the same payee, or the start of the bank's description).
 */

export function FindSimilar({
  payeeName,
  description,
  className,
  onFind,
}: {
  /** The payee Muny shows for it, if any (searched as is). */
  payeeName?: string | null;
  /** The bank's description. */
  description: string;
  className?: string;
  /** Also run on click (e.g. close the dialog it's in). */
  onFind?: () => void;
}) {
  const q = payeeName ? similarQuery(payeeName, true) : similarQuery(description);
  if (!q) return null;
  return (
    <Link
      to="/transactions"
      search={{ q }}
      title={`Find transactions like this ("${q}")`}
      aria-label={`Find transactions like ${q}`}
      onClick={(e) => {
        e.stopPropagation();
        onFind?.();
      }}
      className={cx(
        "inline-flex shrink-0 items-center rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200",
        className,
      )}
    >
      <Search aria-hidden="true" className="size-3.5" />
    </Link>
  );
}
