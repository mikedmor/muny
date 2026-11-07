import {
  type ArrangeCard,
  arrangeColumns,
  BUILTIN_CARDS,
  CUSTOM_PREFIX,
  type CustomCard,
  customCardArrangement,
  moveCard,
} from "@muny/shared";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useDashboard, useResetLayout, useSaveLayout } from "../lib/queries.js";
import { CustomCardDialog } from "./CustomCard.js";
import { Modal } from "./forms.js";
import { Alert, Button, cx, PageHeader } from "./ui.js";

/**
 * The Overview: your cards, in your priority order, in as many columns as the
 * screen has room for. Which cards and in what order is yours (Customize);
 * the columns are worked out in @muny/shared.
 */

/** Columns by screen width, and how wide each is. */
const TIERS = [
  {
    query: "(min-width: 150rem)",
    count: 4,
    side: "minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr) 26rem",
  },
  { query: "(min-width: 112rem)", count: 3, side: "minmax(0,1.3fr) minmax(0,1fr) 26rem" },
  { query: "(min-width: 64rem)", count: 2, side: "minmax(0,1fr) 24rem" },
] as const;

const readTier = () => TIERS.find((t) => window.matchMedia(t.query).matches) ?? null;

function useColumns() {
  const [tier, setTier] = useState(readTier);
  useEffect(() => {
    const on = () => setTier(readTier());
    const lists = TIERS.map((t) => window.matchMedia(t.query));
    for (const m of lists) m.addEventListener("change", on);
    return () => {
      for (const m of lists) m.removeEventListener("change", on);
    };
  }, []);
  return tier;
}

const customRef = (c: CustomCard) => `${CUSTOM_PREFIX}${c.id}`;

function describe(ref: string, custom: CustomCard[]) {
  const c = custom.find((x) => customRef(x) === ref);
  if (c) return { title: c.title, description: c.description ?? "Your custom card." };
  const b = BUILTIN_CARDS.find((x) => x.id === ref);
  return { title: b?.title ?? ref, description: b?.description ?? "" };
}

const ROW_PX = 16;
const GAP_PX = 24;

/** A card's placement and height: measured if we've seen it, else its typical height. */
function arrangeInfo(ref: string, custom: CustomCard[], heights: Heights): ArrangeCard {
  const c = custom.find((x) => customRef(x) === ref);
  const b = BUILTIN_CARDS.find((x) => x.id === ref);
  const known = c
    ? customCardArrangement(c.spec.view)
    : { placement: b?.placement ?? ("main" as const), weight: b?.weight ?? 24 };
  const px = heights[ref];
  return {
    card: ref,
    placement: known.placement,
    // A card with nothing to show takes no space, not even a gap.
    weight: px === undefined ? known.weight * ROW_PX + GAP_PX : px === 0 ? 0 : px + GAP_PX,
  };
}

type Heights = Record<string, number>;

const HEIGHTS_KEY = "muny.overview.heights";
/** Rearranging is only for while the page settles; after that cards stay put. */
const SETTLE_MS = 6000;
const SETTLE_ROUNDS = 4;
/** Differences smaller than this aren't worth moving a card for. */
const NOTICEABLE_PX = 24;

/** Remembered per browser and column count, so the next visit starts in the right place. */
function savedHeights(count: number): Heights {
  try {
    return JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? "{}")[count] ?? {};
  } catch {
    return {};
  }
}

function saveHeights(count: number, heights: Heights) {
  try {
    const all = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? "{}");
    localStorage.setItem(HEIGHTS_KEY, JSON.stringify({ ...all, [count]: heights }));
  } catch {
    // Private windows and full storage: it just settles again next visit.
  }
}

/**
 * The heights to arrange by. They only change for a few seconds after the page
 * opens or the layout changes, so nothing moves under you later (opening an
 * account, changing the calendar's month). Later changes are remembered for the
 * next visit.
 */
function useCardHeights(count: number, layout: string) {
  const [heights, setHeights] = useState<Heights>(() => savedHeights(count));
  const live = useRef<Heights>({});
  const applied = useRef(heights);
  const settling = useRef({ start: Date.now(), rounds: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new column count or layout starts a new settling window.
  useEffect(() => {
    live.current = {};
    const saved = savedHeights(count);
    applied.current = saved;
    setHeights(saved);
    settling.current = { start: Date.now(), rounds: 0 };
    return () => clearTimeout(timer.current);
  }, [count, layout]);

  const countNow = useRef(count);
  countNow.current = count;
  const report = useRef((card: string, px: number) => {
    live.current[card] = px;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = { ...applied.current, ...live.current };
      saveHeights(countNow.current, next);
      const w = settling.current;
      if (w.rounds >= SETTLE_ROUNDS || Date.now() - w.start > SETTLE_MS) return;
      const moved = Object.keys(next).some(
        (k) => Math.abs((next[k] ?? 0) - (applied.current[k] ?? -1000)) >= NOTICEABLE_PX,
      );
      if (!moved) return;
      w.rounds++;
      applied.current = next;
      setHeights(next);
    }, 200);
  });
  return { heights, report: report.current };
}

/** One card on the page, reporting its height. */
function CardSlot({
  card,
  onHeight,
  children,
}: {
  card: string;
  onHeight: (card: string, px: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(card, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [card, onHeight]);
  return (
    // A card with nothing to show renders nothing, and takes no space.
    <div ref={ref} data-card={card} className="min-w-0 empty:hidden">
      {children}
    </div>
  );
}

export function DashboardBoard({
  title,
  top,
  renderCard,
}: {
  title: string;
  /** Shown above the cards, always. */
  top?: ReactNode;
  renderCard: (card: string) => ReactNode;
}) {
  const dashboard = useDashboard();
  const tier = useColumns();
  const [customizing, setCustomizing] = useState(false);
  const cards = dashboard.data?.cards ?? [];
  const custom = dashboard.data?.customCards ?? [];
  const count = tier?.count ?? 1;
  const { heights, report } = useCardHeights(count, cards.join());
  const { columns, hasSide } = arrangeColumns(
    cards.map((c) => arrangeInfo(c, custom, heights)),
    count,
  );
  const template = !tier
    ? "minmax(0,1fr)"
    : hasSide
      ? tier.side
      : `repeat(${tier.count}, minmax(0,1fr))`;

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <Button
            variant="secondary"
            disabled={!dashboard.data}
            onClick={() => setCustomizing(true)}
          >
            Customize
          </Button>
        }
      />
      <div className="space-y-6">
        {dashboard.isError && <Alert>Couldn't load your Overview layout.</Alert>}
        {top}
        <div className="grid items-start gap-6" style={{ gridTemplateColumns: template }}>
          {columns.map((column, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond position.
            <div key={i} className="flex min-w-0 flex-col gap-6">
              {column.map((card) => (
                <CardSlot key={card} card={card} onHeight={report}>
                  {renderCard(card)}
                </CardSlot>
              ))}
            </div>
          ))}
        </div>
      </div>
      {customizing && dashboard.data && (
        <CustomizeDialog
          initial={dashboard.data.cards}
          custom={custom}
          onClose={() => setCustomizing(false)}
        />
      )}
    </>
  );
}

function CustomizeDialog({
  initial,
  custom,
  onClose,
}: {
  initial: string[];
  custom: CustomCard[];
  onClose: () => void;
}) {
  const save = useSaveLayout();
  const reset = useResetLayout();
  const [cards, setCards] = useState(initial);
  const [builder, setBuilder] = useState<{ card: CustomCard | null } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const startDrag = (e: ReactPointerEvent<HTMLElement>, card: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Captured on the list, which stays put: rows move in the page as they reorder.
    list.current?.setPointerCapture(e.pointerId);
    setDragging(card);
  };

  const onDrag = (e: ReactPointerEvent<HTMLOListElement>) => {
    if (!dragging || !list.current) return;
    // The dragged card's place: how many of the other rows are above the pointer.
    let to = 0;
    for (const row of list.current.children) {
      if ((row as HTMLElement).dataset.row === dragging) continue;
      const r = row.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) to++;
    }
    if (cards.indexOf(dragging) !== to) setCards(moveCard(cards, dragging, to));
  };

  const endDrag = () => setDragging(null);

  const available = [...BUILTIN_CARDS.map((c) => c.id), ...custom.map(customRef)].filter(
    (c) => !cards.includes(c),
  );

  const remove = (card: string) => setCards(cards.filter((c) => c !== card));
  const add = (card: string) => setCards([...cards, card]);

  return (
    <Modal open onClose={onClose} title="Customize your Overview">
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Drag cards to set their priority: higher in this list means higher on the page. Muny fits
          them into the columns your screen has room for.
        </p>
        <ol
          ref={list}
          aria-label="Cards on your Overview, highest priority first"
          className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800"
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {cards.map((card, i) => {
            const info = describe(card, custom);
            const own = custom.find((c) => customRef(c) === card);
            return (
              <li
                key={card}
                data-row={card}
                className={cx(
                  "group flex items-center gap-2 bg-surface px-2 py-1.5 dark:bg-slate-900",
                  dragging === card && "relative z-10 shadow-lg ring-2 ring-brand-500",
                )}
              >
                <span
                  aria-hidden="true"
                  title="Drag to change priority"
                  data-handle
                  onPointerDown={(e) => startDrag(e, card)}
                  className={cx(
                    "flex h-8 w-6 shrink-0 touch-none items-center justify-center text-lg leading-none text-slate-400",
                    dragging ? "cursor-grabbing" : "cursor-grab",
                  )}
                >
                  ⠿
                </span>
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-400">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{info.title}</span>
                {/* Moving by keyboard, or where dragging is awkward. */}
                <RowButton
                  subtle
                  label={`Move ${info.title} up`}
                  disabled={i === 0}
                  onClick={() => setCards(moveCard(cards, card, i - 1))}
                >
                  ↑
                </RowButton>
                <RowButton
                  subtle
                  label={`Move ${info.title} down`}
                  disabled={i === cards.length - 1}
                  onClick={() => setCards(moveCard(cards, card, i + 1))}
                >
                  ↓
                </RowButton>
                {own && (
                  <RowButton label={`Edit ${info.title}`} onClick={() => setBuilder({ card: own })}>
                    ✎
                  </RowButton>
                )}
                <RowButton label={`Remove ${info.title}`} onClick={() => remove(card)}>
                  ✕
                </RowButton>
              </li>
            );
          })}
          {cards.length === 0 && (
            <li className="px-3 py-4 text-center text-slate-500">No cards. Add some below.</li>
          )}
        </ol>

        <section>
          <h3 className="mb-1 text-sm font-semibold">Add a card</h3>
          {available.length > 0 ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
              {available.map((card) => {
                const info = describe(card, custom);
                const own = custom.find((c) => customRef(c) === card);
                return (
                  <li key={card} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{info.title}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {info.description}
                      </span>
                    </span>
                    {own && (
                      <RowButton
                        label={`Edit ${info.title}`}
                        onClick={() => setBuilder({ card: own })}
                      >
                        ✎
                      </RowButton>
                    )}
                    <Button variant="secondary" className="shrink-0" onClick={() => add(card)}>
                      Add
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Every card is on your Overview.</p>
          )}
          <Button variant="ghost" className="mt-2" onClick={() => setBuilder({ card: null })}>
            + Create a custom card
          </Button>
        </section>

        {(save.error ?? reset.error) && <Alert>{(save.error ?? reset.error)?.message}</Alert>}
        <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button
            variant="ghost"
            disabled={reset.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Go back to the standard Overview? Your custom cards stay available to add.",
                )
              )
                reset.mutate(undefined, { onSuccess: onClose });
            }}
          >
            Reset to standard
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => save.mutate(cards, { onSuccess: onClose })}
            >
              Done
            </Button>
          </div>
        </div>
      </div>

      {builder && (
        <CustomCardDialog
          card={builder.card}
          onClose={() => setBuilder(null)}
          onCreated={(card) => {
            add(customRef(card));
            setBuilder(null);
          }}
          onDeleted={(id) => {
            remove(`${CUSTOM_PREFIX}${id}`);
            setBuilder(null);
          }}
        />
      )}
    </Modal>
  );
}

function RowButton({
  label,
  onClick,
  disabled,
  subtle,
  children,
}: {
  /** Only shows on hover and keyboard focus, or on screens that can't hover. */
  subtle?: boolean;
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
      className={cx(
        "flex size-7 shrink-0 items-center justify-center rounded leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200",
        subtle &&
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      {children}
    </button>
  );
}
