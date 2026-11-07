import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  BLOCK_KIND_INFO,
  BLOCK_KINDS,
  type BlockKind,
  BUILTIN_CARDS,
  CARD_GRID_COLUMNS,
  type CardBlock,
  type CardDoc,
  type CardResult,
  type CustomCard,
  checkCardDoc,
  DATASET_BY_ID,
  DATASETS,
  type DatasetInfo,
  type FieldType,
  FUNCTIONS,
} from "@muny/shared";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  AreaChart,
  BarChart3,
  Bot,
  CalendarDays,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  Copy,
  Grid3x3,
  Hash,
  Heading,
  LayoutGrid,
  List,
  type LucideIcon,
  Minus,
  Plus,
  Redo2,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  Type,
  Undo2,
  Waves,
} from "lucide-react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BlockView, spanFor } from "../cardkit/blocks.js";
import { showsOwnTitle } from "../cardkit/CustomCardView.js";
import {
  addFieldToBlock,
  assistantPrompt,
  blockForField,
  defaultBlock,
  measureFromField,
  newBlockId,
  queryForDataset,
} from "../cardkit/defaults.js";
import { BlockInspector, MetricsEditor } from "../cardkit/inspector.js";
import { useWidth } from "../cardkit/xychart.js";
import { Modal } from "../components/forms.js";
import { Alert, Button, buttonClass, Card, cx, PageHeader } from "../components/ui.js";
import {
  useCardPreview,
  useCardTemplate,
  useDashboard,
  useDashboardSchema,
  useDeleteCustomCard,
  useSaveCustomCard,
} from "../lib/queries.js";

/**
 * The card editor. Drag kinds of block onto the card and fields onto blocks; the
 * card on the canvas is the real thing, recalculated as you go.
 */

const KIND_ICONS: Record<BlockKind, LucideIcon> = {
  stat: Hash,
  progress: SlidersHorizontal,
  text: Type,
  heading: Heading,
  divider: Minus,
  list: List,
  table: Table2,
  bars: BarChart3,
  column: ChartColumn,
  line: ChartLine,
  area: AreaChart,
  pie: ChartPie,
  treemap: LayoutGrid,
  heatmap: Grid3x3,
  scatter: ChartScatter,
  waterfall: Waves,
  calendar: CalendarDays,
};

const FIELD_MARK: Record<FieldType, string> = {
  money: "$",
  number: "#",
  percent: "%",
  text: "Aa",
  date: "▦",
  month: "▦",
  boolean: "✓",
};

const WIDTHS = [
  { id: "side", label: "Side column", px: 416 },
  { id: "main", label: "Wide column", px: 640 },
  { id: "full", label: "Very wide", px: 960 },
] as const;

const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  // The most specific thing under the pointer: a slot, then a block, then the canvas.
  if (within.length) {
    const rank = (id: unknown) => {
      const s = String(id);
      return s.startsWith("canvas")
        ? 2
        : s.includes("dim:") || s.includes("measure") || s.includes("filter")
          ? 0
          : 1;
    };
    return [...within].sort((a, b) => rank(a.id) - rank(b.id));
  }
  return rectIntersection(args);
};

function KindTile({ kind, onAdd }: { kind: BlockKind; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `new:${kind}` });
  const info = BLOCK_KIND_INFO[kind];
  const Icon = KIND_ICONS[kind];
  return (
    <button
      ref={setNodeRef}
      type="button"
      title={`${info.description} Drag it onto the card, or click to add it.`}
      onClick={onAdd}
      className={cx(
        "flex cursor-grab touch-none flex-col items-center gap-1 rounded-lg border border-slate-200 bg-surface p-2 text-center text-[11px] leading-tight hover:border-brand-500 active:cursor-grabbing dark:border-slate-800 dark:bg-slate-900",
        isDragging && "opacity-40",
      )}
      {...attributes}
      {...listeners}
    >
      <Icon aria-hidden="true" className="size-4 text-slate-500" />
      {info.label}
    </button>
  );
}

function FieldChip({
  dataset,
  id,
  label,
  type,
  hint,
  onAdd,
}: {
  dataset: string;
  id: string;
  label: string;
  type: FieldType;
  hint?: string;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `field:${dataset}:${id}`,
  });
  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        title={`${hint ? `${hint} ` : ""}Drag it onto a block, or click to add it to the selected one.`}
        onClick={onAdd}
        className={cx(
          "flex w-full cursor-grab touch-none items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-slate-100 active:cursor-grabbing dark:hover:bg-slate-800",
          isDragging && "opacity-40",
        )}
        {...attributes}
        {...listeners}
      >
        <span
          aria-hidden="true"
          className="w-4 shrink-0 text-center text-[10px] font-semibold text-slate-400"
        >
          {FIELD_MARK[type]}
        </span>
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

function DataBrowser({
  active,
  onAddField,
}: {
  active: string | undefined;
  onAddField: (dataset: string, field: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const shown = open ?? active ?? "transactions";
  const q = search.trim().toLowerCase();
  const matchesField = (d: DatasetInfo) =>
    d.fields.filter((f) => !q || `${f.label} ${d.label}`.toLowerCase().includes(q));
  const groups = [...new Set(DATASETS.map((d) => d.group))];
  return (
    <div>
      <label className="relative mb-2 block">
        <span className="sr-only">Find data</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-2 left-2 size-3.5 text-slate-400"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find any data"
          className="w-full rounded-lg border border-slate-300 bg-surface py-1.5 pr-2 pl-7 text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      {groups.map((g) => {
        const sets = DATASETS.filter((d) => d.group === g && matchesField(d).length > 0);
        if (!sets.length) return null;
        return (
          <div key={g} className="mb-2">
            <p className="px-1 pb-0.5 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
              {g}
            </p>
            {sets.map((d) => {
              const isOpen = !!q || shown === d.id;
              return (
                <div key={d.id}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    title={d.description}
                    onClick={() => setOpen(isOpen ? "" : d.id)}
                    className={cx(
                      "flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800",
                      active === d.id && "text-brand-700 dark:text-brand-500",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        "text-[9px] text-slate-400 transition-transform",
                        isOpen && "rotate-90",
                      )}
                    >
                      ▶
                    </span>
                    {d.label}
                  </button>
                  {isOpen && (
                    <ul className="mb-1 ml-2 border-l border-slate-200 pl-1 dark:border-slate-800">
                      {matchesField(d).map((f) => (
                        <FieldChip
                          key={f.id}
                          dataset={d.id}
                          id={f.id}
                          label={f.label}
                          type={f.type}
                          hint={f.hint}
                          onAdd={() => onAddField(d.id, f.id)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function FormulaHelp() {
  const groups = [...new Set(FUNCTIONS.map((f) => f.group))];
  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1 text-slate-600 dark:text-slate-400">
        <p>
          <code>[Spending] / [Income]</code> divides one total by another. Money is in dollars, so{" "}
          <code>[Amount] &gt; 100</code> means over a hundred dollars.
        </p>
        <p>
          <code>sum([Spending], [Category] = "Dining")</code> totals only some rows.
        </p>
        <p>
          <code>running_sum([Spending])</code> builds up across a chart.
        </p>
        <p>
          <code>$income - $spent</code> uses named values, from any data.
        </p>
      </div>
      {groups.map((g) => (
        <div key={g}>
          <p className="mb-0.5 font-semibold">{g}</p>
          <ul className="space-y-0.5">
            {FUNCTIONS.filter((f) => f.group === g).map((f) => (
              <li key={f.name}>
                <code className="text-[11px]">{f.usage}</code>
                <span className="block text-[11px] text-slate-500">{f.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CanvasBlock({
  block,
  result,
  today,
  selected,
  narrow,
  columnPx,
  onSelect,
  onDuplicate,
  onRemove,
  onResize,
}: {
  block: CardBlock;
  result: CardResult | undefined;
  today: string;
  selected: boolean;
  narrow: boolean;
  columnPx: number;
  onSelect: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onResize: (w: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: block.id });
  const start = useRef<{ x: number; w: number } | null>(null);

  const onResizeStart = (e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: block.w };
    onSelect();
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!start.current) return;
    const delta = Math.round((e.clientX - start.current.x) / Math.max(1, columnPx));
    const w = Math.min(CARD_GRID_COLUMNS, Math.max(1, start.current.w + delta));
    if (w !== block.w) onResize(w);
  };

  const info = BLOCK_KIND_INFO[block.kind];
  return (
    <div
      ref={setNodeRef}
      data-canvas-block={block.id}
      style={{
        gridColumn: `span ${spanFor(block.w, narrow)}`,
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cx(
        "group relative min-w-0 rounded-lg p-1 outline-offset-1",
        selected
          ? "outline-2 outline-brand-600"
          : isOver
            ? "outline-2 outline-dashed outline-brand-500"
            : "outline-1 outline-transparent hover:outline-slate-300 dark:hover:outline-slate-700",
        isDragging && "z-20 opacity-60",
      )}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the toolbar's buttons and the inspector give keyboard access. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: selecting also happens through the block's move button. */}
      <div onClick={onSelect} className="cursor-pointer">
        {block.title && <p className="mb-2 text-sm font-medium">{block.title}</p>}
        <div inert={selected ? undefined : true}>
          <BlockView block={block} result={result?.blocks[block.id]} today={today} />
        </div>
      </div>
      <div
        className={cx(
          "absolute -top-3 right-1 z-10 flex items-center gap-0.5 rounded-md border border-slate-200 bg-surface px-0.5 shadow-sm dark:border-slate-700 dark:bg-slate-900",
          selected
            ? "opacity-100"
            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      >
        <button
          type="button"
          aria-label={`Move ${info.label}. ${block.w} of 12 columns wide.`}
          title="Drag to move"
          onClick={onSelect}
          className="cursor-grab touch-none rounded px-1 py-0.5 text-[10px] font-medium text-slate-500 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          ⠿ {info.label}
        </button>
        <button
          type="button"
          aria-label={`Duplicate ${info.label}`}
          title="Duplicate"
          onClick={onDuplicate}
          className="rounded p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          <Copy aria-hidden="true" className="size-3" />
        </button>
        <button
          type="button"
          aria-label={`Delete ${info.label}`}
          title="Delete"
          onClick={onRemove}
          className="rounded p-1 text-slate-500 hover:text-red-600"
        >
          <Trash2 aria-hidden="true" className="size-3" />
        </button>
      </div>
      <div
        data-resize={block.id}
        title={`${block.w} of 12 columns. Drag to resize.`}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={() => {
          start.current = null;
        }}
        onPointerCancel={() => {
          start.current = null;
        }}
        className={cx(
          "absolute top-1/2 -right-1.5 z-10 h-8 w-2.5 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border border-slate-300 bg-surface shadow-sm hover:border-brand-500 dark:border-slate-600 dark:bg-slate-900",
          selected ? "block" : "hidden group-hover:block",
        )}
      />
    </div>
  );
}

function Canvas({
  doc,
  result,
  today,
  selected,
  title,
  description,
  width,
  onSelect,
  onResize,
  onDuplicate,
  onRemove,
}: {
  doc: CardDoc;
  result: CardResult | undefined;
  today: string;
  selected: string | null;
  title: string;
  description: string;
  width: number;
  onSelect: (id: string | null) => void;
  onResize: (id: string, w: number) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas" });
  const { ref: gridRef, width: gridWidth } = useWidth(width);
  const narrow = gridWidth < 380;
  return (
    <div className="overflow-x-auto pb-2">
      <div className="mx-auto max-w-full" style={{ width }}>
        <Card className="p-4">
          {!showsOwnTitle(doc) && <h2 className="mb-2 font-semibold">{title || "Your card"}</h2>}
          {description && <p className="mb-2 text-xs text-slate-500">{description}</p>}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the background deselects; Escape does too. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above. */}
          <div
            ref={setNodeRef}
            data-canvas
            onClick={(e) => {
              if (e.target === e.currentTarget) onSelect(null);
            }}
            className={cx(
              "min-h-40 rounded-lg transition-colors",
              isOver && "bg-brand-50 dark:bg-brand-700/10",
            )}
          >
            {doc.blocks.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
                <p className="font-medium">Drag a block or a piece of data here</p>
                <p className="text-xs">Everything on the left can go on your card.</p>
              </div>
            ) : (
              <SortableContext items={doc.blocks.map((b) => b.id)} strategy={rectSortingStrategy}>
                <div ref={gridRef} className="grid grid-cols-12 gap-x-3 gap-y-4 pt-3">
                  {doc.blocks.map((b) => (
                    <CanvasBlock
                      key={b.id}
                      block={b}
                      result={result}
                      today={today}
                      selected={selected === b.id}
                      narrow={narrow}
                      columnPx={gridWidth / CARD_GRID_COLUMNS}
                      onSelect={() => onSelect(b.id)}
                      onDuplicate={() => onDuplicate(b.id)}
                      onRemove={() => onRemove(b.id)}
                      onResize={(w) => onResize(b.id, w)}
                    />
                  ))}
                </div>
              </SortableContext>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function JsonDialog({
  title,
  description,
  doc,
  onClose,
  onApply,
}: {
  title: string;
  description: string;
  doc: CardDoc;
  onClose: () => void;
  onApply: (input: { title?: string; description?: string; doc: CardDoc }) => void;
}) {
  const schema = useDashboardSchema(true);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const area =
    "w-full rounded-lg border border-slate-300 bg-surface p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950";
  const apply = () => {
    setError(null);
    try {
      const parsed = JSON.parse(text) as { title?: unknown; description?: unknown; doc?: unknown };
      const candidate = (parsed.doc ?? parsed) as CardDoc;
      if (candidate?.v !== 2 || !Array.isArray(candidate.blocks))
        throw new Error('It needs a "doc" with "v": 2 and a list of "blocks".');
      onApply({
        ...(typeof parsed.title === "string" ? { title: parsed.title.slice(0, 60) } : {}),
        ...(typeof parsed.description === "string"
          ? { description: parsed.description.slice(0, 200) }
          : {}),
        doc: candidate,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That isn't valid JSON.");
    }
  };
  return (
    <Modal open onClose={onClose} title="Use JSON or an AI assistant" wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">Ask an assistant</p>
          <p className="text-xs text-slate-500">
            Copy this into any AI assistant and describe the card you want, as complicated as you
            like. It holds none of your financial data, only what a card can be.
          </p>
          <textarea
            readOnly
            rows={8}
            aria-label="Prompt for an AI assistant"
            value={schema.data ? assistantPrompt(schema.data) : "Loading…"}
            onFocus={(e) => e.target.select()}
            className={area}
          />
          <p className="text-sm font-medium">This card</p>
          <textarea
            readOnly
            rows={8}
            aria-label="This card as JSON"
            value={JSON.stringify({ title, description, doc }, null, 2)}
            onFocus={(e) => e.target.select()}
            className={area}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">Paste a card</p>
          <p className="text-xs text-slate-500">
            From an assistant or someone else's Muny. It goes on the canvas so you can check it
            before saving. Cards are data only, so they can't run anything.
          </p>
          <textarea
            rows={18}
            aria-label="Card JSON"
            spellCheck={false}
            placeholder='{ "title": "…", "doc": { "v": 2, "blocks": [ … ] } }'
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={area}
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Button variant="secondary" disabled={!text.trim()} onClick={apply}>
            Put it on the canvas
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: [string, string][];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" className="flex border-b border-slate-200 text-xs dark:border-slate-800">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          onClick={() => onChange(id)}
          className={cx(
            "-mb-px flex-1 border-b-2 px-1 py-2 font-medium whitespace-nowrap",
            active === id
              ? "border-brand-600 text-brand-700 dark:text-brand-500"
              : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function CardEditorPage() {
  const { cardId } = useParams({ from: "/overview/cards/$cardId" });
  const { from } = useSearch({ from: "/overview/cards/$cardId" });
  const dashboard = useDashboard();
  const template = useCardTemplate(cardId === "new" ? from : undefined);
  if (!dashboard.data || (from && cardId === "new" && !template.data && !template.isError))
    return <p className="text-slate-500">Loading…</p>;
  const existing = dashboard.data.customCards.find((c) => c.id === cardId) ?? null;
  if (cardId !== "new" && !existing)
    return (
      <>
        <PageHeader title="Card" />
        <p className="text-sm text-slate-500">
          That card is gone.{" "}
          <Link to="/overview/customize" className="text-brand-600 underline">
            Back to customizing
          </Link>
        </p>
      </>
    );
  const builtin = from ? BUILTIN_CARDS.find((c) => c.id === from) : undefined;
  return (
    <Editor
      key={cardId}
      existing={existing}
      start={existing?.doc ?? template.data ?? { v: 2, blocks: [] }}
      startTitle={existing?.title ?? builtin?.title ?? ""}
      basedOn={existing?.basedOn ?? builtin?.id}
    />
  );
}

function Editor({
  existing,
  start,
  startTitle,
  basedOn,
}: {
  existing: CustomCard | null;
  start: CardDoc;
  startTitle: string;
  basedOn: string | undefined;
}) {
  const navigate = useNavigate();
  const save = useSaveCustomCard();
  const del = useDeleteCustomCard();
  const [title, setTitle] = useState(startTitle);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [history, setHistory] = useState<{ past: CardDoc[]; doc: CardDoc; future: CardDoc[] }>({
    past: [],
    doc: start,
    future: [],
  });
  const doc = history.doc;
  const [selected, setSelected] = useState<string | null>(doc.blocks[0]?.id ?? null);
  const [leftTab, setLeftTab] = useState("blocks");
  const [rightTab, setRightTab] = useState("block");
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>("main");
  const [dragging, setDragging] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);

  // Recalculate shortly after you stop changing things.
  const [previewDoc, setPreviewDoc] = useState<CardDoc | null>(doc);
  useEffect(() => {
    const t = setTimeout(() => setPreviewDoc(doc), 300);
    return () => clearTimeout(t);
  }, [doc]);
  const preview = useCardPreview(previewDoc);

  const change = (next: CardDoc | ((d: CardDoc) => CardDoc)) =>
    setHistory((h) => {
      const doc = typeof next === "function" ? next(h.doc) : next;
      return doc === h.doc ? h : { past: [...h.past.slice(-99), h.doc], doc, future: [] };
    });
  const undo = () =>
    setHistory((h) => {
      const prev = h.past[h.past.length - 1];
      return prev ? { past: h.past.slice(0, -1), doc: prev, future: [h.doc, ...h.future] } : h;
    });
  const redo = () =>
    setHistory((h) => {
      const next = h.future[0];
      return next ? { past: [...h.past, h.doc], doc: next, future: h.future.slice(1) } : h;
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: undo and redo only use the state setter, which never changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select");
      if (typing || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedBlock = doc.blocks.find((b) => b.id === selected) ?? null;
  const issues = useMemo(() => checkCardDoc(doc), [doc]);

  const setBlock = (id: string, fn: (b: CardBlock) => CardBlock) =>
    change((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? fn(b) : b)) }));

  const insert = (block: CardBlock, at?: number) => {
    change((d) => {
      const blocks = [...d.blocks];
      blocks.splice(at ?? blocks.length, 0, block);
      return { ...d, blocks };
    });
    setSelected(block.id);
    setRightTab("block");
  };

  const addKind = (kind: BlockKind, at?: number) => insert(defaultBlock(kind, newBlockId(doc)), at);

  const addField = (dataset: string, field: string) => {
    if (selectedBlock && BLOCK_KIND_INFO[selectedBlock.kind].query)
      setBlock(selectedBlock.id, (b) => addFieldToBlock(b, dataset, field));
    else insert(blockForField(dataset, field, newBlockId(doc)));
  };

  const dropOnSlot = (slot: string, dataset: string, field: string) => {
    const block = selectedBlock;
    if (!block) return;
    const layerMatch = /^layer(\d+):/.exec(slot);
    const layer = layerMatch ? Number(layerMatch[1]) : null;
    const name = slot.replace(/^layer\d+:/, "");
    const info = DATASET_BY_ID.get(dataset);
    const type = info?.fields.find((f) => f.id === field)?.type;
    setBlock(block.id, (b) => {
      const current = layer === null ? b.query : b.layers?.[layer];
      const query = queryForDataset(current, dataset);
      let next = query;
      if (name.startsWith("dim:")) {
        const i = Number(name.slice(4));
        const dims = [...(query.dimensions ?? [])];
        dims[Math.min(i, dims.length)] = {
          field,
          ...(type === "date" || type === "month" ? { bucket: "month" as const } : {}),
        };
        next = { ...query, dimensions: dims };
      } else if (name === "measure") {
        const measure = measureFromField(query, dataset, field);
        const max = BLOCK_KIND_INFO[b.kind].measures[1];
        next = {
          ...query,
          measures: max === 1 ? [measure] : [...(query.measures ?? []), measure],
        };
      } else if (name === "filter") {
        const op = type === "boolean" ? ("is_true" as const) : ("eq" as const);
        next = {
          ...query,
          filters: [
            ...(query.filters ?? []),
            { field, op, ...(type === "boolean" ? {} : { value: "" }) },
          ],
        };
      }
      if (layer === null) return { ...b, query: next };
      const layers = [...(b.layers ?? [])];
      layers[layer] = next;
      return { ...b, layers };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    if (a.startsWith("new:")) {
      if (o.includes("dim:") || o.includes("measure") || o.includes("filter")) return;
      const at = doc.blocks.findIndex((b) => b.id === o);
      addKind(a.slice(4) as BlockKind, at >= 0 ? at : undefined);
      return;
    }
    if (a.startsWith("field:")) {
      const [, dataset = "", field = ""] = a.split(":");
      if (o.includes("dim:") || o.includes("measure") || o.includes("filter")) {
        dropOnSlot(o, dataset, field);
        return;
      }
      const target = doc.blocks.find((b) => b.id === o);
      if (target && BLOCK_KIND_INFO[target.kind].query) {
        setBlock(target.id, (b) => addFieldToBlock(b, dataset, field));
        setSelected(target.id);
        return;
      }
      if (o === "canvas" || target) {
        const at = target ? doc.blocks.indexOf(target) : undefined;
        insert(blockForField(dataset, field, newBlockId(doc)), at);
      }
      return;
    }
    if (a !== o) {
      const from = doc.blocks.findIndex((b) => b.id === a);
      const to = doc.blocks.findIndex((b) => b.id === o);
      if (from >= 0 && to >= 0) change((d) => ({ ...d, blocks: arrayMove(d.blocks, from, to) }));
    }
  };

  const submit = () =>
    save.mutate(
      {
        ...(existing ? { id: existing.id } : {}),
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        doc,
        ...(basedOn ? { basedOn } : {}),
      },
      { onSuccess: () => void navigate({ to: "/overview/customize" }) },
    );

  const device = WIDTHS.find((w) => w.id === width) ?? WIDTHS[1];
  const label = dragging?.startsWith("new:")
    ? BLOCK_KIND_INFO[dragging.slice(4) as BlockKind]?.label
    : dragging?.startsWith("field:")
      ? DATASET_BY_ID.get(dragging.split(":")[1] ?? "")?.fields.find(
          (f) => f.id === dragging.split(":")[2],
        )?.label
      : dragging
        ? BLOCK_KIND_INFO[doc.blocks.find((b) => b.id === dragging)?.kind ?? "text"]?.label
        : null;
  const today = preview.data?.today ?? new Date().toISOString().slice(0, 10);

  const panel =
    "rounded-xl border border-slate-200 bg-surface shadow-sm dark:border-slate-800 dark:bg-slate-900";
  const iconButton = "px-2";
  const leftPanel: ReactNode = (
    <aside className={cx(panel, "min-w-0")}>
      <Tabs
        active={leftTab}
        onChange={setLeftTab}
        tabs={[
          ["blocks", "Blocks"],
          ["data", "Data"],
          ["help", "Formulas"],
        ]}
      />
      <div className="max-h-[calc(100dvh-13rem)] overflow-y-auto p-2">
        {leftTab === "blocks" &&
          (["Numbers", "Charts", "Lists", "Layout"] as const).map((g) => (
            <div key={g} className="mb-3">
              <p className="px-1 pb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                {g}
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {BLOCK_KINDS.filter((k) => BLOCK_KIND_INFO[k].group === g).map((k) => (
                  <KindTile key={k} kind={k} onAdd={() => addKind(k)} />
                ))}
              </div>
            </div>
          ))}
        {leftTab === "data" && (
          <DataBrowser active={selectedBlock?.query?.dataset} onAddField={addField} />
        )}
        {leftTab === "help" && <FormulaHelp />}
      </div>
    </aside>
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(e) => {
        const id = String(e.active.id);
        setDragging(id);
        if (doc.blocks.some((b) => b.id === id)) setSelected(id);
      }}
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <PageHeader
        title={existing ? `Edit ${existing.title}` : "Create a card"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              className={iconButton}
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={history.past.length === 0}
              onClick={undo}
            >
              <Undo2 aria-hidden="true" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              className={iconButton}
              aria-label="Redo"
              title="Redo (Ctrl+Y)"
              disabled={history.future.length === 0}
              onClick={redo}
            >
              <Redo2 aria-hidden="true" className="size-4" />
            </Button>
            <Button variant="secondary" onClick={() => setJsonOpen(true)}>
              <Bot aria-hidden="true" className="size-4" /> JSON or AI
            </Button>
            {existing && (
              <Button
                variant="ghost"
                className="text-red-600 dark:text-red-400"
                disabled={del.isPending}
                onClick={() => {
                  if (window.confirm(`Delete "${existing.title}" for everyone in this household?`))
                    del.mutate(existing.id, {
                      onSuccess: () => void navigate({ to: "/overview/customize" }),
                    });
                }}
              >
                Delete
              </Button>
            )}
            <Link
              to="/overview/customize"
              className={buttonClass("secondary")}
              onClick={(e) => {
                if (
                  history.past.length > 0 &&
                  !window.confirm("Throw away your changes to this card?")
                )
                  e.preventDefault();
              }}
            >
              Cancel
            </Link>
            <Button disabled={!title.trim() || save.isPending} onClick={submit}>
              {save.isPending ? "Saving…" : existing ? "Save" : "Create card"}
            </Button>
          </div>
        }
      />
      {(save.error ?? del.error) && (
        <div className="mb-3">
          <Alert>{(save.error ?? del.error)?.message}</Alert>
        </div>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_21rem]">
        <div className="xl:sticky xl:top-4">{leftPanel}</div>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-48 flex-1">
              <span className="mb-0.5 block text-xs font-medium text-slate-600 dark:text-slate-400">
                Card title
              </span>
              <input
                value={title}
                maxLength={60}
                placeholder="What's this card about?"
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm font-medium dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <label className="min-w-48 flex-1">
              <span className="mb-0.5 block text-xs font-medium text-slate-600 dark:text-slate-400">
                A note under it (optional)
              </span>
              <input
                value={description}
                maxLength={200}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <div
              role="radiogroup"
              aria-label="Preview width"
              className="flex rounded-lg border border-slate-200 bg-surface p-0.5 dark:border-slate-800 dark:bg-slate-900"
            >
              {WIDTHS.map((w) => (
                // biome-ignore lint/a11y/useSemanticElements: a compact segmented control.
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={width === w.id}
                  onClick={() => setWidth(w.id)}
                  className={cx(
                    "rounded-md px-2 py-1 text-xs whitespace-nowrap",
                    width === w.id
                      ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                      : "text-slate-500",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          {preview.error && <Alert>{preview.error.message}</Alert>}
          <div className={cx(preview.isFetching && "opacity-80")}>
            <Canvas
              doc={doc}
              result={preview.data}
              today={today}
              selected={selected}
              title={title}
              description={description}
              width={device.px}
              onSelect={(id) => {
                setSelected(id);
                if (id) setRightTab("block");
              }}
              onResize={(id, w) => setBlock(id, (b) => ({ ...b, w }))}
              onDuplicate={(id) => {
                const source = doc.blocks.find((b) => b.id === id);
                if (source)
                  insert(
                    { ...structuredClone(source), id: newBlockId(doc) },
                    doc.blocks.indexOf(source) + 1,
                  );
              }}
              onRemove={(id) => {
                change((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }));
                if (selected === id) setSelected(null);
              }}
            />
          </div>
          {issues.some((i) => !i.block) && (
            <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {issues
                .filter((i) => !i.block)
                .map((i) => (
                  <li key={i.message}>{i.message}</li>
                ))}
            </ul>
          )}
          <p className="text-center text-xs text-slate-500">
            Colors come from your theme, so the card follows it automatically.
          </p>
        </div>

        <aside className={cx(panel, "min-w-0 xl:sticky xl:top-4")}>
          <Tabs
            active={rightTab}
            onChange={setRightTab}
            tabs={[
              ["block", "Selected block"],
              ["values", `Named values${doc.metrics?.length ? ` (${doc.metrics.length})` : ""}`],
            ]}
          />
          <div className="max-h-[calc(100dvh-13rem)] overflow-y-auto pt-3">
            {rightTab === "values" ? (
              <MetricsEditor
                doc={doc}
                result={preview.data}
                onChange={(metrics) =>
                  change((d) => {
                    const { metrics: _m, ...rest } = d;
                    return metrics.length ? { ...rest, metrics } : rest;
                  })
                }
              />
            ) : selectedBlock ? (
              <BlockInspector
                key={selectedBlock.id}
                block={selectedBlock}
                doc={doc}
                issues={issues.filter((i) => i.block === selectedBlock.id).map((i) => i.message)}
                onChange={(b) => setBlock(selectedBlock.id, () => b)}
              />
            ) : (
              <div className="p-4 text-center text-sm text-slate-500">
                <Plus aria-hidden="true" className="mx-auto mb-1 size-5" />
                Click a block on the card to change it, or add one from the left.
              </div>
            )}
          </div>
        </aside>
      </div>
      <DragOverlay dropAnimation={null}>
        {label && (
          <div className="rounded-lg border border-brand-600 bg-surface px-3 py-1.5 text-xs font-medium shadow-lg dark:bg-slate-900">
            {label}
          </div>
        )}
      </DragOverlay>
      {jsonOpen && (
        <JsonDialog
          title={title}
          description={description}
          doc={doc}
          onClose={() => setJsonOpen(false)}
          onApply={(input) => {
            if (input.title) setTitle(input.title);
            if (input.description) setDescription(input.description);
            change(input.doc);
            setSelected(input.doc.blocks[0]?.id ?? null);
            setJsonOpen(false);
          }}
        />
      )}
    </DndContext>
  );
}
