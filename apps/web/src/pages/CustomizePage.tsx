import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  arrangeColumns,
  BUILTIN_CARDS,
  CUSTOM_PREFIX,
  type CustomCard,
  fitManualColumns,
  type ManualColumns,
} from "@muny/shared";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  GripVertical,
  Laptop,
  Monitor,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Tv,
  Undo2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useWidth } from "../cardkit/xychart.js";
import {
  arrangeCards,
  BoardColumns,
  columnTemplate,
  currentColumnCount,
  describeCard,
} from "../components/DashboardBoard.js";
import { Alert, Button, buttonClass, Card, cx, PageHeader } from "../components/ui.js";
import { useAuthStatus } from "../lib/auth.js";
import { useDashboard, useResetLayout, useSaveLayout } from "../lib/queries.js";
import { useCardRenderer } from "./OverviewPage.js";

/**
 * Customize your Overview: your cards in priority order, a live picture of the
 * page they make, and everything you could add, with previews. Changes save as
 * they're made, and Undo steps back.
 */

const SCREENS = [
  { count: 1, width: 430, label: "Phone", icon: Smartphone },
  { count: 2, width: 1300, label: "Laptop", icon: Laptop },
  { count: 3, width: 1900, label: "Wide", icon: Monitor },
  { count: 4, width: 2576, label: "Ultrawide", icon: Tv },
] as const;

const customRef = (c: CustomCard) => `${CUSTOM_PREFIX}${c.id}`;

/** Under the pointer, the card before its column. */
const manualCollision: CollisionDetection = (args) =>
  [...pointerWithin(args)].sort(
    (a, b) => Number(String(a.id).startsWith("mcol:")) - Number(String(b.id).startsWith("mcol:")),
  );

const moved = (columns: string[][], card: string, column: number, index: number) => {
  const next = columns.map((list) => list.filter((c) => c !== card));
  next[column]?.splice(index, 0, card);
  return next;
};

/** One card on the page while arranging by hand. */
function ManualCard({
  card,
  title,
  scale,
  marker,
  canLeft,
  canRight,
  canUp,
  canDown,
  onMove,
  onRemove,
  editing,
  children,
}: {
  card: string;
  title: string;
  scale: number;
  marker: "before" | "after" | null;
  canLeft: boolean;
  canRight: boolean;
  canUp: boolean;
  canDown: boolean;
  onMove: (by: "left" | "right" | "up" | "down") => void;
  onRemove: () => void;
  editing: ReactNode;
  children: ReactNode;
}) {
  const drag = useDraggable({ id: `mcard:${card}` });
  const drop = useDroppable({ id: `mdrop:${card}` });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      data-manual-card={card}
      className={cx(
        "group relative min-w-0 rounded-xl focus-within:z-30 hover:z-30",
        drag.isDragging && "opacity-40",
      )}
    >
      {marker && (
        <div
          aria-hidden="true"
          className={cx(
            "absolute inset-x-0 z-20 rounded-full bg-brand-600",
            marker === "before" ? "-top-3" : "-bottom-3",
          )}
          style={{ height: Math.max(3, 3 / scale) }}
        />
      )}
      <div
        {...drag.listeners}
        {...drag.attributes}
        title={`Drag ${title} to another place`}
        className="cursor-grab touch-none rounded-xl outline-brand-500 hover:outline-2 active:cursor-grabbing"
      >
        <div
          inert
          className="pointer-events-none min-h-24 rounded-xl bg-slate-100 dark:bg-slate-900"
        >
          {children}
        </div>
      </div>
      <div
        className="absolute top-1 right-1 z-10 flex origin-top-right items-center gap-0.5 rounded-lg border border-slate-200 bg-surface px-1 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        style={{ transform: `scale(${Math.min(2.5, 1 / scale)})` }}
      >
        <span
          {...drag.listeners}
          className="max-w-32 cursor-grab touch-none truncate px-1 py-1 text-xs font-medium active:cursor-grabbing"
        >
          {title}
        </span>
        <span className="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
          <IconButton
            label={`Move ${title} left`}
            disabled={!canLeft}
            onClick={() => onMove("left")}
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
          </IconButton>
          <IconButton label={`Move ${title} up`} disabled={!canUp} onClick={() => onMove("up")}>
            <ArrowUp aria-hidden="true" className="size-3.5" />
          </IconButton>
          <IconButton
            label={`Move ${title} down`}
            disabled={!canDown}
            onClick={() => onMove("down")}
          >
            <ArrowDown aria-hidden="true" className="size-3.5" />
          </IconButton>
          <IconButton
            label={`Move ${title} right`}
            disabled={!canRight}
            onClick={() => onMove("right")}
          >
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </IconButton>
          {editing}
          <IconButton label={`Remove ${title}`} onClick={onRemove}>
            <X aria-hidden="true" className="size-4" />
          </IconButton>
        </span>
      </div>
    </div>
  );
}

function ManualColumn({
  index,
  empty,
  children,
}: {
  index: number;
  empty: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `mcol:${index}` });
  return (
    <div
      ref={setNodeRef}
      data-manual-column={index}
      className={cx(
        "flex min-h-64 min-w-0 flex-col gap-6 rounded-xl",
        (empty || isOver) && "outline-2 outline-dashed outline-slate-400 dark:outline-slate-600",
        isOver && "outline-brand-500",
      )}
    >
      {children}
    </div>
  );
}

/** A real card drawn small. It can't be clicked or tabbed into. */
function Thumbnail({
  children,
  height = 132,
  virtual = 460,
}: {
  children: ReactNode;
  height?: number;
  virtual?: number;
}) {
  const { ref, width } = useWidth(240);
  return (
    <div
      ref={ref}
      inert
      aria-hidden="true"
      className="relative overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-950"
      style={{ height }}
    >
      <div
        className="peer relative origin-top-left"
        style={{ width: virtual, transform: `scale(${width / virtual})` }}
      >
        {children}
      </div>
      <p className="absolute inset-0 hidden items-center justify-center p-2 text-center text-xs text-slate-500 peer-empty:flex">
        Nothing to show yet
      </p>
    </div>
  );
}

function PriorityRow({
  id,
  index,
  total,
  title,
  description,
  editing,
  canEdit,
  onMove,
  onRemove,
  onHover,
}: {
  id: string;
  index: number;
  total: number;
  title: string;
  description: string;
  editing: ReactNode;
  canEdit: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
  onHover: (hover: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <li
      ref={setNodeRef}
      data-row={id}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(
        "group flex items-center gap-1.5 bg-surface px-1.5 py-1.5 dark:bg-slate-900",
        isDragging && "relative z-10 opacity-50",
      )}
    >
      <button
        type="button"
        aria-label={`Drag ${title} to change its priority`}
        title="Drag to change priority"
        className="flex h-9 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-slate-400 hover:text-slate-600 active:cursor-grabbing dark:hover:text-slate-200"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-4" />
      </button>
      <span className="w-5 shrink-0 text-right text-xs text-slate-400 tabular-nums">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 px-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-slate-500">{description}</span>
      </span>
      <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <IconButton
          label={`Move ${title} up`}
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
        >
          <ArrowUp aria-hidden="true" className="size-3.5" />
        </IconButton>
        <IconButton
          label={`Move ${title} down`}
          disabled={index === total - 1}
          onClick={() => onMove(index + 1)}
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
        </IconButton>
        {canEdit && editing}
      </span>
      <IconButton label={`Remove ${title}`} onClick={onRemove}>
        <X aria-hidden="true" className="size-4" />
      </IconButton>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
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
      className="flex size-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {children}
    </button>
  );
}

function LibraryTile({
  id,
  title,
  description,
  isCustom,
  children,
  editing,
  onAdd,
}: {
  id: string;
  title: string;
  description: string;
  isCustom: boolean;
  children: ReactNode;
  editing: ReactNode;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib:${id}` });
  return (
    <li
      ref={setNodeRef}
      className={cx(
        "rounded-xl border border-slate-200 bg-surface p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900",
        isDragging && "opacity-40",
      )}
    >
      <div {...attributes} {...listeners} className="cursor-grab touch-none active:cursor-grabbing">
        <Thumbnail>{children}</Thumbnail>
      </div>
      <div className="mt-2 flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{title}</span>
            {isCustom && (
              <span className="shrink-0 rounded bg-slate-100 px-1 text-[10px] font-normal text-slate-500 dark:bg-slate-800">
                Yours
              </span>
            )}
          </span>
          <span className="block text-xs text-slate-500">{description}</span>
        </span>
        {editing}
        <Button variant="secondary" className="shrink-0 px-2 py-1 text-xs" onClick={onAdd}>
          <Plus aria-hidden="true" className="size-3.5" /> Add
        </Button>
      </div>
    </li>
  );
}

function ListDrop({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "list" });
  return (
    <div
      ref={setNodeRef}
      className={cx(
        "overflow-hidden rounded-xl border bg-surface shadow-sm dark:bg-slate-900",
        isOver
          ? "border-brand-600 ring-1 ring-brand-600"
          : "border-slate-200 dark:border-slate-800",
      )}
    >
      {children}
    </div>
  );
}

export function CustomizePage() {
  const dashboard = useDashboard();
  const viewOnly = useAuthStatus().data?.user?.role === "viewer";
  const save = useSaveLayout();
  const reset = useResetLayout();
  const renderCard = useCardRenderer();
  const custom = dashboard.data?.customCards ?? [];
  const [state, setState] = useState<{ cards: string[]; columns: ManualColumns } | null>(null);
  const [history, setHistory] = useState<{ cards: string[]; columns: ManualColumns }[]>([]);
  const [marker, setMarker] = useState<{ card: string; side: "before" | "after" } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "builtin" | "custom">("all");
  const [screen, setScreen] = useState(() => currentColumnCount() - 1);
  const { ref: previewRef, width: previewWidth } = useWidth(600);
  const previewContent = useRef<HTMLDivElement>(null);
  const [previewHeight, setPreviewHeight] = useState(400);

  const loaded = dashboard.data;
  useEffect(() => {
    if (loaded && state === null) setState({ cards: loaded.cards, columns: loaded.columns });
  }, [loaded, state]);

  useEffect(() => {
    const el = previewContent.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPreviewHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const list = state?.cards ?? [];
  const manual = state?.columns ?? {};
  const commit = (next: { cards: string[]; columns: ManualColumns }) => {
    if (state) setHistory((h) => [...h.slice(-49), state]);
    setState(next);
    save.mutate(next);
  };
  /** A change to the cards on the page. Taking one off takes it off every size. */
  const change = (cards: string[]) => {
    const columns: ManualColumns = {};
    for (const [size, lists] of Object.entries(manual))
      columns[size as keyof ManualColumns] = lists?.map((column) =>
        column.filter((c) => cards.includes(c)),
      );
    commit({ cards, columns });
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setState(prev);
    save.mutate(prev);
  };

  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...custom.map(customRef), ...BUILTIN_CARDS.map((c) => c.id)]
      .filter((c) => !list.includes(c))
      .filter((c) =>
        show === "all"
          ? true
          : show === "custom"
            ? c.startsWith(CUSTOM_PREFIX)
            : !c.startsWith(CUSTOM_PREFIX),
      )
      .filter((c) => {
        if (!q) return true;
        const info = describeCard(c, custom);
        return `${info.title} ${info.description}`.toLowerCase().includes(q);
      });
  }, [custom, list, search, show]);

  const device = SCREENS[screen] ?? SCREENS[1];
  const sizeKey = `${device.count}` as keyof ManualColumns;
  const savedManual = manual[sizeKey];
  const manualColumns = savedManual
    ? fitManualColumns(savedManual, arrangeCards(list, custom, device.count), device.count)
    : null;

  const setManual = (columns: string[][] | null, cards = list) => {
    const next = { ...manual };
    if (columns) next[sizeKey] = columns;
    else delete next[sizeKey];
    commit({ cards, columns: next });
  };

  const moveByButton = (card: string, by: "left" | "right" | "up" | "down") => {
    if (!manualColumns) return;
    const from = manualColumns.findIndex((column) => column.includes(card));
    const at = manualColumns[from]?.indexOf(card) ?? 0;
    if (by === "up") setManual(moved(manualColumns, card, from, at - 1));
    if (by === "down") setManual(moved(manualColumns, card, from, at + 1));
    if (by === "left" || by === "right") {
      const to = from + (by === "left" ? -1 : 1);
      setManual(moved(manualColumns, card, to, Math.min(at, manualColumns[to]?.length ?? 0)));
    }
  };

  const onDragMove = (e: DragMoveEvent) => {
    const overId = String(e.over?.id ?? "");
    const pointer = e.activatorEvent as PointerEvent;
    if (!overId.startsWith("mdrop:") || !e.over || pointer.clientY === undefined) {
      if (marker) setMarker(null);
      return;
    }
    const y = pointer.clientY + e.delta.y;
    const side = y > e.over.rect.top + e.over.rect.height / 2 ? "after" : "before";
    const card = overId.slice(6);
    if (marker?.card !== card || marker.side !== side) setMarker({ card, side });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const placed = marker;
    setDragging(null);
    setMarker(null);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (manualColumns) {
      const card = activeId.replace(/^(lib|mcard):/, "");
      const isNew = activeId.startsWith("lib:");
      const base = isNew ? manualColumns.map((column) => [...column]) : manualColumns;
      let next: string[][] | null = null;
      if (overId.startsWith("mcol:")) {
        const to = Number(overId.slice(5));
        const rest = base[to]?.filter((c) => c !== card) ?? [];
        next = moved(base, card, to, rest.length);
      } else if (overId.startsWith("mdrop:")) {
        const target = overId.slice(6);
        if (target === card) return;
        const to = base.findIndex((column) => column.includes(target));
        const rest = base[to]?.filter((c) => c !== card) ?? [];
        const at = rest.indexOf(target) + (placed?.side === "after" ? 1 : 0);
        next = moved(base, card, to, at);
      }
      if (next) setManual(next, isNew ? [...list, card] : list);
      return;
    }
    if (activeId.startsWith("lib:")) {
      const card = activeId.slice(4);
      const at = list.indexOf(overId);
      change(at >= 0 ? [...list.slice(0, at), card, ...list.slice(at)] : [...list, card]);
      return;
    }
    if (activeId === overId) return;
    const from = list.indexOf(activeId);
    const to = list.indexOf(overId);
    if (from >= 0 && to >= 0) change(arrayMove(list, from, to));
  };

  const editLink = (ref: string) => {
    if (viewOnly) return null;
    const own = custom.find((c) => customRef(c) === ref);
    if (own)
      return (
        <Link
          to="/overview/cards/$cardId"
          params={{ cardId: own.id }}
          aria-label={`Edit ${own.title}`}
          title={`Edit ${own.title}`}
          className="flex size-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </Link>
      );
    const info = describeCard(ref, custom);
    return (
      <Link
        to="/overview/cards/$cardId"
        params={{ cardId: "new" }}
        search={{ from: ref }}
        aria-label={`Customize a copy of ${info.title}`}
        title={`Customize a copy of ${info.title}`}
        className="flex size-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <Pencil aria-hidden="true" className="size-3.5" />
      </Link>
    );
  };

  const scale = previewWidth / device.width;
  const activeInfo = dragging ? describeCard(dragging.replace(/^(lib|mcard):/, ""), custom) : null;
  const error = save.error ?? reset.error;

  return (
    <>
      <PageHeader
        title="Customize your Overview"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span aria-live="polite" className="text-xs text-slate-500">
              {save.isPending ? "Saving…" : history.length > 0 ? "Saved" : ""}
            </span>
            <Button
              variant="ghost"
              disabled={history.length === 0 || save.isPending}
              onClick={undo}
            >
              <Undo2 aria-hidden="true" className="size-4" /> Undo
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
                  reset.mutate(undefined, {
                    onSuccess: (d) => {
                      if (state) setHistory((h) => [...h, state]);
                      setState({ cards: d.cards, columns: d.columns });
                    },
                  });
              }}
            >
              Reset to standard
            </Button>
            <Link to="/" className={buttonClass("primary")}>
              Done
            </Link>
          </div>
        }
      />
      {error && (
        <div className="mb-4">
          <Alert>{error.message}</Alert>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={manualColumns ? manualCollision : closestCenter}
        onDragStart={(e) => setDragging(String(e.active.id))}
        onDragMove={onDragMove}
        onDragCancel={() => {
          setDragging(null);
          setMarker(null);
        }}
        onDragEnd={onDragEnd}
      >
        <div
          className={cx(
            "grid items-start gap-6",
            manualColumns
              ? "lg:grid-cols-[minmax(0,1fr)_22rem]"
              : "lg:grid-cols-2 2xl:grid-cols-[22rem_minmax(0,1fr)_22rem]",
          )}
        >
          <section className={cx("min-w-0", manualColumns && "hidden")}>
            <h2 className="mb-1 font-semibold">On your Overview</h2>
            <p className="mb-3 text-sm text-slate-500">
              Higher in this list means higher on the page. Drag to reorder, or drag a card in from
              the right.
            </p>
            <ListDrop>
              <SortableContext items={list} strategy={verticalListSortingStrategy}>
                <ol
                  aria-label="Cards on your Overview, highest priority first"
                  className="divide-y divide-slate-100 dark:divide-slate-800"
                >
                  {list.map((card, i) => {
                    const info = describeCard(card, custom);
                    return (
                      <PriorityRow
                        key={card}
                        id={card}
                        index={i}
                        total={list.length}
                        title={info.title}
                        description={info.description}
                        canEdit
                        editing={editLink(card)}
                        onMove={(to) => change(arrayMove(list, i, to))}
                        onRemove={() => change(list.filter((c) => c !== card))}
                        onHover={(h) => setHovered(h ? card : null)}
                      />
                    );
                  })}
                  {list.length === 0 && (
                    <li className="px-3 py-6 text-center text-sm text-slate-500">
                      No cards yet. Add some from the list of cards.
                    </li>
                  )}
                </ol>
              </SortableContext>
            </ListDrop>
          </section>

          <section
            className={cx(
              "min-w-0",
              !manualColumns && "lg:order-3 lg:col-span-2 2xl:order-none 2xl:col-span-1",
            )}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold">Your page</h2>
                <p className="text-sm text-slate-500">
                  {manualColumns
                    ? `Drag cards to any column. Only ${device.label} is arranged this way; other sizes keep their own.`
                    : "Live, with your real numbers."}
                </p>
              </div>
              <div
                role="radiogroup"
                aria-label="Preview at this screen size"
                className="flex rounded-lg border border-slate-200 bg-surface p-0.5 dark:border-slate-800 dark:bg-slate-900"
              >
                {SCREENS.map((s, i) => (
                  // biome-ignore lint/a11y/useSemanticElements: a compact segmented control of icons.
                  <button
                    key={s.label}
                    type="button"
                    role="radio"
                    aria-checked={screen === i}
                    aria-label={s.label}
                    title={
                      manual[`${s.count}` as keyof ManualColumns]
                        ? `${s.label}: arranged by hand`
                        : `${s.label}: arranges itself`
                    }
                    onClick={() => setScreen(i)}
                    className={cx(
                      "flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                      screen === i
                        ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                        : "text-slate-500",
                    )}
                  >
                    <s.icon aria-hidden="true" className="size-3.5" />
                    <span className="hidden sm:inline">{s.label}</span>
                    {manual[`${s.count}` as keyof ManualColumns] && (
                      <span
                        title="Arranged by hand"
                        className="size-1.5 rounded-full bg-brand-600"
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
              <div>
                <span className="font-medium">Columns at {device.label} size</span>
                <span className="block text-xs text-slate-500">
                  {manualColumns
                    ? "Stay exactly where you put them. New cards go in the shortest column."
                    : "Muny keeps them level, using your priority order."}
                </span>
              </div>
              <div
                role="radiogroup"
                aria-label={`How to arrange the ${device.label} size`}
                className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800"
              >
                {(
                  [
                    ["auto", "Automatic"],
                    ["manual", "By hand"],
                  ] as const
                ).map(([mode, label]) => {
                  const on = (mode === "manual") === !!manualColumns;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a compact segmented control.
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => {
                        if (on) return;
                        // Starts from what's showing, so nothing jumps.
                        setManual(
                          mode === "manual"
                            ? arrangeColumns(arrangeCards(list, custom, device.count), device.count)
                                .columns
                            : null,
                        );
                      }}
                      className={cx(
                        "rounded-md px-2.5 py-1 text-xs",
                        on
                          ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                          : "text-slate-500",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              ref={previewRef}
              className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
              style={{ height: previewHeight * scale }}
            >
              <div
                ref={previewContent}
                inert={!manualColumns}
                className="origin-top-left p-4"
                style={{ width: device.width, transform: `scale(${scale})` }}
              >
                {manualColumns ? (
                  <div
                    className="grid items-start gap-6"
                    style={{ gridTemplateColumns: columnTemplate(device.count, true) }}
                  >
                    {manualColumns.map((column, i) => (
                      <ManualColumn
                        // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity beyond position.
                        key={i}
                        index={i}
                        empty={column.length === 0}
                      >
                        {column.map((card, at) => (
                          <ManualCard
                            key={card}
                            card={card}
                            title={describeCard(card, custom).title}
                            scale={scale}
                            marker={marker?.card === card ? marker.side : null}
                            canLeft={i > 0}
                            canRight={i < manualColumns.length - 1}
                            canUp={at > 0}
                            canDown={at < column.length - 1}
                            onMove={(by) => moveByButton(card, by)}
                            onRemove={() => change(list.filter((c) => c !== card))}
                            editing={editLink(card)}
                          >
                            {renderCard(card)}
                          </ManualCard>
                        ))}
                      </ManualColumn>
                    ))}
                  </div>
                ) : (
                  <BoardColumns
                    cards={list}
                    custom={custom}
                    count={device.count}
                    renderCard={renderCard}
                    highlight={hovered}
                  />
                )}
              </div>
            </div>
          </section>

          <section className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h2 className="font-semibold">Add a card</h2>
              {!viewOnly && (
                <Link
                  to="/overview/cards/$cardId"
                  params={{ cardId: "new" }}
                  className={buttonClass("secondary", "px-2 py-1 text-xs")}
                >
                  <Plus aria-hidden="true" className="size-3.5" /> Create your own
                </Link>
              )}
            </div>
            <p className="mb-3 text-sm text-slate-500">
              Build one from anything in Muny, or customize a copy of any card with its ✎.
            </p>
            <div className="mb-3 flex gap-2">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Search cards</span>
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search cards"
                  className="w-full rounded-lg border border-slate-300 bg-surface py-2 pr-2 pl-8 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </label>
              <select
                aria-label="Which cards to show"
                value={show}
                onChange={(e) => setShow(e.target.value as typeof show)}
                className="rounded-lg border border-slate-300 bg-surface px-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="all">All</option>
                <option value="builtin">Built in</option>
                <option value="custom">Yours</option>
              </select>
            </div>
            {available.length > 0 ? (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-1">
                {available.map((card) => {
                  const info = describeCard(card, custom);
                  return (
                    <LibraryTile
                      key={card}
                      id={card}
                      title={info.title}
                      description={info.description}
                      isCustom={card.startsWith(CUSTOM_PREFIX)}
                      editing={editLink(card)}
                      onAdd={() => change([...list, card])}
                    >
                      {renderCard(card)}
                    </LibraryTile>
                  );
                })}
              </ul>
            ) : (
              <Card className="text-center text-sm text-slate-500">
                {search ? "No cards match that." : "Every card is on your Overview."}
              </Card>
            )}
          </section>
        </div>
        <DragOverlay>
          {activeInfo && (
            <div className="rounded-lg border border-brand-600 bg-surface px-3 py-2 text-sm font-medium shadow-lg dark:bg-slate-900">
              {activeInfo.title}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </>
  );
}
