import type { CurrentUser } from "@muny/shared";
import { Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { useLogout, useMeta } from "../lib/auth.js";
import { cx } from "./ui.js";

const NAV = [
  { to: "/", label: "Overview", icon: "◎" },
  { to: "/transactions", label: "Transactions", icon: "≡" },
  { to: "/recurring", label: "Recurring", icon: "↻" },
  { to: "/budgets", label: "Budgets", icon: "◔" },
  { to: "/reports", label: "Reports", icon: "▤" },
  { to: "/accounts", label: "Accounts", icon: "▣" },
  { to: "/import", label: "Import", icon: "⇪" },
  { to: "/settings", label: "Settings", icon: "⚙" },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          activeOptions={{ exact: item.to === "/" }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          activeProps={{
            className: "!bg-brand-50 !text-brand-700 dark:!bg-brand-700/20 dark:!text-brand-500",
          }}
        >
          <span aria-hidden className="w-4 text-center">
            {item.icon}
          </span>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell({ user }: { user: CurrentUser }) {
  const [open, setOpen] = useState(false);
  const logout = useLogout();
  const meta = useMeta();

  const userBox = (
    <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
      <p className="truncate px-3 text-sm font-medium">{user.displayName ?? user.email}</p>
      {user.displayName && <p className="truncate px-3 text-xs text-slate-500">{user.email}</p>}
      <button
        type="button"
        onClick={() => logout.mutate()}
        className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
      >
        Sign out
      </button>
      <p className="mt-2 px-3 text-[11px] text-slate-400">
        Muny {meta.data ? `v${meta.data.version}` : ""} · AGPL-3.0 ·{" "}
        {meta.data && (
          <a href={meta.data.sourceUrl} target="_blank" rel="noreferrer" className="underline">
            Source
          </a>
        )}
      </p>
    </div>
  );

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 md:flex dark:bg-slate-950 dark:text-slate-100">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-slate-200 bg-white p-4 md:sticky md:top-0 md:flex md:h-dvh dark:border-slate-800 dark:bg-slate-900">
        <div>
          <Link to="/" className="mb-6 flex items-center gap-2 px-3">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="text-lg font-semibold">Muny</span>
          </Link>
          <NavLinks />
        </div>
        {userBox}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden dark:border-slate-800 dark:bg-slate-900">
        <Link to="/" className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-lg font-semibold">Muny</span>
        </Link>
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="rounded-lg px-3 py-1 text-xl hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {open ? "✕" : "☰"}
        </button>
      </header>
      <div
        className={cx(
          "fixed inset-x-0 top-[57px] bottom-0 z-10 flex flex-col justify-between bg-white p-4 md:hidden dark:bg-slate-900",
          !open && "hidden",
        )}
      >
        <NavLinks onNavigate={() => setOpen(false)} />
        {userBox}
      </div>

      <main className="mx-auto w-full min-w-0 max-w-[150rem] flex-1 px-4 py-6 md:px-8 md:py-8">
        {user.role === "viewer" && (
          <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            You have view-only access to this household.
          </p>
        )}
        <Outlet />
      </main>
    </div>
  );
}
