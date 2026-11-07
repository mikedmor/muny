import {
  resolveTheme,
  SYSTEM_THEME,
  type Theme,
  type ThemeInput,
  type ThemeState,
  themeVariables,
} from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "./api.js";

/**
 * The current theme is a set of CSS variables on <html>. A preview sets the same
 * variables on its own panel, and everything inside follows.
 */

const CACHE_KEY = "muny.theme";
const themeKey = ["theme"] as const;

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply(el: HTMLElement, theme: Theme) {
  el.dataset.mode = theme.mode;
  for (const [name, value] of Object.entries(themeVariables(theme)))
    el.style.setProperty(name, value);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme.colors.background);
}

/** Before the first render, so a page never flashes in the wrong colors. */
export function applyCachedTheme() {
  let cached: Theme | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    if (saved?.selected !== SYSTEM_THEME) cached = saved?.theme ?? null;
  } catch {
    // Private windows and bad values: it just follows the device until the choice loads.
  }
  apply(document.documentElement, cached ?? resolveTheme(SYSTEM_THEME, [], darkQuery().matches));
}

function cacheTheme(selected: string, theme: Theme) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ selected, theme }));
  } catch {
    // Same as above.
  }
}

export const useThemeState = () =>
  useQuery({
    queryKey: themeKey,
    queryFn: () => api.get<ThemeState>("/api/theme"),
    staleTime: 5 * 60_000,
  });

export const useSelectTheme = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.put<ThemeState>("/api/theme/selected", { id }),
    onSuccess: (state) => qc.setQueryData(themeKey, state),
  });
};

export const useSaveTheme = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ThemeInput & { id?: string }) =>
      id ? api.put<Theme>(`/api/themes/${id}`, input) : api.post<Theme>("/api/themes", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: themeKey }),
  });
};

export const useDeleteTheme = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/themes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: themeKey }),
  });
};

interface ThemePreview {
  /** A theme being tried across the whole app, not saved. */
  trying: Theme | null;
  tryTheme: (theme: Theme | null) => void;
  /** What's showing now. */
  current: Theme;
}

const ThemeContext = createContext<ThemePreview | null>(null);

export function useThemePreview() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemePreview needs a ThemeProvider");
  return ctx;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const state = useThemeState();
  const [trying, tryTheme] = useState<Theme | null>(null);
  const [prefersDark, setPrefersDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const q = darkQuery();
    const on = () => setPrefersDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);

  const selected = state.data?.selected ?? SYSTEM_THEME;
  const saved = useMemo(
    () => resolveTheme(selected, state.data?.custom ?? [], prefersDark),
    [selected, state.data?.custom, prefersDark],
  );
  const current = trying ?? saved;

  useEffect(() => {
    apply(document.documentElement, current);
  }, [current]);

  useEffect(() => {
    if (state.data) cacheTheme(selected, saved);
  }, [state.data, selected, saved]);

  const value = useMemo(() => ({ trying, tryTheme, current }), [trying, current]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Shows what's inside it in a theme, whatever the rest of the page is using. */
export function ThemeScope({
  theme,
  className,
  children,
}: {
  theme: Theme;
  className?: string;
  children: ReactNode;
}) {
  const style = useMemo(() => themeVariables(theme) as CSSProperties, [theme]);
  return (
    <div data-mode={theme.mode} style={style} className={className}>
      {children}
    </div>
  );
}
