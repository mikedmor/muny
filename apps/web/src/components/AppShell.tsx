import { type CurrentUser, SUPPORT_URL } from "@muny/shared";
import { Link, Outlet } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  Bell,
  Bitcoin,
  ChartCandlestick,
  ChartColumn,
  ChartPie,
  ChevronsUpDown,
  Code,
  CreditCard,
  FolderOpen,
  HandCoins,
  Heart,
  House,
  Import,
  Landmark,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Menu,
  MessageCircleQuestion,
  PiggyBank,
  Receipt,
  Repeat,
  Settings,
  Target,
  X,
} from "lucide-react";
import { useState } from "react";
import { useLogout, useMeta } from "../lib/auth.js";
import { useNotifications } from "../lib/queries.js";
import { ThemeProvider } from "../lib/theme.js";
import { useAiSettings } from "../pages/settings/AiSettings.js";
import { DemoBanner } from "./DemoNotice.js";
import { ThemeTryBar } from "./ThemeSettings.js";
import { UndoBar } from "./Undo.js";
import { UpdateNotice } from "./UpdateNotice.js";
import { cx } from "./ui.js";

/** The menu, in groups. Icons: Lucide (ISC license), drawn at one size and weight. */
const NAV: { label?: string; items: { to: string; label: string; icon: LucideIcon }[] }[] = [
  {
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard },
      { to: "/alerts", label: "Alerts", icon: Bell },
    ],
  },
  {
    label: "Money",
    items: [
      { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
      { to: "/recurring", label: "Recurring", icon: Repeat },
      { to: "/spending", label: "Spending", icon: ChartPie },
      { to: "/budgets", label: "Budgets", icon: Target },
      { to: "/loans", label: "Loans", icon: HandCoins },
      { to: "/cards", label: "Credit cards", icon: CreditCard },
    ],
  },
  {
    label: "Wealth",
    items: [
      { to: "/stocks", label: "Stocks", icon: ChartCandlestick },
      { to: "/crypto", label: "Crypto", icon: Bitcoin },
      { to: "/savings", label: "Savings", icon: PiggyBank },
      { to: "/assets", label: "Assets", icon: House },
    ],
  },
  {
    label: "Insights",
    items: [
      { to: "/ask", label: "Ask Muny", icon: MessageCircleQuestion },
      { to: "/reports", label: "Reports", icon: ChartColumn },
      { to: "/taxes", label: "Taxes", icon: Receipt },
      { to: "/documents", label: "Documents", icon: FolderOpen },
    ],
  },
];

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-auto rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-on-brand tabular-nums">
      {count > 99 ? "99+" : count}
      <span className="sr-only"> unread</span>
    </span>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const unread = useNotifications().data?.unread ?? 0;
  const ai = useAiSettings().data;
  const canAsk = !!ai?.enabled && ai.features.ask;
  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {NAV.map((group, g) => (
        <div key={group.label ?? `g${g}`} className="flex flex-col gap-0.5">
          {group.label && (
            <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {group.label}
            </p>
          )}
          {group.items
            .filter((item) => item.to !== "/ask" || canAsk)
            .map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                activeOptions={{ exact: item.to === "/" }}
                className="group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                activeProps={{
                  className:
                    "!bg-brand-50 !text-brand-700 dark:!bg-brand-700/20 dark:!text-brand-500",
                }}
              >
                <item.icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                {item.label}
                {item.to === "/alerts" && <UnreadBadge count={unread} />}
              </Link>
            ))}
        </div>
      ))}
    </nav>
  );
}

const initials = (user: CurrentUser) => {
  const name = (user.displayName ?? "").trim();
  const parts = name ? name.split(/\s+/) : [user.email.split("@")[0] ?? "?"];
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
};

/** The account card at the bottom of the menu: who's signed in, with a small menu. */
function UserBox({ user, onNavigate }: { user: CurrentUser; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const logout = useLogout();
  const meta = useMeta();
  return (
    <div className="relative border-t border-slate-200 pt-3 dark:border-slate-800">
      {open && (
        <>
          <button
            type="button"
            aria-label="Close the account menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 bottom-full left-0 z-20 mb-2 rounded-lg border border-slate-200 bg-surface p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            <Link
              to="/accounts"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Landmark aria-hidden="true" className="size-4" /> Accounts
            </Link>
            <Link
              to="/import"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Import aria-hidden="true" className="size-4" /> Import
            </Link>
            <Link
              to="/settings"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Settings aria-hidden="true" className="size-4" /> Settings
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={() => logout.mutate()}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-slate-100 dark:text-red-400 dark:hover:bg-slate-800"
            >
              <LogOut aria-hidden="true" className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-on-brand"
        >
          {initials(user)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {user.displayName ?? user.email}
          </span>
          {user.displayName && (
            <span className="block truncate text-xs text-slate-500">{user.email}</span>
          )}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
      </button>
      <p className="mt-2 flex items-center gap-1.5 px-2 text-[11px] text-slate-400 dark:text-slate-500">
        <span>Muny{meta.data ? ` v${meta.data.version}` : ""}</span>
        <span aria-hidden="true">·</span>
        <span>AGPL-3.0</span>
        {meta.data && (
          <>
            <span aria-hidden="true">·</span>
            <a
              href={meta.data.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-300"
            >
              <Code aria-hidden="true" className="size-3" /> Source
            </a>
          </>
        )}
      </p>
      <a
        href={SUPPORT_URL}
        target="_blank"
        rel="noreferrer"
        title="Muny is free and open source. A donation helps keep it going."
        className="mt-1 inline-flex items-center gap-1.5 px-2 text-[11px] text-slate-400 hover:text-pink-600 dark:text-slate-500 dark:hover:text-pink-400"
      >
        <Heart aria-hidden="true" className="size-3" /> Support development
      </a>
    </div>
  );
}

export function AppShell({ user }: { user: CurrentUser }) {
  return (
    <ThemeProvider>
      <ThemeTryBar />
      <Shell user={user} />
    </ThemeProvider>
  );
}

function Shell({ user }: { user: CurrentUser }) {
  const [open, setOpen] = useState(false);
  const unread = useNotifications().data?.unread ?? 0;

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 md:flex dark:bg-slate-950 dark:text-slate-100">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-slate-200 bg-surface p-4 md:sticky md:top-0 md:flex md:h-dvh dark:border-slate-800 dark:bg-slate-900">
        <div className="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Link to="/" className="mb-6 flex items-center gap-2 px-3">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="text-lg font-semibold">Muny</span>
          </Link>
          <NavLinks />
        </div>
        <UserBox user={user} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-surface px-4 py-3 md:hidden dark:border-slate-800 dark:bg-slate-900">
        <Link to="/" className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-lg font-semibold">Muny</span>
        </Link>
        <div className="flex items-center gap-1">
          <Link
            to="/alerts"
            onClick={() => setOpen(false)}
            aria-label={unread ? `Alerts, ${unread} unread` : "Alerts"}
            className="relative rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Bell aria-hidden="true" className="size-5" />
            {unread > 0 && (
              <span
                aria-hidden="true"
                className="absolute top-0 right-0 rounded-full bg-brand-600 px-1 text-[10px] font-semibold leading-4 text-on-brand"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Link>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {open ? (
              <X aria-hidden="true" className="size-5" />
            ) : (
              <Menu aria-hidden="true" className="size-5" />
            )}
          </button>
        </div>
      </header>
      <div
        className={cx(
          "fixed inset-x-0 top-[57px] bottom-0 z-10 flex flex-col justify-between overflow-y-auto bg-surface p-4 md:hidden dark:bg-slate-900",
          !open && "hidden",
        )}
      >
        <NavLinks onNavigate={() => setOpen(false)} />
        <UserBox user={user} onNavigate={() => setOpen(false)} />
      </div>

      <main className="mx-auto w-full min-w-0 max-w-[200rem] flex-1 px-4 py-6 md:px-8 md:py-8">
        {user.role === "viewer" && (
          <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            You have view-only access to this household.
          </p>
        )}
        <UpdateNotice />
        <DemoBanner />
        <Outlet />
        <UndoBar />
      </main>
    </div>
  );
}
