import {
  type BudgetLine,
  formatMoney,
  MoneyParseError,
  parseAmount,
  toDecimalString,
} from "@muny/shared";
import { useState } from "react";
import { useDeleteBudget, useSetBudget } from "../lib/queries.js";
import { Checkbox, MoneyField } from "./forms.js";
import { Alert, Button, cx } from "./ui.js";

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

/**
 * Click-to-edit budget amount (like Rocket Money): type a new amount, Enter or
 * click away saves, Esc cancels, the trash icon removes the budget. While
 * editing, a popup shows the last 3 months of spending against the amount.
 */
export function InlineBudget({
  line,
  month,
  auto,
}: {
  line: BudgetLine;
  month: string;
  /**
   * Earnings/bills only: the automatic amount (from the forecast). With no
   * fixed budget the row shows this, marked "Auto"; the popup can switch back.
   */
  auto?: number;
}) {
  const set = useSetBudget();
  const del = useDeleteBudget();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const start = () => {
    setText(line.budgetCents !== null ? toDecimalString(line.budgetCents, "USD") : "");
    setEditing(true);
  };
  let typed: number | null = null;
  try {
    typed = text.trim() ? parseAmount(text, { currency: "USD" }) : null;
  } catch (err) {
    if (!(err instanceof MoneyParseError)) throw err;
  }
  const valid = typed === null || typed >= 0;
  const commit = () => {
    setEditing(false);
    if (!valid || typed === null) return;
    if (typed === line.budgetCents) return;
    set.mutate({
      categoryId: line.categoryId,
      kind: line.kind,
      amountCents: typed,
      rollover: line.rollover,
      fromMonth: month,
    });
  };
  const remove = () => {
    if (line.budgetId) del.mutate(line.budgetId);
  };
  const isAuto = auto !== undefined && line.budgetCents === null;
  const shown = line.budgetCents ?? (auto !== undefined ? auto : null);

  if (!editing) {
    return (
      <span className="group flex items-center gap-1.5 sm:justify-end">
        {line.budgetId && (
          <button
            type="button"
            onClick={remove}
            disabled={del.isPending}
            aria-label={
              auto !== undefined
                ? `Switch ${line.name} back to automatic`
                : `Remove the ${line.name} budget`
            }
            title={auto !== undefined ? "Back to automatic" : "Remove budget"}
            className="rounded p-0.5 text-slate-400 opacity-0 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
          >
            {auto !== undefined ? "↺" : "🗑"}
          </button>
        )}
        {isAuto && (
          <span
            title="Automatic: from your recurring income and bills. Click the amount to set your own."
            className="rounded bg-slate-100 px-1 text-[10px] font-semibold uppercase text-slate-500 dark:bg-slate-800"
          >
            Auto
          </span>
        )}
        <button
          type="button"
          onClick={start}
          aria-label={`Budget for ${line.name}: ${shown !== null ? formatMoney(shown) : "none"}${isAuto ? " (automatic)" : ""}. Click to change.`}
          className={cx(
            "min-w-20 rounded border-b border-dashed px-1 text-right tabular-nums hover:border-brand-500",
            shown === null
              ? "border-transparent text-xs text-brand-600"
              : "border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-200",
          )}
        >
          {shown !== null ? formatMoney(shown) : "Set budget"}
        </button>
      </span>
    );
  }

  const history = line.historyCents;
  const max = Math.max(1, typed ?? 0, ...history.map((h) => h.cents));
  return (
    <span className="relative flex sm:justify-end">
      <span className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-1.5 flex items-center text-sm text-slate-400">
          $
        </span>
        <input
          // biome-ignore lint/a11y/noAutofocus: opened by a click on the amount
          autoFocus
          inputMode="decimal"
          aria-label={`Monthly budget for ${line.name}`}
          aria-invalid={!valid}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className={cx(
            "w-24 rounded-md border bg-white py-1 pr-1.5 pl-4 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-brand-500/30 dark:bg-slate-950",
            valid ? "border-brand-500" : "border-red-500",
          )}
        />
      </span>
      <span
        role="tooltip"
        className="absolute top-full left-0 z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] sm:right-0 sm:left-auto rounded-xl border border-slate-200 bg-white p-3 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900"
      >
        <span className="block text-xs text-slate-600 dark:text-slate-300">
          {line.kind === "income"
            ? "Your income over the past 3 months"
            : line.kind === "bills"
              ? "Bills & subscriptions paid over the past 3 months"
              : "Your spending over the past 3 months"}
        </span>
        <span className="relative mt-2 flex h-24 items-end justify-around gap-3 border-b border-slate-200 dark:border-slate-700">
          {history.map((h) => (
            <span key={h.month} className="flex h-full flex-1 flex-col items-center justify-end">
              <span className="mb-0.5 text-[10px] tabular-nums text-slate-600 dark:text-slate-300">
                {formatMoney(h.cents).replace(/\.00$/, "")}
              </span>
              <span
                className="w-full rounded-t-[4px]"
                style={{
                  height: `${Math.max(2, (h.cents / max) * 70)}%`,
                  background: "var(--viz-series-1)",
                }}
              />
            </span>
          ))}
          {typed !== null && typed > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-slate-500 dark:border-slate-300"
              style={{ bottom: `${(typed / max) * 70}%` }}
            />
          )}
        </span>
        <span className="mt-1 flex justify-around text-[10px] text-slate-500">
          {history.map((h) => (
            <span key={h.month}>{monthLabel(h.month, { month: "short" })}</span>
          ))}
        </span>
        <span className="mt-2 block text-[11px] text-slate-500">
          Average {formatMoney(line.averageCents)}/mo · Enter to save, Esc to cancel
        </span>
        {auto !== undefined && (
          <button
            type="button"
            // Keep focus in the input so blur doesn't save before this click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setEditing(false);
              if (line.budgetId) del.mutate(line.budgetId);
            }}
            className={cx(
              "mt-2 flex w-full items-center justify-between rounded-lg border px-2 py-1.5 text-xs",
              isAuto
                ? "border-brand-500 bg-brand-50 dark:bg-brand-700/20"
                : "border-slate-300 hover:border-brand-500 dark:border-slate-600",
            )}
          >
            <span>
              <span className="font-semibold">{isAuto ? "✓ Automatic" : "Use automatic"}</span>
              <span className="block text-left text-slate-500">
                {line.kind === "income" ? "Paychecks Muny expects" : "Recurring bills scheduled"}
              </span>
            </span>
            <span className="font-medium tabular-nums">{formatMoney(auto)}</span>
          </button>
        )}
      </span>
    </span>
  );
}
