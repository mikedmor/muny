import {
  formatMoney,
  type OpportunityKind,
  type SavingsOpportunities,
  type SavingsOpportunity,
} from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Card, cx } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useInvalidatingMutation } from "../lib/queries.js";

/**
 * Savings → Ways to save: what Muny's rules found in your own data, biggest
 * yearly saving first. Nothing here calls a model; each one says how it was
 * worked out.
 */

const KEY = ["savings", "opportunities"];

const KIND: Record<OpportunityKind, { icon: string; label: string }> = {
  overlap: { icon: "🔁", label: "Doubled up" },
  charged_after_cancel: { icon: "🚫", label: "Charged after cancelling" },
  price_increase: { icon: "📈", label: "Price went up" },
  diy: { icon: "🛠️", label: "Self-host it" },
  card_interest: { icon: "💳", label: "Card interest" },
  debt_order: { icon: "🎯", label: "Loan payoff order" },
  idle_cash: { icon: "🏦", label: "Idle cash" },
};

const SURE: Record<SavingsOpportunity["confidence"], { label: string; className: string }> = {
  sure: { label: "Happening now", className: "text-red-600 dark:text-red-400" },
  likely: { label: "If you act", className: "text-slate-500" },
  guess: { label: "A rough guess", className: "text-amber-700 dark:text-amber-400" },
};

function Opportunity({
  o,
  hidden,
  onToggle,
}: {
  o: SavingsOpportunity;
  hidden?: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const k = KIND[o.kind];
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-lg dark:bg-slate-800"
        >
          {k.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className={cx("font-medium", hidden && "text-slate-500")}>{o.title}</h3>
            <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
              {formatMoney(o.yearlyCents)}/yr
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {k.label} ·{" "}
            <span className={SURE[o.confidence].className}>{SURE[o.confidence].label}</span>
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{o.detail}</p>
          {open && o.evidence.length > 0 && (
            <dl className="mt-2 grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
              {o.evidence.map((e) => (
                <div key={e.label} className="contents">
                  <dt className="text-slate-500">{e.label}</dt>
                  <dd className="text-right tabular-nums">{e.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-4 text-xs font-medium">
            {o.evidence.length > 0 && (
              <button
                type="button"
                onClick={() => setOpen((x) => !x)}
                aria-expanded={open}
                className="text-brand-600 hover:underline dark:text-brand-500"
              >
                {open ? "Hide the numbers" : "Show the numbers"}
              </button>
            )}
            {o.link && (
              <Link
                to={o.link.to}
                hash={o.link.hash}
                className="text-brand-600 hover:underline dark:text-brand-500"
              >
                Go there
              </Link>
            )}
            <button type="button" onClick={onToggle} className="text-slate-500 hover:underline">
              {hidden ? "Show again" : "Hide"}
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function OpportunitiesTab() {
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<SavingsOpportunities>("/api/savings/opportunities"),
  });
  const toggle = useInvalidatingMutation(
    (body: { id: string; dismissed: boolean }) =>
      api.post("/api/savings/opportunities/dismiss", body),
    [KEY],
  );
  const [showHidden, setShowHidden] = useState(false);
  const d = list.data;
  return (
    <div className="max-w-3xl space-y-4">
      {list.isError && <Alert>Couldn't work out ways to save.</Alert>}
      {d && (
        <Card>
          <p className="text-sm font-medium text-slate-500">You could save up to</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatMoney(d.totalYearlyCents)}
            <span className="text-base font-medium text-slate-500"> a year</span>
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Worked out from your own transactions, cards, loans and savings by fixed rules; no AI
            and nothing leaves Muny. Some overlap, so the total is the most it could be.
          </p>
        </Card>
      )}
      {d && (
        <Card className="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {d.items.map((o) => (
              <Opportunity
                key={o.id}
                o={o}
                onToggle={() => toggle.mutate({ id: o.id, dismissed: true })}
              />
            ))}
            {d.items.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-slate-500">
                Nothing right now. Muny checks again as new transactions arrive.
              </li>
            )}
          </ul>
        </Card>
      )}
      {d && d.dismissed.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowHidden((x) => !x)}
            aria-expanded={showHidden}
            className="text-sm text-slate-500 hover:underline"
          >
            {showHidden ? "Hide" : "Show"} {d.dismissed.length} you've hidden
          </button>
          {showHidden && (
            <Card className="mt-2 p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {d.dismissed.map((o) => (
                  <Opportunity
                    key={o.id}
                    o={o}
                    hidden
                    onToggle={() => toggle.mutate({ id: o.id, dismissed: false })}
                  />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
