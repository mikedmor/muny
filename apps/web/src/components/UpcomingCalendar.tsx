import type { UpcomingCharge } from "@muny/shared";
import { formatMoney } from "@muny/shared";
import { useMemo, useState } from "react";
import { useUpcoming } from "../lib/queries.js";
import { Button, Card, cx } from "./ui.js";

/** Bills, subscriptions and income on a month calendar (Recurring and the Overview). */

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let d = 1; d <= days; d++) cells.push(iso(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function UpcomingCalendar() {
  const today = iso(new Date());
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const monthStart = iso(new Date(cursor.y, cursor.m, 1));
  const monthEnd = iso(new Date(cursor.y, cursor.m + 1, 0));
  const later = (a: string, b: string) => (a < b ? b : a);
  const month = useUpcoming(later(monthStart, today), later(monthEnd, today));
  const byDay = useMemo(() => {
    const m = new Map<string, UpcomingCharge[]>();
    for (const u of month.data ?? []) m.set(u.date, [...(m.get(u.date) ?? []), u]);
    return m;
  }, [month.data]);

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <Button
          variant="ghost"
          aria-label="Previous month"
          onClick={() =>
            setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))
          }
        >
          ‹
        </Button>
        <p className="font-medium">
          {new Date(cursor.y, cursor.m, 1).toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        </p>
        <Button
          variant="ghost"
          aria-label="Next month"
          onClick={() =>
            setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))
          }
        >
          ›
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-slate-200 text-xs dark:bg-slate-800">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="bg-slate-50 py-1 text-center font-medium text-slate-500 dark:bg-slate-900"
          >
            {d}
          </div>
        ))}
        {monthGrid(cursor.y, cursor.m).map((d, i) => {
          const items = d ? (byDay.get(d) ?? []) : [];
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed grid cells
              key={i}
              className={cx(
                "min-h-20 bg-white p-1 dark:bg-slate-950",
                !d && "bg-slate-50 dark:bg-slate-900",
                d === today && "ring-2 ring-inset ring-brand-500",
                d && d < today && "opacity-50",
              )}
            >
              {d && <p className="text-[11px] text-slate-500">{Number(d.slice(8))}</p>}
              {items.slice(0, 3).map((u) => (
                <p
                  key={`${u.seriesId}-${u.pending ? "p" : ""}`}
                  title={`${u.name} ${formatMoney(u.amountCents)}${u.pending ? " (pending)" : ""}`}
                  className={cx(
                    "mt-0.5 truncate rounded px-1 text-[11px]",
                    u.pending && "outline-1 outline-dashed outline-current",
                    u.amountCents > 0
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : u.kind === "bill"
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                        : "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
                  )}
                >
                  {u.pending && "⏳ "}
                  {u.name}
                </p>
              ))}
              {items.length > 3 && (
                <p className="text-[11px] text-slate-500">+{items.length - 3} more</p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
