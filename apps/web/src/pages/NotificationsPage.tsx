import type { AppNotification } from "@muny/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { useMarkRead, useNotifications, useRunAlerts } from "../lib/queries.js";
import { AlertsSettings } from "./settings/AlertsSettings.js";

const ICON: Record<string, string> = {
  low_balance: "🪫",
  large_transaction: "💳",
  unusual_charge: "🧐",
  duplicate_charge: "👯",
  bill_due: "📅",
  price_increase: "📈",
  budget: "🎯",
  charged_after_cancel: "🚫",
  connection_error: "🔌",
  trial_ending: "⏳",
};

function when(ms: number) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Group by day for scanning. */
function dayKey(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const TABS = [
  ["alerts", "Alerts"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

export function NotificationsPage() {
  const n = useNotifications();
  const read = useMarkRead();
  const run = useRunAlerts();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() =>
    window.location.hash === "#settings" ? "settings" : "alerts",
  );
  const show = (k: Tab) => {
    setTab(k);
    window.history.replaceState(null, "", `#${k}`);
  };
  const items = n.data?.items ?? [];
  const groups = new Map<string, AppNotification[]>();
  for (const i of items)
    groups.set(dayKey(i.createdAt), [...(groups.get(dayKey(i.createdAt)) ?? []), i]);

  const open = (i: AppNotification) => {
    if (!i.readAt) read.mutate([i.id]);
    if (i.link) void navigate({ to: i.link });
  };

  return (
    <>
      <PageHeader
        title="Alerts"
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={run.isPending}
              onClick={() => run.mutate(undefined)}
            >
              {run.isPending ? "Checking…" : "Check now"}
            </Button>
            <Button
              variant="secondary"
              disabled={!n.data?.unread || read.isPending}
              onClick={() => read.mutate(undefined)}
            >
              Mark all read
            </Button>
          </div>
        }
      />
      <div
        role="tablist"
        className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => show(k)}
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
      {tab === "settings" ? (
        <AlertsSettings />
      ) : (
        <AlertList
          n={n}
          items={items}
          groups={groups}
          open={open}
          onSettings={() => show("settings")}
        />
      )}
    </>
  );
}

function AlertList({
  n,
  items,
  groups,
  open,
  onSettings,
}: {
  n: ReturnType<typeof useNotifications>;
  items: AppNotification[];
  groups: Map<string, AppNotification[]>;
  open: (i: AppNotification) => void;
  onSettings: () => void;
}) {
  return (
    <>
      <p className="-mt-3 mb-4 text-sm text-slate-500">
        Muny checks every 5 minutes.{" "}
        <button type="button" onClick={onSettings} className="text-brand-600 underline">
          Choose which alerts you get and where
        </button>
        . Alerts for an account (low balance, large charges) are set with the bell next to it on{" "}
        <Link to="/accounts" className="text-brand-600 underline">
          Accounts
        </Link>
        .
      </p>
      {n.isError && <Alert>{n.error.message}</Alert>}
      {n.data && items.length === 0 && (
        <Card className="text-center text-sm text-slate-500">
          Nothing yet. You'll see bills coming due, unusual charges, low balances and more here.
        </Card>
      )}
      <div className="max-w-4xl space-y-6">
        {[...groups].map(([day, list]) => (
          <section key={day}>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {day}
            </h2>
            <Card className="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => open(i)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      <span aria-hidden="true" className="mt-0.5 text-lg">
                        {ICON[i.ruleType] ?? "🔔"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cx(
                            "block text-sm",
                            i.readAt ? "text-slate-600 dark:text-slate-400" : "font-semibold",
                          )}
                        >
                          {i.title}
                          {i.severity === "warning" && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                              Check
                            </span>
                          )}
                        </span>
                        <span className="block text-sm text-slate-500">{i.body}</span>
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">
                        {!i.readAt && (
                          <span className="mr-1.5 inline-block size-2 rounded-full bg-brand-600" />
                        )}
                        <span className="sr-only">{i.readAt ? "" : "Unread. "}</span>
                        {when(i.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))}
      </div>
    </>
  );
}
