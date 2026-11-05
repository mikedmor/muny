import { type BudgetLine, formatMoney } from "@muny/shared";
import { useState } from "react";
import { useDeleteBudget, useSetBudget } from "../lib/queries.js";
import { Checkbox, MoneyField } from "./forms.js";
import { Alert, Button } from "./ui.js";

/** Shared budget pieces: progress ring and the budget editor. */

export const monthLabel = (
  m: string,
  opts: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" },
) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, opts);
};

/** Progress ring: the arc shows how much of the limit is used. */
export function Ring({
  used,
  limit,
  size = 22,
  stroke = 3,
  children,
}: {
  used: number;
  limit: number;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : used > 0 ? 1 : 0;
  const over = limit > 0 ? used > limit : used > 0;
  const color = over
    ? "stroke-red-500"
    : pct > 0.85
      ? "stroke-amber-500"
      : "stroke-[var(--viz-series-1)]";
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} aria-hidden="true" className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-slate-200 dark:stroke-slate-700"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (over ? 1 : pct))}
          className={color}
        />
      </svg>
      {children && (
        <span className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </span>
      )}
    </span>
  );
}

export function EditBudget({
  line,
  month,
  onDone,
}: {
  line: BudgetLine;
  month: string;
  onDone: () => void;
}) {
  const set = useSetBudget();
  const del = useDeleteBudget();
  const suggested = line.averageCents > 0 ? Math.ceil(line.averageCents / 1000) * 1000 : null;
  const [amount, setAmount] = useState<number | null>(line.budgetCents ?? suggested);
  const [rollover, setRollover] = useState(line.rollover);
  return (
    <div className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <MoneyField
          label={`Monthly budget from ${monthLabel(month)}`}
          cents={amount}
          onChange={(c) => setAmount(c)}
          hint={
            line.averageCents > 0
              ? `You spent ${formatMoney(line.averageCents)}/mo on average over the last 3 months.`
              : undefined
          }
        />
        <Checkbox
          label="Roll over"
          description="Carry what's left (or overspent) into next month."
          checked={rollover}
          onChange={setRollover}
        />
      </div>
      {(set.error || del.error) && <Alert>{(set.error ?? del.error)?.message}</Alert>}
      <div className="flex flex-wrap justify-between gap-2">
        {line.budgetId ? (
          <Button
            variant="ghost"
            className="text-red-600"
            onClick={() => line.budgetId && del.mutate(line.budgetId, { onSuccess: onDone })}
          >
            Remove budget
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={amount === null || set.isPending}
            onClick={() =>
              amount !== null &&
              set.mutate(
                { categoryId: line.categoryId, amountCents: amount, rollover, fromMonth: month },
                { onSuccess: onDone },
              )
            }
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
