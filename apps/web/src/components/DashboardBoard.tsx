import {
  type ArrangeCard,
  arrangeColumns,
  BUILTIN_CARDS,
  CUSTOM_PREFIX,
  type CustomCard,
  customCardArrangement,
  fitManualColumns,
  type ManualColumns,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useDashboard } from "../lib/queries.js";
import { Alert, buttonClass, cx, PageHeader } from "./ui.js";

/**
 * The Overview: your cards, in your priority order, in as many columns as the
 * screen has room for. Which cards and in what order is yours (the Customize page);
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

/** How many columns this screen shows right now. */
export const currentColumnCount = () => readTier()?.count ?? 1;

/** The columns' widths. With hand-arranged columns, the last is always the narrow one. */
export function columnTemplate(count: number, hasSide: boolean) {
  const tier = TIERS.find((t) => t.count === count);
  if (!tier) return "minmax(0,1fr)";
  return hasSide ? tier.side : `repeat(${tier.count}, minmax(0,1fr))`;
}

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

export function describeCard(ref: string, custom: CustomCard[]) {
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
    ? customCardArrangement(c.doc)
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
  highlight,
  children,
}: {
  card: string;
  onHeight: (card: string, px: number) => void;
  highlight?: boolean;
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
    <div
      ref={ref}
      data-card={card}
      className={cx(
        "min-w-0 rounded-xl empty:hidden",
        highlight && "outline-4 outline-offset-2 outline-brand-600",
      )}
    >
      {children}
    </div>
  );
}

/** Everything arrangement needs to know about your cards at this size, heights included. */
export function arrangeCards(cards: string[], custom: CustomCard[], count: number): ArrangeCard[] {
  const heights = savedHeights(count);
  return cards.map((c) => arrangeInfo(c, custom, heights));
}

/** Your cards in a given number of columns. The Overview, and the preview while customizing. */
export function BoardColumns({
  cards,
  custom,
  count,
  manual,
  renderCard,
  highlight,
}: {
  cards: string[];
  custom: CustomCard[];
  count: number;
  /** This size's hand arrangement, if it has one. */
  manual?: string[][];
  renderCard: (card: string) => ReactNode;
  highlight?: string | null;
}) {
  const { heights, report } = useCardHeights(count, cards.join());
  const info = cards.map((c) => arrangeInfo(c, custom, heights));
  const auto = manual ? null : arrangeColumns(info, count);
  const columns = auto?.columns ?? fitManualColumns(manual ?? [], info, count);
  const template = columnTemplate(count, auto ? auto.hasSide : true);
  return (
    <div className="grid items-start gap-6" style={{ gridTemplateColumns: template }}>
      {columns.map((column, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond position.
        <div key={i} className="flex min-w-0 flex-col gap-6">
          {column.map((card) => (
            <CardSlot key={card} card={card} onHeight={report} highlight={highlight === card}>
              {renderCard(card)}
            </CardSlot>
          ))}
        </div>
      ))}
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
  const cards = dashboard.data?.cards ?? [];
  const custom = dashboard.data?.customCards ?? [];
  const count = tier?.count ?? 1;

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <Link to="/overview/customize" className={buttonClass("secondary")}>
            Customize
          </Link>
        }
      />
      <div className="space-y-6">
        {dashboard.isError && <Alert>Couldn't load your Overview layout.</Alert>}
        {top}
        <BoardColumns
          cards={cards}
          custom={custom}
          count={count}
          manual={dashboard.data?.columns[`${count}` as keyof ManualColumns]}
          renderCard={renderCard}
        />
      </div>
    </>
  );
}
