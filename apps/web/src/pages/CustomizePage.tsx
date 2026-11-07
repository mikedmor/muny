import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
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
import { BUILTIN_CARDS, CUSTOM_PREFIX, type CustomCard } from "@muny/shared";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
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
import { BoardColumns, describeCard } from "../components/DashboardBoard.js";
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
  const [cards, setCards] = useState<string[] | null>(null);
  const [history, setHistory] = useState<string[][]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "builtin" | "custom">("all");
  const [screen, setScreen] = useState(1);
  const { ref: previewRef, width: previewWidth } = useWidth(600);
  const previewContent = useRef<HTMLDivElement>(null);
  const [previewHeight, setPreviewHeight] = useState(400);

  const serverCards = dashboard.data?.cards;
  useEffect(() => {
    if (serverCards && cards === null) setCards(serverCards);
  }, [serverCards, cards]);

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

  const list = cards ?? [];
  const change = (next: string[]) => {
    setHistory((h) => [...h.slice(-49), list]);
    setCards(next);
    save.mutate(next);
  };
  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setCards(prev);
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

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
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

  const device = SCREENS[screen] ?? SCREENS[1];
  const scale = previewWidth / device.width;
  const activeInfo = dragging ? describeCard(dragging.replace(/^lib:/, ""), custom) : null;
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
                      setHistory((h) => [...h, list]);
                      setCards(d.cards);
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
        collisionDetection={closestCenter}
        onDragStart={(e) => setDragging(String(e.active.id))}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="grid items-start gap-6 lg:grid-cols-2 2xl:grid-cols-[22rem_minmax(0,1fr)_22rem]">
          <section className="min-w-0">
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

          <section className="min-w-0 lg:order-3 lg:col-span-2 2xl:order-none 2xl:col-span-1">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold">Your page</h2>
                <p className="text-sm text-slate-500">Live, with your real numbers.</p>
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
                    title={s.label}
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
                  </button>
                ))}
              </div>
            </div>
            <div
              ref={previewRef}
              className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
              style={{ height: previewHeight * scale }}
            >
              <div
                ref={previewContent}
                inert
                className="origin-top-left p-4"
                style={{ width: device.width, transform: `scale(${scale})` }}
              >
                <BoardColumns
                  cards={list}
                  custom={custom}
                  count={device.count}
                  renderCard={renderCard}
                  highlight={hovered}
                />
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
