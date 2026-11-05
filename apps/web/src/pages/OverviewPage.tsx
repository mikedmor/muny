import {
  type Account,
  type AccountType,
  formatMoney,
  type Overview,
  type TransactionPage,
} from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ColumnChart, LineChart, PaceChart, RankedBars } from "../components/charts.js";
import { Alert, Card, cx, PageHeader } from "../components/ui.js";
import { CategoryIcon, MerchantAvatar } from "../components/visuals.js";
import { api } from "../lib/api.js";
import { keys, useAccounts, useConnections } from "../lib/queries.js";

/**
 * The home dashboard, modeled on Rocket Money's: how this month's spending is
 * pacing against last month, what's in your accounts (cash first, debts kept
 * to their own rows rather than folded into one net-worth number), what's due,
 * how the budget is going, and what just happened.
 */

const monthName = (iso: string) =>
  new Date(`${iso.slice(0, 7)}-15T00:00:00`).toLocaleDateString(undefined, { month: "long" });
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const weekday = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

function addDaysIso(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, n: number) {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 15));
  return d.toISOString().slice(0, 10);
}

function syncedAgo(ms: number) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 2) return "Synced just now";
  if (min < 60) return `Synced ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `Synced ${h} h ago`;
  return `Synced ${Math.round(h / 24)} days ago`;
}

function SectionHeader({ title, link }: { title: string; link?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="font-semibold">{title}</h2>
      {link && <span className="text-sm text-brand-600 hover:underline">{link}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spending this month
// ---------------------------------------------------------------------------

function SpendingCard({ d }: { d: Overview }) {
  const s = d.spending;
  const diff = s.monthToDateCents - s.lastMonthSameDayCents;
  const thisName = monthName(d.today);
  const lastName = monthName(addMonthsIso(d.today, -1));
  return (
    <Card>
      <p className="text-sm font-medium text-slate-500">Spent this month</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">
        {formatMoney(s.monthToDateCents)}
      </p>
      <p className="mt-1 text-sm">
        {diff === 0 ? (
          <span className="text-slate-500">The same as this point in {lastName}</span>
        ) : (
          <span
            className={
              diff < 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
            }
          >
            {diff > 0 ? "▲" : "▼"} {formatMoney(Math.abs(diff))} {diff > 0 ? "more" : "less"} than
            this point in {lastName}
          </span>
        )}
      </p>
      <div className="mt-4">
        <PaceChart
          current={s.thisMonthDaily}
          previous={s.lastMonthDaily}
          days={s.daysInMonth}
          currentLabel={thisName}
          previousLabel={lastName}
          dayLabel={(day) => `Day ${day}`}
          ariaLabel={`Running spending total: ${thisName} so far compared with ${lastName}`}
        />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
        <div>
          <dt className="text-slate-500">Earned this month</dt>
          <dd className="font-medium tabular-nums">{formatMoney(d.incomeMonthToDateCents)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Spent in {lastName}</dt>
          <dd className="font-medium tabular-nums">{formatMoney(s.lastMonthTotalCents)}</dd>
        </div>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Accounts, grouped like Rocket Money: checking, cards, net cash, savings...
// ---------------------------------------------------------------------------

const GROUPS: { key: string; label: string; types: AccountType[]; debt?: boolean }[] = [
  { key: "checking", label: "Checking", types: ["checking", "cash"] },
  { key: "credit", label: "Credit cards", types: ["credit"], debt: true },
  { key: "savings", label: "Savings", types: ["savings"] },
  { key: "investment", label: "Investments", types: ["investment"] },
  { key: "loan", label: "Loans", types: ["loan"], debt: true },
  { key: "other", label: "Property & other", types: ["asset", "other"] },
];

function AccountGroupRow({
  label,
  accounts,
  debt,
}: {
  label: string;
  accounts: Account[];
  debt?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const total = accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  // Debts are shown as the positive amount owed, the way banks show them.
  const shown = debt ? -total : total;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cx("text-xs text-slate-400 transition-transform", open && "rotate-90")}
          >
            ▶
          </span>
          <span className="truncate font-medium">{label}</span>
          <span className="text-xs text-slate-500">{accounts.length}</span>
        </span>
        <span className="text-right tabular-nums">
          {formatMoney(shown)}
          {debt && <span className="ml-1 text-xs text-slate-500">owed</span>}
        </span>
      </button>
      {open && (
        <ul className="bg-slate-50/60 pb-1 text-sm dark:bg-slate-800/30">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-1.5 pl-10 pr-4">
              <span className="min-w-0">
                <span className="block truncate">{a.name}</span>
                <span className="text-xs text-slate-500">
                  {[a.institutionName, a.mask && `••${a.mask}`].filter(Boolean).join(" · ") ||
                    "Manual"}
                </span>
              </span>
              <span className="tabular-nums">
                {formatMoney(debt ? -a.balanceCents : a.balanceCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function AccountsCard() {
  const accounts = useAccounts();
  const connections = useConnections();
  const visible = (accounts.data ?? []).filter((a) => !a.hidden);
  const sum = (types: AccountType[]) =>
    visible.filter((a) => types.includes(a.type)).reduce((s, a) => s + a.balanceCents, 0);
  const checking = sum(["checking", "cash"]);
  const savings = sum(["savings"]);
  const cards = sum(["credit"]);
  const hasCards = visible.some((a) => a.type === "credit");
  const lastSync = Math.max(0, ...(connections.data ?? []).map((c) => c.lastSyncAt ?? 0));

  return (
    <Card className="p-0">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">Accounts</h2>
          <Link to="/accounts" className="text-sm text-brand-600 hover:underline">
            Manage
          </Link>
        </div>
        <p className="mt-2 text-sm text-slate-500">Cash in checking &amp; savings</p>
        <p className="text-4xl font-semibold tracking-tight tabular-nums">
          {formatMoney(checking + savings)}
        </p>
        {lastSync > 0 && <p className="mt-1 text-xs text-slate-500">{syncedAgo(lastSync)}</p>}
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        {GROUPS.flatMap((g) => {
          const list = visible.filter((a) => g.types.includes(a.type));
          if (list.length === 0) return [];
          const row = <AccountGroupRow key={g.key} label={g.label} accounts={list} debt={g.debt} />;
          if (g.key !== "credit" || !hasCards) return [row];
          // Net cash sits right after credit cards, as in Rocket Money.
          return [
            row,
            <li key="net-cash" className="flex items-center justify-between gap-3 py-2.5 pr-4 pl-9">
              <span>
                <span className="font-medium">Net cash</span>
                <span className="block text-xs text-slate-500">Checking minus card balances</span>
              </span>
              <span className="tabular-nums">{formatMoney(checking + cards)}</span>
            </li>,
          ];
        })}
      </ul>
      <div className="border-t border-slate-200 px-4 py-2 text-right text-sm dark:border-slate-800">
        <Link to="/reports" hash="net-worth" className="text-slate-500 hover:underline">
          Net worth &amp; trends
        </Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Budget, upcoming, recent, categories
// ---------------------------------------------------------------------------

function BudgetCard({ d }: { d: Overview }) {
  if (!d.budget) {
    return (
      <Card>
        <SectionHeader title="Budget" />
        <p className="text-sm text-slate-500">
          You spent {formatMoney(d.spending.lastMonthTotalCents)} last month.{" "}
          <Link to="/budgets" className="text-brand-600 underline">
            Set a budget
          </Link>{" "}
          to see what's left to spend.
        </p>
      </Card>
    );
  }
  const budget = d.budget.budgetCents ?? 0;
  const spent = d.budget.spentCents;
  const left = budget - spent;
  const day = Number(d.today.slice(8));
  const pace = Math.round((budget * day) / d.spending.daysInMonth);
  const pct = (v: number) => Math.min(100, (v / Math.max(1, budget)) * 100);
  const over = spent > budget;
  return (
    <Card>
      <SectionHeader title="Budget" link={<Link to="/budgets">Details</Link>} />
      <p className="text-sm text-slate-500">{over ? "Over budget by" : "Left to spend"}</p>
      <p className="text-2xl font-semibold tabular-nums">{formatMoney(Math.abs(left))}</p>
      <div className="relative mt-3 h-2.5 rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className={cx("h-full rounded-full", over ? "bg-red-500" : "bg-emerald-500")}
          style={{ width: `${pct(spent)}%` }}
        />
        {/* Where spending "should" be today if spread evenly over the month. */}
        <div
          aria-hidden="true"
          className="absolute -top-1 h-4.5 w-0.5 rounded bg-slate-500 dark:bg-slate-300"
          style={{ left: `calc(${pct(pace)}% - 1px)` }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {formatMoney(spent)} of {formatMoney(budget)} ·{" "}
        {spent <= pace
          ? `${formatMoney(pace - spent)} under today's pace`
          : `${formatMoney(spent - pace)} over today's pace`}
      </p>
    </Card>
  );
}

function UpcomingCard({ d }: { d: Overview }) {
  const total = d.upcoming.reduce((s, u) => s - u.amountCents, 0);
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <SectionHeader title="Coming up" link={<Link to="/recurring">All recurring</Link>} />
        {d.upcoming.length > 0 && (
          <p className="-mt-2 mb-2 text-xs text-slate-500">
            {formatMoney(total)} due in the next 7 days
          </p>
        )}
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        {d.upcoming.map((u) => (
          <li key={`${u.seriesId}-${u.date}`} className="flex items-center gap-3 px-4 py-2">
            <MerchantAvatar name={u.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{u.name}</span>
              <span className="text-xs text-slate-500">
                {u.date === d.today ? "Today" : weekday(u.date)}
              </span>
            </span>
            <span className="tabular-nums">{formatMoney(-u.amountCents)}</span>
          </li>
        ))}
        {d.upcoming.length === 0 && (
          <li className="px-4 py-3 text-slate-500">Nothing due in the next 7 days.</li>
        )}
      </ul>
    </Card>
  );
}

function RecentTransactions({ limit }: { limit: number }) {
  const recent = useQuery({
    queryKey: [...keys.transactions, "recent", limit],
    queryFn: () => api.get<TransactionPage>(`/api/transactions?limit=${limit}&offset=0`),
  });
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <SectionHeader title="Recent transactions" link={<Link to="/transactions">See all</Link>} />
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        {recent.data?.items.map((t) => {
          const name = t.payeeName ?? t.description;
          const category = t.transferPairId
            ? "Transfer"
            : (t.categoryName ?? (t.splits.length ? "Split" : "Uncategorized"));
          return (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
              <MerchantAvatar name={name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{name}</span>
                <span className="flex items-center gap-1 truncate text-xs text-slate-500">
                  <CategoryIcon
                    name={t.transferPairId ? "Transfer" : t.categoryName}
                    group={t.categoryGroupName}
                    className="w-4"
                  />
                  <span className="truncate">
                    {category} · {shortDate(t.postedDate)}
                    {t.pending && " · Pending"}
                  </span>
                </span>
              </span>
              <span
                className={cx(
                  "shrink-0 font-medium tabular-nums",
                  t.amountCents > 0 && "text-emerald-700 dark:text-emerald-400",
                )}
              >
                {t.amountCents > 0 ? "+" : ""}
                {formatMoney(Math.abs(t.amountCents))}
              </span>
            </li>
          );
        })}
        {recent.data?.items.length === 0 && (
          <li className="px-4 py-3 text-slate-500">No transactions yet.</li>
        )}
      </ul>
    </Card>
  );
}

function CategoriesCard({ d }: { d: Overview }) {
  return (
    <Card>
      <SectionHeader
        title="Where your money went this month"
        link={<Link to="/reports">Reports</Link>}
      />
      <RankedBars
        total={d.spending.monthToDateCents}
        items={d.topCategories.map((c) => ({
          key: c.id ?? "uncategorized",
          label: c.name,
          icon: <CategoryIcon name={c.id ? c.name : null} group={c.groupName} />,
          cents: c.cents,
        }))}
      />
    </Card>
  );
}

function TopMerchantsCard({ d }: { d: Overview }) {
  const max = Math.max(1, ...d.topMerchants.map((m) => m.cents));
  return (
    <Card className="p-0">
      <div className="px-4 pt-4">
        <SectionHeader
          title="Top merchants this month"
          link={
            <Link to="/reports" hash="spending">
              More
            </Link>
          }
        />
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
        {d.topMerchants.map((m, i) => (
          <li key={m.name} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-4 text-right text-xs text-slate-400 tabular-nums">{i + 1}</span>
            <MerchantAvatar name={m.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{m.name}</span>
              <span className="mt-1 block h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(2, (m.cents / max) * 100)}%`,
                    background: "var(--viz-series-1)",
                  }}
                />
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-medium tabular-nums">{formatMoney(m.cents)}</span>
              <span className="block text-xs text-slate-500">
                {m.count} {m.count === 1 ? "charge" : "charges"}
              </span>
            </span>
          </li>
        ))}
        {d.topMerchants.length === 0 && (
          <li className="px-4 py-3 text-slate-500">No spending yet this month.</li>
        )}
      </ul>
    </Card>
  );
}

const shortMonth = (ym: string) =>
  new Date(`${ym}-15T00:00:00`).toLocaleDateString(undefined, { month: "short" });

function CashFlowCard({ d }: { d: Overview }) {
  const months = d.cashFlow;
  const full = months.slice(0, -1);
  const avgNet = full.length
    ? Math.round(full.reduce((s, m) => s + m.incomeCents - m.spendingCents, 0) / full.length)
    : 0;
  return (
    <Card>
      <SectionHeader
        title="Income vs. spending"
        link={
          <Link to="/reports" hash="cash-flow">
            Cash flow
          </Link>
        }
      />
      {full.length > 0 && (
        <p className="-mt-1 mb-3 text-sm text-slate-500">
          Over the last {full.length} full months you {avgNet >= 0 ? "kept" : "overspent by"}{" "}
          <span
            className={cx(
              "font-medium",
              avgNet >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
            )}
          >
            {formatMoney(Math.abs(avgNet))}
          </span>{" "}
          a month on average.
        </p>
      )}
      <ColumnChart
        ariaLabel="Income and spending for the last six months"
        seriesNames={["Income", "Spending"]}
        data={months.map((m, i) => ({
          key: m.month,
          label: shortMonth(m.month),
          title: i === months.length - 1 ? `${shortMonth(m.month)} (so far)` : shortMonth(m.month),
          values: [m.incomeCents, m.spendingCents],
        }))}
      />
    </Card>
  );
}

function CashTrendCard({ d }: { d: Overview }) {
  const pts = d.cashTrend;
  const diff = (pts[pts.length - 1]?.cents ?? 0) - (pts[0]?.cents ?? 0);
  return (
    <Card>
      <SectionHeader
        title="Cash over time"
        link={
          <Link to="/reports" hash="net-worth">
            Net worth
          </Link>
        }
      />
      <p className="-mt-1 mb-3 text-sm text-slate-500">
        Checking &amp; savings{" "}
        <span
          className={cx(
            "font-medium",
            diff >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
          )}
        >
          {diff >= 0 ? "up" : "down"} {formatMoney(Math.abs(diff))}
        </span>{" "}
        over 6 months
      </p>
      <LineChart
        ariaLabel="Cash in checking and savings, weekly over the last six months"
        height={160}
        points={pts.map((p) => ({ date: p.date, label: shortDate(p.date), value: p.cents }))}
      />
    </Card>
  );
}

function AttentionBar({ d }: { d: Overview }) {
  const items = [
    d.attention.connectionsNeedingLogin > 0 && (
      <Link key="c" to="/accounts" className="underline">
        {d.attention.connectionsNeedingLogin} bank connection
        {d.attention.connectionsNeedingLogin === 1 ? " needs" : "s need"} attention
      </Link>
    ),
    d.attention.uncategorized > 0 && (
      <Link
        key="u"
        to="/transactions"
        search={{ categoryId: "uncategorized", from: addDaysIso(d.today, -90) }}
        className="underline"
      >
        {d.attention.uncategorized} uncategorized transaction
        {d.attention.uncategorized === 1 ? "" : "s"}
      </Link>
    ),
    d.attention.newRecurring > 0 && (
      <Link key="r" to="/recurring" hash="review" className="underline">
        {d.attention.newRecurring} new recurring charge
        {d.attention.newRecurring === 1 ? "" : "s"} to review
      </Link>
    ),
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="font-medium">To do:</span>
      {items}
    </div>
  );
}

// ---------------------------------------------------------------------------

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function OverviewPage() {
  const accounts = useAccounts();
  const o = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview") });
  const d = o.data;
  // In the wide layouts recent transactions get a full-height column of their own.
  const tall = useMediaQuery("(min-width: 112rem)");

  if (accounts.isSuccess && accounts.data.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <Card className="text-center">
          <p className="font-medium">Welcome to Muny</p>
          <p className="mt-1 text-sm text-slate-500">
            Start by{" "}
            <Link to="/import" className="text-brand-600 underline">
              importing your Rocket Money history
            </Link>{" "}
            or a bank file, or{" "}
            <Link to="/accounts" className="text-brand-600 underline">
              connect a bank
            </Link>
            .
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Overview" />
      {o.isError && <Alert>Couldn't load the overview.</Alert>}
      {d && (
        <div className="space-y-6">
          <AttentionBar d={d} />
          {/*
            Phones: one column; the cards interleave by `order` (the column
            wrappers are display:contents).
            Desktop (lg): charts stacked on the left, accounts on the right.
            Wide (112rem+): charts | recent transactions | accounts.
            Ultrawide (150rem+): four columns.
          */}
          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[auto_auto_1fr] lg:items-start lg:[grid-template-areas:'a_s'_'b_s'_'c_s'] min-[112rem]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_26rem] min-[112rem]:grid-rows-[auto_1fr] min-[112rem]:[grid-template-areas:'a_c_s'_'b_c_s'] min-[150rem]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)_26rem] min-[150rem]:grid-rows-1 min-[150rem]:[grid-template-areas:'a_b_c_s']">
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6 lg:[grid-area:a]">
              <div className="order-1 min-w-0 lg:order-0">
                <SpendingCard d={d} />
              </div>
              <div className="order-7 min-w-0 lg:order-0">
                <CashFlowCard d={d} />
              </div>
            </div>
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6 lg:[grid-area:b]">
              <div className="order-6 min-w-0 lg:order-0">
                <CategoriesCard d={d} />
              </div>
              <div className="order-8 min-w-0 lg:order-0">
                <TopMerchantsCard d={d} />
              </div>
              <div className="order-9 min-w-0 lg:order-0">
                <CashTrendCard d={d} />
              </div>
            </div>
            <div className="order-5 min-w-0 lg:order-0 lg:[grid-area:c]">
              <RecentTransactions limit={tall ? 20 : 8} />
            </div>
            <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6 lg:[grid-area:s]">
              <div className="order-2 min-w-0 lg:order-0">
                <AccountsCard />
              </div>
              <div className="order-3 min-w-0 lg:order-0">
                <BudgetCard d={d} />
              </div>
              <div className="order-4 min-w-0 lg:order-0">
                <UpcomingCard d={d} />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
