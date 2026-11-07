import type { Category, CategoryGroup } from "@muny/shared";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useCategories, useCreateCategory } from "../lib/queries.js";
import { cx } from "./ui.js";
import { CategoryIcon } from "./visuals.js";

/**
 * Category picker with type-to-filter (an ARIA combobox: a button that opens a
 * search box and a grouped listbox). Hidden categories are left out unless
 * currently selected. Value null/"" means uncategorized (or `emptyLabel`).
 *
 * Keyboard: Enter/Space/↓ or just start typing to open; ↑/↓ to move,
 * Enter to pick, Esc to close. Matches category or group names.
 *
 * A search that matches no category offers to create it ("+ Create …"):
 * choose its group, and it's made and picked in one go.
 */

/** The "+ Create …" option's value. */
const CREATE = "__create__";

interface Option {
  value: string;
  label: string;
  group: string | null;
}

/** Lowercase without accents, for forgiving matching. */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function CategorySelect({
  value,
  onChange,
  emptyLabel = "Uncategorized",
  extraOptions,
  className,
  disabled,
  "aria-label": ariaLabel,
  id,
  filter,
  hideEmpty = false,
  allowCreate = true,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  emptyLabel?: string;
  extraOptions?: { value: string; label: string }[];
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  id?: string;
  /** Only these categories are offered. */
  filter?: (c: Category, g: CategoryGroup) => boolean;
  /** Don't offer the empty choice (the button still shows `emptyLabel`). */
  hideEmpty?: boolean;
  /** Offer to create a category the search doesn't find. */
  allowCreate?: boolean;
}) {
  const categories = useCategories();
  const create = useCreateCategory();
  /** Making a new category: its name, and the group it goes in. */
  const [creating, setCreating] = useState<{ name: string; groupId: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  const options = useMemo<Option[]>(() => {
    const out: Option[] = hideEmpty ? [] : [{ value: "", label: emptyLabel, group: null }];
    for (const o of extraOptions ?? []) out.push({ value: o.value, label: o.label, group: null });
    for (const g of categories.data ?? [])
      for (const c of g.categories)
        if ((!c.hidden || c.id === value) && (!filter || filter(c, g)))
          out.push({ value: c.id, label: c.name, group: g.name });
    return out;
  }, [categories.data, emptyLabel, extraOptions, value, filter, hideEmpty]);

  const selected = options.find((o) => o.value === (value ?? "")) ?? {
    value: "",
    label: emptyLabel,
    group: null,
  };
  const filtered = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return options;
    const hits = options.filter(
      (o) => norm(o.label).includes(q) || (o.group !== null && norm(o.group).includes(q)),
    );
    // No category by exactly this name: offer to make it.
    const exists = (categories.data ?? []).some((g) =>
      g.categories.some((c) => norm(c.name) === q),
    );
    if (allowCreate && !exists)
      hits.push({ value: CREATE, label: `+ Create “${query.trim()}”`, group: null });
    return hits;
  }, [options, query, allowCreate, categories.data]);
  /** Where a new category goes by default: the current one's group, else the first spending group. */
  const defaultGroup = () => {
    const groups = categories.data ?? [];
    return (
      groups.find((g) => g.categories.some((c) => c.id === value))?.id ??
      groups.find((g) => g.kind === "expense")?.id ??
      groups[0]?.id ??
      ""
    );
  };
  const makeIt = async () => {
    if (!creating?.groupId || !creating.name.trim()) return;
    const made = (await create.mutateAsync({
      groupId: creating.groupId,
      name: creating.name.trim(),
    })) as { id: string };
    setCreating(null);
    close();
    onChange(made.id);
  };

  const place = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 300 && r.top > below;
    setPos({
      top: up ? r.top - 4 : r.bottom + 4,
      left: Math.min(r.left, window.innerWidth - Math.max(256, r.width) - 8),
      width: Math.max(256, r.width),
      up,
    });
  };

  const openWith = (initial = "") => {
    if (disabled) return;
    setQuery(initial);
    const idx = initial ? 0 : Math.max(0, options.indexOf(selected as Option));
    setActive(idx);
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    setCreating(null);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (o: Option | undefined) => {
    if (!o) return;
    if (o.value === CREATE) {
      setCreating({ name: query.trim(), groupId: defaultGroup() });
      return;
    }
    close();
    if (o.value !== (value ?? "")) onChange(o.value || null);
  };

  // Close on outside click, scroll or resize (the list is fixed-positioned).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  });

  // Keep the active option in view.
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openWith();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Start typing to search straight away.
      e.preventDefault();
      openWith(e.key);
    }
  };
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Making a category: Enter creates it.
      if (creating) void makeIt();
      else pick(filtered[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't close an enclosing dialog
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  let lastGroup: string | null | undefined;
  const items: ReactNode[] = [];
  filtered.forEach((o, i) => {
    if (o.group !== lastGroup && o.group !== null) {
      items.push(
        <div
          key={`g-${o.group}`}
          role="presentation"
          className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
        >
          {o.group}
        </div>,
      );
    }
    lastGroup = o.group;
    const isSel = o.value === (value ?? "");
    items.push(
      // Combobox pattern: focus stays in the search input, which announces the
      // active option via aria-activedescendant and handles ↑/↓/Enter; options
      // are intentionally not focusable and only take mouse clicks.
      // biome-ignore lint/a11y/useFocusableInteractive: see above
      // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the input
      <div
        key={o.value || "__empty"}
        id={`${uid}-opt-${i}`}
        data-index={i}
        role="option"
        aria-selected={isSel}
        onMouseEnter={() => setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(o)}
        className={cx(
          "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
          i === active && "bg-brand-50 dark:bg-brand-700/25",
          isSel && "font-semibold",
        )}
      >
        {o.group !== null ? (
          <CategoryIcon name={o.label} group={o.group} className="w-5" />
        ) : (
          <span aria-hidden="true" className="inline-block w-5" />
        )}
        <span className="truncate">{o.label}</span>
        {isSel && (
          <span aria-hidden="true" className="ml-auto text-brand-600">
            ✓
          </span>
        )}
      </div>,
    );
  });

  return (
    <>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openWith())}
        onKeyDown={onButtonKey}
        className={cx("flex items-center justify-between gap-1 text-left", className)}
      >
        <span className="truncate">{selected?.label}</span>
        <span aria-hidden="true" className="shrink-0 text-[10px] opacity-60">
          ▾
        </span>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          className="fixed z-50 flex max-h-80 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-900 shadow-xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          style={{
            left: pos.left,
            width: pos.width,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
        >
          <div className="border-b border-slate-200 p-2 dark:border-slate-700">
            <input
              // biome-ignore lint/a11y/noAutofocus: the user just opened the picker to search
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
              placeholder="Search categories…"
              aria-label="Search categories"
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${uid}-opt-${active}` : undefined}
              className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel ?? "Categories"}
            className="overflow-y-auto py-1"
          >
            {creating ? (
              <form
                className="space-y-2 px-3 py-2 text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void makeIt();
                }}
              >
                <p className="font-medium">New category “{creating.name}”</p>
                <label className="block">
                  <span className="text-xs text-slate-500">In the group</span>
                  <select
                    value={creating.groupId}
                    onChange={(e) => setCreating({ ...creating, groupId: e.target.value })}
                    className="mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                  >
                    {(categories.data ?? [])
                      .filter((g) => g.kind !== "transfer")
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                          {g.kind === "income" ? " (income)" : ""}
                        </option>
                      ))}
                  </select>
                </label>
                {create.error && <p className="text-xs text-red-600">{create.error.message}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreating(null)}
                    className="rounded-lg px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={create.isPending}
                    className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                  >
                    {create.isPending ? "Creating…" : "Create and use it"}
                  </button>
                </div>
              </form>
            ) : (
              items
            )}
            {!creating && filtered.length === 0 && (
              <div className="px-3 py-3 text-sm text-slate-500">No category matches “{query}”.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
