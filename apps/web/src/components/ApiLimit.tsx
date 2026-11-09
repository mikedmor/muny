import { type ApiLimit, limitMessage } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { useApiLimits } from "../lib/queries.js";
import { cx } from "./ui.js";

/** The limit stopping any of these services, with the longest wait if several have hit one. */
export function useApiLimit(...providers: string[]): ApiLimit | null {
  const limits = useApiLimits().data ?? [];
  const hits = limits.filter((l) => providers.includes(l.provider));
  return hits.sort((a, b) => b.resetsAt - a.resetsAt)[0] ?? null;
}

/** Why an action is unavailable, and for how long. Shown in place of trying it. */
export function ApiLimitNotice({ limit, className }: { limit: ApiLimit; className?: string }) {
  return (
    <p role="status" className={cx("text-xs text-amber-700 dark:text-amber-400", className)}>
      {limitMessage(limit)}{" "}
      <Link to="/settings" hash="api" className="underline">
        Request limits
      </Link>
    </p>
  );
}
