import {
  formatMoney,
  INTERVAL_LABELS,
  INTERVALS,
  type Interval,
  RECURRING_KINDS,
  type RecurringKind,
  type RecurringSeries,
} from "@muny/shared";
import { type FormEvent, useEffect, useState } from "react";
import { CategorySelect } from "../components/CategorySelect.js";
import { Modal, MoneyField, SelectField } from "../components/forms.js";
import { UpcomingCalendar } from "../components/UpcomingCalendar.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import {
  useDeleteRecurring,
  useRecordSaving,
  useRecurring,
  useRecurringHistory,
  useRescanRecurring,
  useUpcoming,
  useUpdateRecurring,
} from "../lib/queries.js";
import { TrialsTab } from "./TrialsTab.js";

const KIND_LABEL: Record<RecurringKind, string> = {
  subscription: "Subscription",
  bill: "Bill",
  income: "Income",
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
};
const fmtDay = (s: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  parse(s).toLocaleDateString(undefined, opts);

function Money({ cents, className }: { cents: number; className?: string }) {
  return (
    <span className={cx("tabular-nums", cents > 0 && "text-emerald-600", className)}>
      {formatMoney(cents)}
    </span>
  );
}

function Stat({ label, cents, hint }: { label: string; cents: number; hint?: string }) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <Money cents={cents} className="mt-1 block text-xl font-semibold" />
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

function SeriesRow({ s, onOpen }: { s: RecurringSeries; onOpen: () => void }) {
  const update = useUpdateRecurring();
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 basis-40 text-left">
        <p className="truncate font-medium">
          {s.name}
          {s.status === "detected" && (
            <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300">
              New
            </span>
          )}
          {s.chargedAfterCancel && (
            <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
              Charged after cancelling
            </span>
          )}
        </p>
        <p className="truncate text-xs text-slate-500">
          {INTERVAL_LABELS[s.interval]}
          {s.pending
            ? ` · ${formatMoney(Math.abs(s.pending.amountCents))} pending since ${fmtDay(s.pending.date)}`
            : s.active && ` · next ${fmtDay(s.nextDate)}`}
          {!s.active &&
            ` · last ${fmtDay(s.lastDate, { month: "short", day: "numeric", year: "numeric" })}`}
          {s.accountName && ` · ${s.accountName}`}
          {s.priceChange && (
            <span
              className={
                s.priceChange.toCents < s.priceChange.fromCents
                  ? "text-red-600"
                  : "text-emerald-600"
              }
            >
              {" "}
              · was {formatMoney(Math.abs(s.priceChange.fromCents))}
            </span>
          )}
        </p>
      </button>
      {s.active && s.status !== "cancelled" && <CycleStatus s={s} />}
      <div className="text-right">
        <Money cents={s.expectedAmountCents} className="font-medium" />
        {!s.fixedAmount && <p className="text-[11px] text-slate-500">varies</p>}
        {s.fixedAmount && s.interval !== "monthly" && (
          <p className="text-[11px] text-slate-500">{formatMoney(s.monthlyCents)}/mo</p>
        )}
      </div>
      {s.status === "detected" && (
        <div className="flex w-full justify-end gap-1 sm:w-auto">
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => update.mutate({ id: s.id, status: "confirmed" })}
          >
            Confirm
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs text-slate-500"
            onClick={() => update.mutate({ id: s.id, status: "ignored" })}
          >
            Not recurring
          </Button>
        </div>
      )}
    </li>
  );
}

const PILL = "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium";

/** Where a series stands this month: paid, pending, late or still due. */
function CycleStatus({ s }: { s: RecurringSeries }) {
  const today = todayIso();
  const income = s.kind === "income";
  if (s.pending)
    return (
      <span
        title={`Your bank shows ${formatMoney(Math.abs(s.pending.amountCents))} pending since ${fmtDay(s.pending.date)}`}
        className={cx(
          PILL,
          "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
        )}
      >
        ⏳ Pending
      </span>
    );
  if (s.late)
    return (
      <span
        title={`Expected ${fmtDay(s.nextDate)} and not seen yet`}
        className={cx(PILL, "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300")}
      >
        Late · due {fmtDay(s.nextDate)}
      </span>
    );
  const paid = s.paidThisMonth;
  if (paid.count > 0 && paid.lastDate)
    return (
      <span
        title={`${formatMoney(Math.abs(paid.cents))} ${income ? "received" : "paid"} this month${paid.count > 1 ? ` (${paid.count} times)` : ""}; next ${fmtDay(s.nextDate)}`}
        className={cx(
          PILL,
          "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
        )}
      >
        ✓ {income ? "Received" : "Paid"} {fmtDay(paid.lastDate)}
      </span>
    );
  if (s.nextDate.slice(0, 7) === today.slice(0, 7))
    return (
      <span
        className={cx(PILL, "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300")}
      >
        {s.nextDate === today ? "Due today" : `Due ${fmtDay(s.nextDate)}`}
      </span>
    );
  return (
    <span className={cx(PILL, "text-slate-500")} title="Nothing due this month">
      Next {fmtDay(s.nextDate)}
    </span>
  );
}

/** This month across bills and subscriptions: paid so far, pending, still due. */
function MonthSummary({ series }: { series: RecurringSeries[] }) {
  const today = todayIso();
  const d = parse(today);
  const monthEnd = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const due = useUpcoming(today, monthEnd);
  const out = series.filter((s) => s.kind !== "income");
  const paid = out.reduce((a, s) => a - Math.min(0, s.paidThisMonth.cents), 0);
  const paidN = out.filter((s) => s.paidThisMonth.count > 0).length;
  const pending = out.reduce((a, s) => a - Math.min(0, s.pending?.amountCents ?? 0), 0);
  const pendingN = out.filter((s) => s.pending).length;
  const ids = new Set(out.map((s) => s.id));
  const left = (due.data ?? []).filter(
    (u) => !u.pending && u.amountCents < 0 && ids.has(u.seriesId),
  );
  const leftCents = left.reduce((a, u) => a - u.amountCents, 0);
  const lateN = out.filter((s) => s.late).length;
  return (
    <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="font-medium">{d.toLocaleDateString(undefined, { month: "long" })}</span>
      <span>
        <span className="text-emerald-700 dark:text-emerald-400">✓ Paid {formatMoney(paid)}</span>{" "}
        <span className="text-slate-500">({paidN})</span>
      </span>
      {pendingN > 0 && (
        <span>
          <span className="text-violet-700 dark:text-violet-300">
            ⏳ Pending {formatMoney(pending)}
          </span>{" "}
          <span className="text-slate-500">({pendingN})</span>
        </span>
      )}
      <span>
        Still due {formatMoney(leftCents)}{" "}
        <span className="text-slate-500">
          ({left.length}
          {lateN > 0 && `, ${lateN} late`})
        </span>
      </span>
    </div>
  );
}

function Section({
  title,
  items,
  total,
  onOpen,
  collapsed,
}: {
  title: string;
  items: RecurringSeries[];
  total?: number;
  onOpen: (s: RecurringSeries) => void;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  if (items.length === 0) return null;
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-baseline justify-between px-1 text-left"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {open ? "▾" : "▸"} {title} <span className="font-normal">({items.length})</span>
        </h2>
        {total !== undefined && (
          <span className="text-sm text-slate-500">{formatMoney(total)}/mo</span>
        )}
      </button>
      {open && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {items.map((s) => (
            <SeriesRow key={s.id} s={s} onOpen={() => onOpen(s)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SeriesDetail({ s, onDone }: { s: RecurringSeries; onDone: () => void }) {
  const update = useUpdateRecurring();
  const del = useDeleteRecurring();
  const history = useRecurringHistory(s.id);
  const [name, setName] = useState(s.name);
  const [kind, setKind] = useState<RecurringKind>(s.kind);
  const [interval, setRepeat] = useState<Interval>(s.interval);
  const [amount, setAmount] = useState<number | null>(Math.abs(s.expectedAmountCents));
  const [categoryId, setCategoryId] = useState(s.categoryId);
  const [notes, setNotes] = useState(s.notes ?? "");
  const sign = s.expectedAmountCents < 0 ? -1 : 1;

  const save = (e: FormEvent) => {
    e.preventDefault();
    update.mutate(
      {
        id: s.id,
        ...(name !== s.name && { name }),
        ...(kind !== s.kind && { kind }),
        ...(interval !== s.interval && { interval }),
        ...(amount !== null &&
          sign * amount !== s.expectedAmountCents && { expectedAmountCents: sign * amount }),
        ...(categoryId !== s.categoryId && { categoryId }),
        notes: notes.trim() || null,
      },
      { onSuccess: onDone },
    );
  };
  const setStatus = (status: RecurringSeries["status"]) =>
    update.mutate({ id: s.id, status }, { onSuccess: onDone });
  const recordSaving = useRecordSaving();
  const [lowering, setLowering] = useState(false);
  const [newPrice, setNewPrice] = useState<number | null>(null);
  // Cancelling also records the saving (and marks the charge cancelled on the server).
  const cancel = () =>
    recordSaving.mutate({ kind: "cancelled", seriesId: s.id }, { onSuccess: onDone });
  const lowered = (kind: "downgraded" | "negotiated") => {
    if (newPrice === null) return;
    // Convert the new per-charge price to a monthly figure like the series' own.
    const perMonth = Math.round(
      (newPrice * Math.abs(s.monthlyCents)) / Math.max(1, Math.abs(s.expectedAmountCents)),
    );
    recordSaving.mutate(
      { kind, seriesId: s.id, afterMonthlyCents: perMonth },
      { onSuccess: onDone },
    );
  };

  return (
    <div className="space-y-5">
      <form onSubmit={save} className="space-y-4">
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            label="Type"
            value={kind}
            onChange={(e) => setKind(e.target.value as RecurringKind)}
          >
            {RECURRING_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Repeats"
            value={interval}
            onChange={(e) => setRepeat(e.target.value as Interval)}
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {INTERVAL_LABELS[i]}
              </option>
            ))}
          </SelectField>
          <MoneyField
            label={s.fixedAmount ? "Amount" : "Typical amount"}
            cents={amount}
            onChange={(c) => setAmount(c)}
          />
        </div>
        <div>
          <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">
            Category
          </span>
          <CategorySelect
            aria-label="Category"
            value={categoryId}
            onChange={setCategoryId}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <Field
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. shared with family, renews in March"
        />
        {lowering && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
            <div className="w-40">
              <MoneyField
                label="New price per charge"
                cents={newPrice}
                onChange={(c, ok) => ok && setNewPrice(c)}
              />
            </div>
            <Button
              variant="secondary"
              disabled={newPrice === null || recordSaving.isPending}
              onClick={() => lowered("downgraded")}
            >
              I downgraded
            </Button>
            <Button
              variant="secondary"
              disabled={newPrice === null || recordSaving.isPending}
              onClick={() => lowered("negotiated")}
            >
              I negotiated it
            </Button>
            <Button variant="ghost" onClick={() => setLowering(false)}>
              Cancel
            </Button>
          </div>
        )}
        {(update.error || del.error || recordSaving.error) && (
          <Alert>{(update.error ?? del.error ?? recordSaving.error)?.message}</Alert>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {s.status !== "cancelled" && s.kind !== "income" && (
              <Button
                variant="ghost"
                onClick={cancel}
                disabled={recordSaving.isPending}
                title="Records the saving; Muny confirms it when the charge stops and flags any further charges"
              >
                I cancelled it
              </Button>
            )}
            {s.status !== "cancelled" && s.kind !== "income" && !lowering && (
              <Button variant="ghost" onClick={() => setLowering(true)}>
                Price went down
              </Button>
            )}
            {s.status !== "ignored" && (
              <Button variant="ghost" onClick={() => setStatus("ignored")}>
                Not recurring
              </Button>
            )}
            {(s.status === "ignored" || s.status === "cancelled") && (
              <Button variant="ghost" onClick={() => setStatus("confirmed")}>
                Restore
              </Button>
            )}
            {s.source === "manual" && (
              <Button
                variant="ghost"
                className="text-red-600"
                onClick={() => del.mutate(s.id, { onSuccess: onDone })}
              >
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onDone}>
              Close
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>

      <section>
        <h3 className="mb-2 text-sm font-semibold">
          History{" "}
          <span className="font-normal text-slate-500">
            · {formatMoney(s.annualCents)} a year · since{" "}
            {fmtDay(s.firstDate, { month: "short", year: "numeric" })}
          </span>
        </h3>
        <ul className="max-h-64 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
          {history.data?.map((t) => (
            <li key={t.id} className="flex justify-between gap-3 px-3 py-1.5">
              <span className="truncate">
                <span className="text-slate-500">
                  {fmtDay(t.postedDate, { month: "short", day: "numeric", year: "numeric" })}
                </span>{" "}
                {t.accountName}
              </span>
              <Money cents={t.amountCents} />
            </li>
          ))}
          {history.data?.length === 0 && (
            <li className="px-3 py-2 text-slate-500">No linked transactions.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Upcoming() {
  const today = todayIso();
  const in30 = iso(new Date(Date.now() + 30 * 86_400_000));
  const next = useUpcoming(today, in30);
  const out30 = (next.data ?? [])
    .filter((u) => u.amountCents < 0)
    .reduce((s, u) => s + u.amountCents, 0);
  const in30sum = (next.data ?? [])
    .filter((u) => u.amountCents > 0)
    .reduce((s, u) => s + u.amountCents, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <UpcomingCalendar />
      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="font-medium">Next 30 days</p>
          <p className="text-xs text-slate-500">
            {formatMoney(out30)} going out{in30sum > 0 && ` · ${formatMoney(in30sum)} coming in`}
          </p>
        </div>
        <ul className="max-h-[32rem] divide-y divide-slate-100 overflow-auto text-sm dark:divide-slate-800">
          {next.data?.map((u) => (
            <li
              key={`${u.seriesId}-${u.date}-${u.pending ? "p" : ""}`}
              className="flex justify-between gap-3 px-4 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {u.name}
                  {u.pending && (
                    <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-300">
                      Pending
                    </span>
                  )}
                </span>
                <span className="text-xs text-slate-500">
                  {u.date === today
                    ? "Today"
                    : fmtDay(u.date, { weekday: "short", month: "short", day: "numeric" })}
                  {u.accountName && ` · ${u.accountName}`}
                </span>
              </span>
              <Money cents={u.amountCents} />
            </li>
          ))}
          {next.data?.length === 0 && (
            <li className="px-4 py-3 text-slate-500">Nothing expected.</li>
          )}
        </ul>
      </Card>
    </div>
  );
}

export function RecurringPage() {
  const recurring = useRecurring();
  const rescan = useRescanRecurring();
  const [tab, setTab] = useState<"list" | "upcoming" | "trials">(() =>
    window.location.hash === "#trials" ? "trials" : "list",
  );
  // "#review" (from the Overview to-do) shows only new charges to confirm.
  const [reviewOnly, setReviewOnly] = useState(() => window.location.hash === "#review");
  useEffect(() => {
    const on = () => {
      if (window.location.hash === "#review") {
        setReviewOnly(true);
        setTab("list");
      } else if (window.location.hash === "#trials") setTab("trials");
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [open, setOpen] = useState<RecurringSeries | null>(null);
  const all = recurring.data ?? [];

  const tracked = all.filter((s) => s.status !== "ignored");
  const live = tracked.filter((s) => s.active && s.status !== "cancelled");
  const shown = reviewOnly ? live.filter((s) => s.status === "detected") : live;
  const subs = shown.filter((s) => s.kind === "subscription");
  const bills = shown.filter((s) => s.kind === "bill");
  const income = shown.filter((s) => s.kind === "income");
  const inactive = tracked.filter((s) => !live.includes(s));
  const ignored = all.filter((s) => s.status === "ignored");
  const sum = (xs: RecurringSeries[]) => xs.reduce((a, s) => a + s.monthlyCents, 0);
  const sortByNext = (xs: RecurringSeries[]) =>
    [...xs].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  const newCount = live.filter((s) => s.status === "detected").length;

  return (
    <>
      <PageHeader
        title="Recurring"
        actions={
          <Button variant="secondary" disabled={rescan.isPending} onClick={() => rescan.mutate()}>
            {rescan.isPending ? "Scanning…" : "Rescan"}
          </Button>
        }
      />
      {recurring.isError && <Alert>Couldn't load recurring charges.</Alert>}

      {recurring.isSuccess && all.length === 0 && (
        <Card className="text-center text-sm text-slate-500">
          Nothing recurring found yet. Muny looks for charges that repeat on a schedule once there's
          a few months of history; import or sync more and it'll fill in.
        </Card>
      )}

      {all.length > 0 && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Subscriptions"
              cents={sum(subs)}
              hint={`${subs.length} active · per month`}
            />
            <Stat label="Bills" cents={sum(bills)} hint={`${bills.length} active · per month`} />
            <Stat
              label="Yearly total"
              cents={(sum(subs) + sum(bills)) * 12}
              hint="subscriptions + bills"
            />
            <Stat label="Recurring income" cents={sum(income)} hint="per month" />
          </div>

          <div
            role="tablist"
            className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800"
          >
            {(
              [
                ["list", `Subscriptions & bills${newCount ? ` (${newCount} new)` : ""}`],
                ["upcoming", "Upcoming"],
                ["trials", "Free trials"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cx(
                  "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                  tab === k
                    ? "border-brand-600 text-brand-700 dark:text-brand-500"
                    : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "list" && reviewOnly && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-500/40 bg-brand-50 px-4 py-3 text-sm dark:bg-brand-700/15">
              <span>
                {newCount > 0 ? (
                  <>
                    Showing the <span className="font-semibold">{newCount}</span> new recurring
                    charge{newCount === 1 ? "" : "s"} Muny found. Choose{" "}
                    <span className="font-medium">Confirm</span> or{" "}
                    <span className="font-medium">Not recurring</span> on each.
                  </>
                ) : (
                  "All caught up: nothing new to review."
                )}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  setReviewOnly(false);
                  window.history.replaceState(null, "", window.location.pathname);
                }}
              >
                Show everything
              </Button>
            </div>
          )}
          {tab === "list" && !reviewOnly && <MonthSummary series={live} />}
          {tab === "list" ? (
            <div className="space-y-6 min-[112rem]:grid min-[112rem]:grid-cols-2 min-[112rem]:items-start min-[112rem]:gap-6 min-[112rem]:space-y-0">
              <Section
                title="Subscriptions"
                items={sortByNext(subs)}
                total={sum(subs)}
                onOpen={setOpen}
              />
              <Section
                title="Bills"
                items={sortByNext(bills)}
                total={sum(bills)}
                onOpen={setOpen}
              />
              <Section
                title="Income"
                items={sortByNext(income)}
                total={sum(income)}
                onOpen={setOpen}
              />
              <Section title="Inactive or cancelled" items={inactive} onOpen={setOpen} collapsed />
              <Section title="Not recurring" items={ignored} onOpen={setOpen} collapsed />
            </div>
          ) : tab === "upcoming" ? (
            <Upcoming />
          ) : (
            <TrialsTab />
          )}
        </>
      )}

      <Modal open={open !== null} onClose={() => setOpen(null)} title={open?.name ?? ""}>
        {open && <SeriesDetail key={open.id} s={open} onDone={() => setOpen(null)} />}
      </Modal>
    </>
  );
}
