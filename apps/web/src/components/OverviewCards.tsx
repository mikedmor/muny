import { type CardsReport, formatMoney, type LoansReport } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api.js";
import { keys, useInvestSummary } from "../lib/queries.js";
import { Card, cx } from "./ui.js";

/** Overview summaries for Stocks, Loans and Credit cards (shown only when there's something to show). */

const day = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Header({ title, to, label }: { title: string; to: string; label: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h2 className="font-semibold">{title}</h2>
      <Link to={to} className="text-sm text-brand-600 hover:underline">
        {label} →
      </Link>
    </div>
  );
}

export function StocksOverviewCard() {
  const s = useInvestSummary();
  const d = s.data;
  if (!d || d.accounts.length === 0) return null;
  const top = [...d.positions].sort((a, b) => b.valueCents - a.valueCents).slice(0, 4);
  const gainPct = d.costBasisCents > 0 ? (d.gainCents / d.costBasisCents) * 100 : null;
  return (
    <Card className="space-y-3">
      <Header title="Stocks" to="/stocks" label="Open Stocks" />
      <div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(d.valueCents)}</p>
        {d.costBasisCents > 0 && (
          <p
            className={cx(
              "text-sm tabular-nums",
              d.gainCents >= 0 ? "text-emerald-600" : "text-red-600",
            )}
          >
            {d.gainCents >= 0 ? "▲" : "▼"} {formatMoney(Math.abs(d.gainCents))}
            {gainPct !== null && ` (${Math.abs(gainPct).toFixed(1)}%)`} overall
          </p>
        )}
      </div>
      <ul className="space-y-1.5 text-sm">
        {top.map((p) => (
          <li key={p.securityId} className="flex items-center gap-2">
            <span className="w-14 font-medium">{p.symbol}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{p.name}</span>
            <span className="tabular-nums">{formatMoney(p.valueCents)}</span>
          </li>
        ))}
      </ul>
      {d.incomeLast12Cents > 0 && (
        <p className="text-xs text-slate-500">
          Dividends and interest, last 12 months: {formatMoney(d.incomeLast12Cents)}
        </p>
      )}
    </Card>
  );
}

export function LoansOverviewCard() {
  const q = useQuery({
    queryKey: [...keys.accounts, "loans"],
    queryFn: () => api.get<LoansReport>("/api/loans"),
  });
  const r = q.data;
  if (!r || r.loans.length === 0) return null;
  // By lender (several loans from one lender together).
  const byLender = new Map<string, { name: string; owed: number; count: number }>();
  for (const l of r.loans) {
    const k = (l.lender ?? l.name).trim().toLowerCase();
    const cur = byLender.get(k) ?? { name: l.lender ?? l.name, owed: 0, count: 0 };
    byLender.set(k, { ...cur, owed: cur.owed + l.balanceCents, count: cur.count + 1 });
  }
  const rows = [...byLender.values()].sort((a, b) => b.owed - a.owed);
  const interest = r.loans.reduce((s, l) => s + (l.interestThisYearCents ?? 0), 0);
  return (
    <Card className="space-y-3">
      <Header title="Loans" to="/loans" label="Open Loans" />
      <div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(r.totalOwedCents)}</p>
        <p className="text-sm text-slate-500">
          {formatMoney(r.monthlyPaymentsCents)} a month
          {r.nextDue && (
            <>
              {" "}
              · next {day(r.nextDue.date)} ({r.nextDue.name})
            </>
          )}
        </p>
      </div>
      <ul className="space-y-1.5 text-sm">
        {rows.slice(0, 5).map((x) => (
          <li key={x.name} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{x.name}</span>
            {x.count > 1 && <span className="text-xs text-slate-500">{x.count} loans</span>}
            <span className="tabular-nums">{formatMoney(x.owed)}</span>
          </li>
        ))}
      </ul>
      {interest > 0 && (
        <p className="text-xs text-slate-500">Interest this year: {formatMoney(interest)}</p>
      )}
    </Card>
  );
}

export function CardsOverviewCard() {
  const q = useQuery({
    queryKey: [...keys.accounts, "cards"],
    queryFn: () => api.get<CardsReport>("/api/cards"),
  });
  const r = q.data;
  if (!r || r.cards.length === 0) return null;
  const u = r.utilizationPct;
  return (
    <Card className="space-y-3">
      <Header title="Credit cards" to="/cards" label="Open Credit cards" />
      <div>
        <p className="text-2xl font-semibold tabular-nums">{formatMoney(r.totalOwedCents)}</p>
        <p className="text-sm text-slate-500">
          {u !== null && `${u.toFixed(0)}% of limits used`}
          {u !== null && r.nextDue && " · "}
          {r.nextDue && (
            <>
              next due {day(r.nextDue.date)}
              {r.nextDue.amountCents ? ` (${formatMoney(r.nextDue.amountCents)} min)` : ""}
            </>
          )}
        </p>
      </div>
      <ul className="space-y-1.5 text-sm">
        {r.cards.slice(0, 5).map((c) => (
          <li key={c.accountId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">
              {c.name}
              {c.mask && <span className="ml-1 text-xs text-slate-500">••{c.mask}</span>}
            </span>
            {c.dueDate && <span className="text-xs text-slate-500">due {day(c.dueDate)}</span>}
            <span className="tabular-nums">{formatMoney(c.balanceCents)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
