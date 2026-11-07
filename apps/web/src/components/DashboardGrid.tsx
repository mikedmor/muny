import {
  addCard,
  BUILTIN_CARDS,
  CARD_MAX_H,
  CARD_MIN_H,
  CARD_MIN_W,
  CUSTOM_PREFIX,
  type CustomCard,
  type DashboardItem,
  GRID_COLUMNS,
  GRID_ROW_PX,
  normalizeLayout,
  placeCard,
  removeCard,
} from "@muny/shared";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDashboard, useResetLayout, useSaveLayout } from "../lib/queries.js";
import { CustomCardDialog } from "./CustomCard.js";
import { Modal } from "./forms.js";
import { Alert, Button, cx, PageHeader } from "./ui.js";

/**
 * The Overview's 12-column grid. "Customize" lets you drag a card by its body,
 * resize it from the corner (or use the buttons, which also work by keyboard
 * and on a phone), add and remove cards. Nothing is saved until Done.
 * The rules for where cards end up live in @muny/shared.
 */

const GAP_PX = 24;

function useIsWide() {
  const query = "(min-width: 64rem)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

/** Reports its content's height, so a card can be as tall as what's in it. */
function Measured({ onHeight, children }: { onHeight: (px: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const report = useRef(onHeight);
  report.current = onHeight;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => report.current(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref}>{children}</div>;
}

const rowsFor = (px: number) =>
  Math.min(CARD_MAX_H, Math.max(CARD_MIN_H, Math.ceil((px + GAP_PX) / GRID_ROW_PX)));

function cardTitle(card: string, custom: CustomCard[]) {
  if (card.startsWith(CUSTOM_PREFIX))
    return custom.find((c) => `${CUSTOM_PREFIX}${c.id}` === card)?.title ?? "Custom card";
  return BUILTIN_CARDS.find((c) => c.id === card)?.title ?? card;
}

interface Gesture {
  mode: "move" | "resize";
  card: string;
  startX: number;
  startY: number;
  base: DashboardItem[];
  item: DashboardItem;
}

export function DashboardGrid({
  title,
  top,
  renderCard,
}: {
  title: string;
  /** Shown above the grid, always. */
  top?: ReactNode;
  renderCard: (item: DashboardItem) => ReactNode;
}) {
  const dashboard = useDashboard();
  const save = useSaveLayout();
  const reset = useResetLayout();
  const wide = useIsWide();
  const [draft, setDraft] = useState<DashboardItem[] | null>(null);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [adding, setAdding] = useState(false);
  const [builder, setBuilder] = useState<{ card: CustomCard | null } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const editing = draft !== null;
  const custom = dashboard.data?.customCards ?? [];

  /** Where everything is, with content-sized cards at their measured height. */
  const items = useMemo(() => {
    const base = draft ?? dashboard.data?.items ?? [];
    return normalizeLayout(
      base.map((i) => {
        const px = measured[i.card];
        if (!i.auto || px === undefined) return i;
        // A card with nothing to show takes no space, unless you're arranging.
        if (px === 0) return { ...i, h: editing ? CARD_MIN_H : 0 };
        return { ...i, h: rowsFor(px) };
      }),
    );
  }, [draft, dashboard.data?.items, measured, editing]);

  const onHeight = (card: string, px: number) =>
    setMeasured((m) => (m[card] === px ? m : { ...m, [card]: px }));

  const begin = (e: ReactPointerEvent<HTMLElement>, mode: Gesture["mode"], item: DashboardItem) => {
    if (!wide || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      mode,
      card: item.card,
      startX: e.clientX,
      startY: e.clientY,
      base: items,
      item,
    };
  };

  const track = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    const width = grid.current?.getBoundingClientRect().width;
    if (!g || !width) return;
    const colStep = (width + GAP_PX) / GRID_COLUMNS;
    const cols = Math.round((e.clientX - g.startX) / colStep);
    const rows = Math.round((e.clientY - g.startY) / GRID_ROW_PX);
    const { x, y, w, h } = g.item;
    if (g.mode === "move") {
      setDraft(placeCard(g.base, g.card, { x: x + cols, y: y + rows, w, h }));
      return;
    }
    // Resizing takes over from "as tall as its content".
    const sized = g.base.map((i) => (i.card === g.card ? { ...i, auto: false } : i));
    setDraft(placeCard(sized, g.card, { x, y, w: w + cols, h: h + rows }));
  };

  const finish = () => {
    gesture.current = null;
  };

  const change = (next: DashboardItem[]) => setDraft(next);
  const nudge = (item: DashboardItem, rect: Partial<DashboardItem>) =>
    change(placeCard(items, item.card, { x: item.x, y: item.y, w: item.w, h: item.h, ...rect }));
  const resize = (item: DashboardItem, rect: Partial<DashboardItem>) =>
    change(
      placeCard(
        items.map((i) => (i.card === item.card ? { ...i, auto: false } : i)),
        item.card,
        { x: item.x, y: item.y, w: item.w, h: item.h, ...rect },
      ),
    );
  /** Up or down past the nearest card in the same columns. */
  const step = (item: DashboardItem, dir: -1 | 1) => {
    const sameColumns = items.filter(
      (o) => o.card !== item.card && o.h > 0 && o.x < item.x + item.w && item.x < o.x + o.w,
    );
    if (dir < 0) {
      const above = sameColumns.filter((o) => o.y < item.y).sort((a, b) => b.y - a.y)[0];
      if (above) nudge(item, { y: above.y });
      return;
    }
    const below = sameColumns.filter((o) => o.y > item.y).sort((a, b) => a.y - b.y)[0];
    if (below) nudge(item, { y: below.y + below.h });
  };

  const placed = new Set(items.map((i) => i.card));
  const finishEdit = () => {
    if (!draft) return;
    // Saved heights are never 0: a card empty today may have something tomorrow.
    save.mutate(
      items.map((i) => ({ ...i, h: Math.max(CARD_MIN_H, i.h) })),
      { onSuccess: () => setDraft(null) },
    );
  };

  const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

  const cell = (item: DashboardItem) => {
    const content = renderCard(item);
    const fixed = !item.auto && wide;
    const body = fixed ? (
      <div className="absolute inset-x-0 top-0 bottom-6 overflow-auto rounded-xl [&>*]:min-h-full">
        {content}
      </div>
    ) : (
      <Measured onHeight={(px) => onHeight(item.card, px)}>{content}</Measured>
    );
    const empty = item.auto && measured[item.card] === 0;
    return (
      <div
        key={item.card}
        data-card={item.card}
        // An empty card stays in the page at no height, so it notices when it has content.
        className={cx("relative min-w-0 hover:z-10 focus-within:z-10", !wide && !empty && "mb-6")}
        style={
          wide
            ? {
                gridColumn: `${item.x + 1} / span ${item.w}`,
                gridRow: `${item.y + 1} / span ${Math.max(1, item.h)}`,
              }
            : undefined
        }
      >
        <div className={cx(editing && "pointer-events-none select-none")} inert={editing}>
          {body}
        </div>
        {editing && (
          <div
            className={cx(
              "absolute inset-x-0 top-0 rounded-xl bg-slate-900/10 ring-2 ring-brand-500/60 dark:bg-slate-950/40",
              wide ? "bottom-6 cursor-move touch-none" : "bottom-0",
            )}
            onPointerDown={(e) => begin(e, "move", item)}
            onPointerMove={track}
            onPointerUp={finish}
            onPointerCancel={finish}
          >
            <div
              className="absolute inset-x-1 top-1 flex flex-wrap items-center gap-0.5 rounded-lg bg-white/95 px-1 py-0.5 text-xs shadow-sm dark:bg-slate-800/95"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="mr-auto truncate px-1 font-medium">
                {cardTitle(item.card, custom)}
                {empty && (
                  <span className="font-normal text-slate-500"> · nothing to show yet</span>
                )}
              </span>
              <Tool label="Move up" onClick={() => step(item, -1)}>
                ↑
              </Tool>
              <Tool label="Move down" onClick={() => step(item, 1)}>
                ↓
              </Tool>
              {wide && (
                <>
                  <Tool
                    label="Move left"
                    disabled={item.x === 0}
                    onClick={() => nudge(item, { x: item.x - 1 })}
                  >
                    ←
                  </Tool>
                  <Tool
                    label="Move right"
                    disabled={item.x + item.w >= GRID_COLUMNS}
                    onClick={() => nudge(item, { x: item.x + 1 })}
                  >
                    →
                  </Tool>
                  <Tool
                    label="Narrower"
                    disabled={item.w <= CARD_MIN_W}
                    onClick={() => resize(item, { w: item.w - 1 })}
                  >
                    ⇤
                  </Tool>
                  <Tool
                    label="Wider"
                    disabled={item.w >= GRID_COLUMNS}
                    onClick={() => resize(item, { w: item.w + 1 })}
                  >
                    ⇥
                  </Tool>
                  <Tool label="Shorter" onClick={() => resize(item, { h: item.h - 2 })}>
                    −
                  </Tool>
                  <Tool label="Taller" onClick={() => resize(item, { h: item.h + 2 })}>
                    +
                  </Tool>
                  {!item.auto && (
                    <Tool
                      label="Fit height to content"
                      onClick={() =>
                        change(items.map((i) => (i.card === item.card ? { ...i, auto: true } : i)))
                      }
                    >
                      ↕
                    </Tool>
                  )}
                </>
              )}
              {item.card.startsWith(CUSTOM_PREFIX) && (
                <Tool
                  label="Edit this card"
                  onClick={() =>
                    setBuilder({
                      card: custom.find((c) => `${CUSTOM_PREFIX}${c.id}` === item.card) ?? null,
                    })
                  }
                >
                  ✎
                </Tool>
              )}
              <Tool
                label="Remove from Overview"
                onClick={() => change(removeCard(items, item.card))}
              >
                ✕
              </Tool>
            </div>
            {wide && (
              <div
                title="Drag to resize"
                className="absolute right-0 bottom-0 size-5 cursor-nwse-resize touch-none rounded-br-xl border-r-4 border-b-4 border-brand-500"
                onPointerDown={(e) => begin(e, "resize", item)}
                onPointerMove={track}
                onPointerUp={finish}
                onPointerCancel={finish}
              />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title={title}
        actions={
          editing ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setAdding(true)}>
                Add card
              </Button>
              <Button
                variant="ghost"
                disabled={reset.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Go back to the standard Overview? Your custom cards stay available to add.",
                    )
                  )
                    reset.mutate(undefined, { onSuccess: () => setDraft(null) });
                }}
              >
                Reset
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={save.isPending} onClick={finishEdit}>
                Done
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              disabled={!dashboard.data}
              onClick={() => setDraft(items.map((i) => ({ ...i, h: Math.max(CARD_MIN_H, i.h) })))}
            >
              Customize
            </Button>
          )
        }
      />
      <div className="space-y-6">
        {dashboard.isError && <Alert>Couldn't load your Overview layout.</Alert>}
        {(save.error ?? reset.error) && <Alert>{(save.error ?? reset.error)?.message}</Alert>}
        {top}
        {editing && (
          <p className="text-sm text-slate-500">
            {wide
              ? "Drag a card to move it and its corner to resize it, or use the buttons on each card. Cards float up to fill the space."
              : "Use the arrows to reorder cards. On a wider screen you can also resize them."}
          </p>
        )}
        {wide ? (
          <div
            ref={grid}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
              gridAutoRows: `${GRID_ROW_PX}px`,
              columnGap: GAP_PX,
            }}
          >
            {/* A steady order while arranging: moving a node mid-drag would drop the pointer. */}
            {(editing ? [...items].sort((a, b) => a.card.localeCompare(b.card)) : ordered).map(
              cell,
            )}
          </div>
        ) : (
          <div>{ordered.map(cell)}</div>
        )}
        {editing && items.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-500">
            No cards. Choose <span className="font-medium">Add card</span> to start.
          </p>
        )}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add a card">
        <div className="space-y-4">
          <ul className="max-h-96 divide-y divide-slate-100 overflow-auto text-sm dark:divide-slate-800">
            {BUILTIN_CARDS.filter((c) => !placed.has(c.id)).map((c) => (
              <AddRow
                key={c.id}
                title={c.title}
                description={c.description}
                onAdd={() => {
                  change(addCard(items, c.id, { w: c.w, h: c.h, auto: true }));
                  setAdding(false);
                }}
              />
            ))}
            {custom
              .filter((c) => !placed.has(`${CUSTOM_PREFIX}${c.id}`))
              .map((c) => (
                <AddRow
                  key={c.id}
                  title={c.title}
                  description={c.description ?? "Your custom card."}
                  onAdd={() => {
                    change(
                      addCard(items, `${CUSTOM_PREFIX}${c.id}`, {
                        w: c.spec.view === "stat" ? 3 : 4,
                        h: c.spec.view === "stat" ? 9 : 22,
                        auto: true,
                      }),
                    );
                    setAdding(false);
                  }}
                />
              ))}
          </ul>
          {BUILTIN_CARDS.every((c) => placed.has(c.id)) &&
            custom.every((c) => placed.has(`${CUSTOM_PREFIX}${c.id}`)) && (
              <p className="text-sm text-slate-500">Every card is already on your Overview.</p>
            )}
          <div className="flex justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(false);
                setBuilder({ card: null });
              }}
            >
              Create a custom card…
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      {builder && (
        <CustomCardDialog
          card={builder.card}
          onClose={() => setBuilder(null)}
          onCreated={(card) => {
            const view = card.spec.view;
            change(
              addCard(items, `${CUSTOM_PREFIX}${card.id}`, {
                w: view === "stat" ? 3 : 4,
                h: view === "stat" ? 9 : 22,
                auto: true,
              }),
            );
            setBuilder(null);
          }}
          onDeleted={(id) => {
            change(removeCard(items, `${CUSTOM_PREFIX}${id}`));
            setBuilder(null);
          }}
        />
      )}
    </>
  );
}

function Tool({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded leading-none hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-700"
    >
      {children}
    </button>
  );
}

function AddRow({
  title,
  description,
  onAdd,
}: {
  title: string;
  description: string;
  onAdd: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
      <Button variant="secondary" className="shrink-0" onClick={onAdd}>
        Add
      </Button>
    </li>
  );
}
