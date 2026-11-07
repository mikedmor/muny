import { BUILTIN_THEMES, findTheme, SYSTEM_THEME, type Theme } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useDeleteTheme, useSelectTheme, useThemePreview, useThemeState } from "../lib/theme.js";
import { ThemeThumbnail } from "./ThemeSample.js";
import { Alert, Button, buttonClass, cx } from "./ui.js";

/** Settings → Appearance: choose a theme, try one across the app, or make your own. */
export function ThemeSettings() {
  const state = useThemeState();
  const select = useSelectTheme();
  const del = useDeleteTheme();
  const { tryTheme, trying } = useThemePreview();
  const selected = state.data?.selected ?? SYSTEM_THEME;
  const custom = state.data?.custom ?? [];
  const error = select.error ?? del.error;

  const use = (id: string) => select.mutate(id, { onSuccess: () => tryTheme(null) });

  const tile = (t: Theme, own: boolean) => {
    const isSelected = selected === t.id;
    const isTrying = trying?.id === t.id;
    return (
      <li
        key={t.id}
        className={cx(
          "overflow-hidden rounded-xl border bg-surface shadow-sm dark:bg-slate-900",
          isSelected || isTrying
            ? "border-brand-600 ring-1 ring-brand-600"
            : "border-slate-200 dark:border-slate-800",
        )}
      >
        <ThemeThumbnail theme={t} />
        <div className="space-y-2 p-3">
          <p className="flex items-center justify-between gap-2 text-sm font-medium">
            <span className="truncate">{t.name}</span>
            {isSelected && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-brand-700 dark:text-brand-500">
                <Check aria-hidden="true" className="size-3.5" /> In use
              </span>
            )}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium">
            {!isSelected && (
              <button
                type="button"
                disabled={select.isPending}
                onClick={() => use(t.id)}
                className="text-brand-700 hover:underline dark:text-brand-500"
              >
                Use
              </button>
            )}
            {!isSelected && !isTrying && (
              <button
                type="button"
                onClick={() => tryTheme(t)}
                className="text-slate-600 hover:underline dark:text-slate-400"
              >
                Try it
              </button>
            )}
            {own ? (
              <Link
                to="/settings/themes/$themeId"
                params={{ themeId: t.id }}
                className="text-slate-600 hover:underline dark:text-slate-400"
              >
                Edit
              </Link>
            ) : (
              <Link
                to="/settings/themes/$themeId"
                params={{ themeId: "new" }}
                search={{ from: t.id }}
                className="text-slate-600 hover:underline dark:text-slate-400"
              >
                Customize a copy
              </Link>
            )}
            {own && (
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => {
                  if (
                    window.confirm(`Delete the theme "${t.name}" for everyone in this household?`)
                  )
                    del.mutate(t.id);
                }}
                className="text-red-600 hover:underline dark:text-red-400"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </li>
    );
  };

  const light = findTheme("light") as Theme;
  const dark = findTheme("dark") as Theme;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Theme</h2>
          <p className="text-sm text-slate-500">
            Your choice, on every device you sign in on. Try one to see the whole app in it before
            you decide. Charts and cards pick up the colors by themselves.
          </p>
        </div>
        <Link
          to="/settings/themes/$themeId"
          params={{ themeId: "new" }}
          className={buttonClass("secondary")}
        >
          New theme
        </Link>
      </div>
      {error && <Alert>{error.message}</Alert>}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
        <li
          className={cx(
            "overflow-hidden rounded-xl border bg-surface shadow-sm dark:bg-slate-900",
            selected === SYSTEM_THEME
              ? "border-brand-600 ring-1 ring-brand-600"
              : "border-slate-200 dark:border-slate-800",
          )}
        >
          <div className="grid h-24 grid-cols-2">
            <ThemeThumbnail theme={light} />
            <ThemeThumbnail theme={dark} />
          </div>
          <div className="space-y-2 p-3">
            <p className="flex items-center justify-between gap-2 text-sm font-medium">
              Match this device
              {selected === SYSTEM_THEME && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-brand-700 dark:text-brand-500">
                  <Check aria-hidden="true" className="size-3.5" /> In use
                </span>
              )}
            </p>
            {selected === SYSTEM_THEME ? (
              <p className="text-xs text-slate-500">Light or dark, following the device.</p>
            ) : (
              <button
                type="button"
                disabled={select.isPending}
                onClick={() => use(SYSTEM_THEME)}
                className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-500"
              >
                Use
              </button>
            )}
          </div>
        </li>
        {BUILTIN_THEMES.map((t) => tile(t, false))}
        {custom.map((t) => tile(t, true))}
      </ul>
    </section>
  );
}

/** Stays on screen while a theme is being tried, on any page. */
export function ThemeTryBar() {
  const { trying, tryTheme } = useThemePreview();
  const select = useSelectTheme();
  const state = useThemeState();
  if (!trying) return null;
  const saved = state.data?.custom.some((t) => t.id === trying.id) || findTheme(trying.id);
  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-600 bg-surface px-4 py-2 text-sm shadow-lg dark:bg-slate-900">
      <span>
        Trying <strong>{trying.name}</strong>. Nothing is saved yet; look around any page.
      </span>
      <span className="flex gap-2">
        {saved && (
          <Button
            className="py-1"
            disabled={select.isPending}
            onClick={() => select.mutate(trying.id, { onSuccess: () => tryTheme(null) })}
          >
            Use this theme
          </Button>
        )}
        <Button variant="secondary" className="py-1" onClick={() => tryTheme(null)}>
          Stop trying
        </Button>
      </span>
    </div>
  );
}
