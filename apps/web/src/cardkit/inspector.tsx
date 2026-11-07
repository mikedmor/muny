import { useDroppable } from "@dnd-kit/core";
import {
  AGGREGATE_LABELS,
  AGGREGATES,
  type Aggregate,
  BLOCK_KIND_INFO,
  BLOCK_KINDS,
  type BlockKind,
  type BlockOptions,
  CARD_COLORS,
  CARD_GRID_COLUMNS,
  CARD_MARKS,
  type CardBlock,
  type CardCalculated,
  type CardColor,
  type CardDoc,
  type CardFilter,
  type CardMark,
  type CardMeasure,
  type CardMetric,
  type CardQuery,
  type CardResult,
  DATASET_BY_ID,
  DATASETS,
  DATE_BUCKET_LABELS,
  DATE_BUCKETS,
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  type DateBucket,
  type DatePreset,
  type DateRange,
  FILTER_OP_LABELS,
  FILTER_OPS,
  type FieldType,
  type FilterOp,
  findField,
} from "@muny/shared";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button, cx } from "../components/ui.js";
import { queryForDataset, uniqueId } from "./defaults.js";
import { FormulaInput, type FormulaName } from "./FormulaInput.js";

/**
 * The panel for whatever's selected: its data, its calculations and how it looks.
 * Everything here can also be done by dragging; every drag has a control here too,
 * so the editor works from the keyboard and on a phone.
 */

const inputClass =
  "w-full min-w-0 rounded-lg border border-slate-300 bg-surface px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950";

function Label({ text, children }: { text: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: every caller puts its control inside.
    <label className="block min-w-0">
      <span className="mb-0.5 block text-xs font-medium text-slate-600 dark:text-slate-400">
        {text}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 accent-brand-600"
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function Section({
  title,
  children,
  open: initial = true,
  badge,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  badge?: number;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-400"
      >
        <span>
          {title}
          {badge ? <span className="ml-1 font-normal text-slate-400">{badge}</span> : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cx("size-3.5 transition-transform", !open && "-rotate-90")}
        />
      </button>
      {open && <div className="space-y-2.5 px-3 pb-3">{children}</div>}
    </section>
  );
}

export function DropSlot({
  id,
  empty,
  hint,
  children,
}: {
  id: string;
  empty: boolean;
  hint: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id });
  const fieldDragging = String(active?.id ?? "").startsWith("field:");
  return (
    <div
      ref={setNodeRef}
      data-slot={id}
      className={cx(
        "rounded-lg border border-dashed p-1.5 transition-colors",
        isOver
          ? "border-brand-600 bg-brand-50 dark:bg-brand-700/20"
          : fieldDragging
            ? "border-brand-500"
            : "border-slate-300 dark:border-slate-700",
      )}
    >
      {children}
      {empty && <p className="px-1 py-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

const FORMAT_LABELS: Record<FieldType, string> = {
  money: "Money",
  number: "Number",
  percent: "Percent",
  text: "Text",
  date: "Date",
  month: "Month",
  boolean: "Yes or no",
};

const COLOR_LABELS: Record<CardColor, string> = {
  auto: "Automatic",
  series1: "Chart color 1",
  series2: "Chart color 2",
  series3: "Chart color 3",
  series4: "Chart color 4",
  series5: "Chart color 5",
  series6: "Chart color 6",
  series7: "Chart color 7",
  series8: "Chart color 8",
  positive: "Good",
  negative: "Bad",
  warning: "Warning",
  muted: "Quiet",
};

const MARK_LABELS: Record<CardMark, string> = {
  auto: "Same as the block",
  line: "Line",
  dashed: "Dashed line",
  area: "Area",
  column: "Columns",
};

const clean = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

function FormatSelect({
  value,
  onChange,
}: {
  value: FieldType | undefined;
  onChange: (v: FieldType | undefined) => void;
}) {
  return (
    <select
      aria-label="Show as"
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || undefined) as FieldType | undefined)}
      className={inputClass}
    >
      <option value="">Show as: automatic</option>
      {Object.entries(FORMAT_LABELS).map(([k, label]) => (
        <option key={k} value={k}>
          Show as: {label}
        </option>
      ))}
    </select>
  );
}

function rangeValue(range: DateRange | undefined): string {
  if (!range) return "";
  if ("preset" in range) return range.preset;
  if ("from" in range) return "custom";
  return range.next !== undefined ? "next" : "last";
}

function RangeEditor({
  range,
  onChange,
}: {
  range: DateRange | undefined;
  onChange: (r: DateRange | undefined) => void;
}) {
  const mode = rangeValue(range);
  const n = range && "unit" in range ? (range.last ?? range.next ?? 3) : 3;
  const unit = range && "unit" in range ? range.unit : "months";
  const setRolling = (dir: "last" | "next", count: number, u: "days" | "months") =>
    onChange(dir === "last" ? { last: count, unit: u } : { next: count, unit: u });
  return (
    <div className="space-y-1.5">
      <Label text="Dates">
        <select
          value={mode}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) onChange(undefined);
            else if (v === "custom") {
              const today = new Date().toISOString().slice(0, 10);
              onChange({ from: `${today.slice(0, 7)}-01`, to: today });
            } else if (v === "last" || v === "next") setRolling(v, 3, "months");
            else onChange({ preset: v as DatePreset });
          }}
          className={inputClass}
        >
          <option value="">Any date</option>
          {DATE_PRESETS.filter((p) => p !== "all_time").map((p) => (
            <option key={p} value={p}>
              {DATE_PRESET_LABELS[p]}
            </option>
          ))}
          <option value="last">The last…</option>
          <option value="next">The next…</option>
          <option value="custom">Between two dates</option>
        </select>
      </Label>
      {(mode === "last" || mode === "next") && (
        <div className="flex gap-1.5">
          <input
            type="number"
            min={1}
            max={mode === "last" ? 3650 : 400}
            aria-label="How many"
            value={n}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 1) setRolling(mode, v, unit);
            }}
            className={inputClass}
          />
          <select
            aria-label="Days or months"
            value={unit}
            onChange={(e) => setRolling(mode, n, e.target.value as "days" | "months")}
            className={inputClass}
          >
            <option value="days">days</option>
            <option value="months">months</option>
          </select>
        </div>
      )}
      {range && "from" in range && (
        <div className="flex gap-1.5">
          <input
            type="date"
            aria-label="From"
            value={range.from}
            onChange={(e) => onChange({ ...range, from: e.target.value })}
            className={inputClass}
          />
          <input
            type="date"
            aria-label="To"
            value={range.to}
            onChange={(e) => onChange({ ...range, to: e.target.value })}
            className={inputClass}
          />
        </div>
      )}
    </div>
  );
}

function fieldOptions(query: CardQuery) {
  const info = DATASET_BY_ID.get(query.dataset);
  return [
    ...(info?.fields.map((f) => ({ id: f.id, label: f.label, type: f.type as FieldType })) ?? []),
    ...(query.calculated ?? []).map((c) => ({
      id: c.id,
      label: c.label ?? c.id,
      type: (c.format ?? "text") as FieldType,
    })),
  ];
}

function FilterRow({
  filter,
  query,
  onChange,
  onRemove,
}: {
  filter: CardFilter;
  query: CardQuery;
  onChange: (f: CardFilter) => void;
  onRemove: () => void;
}) {
  const noValue =
    filter.op === "is_empty" ||
    filter.op === "not_empty" ||
    filter.op === "is_true" ||
    filter.op === "is_false";
  const isList = filter.op === "in" || filter.op === "not_in";
  const options = fieldOptions(query);
  const type = options.find((o) => o.id === filter.field)?.type;
  return (
    <li className="space-y-1 rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800/50">
      <div className="flex gap-1">
        <select
          aria-label="Field"
          value={filter.field}
          onChange={(e) => onChange({ ...filter, field: e.target.value })}
          className={inputClass}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Remove this filter"
          onClick={onRemove}
          className="shrink-0 rounded p-1 text-slate-400 hover:text-red-600"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <div className="flex gap-1">
        <select
          aria-label="Condition"
          value={filter.op}
          onChange={(e) => {
            const op = e.target.value as FilterOp;
            const { value, ...rest } = filter;
            onChange(
              op === "is_empty" || op === "not_empty" || op === "is_true" || op === "is_false"
                ? { ...rest, op }
                : { ...rest, op, value: value ?? "" },
            );
          }}
          className={inputClass}
        >
          {FILTER_OPS.map((op) => (
            <option key={op} value={op}>
              {FILTER_OP_LABELS[op]}
            </option>
          ))}
        </select>
        {!noValue && (
          <input
            aria-label="Value"
            placeholder={isList ? "One, two, three" : type === "money" ? "In dollars" : "Value"}
            value={
              Array.isArray(filter.value) ? filter.value.join(", ") : String(filter.value ?? "")
            }
            onChange={(e) =>
              onChange({
                ...filter,
                value: isList
                  ? e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                  : e.target.value,
              })
            }
            className={inputClass}
          />
        )}
      </div>
    </li>
  );
}

function MeasureRow({
  measure,
  query,
  names,
  isChart,
  onChange,
  onRemove,
}: {
  measure: CardMeasure;
  query: CardQuery;
  names: FormulaName[];
  isChart: boolean;
  onChange: (m: CardMeasure) => void;
  onRemove: () => void;
}) {
  const [more, setMore] = useState(false);
  const options = fieldOptions(query);
  const formula = measure.expr !== undefined;
  return (
    <li className="space-y-1.5 rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800/50">
      <div className="flex items-center gap-1">
        <input
          aria-label="Name"
          value={measure.label ?? ""}
          placeholder={measure.id}
          onChange={(e) => onChange(clean({ ...measure, label: e.target.value || undefined }))}
          className={cx(inputClass, "font-medium")}
        />
        <button
          type="button"
          aria-label={`More options for ${measure.label ?? measure.id}`}
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          className="shrink-0 rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <ChevronDown
            aria-hidden="true"
            className={cx("size-3.5 transition-transform", !more && "-rotate-90")}
          />
        </button>
        <button
          type="button"
          aria-label={`Remove ${measure.label ?? measure.id}`}
          onClick={onRemove}
          className="shrink-0 rounded p-1 text-slate-400 hover:text-red-600"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {formula ? (
        <FormulaInput
          label="Formula"
          value={measure.expr ?? ""}
          names={names}
          placeholder="sum([Spending]) / sum([Income])"
          onChange={(expr) => onChange({ ...measure, expr })}
        />
      ) : (
        <div className="flex gap-1">
          <select
            aria-label="How to total it"
            value={measure.agg ?? "sum"}
            onChange={(e) => onChange({ ...measure, agg: e.target.value as Aggregate })}
            className={inputClass}
          >
            {AGGREGATES.map((a) => (
              <option key={a} value={a}>
                {AGGREGATE_LABELS[a]}
              </option>
            ))}
          </select>
          {measure.agg !== "count" && (
            <select
              aria-label="Field"
              value={measure.field ?? ""}
              onChange={(e) => onChange({ ...measure, field: e.target.value })}
              className={inputClass}
            >
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {more && (
        <div className="space-y-1.5">
          <Label text="Name in formulas">
            <input
              value={measure.id}
              spellCheck={false}
              onChange={(e) =>
                onChange({
                  ...measure,
                  id: e.target.value.replace(/[^A-Za-z0-9_]/g, "_") || "value",
                })
              }
              className={cx(inputClass, "font-mono")}
            />
          </Label>
          <FormatSelect
            value={measure.format}
            onChange={(format) => onChange(clean({ ...measure, format }))}
          />
          {isChart && (
            <>
              <Label text="Color">
                <select
                  value={measure.color ?? "auto"}
                  onChange={(e) =>
                    onChange(
                      clean({
                        ...measure,
                        color:
                          e.target.value === "auto" ? undefined : (e.target.value as CardColor),
                      }),
                    )
                  }
                  className={inputClass}
                >
                  {CARD_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {COLOR_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Label>
              <Label text="Draw as">
                <select
                  value={measure.mark ?? "auto"}
                  onChange={(e) =>
                    onChange(
                      clean({
                        ...measure,
                        mark: e.target.value === "auto" ? undefined : (e.target.value as CardMark),
                      }),
                    )
                  }
                  className={inputClass}
                >
                  {CARD_MARKS.map((m) => (
                    <option key={m} value={m}>
                      {MARK_LABELS[m]}
                    </option>
                  ))}
                </select>
              </Label>
            </>
          )}
          <Toggle
            label="Use in formulas only"
            hint="Worked out, but not shown."
            checked={!!measure.hidden}
            onChange={(hidden) => onChange(clean({ ...measure, hidden: hidden || undefined }))}
          />
          {!formula && (
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-500"
              onClick={() => {
                const { field, agg, ...rest } = measure;
                onChange({
                  ...rest,
                  expr: agg === "count" || !field ? "count()" : `${agg ?? "sum"}([${field}])`,
                });
              }}
            >
              Change to a formula
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function namesFor(doc: CardDoc, query?: CardQuery): FormulaName[] {
  const out: FormulaName[] = (doc.metrics ?? []).map((m) => ({
    insert: `$${m.id}`,
    label: `$${m.id}`,
    detail: m.label,
  }));
  if (query) {
    for (const f of fieldOptions(query))
      out.push({ insert: `[${f.label}]`, label: f.label, detail: FORMAT_LABELS[f.type] });
    for (const m of query.measures ?? [])
      out.push({
        insert: `[${m.label ?? m.id}]`,
        label: m.label ?? m.id,
        detail: "A value in this block",
      });
  }
  return out;
}

function QueryEditor({
  query,
  doc,
  kind,
  slotPrefix,
  onChange,
  showDimensions = true,
}: {
  query: CardQuery;
  doc: CardDoc;
  kind: BlockKind;
  slotPrefix: string;
  onChange: (q: CardQuery) => void;
  showDimensions?: boolean;
}) {
  const info = BLOCK_KIND_INFO[kind];
  const dataset = DATASET_BY_ID.get(query.dataset);
  const options = fieldOptions(query);
  const names = useMemo(() => namesFor(doc, query), [doc, query]);
  const rowNames = useMemo(() => names.filter((n) => !n.detail?.startsWith("A value")), [names]);
  const set = (patch: Partial<CardQuery>) => onChange(clean({ ...query, ...patch }));
  const isChart = kind === "line" || kind === "area" || kind === "column";
  const dims = query.dimensions ?? [];
  const groups = [...new Set(DATASETS.map((d) => d.group))];
  const firstField = dataset?.fields[0]?.id ?? "";

  const setDim = (i: number, field: string | null) => {
    const next = [...dims];
    if (!field) next.splice(i, 1);
    else {
      const t = options.find((o) => o.id === field)?.type;
      next[i] = {
        field,
        ...(t === "date" || t === "month" ? { bucket: "month" as const } : {}),
      };
    }
    set({ dimensions: next });
  };

  const slotCount = info.dimensions.length;
  const slots = Array.from({ length: Math.min(slotCount, dims.length + 1) }, (_, i) => i);

  return (
    <>
      <Label text="Data">
        <select
          value={query.dataset}
          onChange={(e) => onChange(queryForDataset(query, e.target.value))}
          className={inputClass}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {DATASETS.filter((d) => d.group === g).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Label>
      {dataset && <p className="text-[11px] text-slate-500">{dataset.description}</p>}
      {dataset?.dateField && (
        <RangeEditor
          range={query.range}
          onChange={(range) => {
            const { range: _old, ...rest } = query;
            onChange(range ? { ...rest, range } : rest);
          }}
        />
      )}

      {showDimensions &&
        slots.map((i) => {
          const dim = dims[i];
          const slot = info.dimensions[i] ?? info.dimensions[slotCount - 1];
          const type = dim && options.find((o) => o.id === dim.field)?.type;
          return (
            <Label key={i} text={slot?.label ?? "Group by"}>
              <DropSlot id={`${slotPrefix}dim:${i}`} empty={false} hint={slot?.hint ?? ""}>
                <div className="flex gap-1">
                  <select
                    value={dim?.field ?? ""}
                    onChange={(e) => setDim(i, e.target.value || null)}
                    className={inputClass}
                  >
                    <option value="">{dim ? "Remove" : "Drop a field, or choose"}</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {dim && (type === "date" || type === "month") && (
                    <select
                      aria-label="How to group the dates"
                      value={dim.bucket ?? ""}
                      onChange={(e) => {
                        const next = [...dims];
                        const bucket = (e.target.value || undefined) as DateBucket | undefined;
                        next[i] = clean({ ...dim, bucket });
                        set({ dimensions: next });
                      }}
                      className={inputClass}
                    >
                      <option value="">Each date</option>
                      {DATE_BUCKETS.map((b) => (
                        <option key={b} value={b}>
                          {DATE_BUCKET_LABELS[b]}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </DropSlot>
              {slot?.hint && !dim && (
                <span className="mt-0.5 block text-[11px] text-slate-500">{slot.hint}</span>
              )}
            </Label>
          );
        })}

      {info.measures[1] > 0 && (
        <div>
          <p className="mb-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">Values</p>
          <DropSlot
            id={`${slotPrefix}measure`}
            empty={(query.measures ?? []).length === 0}
            hint="Drop a number here, or add one below."
          >
            <ul className="space-y-1.5">
              {(query.measures ?? []).map((m, i) => (
                <MeasureRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: renaming changes the id, and mustn't lose focus.
                  key={i}
                  measure={m}
                  query={query}
                  names={names}
                  isChart={isChart}
                  onChange={(next) => {
                    const measures = [...(query.measures ?? [])];
                    measures[i] = next;
                    set({ measures });
                  }}
                  onRemove={() =>
                    set({ measures: (query.measures ?? []).filter((_, n) => n !== i) })
                  }
                />
              ))}
            </ul>
          </DropSlot>
          <div className="mt-1.5 flex gap-1.5">
            <Button
              variant="secondary"
              className="flex-1 px-2 py-1 text-xs"
              onClick={() =>
                set({
                  measures: [
                    ...(query.measures ?? []),
                    {
                      id: uniqueId(
                        "value",
                        (query.measures ?? []).map((m) => m.id),
                      ),
                      field: dataset?.fields.find((f) => f.type === "money")?.id ?? firstField,
                      agg: "sum",
                    },
                  ],
                })
              }
            >
              <Plus aria-hidden="true" className="size-3" /> Value
            </Button>
            <Button
              variant="secondary"
              className="flex-1 px-2 py-1 text-xs"
              onClick={() =>
                set({
                  measures: [
                    ...(query.measures ?? []),
                    {
                      id: uniqueId(
                        "formula",
                        (query.measures ?? []).map((m) => m.id),
                      ),
                      label: "New formula",
                      expr: "count()",
                    },
                  ],
                })
              }
            >
              <Plus aria-hidden="true" className="size-3" /> Formula
            </Button>
          </div>
        </div>
      )}

      <div>
        <p className="mb-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
          Only rows where
        </p>
        <DropSlot
          id={`${slotPrefix}filter`}
          empty={(query.filters ?? []).length === 0}
          hint="Drop a field here to filter by it."
        >
          <ul className="space-y-1.5">
            {(query.filters ?? []).map((f, i) => (
              <FilterRow
                // biome-ignore lint/suspicious/noArrayIndexKey: filters have no identity of their own.
                key={i}
                filter={f}
                query={query}
                onChange={(next) => {
                  const filters = [...(query.filters ?? [])];
                  filters[i] = next;
                  set({ filters });
                }}
                onRemove={() => set({ filters: (query.filters ?? []).filter((_, n) => n !== i) })}
              />
            ))}
          </ul>
        </DropSlot>
        <Button
          variant="ghost"
          className="mt-1 px-2 py-1 text-xs"
          onClick={() =>
            set({
              filters: [...(query.filters ?? []), { field: firstField, op: "eq", value: "" }],
            })
          }
        >
          <Plus aria-hidden="true" className="size-3" /> Filter
        </Button>
      </div>

      <details>
        <summary className="cursor-pointer text-xs font-medium text-slate-600 dark:text-slate-400">
          New columns, order and limits
        </summary>
        <div className="mt-2 space-y-2.5">
          <div>
            <p className="mb-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
              New column for each row
            </p>
            <ul className="space-y-1.5">
              {(query.calculated ?? []).map((c, i) => (
                <CalculatedRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: renaming changes the id, and mustn't lose focus.
                  key={i}
                  calc={c}
                  names={rowNames}
                  onChange={(next) => {
                    const calculated = [...(query.calculated ?? [])];
                    calculated[i] = next;
                    set({ calculated });
                  }}
                  onRemove={() =>
                    set({ calculated: (query.calculated ?? []).filter((_, n) => n !== i) })
                  }
                />
              ))}
            </ul>
            <Button
              variant="ghost"
              className="mt-1 px-2 py-1 text-xs"
              onClick={() =>
                set({
                  calculated: [
                    ...(query.calculated ?? []),
                    {
                      id: uniqueId(
                        "column",
                        (query.calculated ?? []).map((c) => c.id),
                      ),
                      label: "New column",
                      expr: `[${dataset?.fields[0]?.label ?? "Date"}]`,
                    },
                  ],
                })
              }
            >
              <Plus aria-hidden="true" className="size-3" /> Column
            </Button>
          </div>
          <div className="flex gap-1.5">
            <Label text="Sort by">
              <select
                value={query.sort?.[0]?.by ?? ""}
                onChange={(e) =>
                  set({
                    sort: e.target.value
                      ? [{ by: e.target.value, dir: query.sort?.[0]?.dir ?? "desc" }]
                      : undefined,
                  })
                }
                className={inputClass}
              >
                <option value="">Automatic</option>
                {[
                  ...(query.measures ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id })),
                  ...options.filter((o) => !query.measures?.some((m) => m.id === o.id)),
                ].map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Label>
            <Label text="Order">
              <select
                value={query.sort?.[0]?.dir ?? "desc"}
                disabled={!query.sort?.[0]}
                onChange={(e) => {
                  const first = query.sort?.[0];
                  if (first) set({ sort: [{ ...first, dir: e.target.value as "asc" | "desc" }] });
                }}
                className={inputClass}
              >
                <option value="desc">High to low</option>
                <option value="asc">Low to high</option>
              </select>
            </Label>
          </div>
          <Label text="Show at most">
            <input
              type="number"
              min={1}
              max={2000}
              value={query.limit ?? ""}
              placeholder="Every row"
              onChange={(e) => {
                const v = Number(e.target.value);
                set({ limit: e.target.value && v >= 1 ? Math.floor(v) : undefined });
              }}
              className={inputClass}
            />
          </Label>
          {query.limit !== undefined && (
            <Toggle
              label="Gather the rest as Other"
              checked={!!query.other}
              onChange={(other) => set({ other: other || undefined })}
            />
          )}
          <Toggle
            label="Show every date, even empty ones"
            checked={!!query.fill}
            onChange={(fill) => set({ fill: fill || undefined })}
          />
          <Toggle
            label="Keep every row separate"
            hint="For a list of transactions, rather than totals."
            checked={!!query.raw}
            onChange={(raw) => set({ raw: raw || undefined })}
          />
        </div>
      </details>
    </>
  );
}

function CalculatedRow({
  calc,
  names,
  onChange,
  onRemove,
}: {
  calc: CardCalculated;
  names: FormulaName[];
  onChange: (c: CardCalculated) => void;
  onRemove: () => void;
}) {
  return (
    <li className="space-y-1.5 rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800/50">
      <div className="flex gap-1">
        <input
          aria-label="Column name"
          value={calc.label ?? ""}
          placeholder={calc.id}
          onChange={(e) => onChange(clean({ ...calc, label: e.target.value || undefined }))}
          className={cx(inputClass, "font-medium")}
        />
        <button
          type="button"
          aria-label={`Remove ${calc.label ?? calc.id}`}
          onClick={onRemove}
          className="shrink-0 rounded p-1 text-slate-400 hover:text-red-600"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <FormulaInput
        label="Formula, for each row"
        value={calc.expr}
        names={names}
        placeholder={'if([Amount] < -100, "Large", "Small")'}
        onChange={(expr) => onChange({ ...calc, expr })}
      />
      <FormatSelect
        value={calc.format}
        onChange={(format) => onChange(clean({ ...calc, format }))}
      />
    </li>
  );
}

/** Which of a query's columns does a job in a list. */
function ColumnSelect({
  label,
  value,
  block,
  onChange,
  none = "Automatic",
  include = "all",
}: {
  label: string;
  value: string | undefined;
  block: CardBlock;
  onChange: (v: string | undefined) => void;
  none?: string;
  include?: "all" | "measures";
}) {
  const q = block.query;
  const options = [
    ...(include === "all"
      ? (q?.dimensions ?? []).map((d) => ({
          id: d.field,
          label: d.label ?? findFieldLabel(q, d.field),
        }))
      : []),
    ...(q?.measures ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id })),
  ];
  return (
    <Label text={label}>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={inputClass}
      >
        <option value="">{none}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Label>
  );
}

function findFieldLabel(query: CardQuery | undefined, field: string) {
  const info = query && DATASET_BY_ID.get(query.dataset);
  const f = info && findField(info, field);
  return f?.label ?? query?.calculated?.find((c) => c.id === field)?.label ?? field;
}

function OptionsEditor({
  block,
  doc,
  onChange,
}: {
  block: CardBlock;
  doc: CardDoc;
  onChange: (o: BlockOptions) => void;
}) {
  const o = block.options ?? {};
  const set = (patch: Partial<BlockOptions>) => onChange(clean({ ...o, ...patch }));
  const names = useMemo(() => namesFor(doc, block.query), [doc, block.query]);
  const text = (
    key: "label" | "compareLabel" | "markerLabel" | "center",
    label: string,
    ph?: string,
  ) => (
    <Label text={label}>
      <input
        value={o[key] ?? ""}
        placeholder={ph}
        onChange={(e) => set({ [key]: e.target.value || undefined })}
        className={inputClass}
      />
    </Label>
  );
  const formula = (
    key: "value" | "compare" | "target" | "marker",
    label: string,
    placeholder: string,
  ) =>
    o[key] === undefined ? (
      <Button
        variant="ghost"
        className="px-2 py-1 text-xs"
        onClick={() => set({ [key]: (doc.metrics?.[0] && `$${doc.metrics[0].id}`) || "0" })}
      >
        <Plus aria-hidden="true" className="size-3" /> {label}
      </Button>
    ) : (
      <div>
        <FormulaInput
          label={label}
          value={o[key] ?? ""}
          names={names}
          placeholder={placeholder}
          rows={1}
          onChange={(v) => set({ [key]: v })}
        />
        <button
          type="button"
          className="text-[11px] text-slate-500 hover:underline"
          onClick={() => set({ [key]: undefined })}
        >
          Remove
        </button>
      </div>
    );
  const liveText = (label: string, rows: number) => (
    <div>
      <Label text={label}>
        <textarea
          rows={rows}
          value={o.text ?? ""}
          onChange={(e) => set({ text: e.target.value || undefined })}
          className={inputClass}
        />
      </Label>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Put a formula in double braces for a live value: {"{{$spent}}"}
      </p>
    </div>
  );

  switch (block.kind) {
    case "stat":
      return (
        <>
          {text("label", "Label")}
          {formula("value", "Value from a formula", "$income - $spent")}
          <Label text="Size">
            <select
              value={o.size ?? "lg"}
              onChange={(e) => set({ size: e.target.value as BlockOptions["size"] })}
              className={inputClass}
            >
              <option value="sm">Small</option>
              <option value="md">Medium</option>
              <option value="lg">Large</option>
              <option value="xl">Extra large</option>
            </select>
          </Label>
          {formula("compare", "Compare with", "$last_month")}
          {o.compare !== undefined && (
            <>
              {text("compareLabel", "What it's compared with", "this point last month")}
              <Label text="Better when it's">
                <select
                  value={o.goodWhen ?? "either"}
                  onChange={(e) => set({ goodWhen: e.target.value as BlockOptions["goodWhen"] })}
                  className={inputClass}
                >
                  <option value="either">Neither</option>
                  <option value="up">Higher</option>
                  <option value="down">Lower</option>
                </select>
              </Label>
            </>
          )}
          {liveText("A line under it", 2)}
          <Toggle
            label="Draw a small line"
            hint="Group by a date above to give it something to draw."
            checked={!!o.spark}
            onChange={(spark) => set({ spark: spark || undefined })}
          />
        </>
      );
    case "text":
      return (
        <>
          {liveText("Text", 4)}
          <Label text="Style">
            <select
              value={o.tone ?? "normal"}
              onChange={(e) => set({ tone: e.target.value as BlockOptions["tone"] })}
              className={inputClass}
            >
              <option value="normal">Normal</option>
              <option value="muted">Quiet</option>
              <option value="positive">Good</option>
              <option value="negative">Bad</option>
              <option value="warning">Warning</option>
            </select>
          </Label>
          <FormulaInput
            label="Style from a formula (optional)"
            value={o.toneExpr ?? ""}
            names={names}
            rows={1}
            optional
            placeholder={'if($left < 0, "negative", "positive")'}
            onChange={(v) => set({ toneExpr: v || undefined })}
          />
        </>
      );
    case "heading":
      return (
        <>
          {liveText("Heading", 1)}
          <Label text="Link to a page (optional)">
            <input
              value={o.link?.to ?? ""}
              placeholder="/budgets"
              onChange={(e) =>
                set({
                  link: e.target.value
                    ? { to: e.target.value, label: o.link?.label ?? "Open" }
                    : undefined,
                })
              }
              className={inputClass}
            />
          </Label>
          {o.link && (
            <Label text="Link text">
              <input
                value={o.link.label}
                onChange={(e) => {
                  const link = o.link;
                  if (link) set({ link: { ...link, label: e.target.value } });
                }}
                className={inputClass}
              />
            </Label>
          )}
        </>
      );
    case "list":
      return (
        <>
          <ColumnSelect
            label="Title"
            value={o.title}
            block={block}
            onChange={(title) => set({ title })}
          />
          <ColumnSelect
            label="Detail"
            value={o.subtitle}
            block={block}
            onChange={(subtitle) => set({ subtitle })}
          />
          <ColumnSelect
            label="Amount"
            value={o.amount}
            block={block}
            include="measures"
            onChange={(amount) => set({ amount })}
          />
          <ColumnSelect
            label="Second amount"
            value={o.subamount}
            block={block}
            include="measures"
            onChange={(subamount) => set({ subamount })}
          />
          <ColumnSelect
            label="Gather rows under"
            value={o.groupBy}
            block={block}
            none="Nothing"
            onChange={(groupBy) => set({ groupBy })}
          />
          <Label text="Picture">
            <select
              value={o.icon ?? "none"}
              onChange={(e) => set({ icon: e.target.value as BlockOptions["icon"] })}
              className={inputClass}
            >
              <option value="none">None</option>
              <option value="merchant">Initials</option>
              <option value="category">Category icon</option>
              <option value="coin">Coin</option>
              <option value="rank">1, 2, 3…</option>
            </select>
          </Label>
          <Toggle
            label="Draw a bar under each row"
            checked={!!o.bar}
            onChange={(bar) => set({ bar: bar || undefined })}
          />
          <Toggle
            label="Color money in, and hide the minus on money out"
            checked={!!o.signColors}
            onChange={(signColors) => set({ signColors: signColors || undefined })}
          />
          <Toggle
            label="Flip the sign of amounts"
            checked={!!o.flip}
            onChange={(flip) => set({ flip: flip || undefined })}
          />
        </>
      );
    case "table":
      return (
        <Toggle
          label="Add a total row"
          checked={!!o.totals}
          onChange={(totals) => set({ totals: totals || undefined })}
        />
      );
    case "bars":
      return (
        <Toggle
          label="Show each one's share"
          checked={!!o.percent}
          onChange={(percent) => set({ percent: percent || undefined })}
        />
      );
    case "pie":
      return (
        <>
          <Toggle
            label="Hollow middle"
            checked={o.donut !== false}
            onChange={(donut) => set({ donut: donut ? undefined : false })}
          />
          {text("center", "In the middle", "The total")}
        </>
      );
    case "progress":
      return (
        <>
          {block.query?.dimensions?.length ? (
            <>
              <ColumnSelect
                label="Value"
                value={o.value}
                block={block}
                include="measures"
                onChange={(value) => set({ value })}
              />
              <ColumnSelect
                label="Target"
                value={o.target}
                block={block}
                include="measures"
                onChange={(target) => set({ target })}
              />
              <ColumnSelect
                label="Marker"
                value={o.marker}
                block={block}
                include="measures"
                none="None"
                onChange={(marker) => set({ marker })}
              />
            </>
          ) : (
            <>
              {formula("value", "Value", "$spent")}
              {formula("target", "Target", "$budget")}
              {formula("marker", "Marker", "$pace")}
            </>
          )}
          {text("label", "Label")}
          <Toggle
            label="Past the target is bad"
            checked={!!o.overIsBad}
            onChange={(overIsBad) => set({ overIsBad: overIsBad || undefined })}
          />
        </>
      );
    case "line":
    case "area":
    case "column":
      return (
        <>
          {block.kind !== "line" && (
            <Toggle
              label="Stack"
              hint="Add them up rather than side by side."
              checked={!!o.stacked}
              onChange={(stacked) => set({ stacked: stacked || undefined })}
            />
          )}
          <Label text="Height in pixels">
            <input
              type="number"
              min={60}
              max={800}
              value={o.height ?? 200}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 60 && v <= 800) set({ height: v });
              }}
              className={inputClass}
            />
          </Label>
          <div>
            <p className="mb-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
              Lines across the chart
            </p>
            <ul className="space-y-1.5">
              {(o.references ?? []).map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: these have no identity of their own.
                <li key={i} className="space-y-1 rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800/50">
                  <div className="flex gap-1">
                    <input
                      aria-label="Name"
                      value={r.label}
                      onChange={(e) => {
                        const references = [...(o.references ?? [])];
                        references[i] = { ...r, label: e.target.value };
                        set({ references });
                      }}
                      className={inputClass}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${r.label}`}
                      onClick={() =>
                        set({ references: (o.references ?? []).filter((_, n) => n !== i) })
                      }
                      className="shrink-0 rounded p-1 text-slate-400 hover:text-red-600"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </button>
                  </div>
                  <FormulaInput
                    label="At"
                    value={r.expr}
                    names={names}
                    rows={1}
                    placeholder="$earned"
                    onChange={(expr) => {
                      const references = [...(o.references ?? [])];
                      references[i] = { ...r, expr };
                      set({ references });
                    }}
                  />
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              className="mt-1 px-2 py-1 text-xs"
              onClick={() =>
                set({
                  references: [
                    ...(o.references ?? []),
                    { label: "Target", expr: doc.metrics?.[0] ? `$${doc.metrics[0].id}` : "100" },
                  ],
                })
              }
            >
              <Plus aria-hidden="true" className="size-3" /> Line
            </Button>
          </div>
        </>
      );
    case "treemap":
    case "scatter":
    case "waterfall":
      return (
        <Label text="Height in pixels">
          <input
            type="number"
            min={60}
            max={800}
            value={o.height ?? 240}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 60 && v <= 800) set({ height: v });
            }}
            className={inputClass}
          />
        </Label>
      );
    default:
      return <p className="text-xs text-slate-500">Nothing else to set.</p>;
  }
}

export function BlockInspector({
  block,
  doc,
  issues,
  onChange,
}: {
  block: CardBlock;
  doc: CardDoc;
  issues: string[];
  onChange: (b: CardBlock) => void;
}) {
  const info = BLOCK_KIND_INFO[block.kind];
  const [layer, setLayer] = useState(0);
  const layers = block.layers ?? [];
  const isChart = block.kind === "line" || block.kind === "area" || block.kind === "column";
  const activeLayer = Math.min(layer, layers.length);
  const query = activeLayer === 0 ? block.query : layers[activeLayer - 1];

  const setQuery = (q: CardQuery) => {
    if (activeLayer === 0) onChange({ ...block, query: q });
    else {
      const next = [...layers];
      next[activeLayer - 1] = q;
      onChange({ ...block, layers: next });
    }
  };

  return (
    <div>
      <div className="space-y-2.5 px-3 pb-3">
        <Label text="Kind of block">
          <select
            value={block.kind}
            onChange={(e) => {
              const kind = e.target.value as BlockKind;
              const next = BLOCK_KIND_INFO[kind];
              const { query: q, layers: l, ...rest } = block;
              onChange({
                ...rest,
                kind,
                ...(next.query && q ? { query: q } : {}),
                ...(next.query && (kind === "line" || kind === "area" || kind === "column") && l
                  ? { layers: l }
                  : {}),
                ...(next.query && !q ? { query: { dataset: "transactions" } } : {}),
              });
            }}
            className={inputClass}
          >
            {BLOCK_KINDS.map((k) => (
              <option key={k} value={k}>
                {BLOCK_KIND_INFO[k].label}
              </option>
            ))}
          </select>
        </Label>
        <Label text="Title (optional)">
          <input
            value={block.title ?? ""}
            onChange={(e) => {
              const { title: _t, ...rest } = block;
              onChange(e.target.value ? { ...rest, title: e.target.value } : rest);
            }}
            className={inputClass}
          />
        </Label>
        <Label text={`Width: ${block.w} of ${CARD_GRID_COLUMNS} columns`}>
          <input
            type="range"
            min={1}
            max={CARD_GRID_COLUMNS}
            value={block.w}
            onChange={(e) => onChange({ ...block, w: Number(e.target.value) })}
            className="w-full accent-brand-600"
          />
        </Label>
        {issues.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {issues.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>

      {info.query && (
        <Section title="Data">
          {isChart && (
            <div className="flex flex-wrap gap-1">
              {[null, ...layers].map((_, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: layers are positions.
                  key={i}
                  type="button"
                  aria-pressed={activeLayer === i}
                  onClick={() => setLayer(i)}
                  className={cx(
                    "rounded-md px-2 py-0.5 text-xs",
                    activeLayer === i
                      ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                      : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800",
                  )}
                >
                  Layer {i + 1}
                </button>
              ))}
              {layers.length < 4 && (
                <button
                  type="button"
                  onClick={() => {
                    const source = query ?? block.query;
                    const next: CardQuery = source
                      ? { ...structuredClone(source) }
                      : { dataset: "transactions" };
                    onChange({ ...block, layers: [...layers, next] });
                    setLayer(layers.length + 1);
                  }}
                  className="rounded-md px-2 py-0.5 text-xs text-brand-600 hover:underline dark:text-brand-500"
                >
                  + Layer
                </button>
              )}
              {activeLayer > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onChange({ ...block, layers: layers.filter((_, n) => n !== activeLayer - 1) });
                    setLayer(0);
                  }}
                  className="rounded-md px-2 py-0.5 text-xs text-red-600 hover:underline dark:text-red-400"
                >
                  Remove layer
                </button>
              )}
            </div>
          )}
          {query ? (
            <QueryEditor
              key={activeLayer}
              query={query}
              doc={doc}
              kind={block.kind}
              slotPrefix={activeLayer === 0 ? "" : `layer${activeLayer - 1}:`}
              onChange={setQuery}
            />
          ) : (
            <Button
              variant="secondary"
              className="w-full px-2 py-1 text-xs"
              onClick={() => setQuery({ dataset: "transactions" })}
            >
              <Plus aria-hidden="true" className="size-3" /> Add data
            </Button>
          )}
        </Section>
      )}

      <Section title="Look">
        <OptionsEditor
          block={block}
          doc={doc}
          onChange={(options) => {
            const { options: _o, ...rest } = block;
            onChange(Object.keys(options).length ? { ...rest, options } : rest);
          }}
        />
      </Section>
    </div>
  );
}

/** Named values: numbers worked out once and used anywhere on the card. */
export function MetricsEditor({
  doc,
  result,
  onChange,
}: {
  doc: CardDoc;
  result: CardResult | undefined;
  onChange: (metrics: CardMetric[]) => void;
}) {
  const metrics = doc.metrics ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, m: CardMetric) => {
    const next = [...metrics];
    next[i] = m;
    onChange(next);
  };
  const groups = [...new Set(DATASETS.map((d) => d.group))];
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-slate-500">
        A named value is worked out once and can be used in any formula or text on this card, as
        $name. It's how to do sums across different data.
      </p>
      <ul className="space-y-1.5">
        {metrics.map((m, i) => {
          const current = result?.metrics[m.id];
          const dataset = m.dataset ? DATASET_BY_ID.get(m.dataset) : undefined;
          const names: FormulaName[] = [
            ...metrics
              .filter((x) => x.id !== m.id)
              .map((x) => ({ insert: `$${x.id}`, label: `$${x.id}`, detail: x.label })),
            ...(dataset?.fields.map((f) => ({
              insert: `[${f.label}]`,
              label: f.label,
              detail: FORMAT_LABELS[f.type],
            })) ?? []),
          ];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: renaming changes the id, and mustn't lose focus.
            <li key={i} className="rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                aria-expanded={open === i}
                onClick={() => setOpen((o) => (o === i ? null : i))}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs">${m.id}</span>
                  {m.label && (
                    <span className="block truncate text-[11px] text-slate-500">{m.label}</span>
                  )}
                </span>
                <span
                  className={cx(
                    "shrink-0 text-xs tabular-nums",
                    current && "error" in current && "text-red-600 dark:text-red-400",
                  )}
                >
                  {current ? ("error" in current ? "Error" : current.text) : "…"}
                </span>
              </button>
              {open === i && (
                <div className="space-y-2 border-t border-slate-200 p-2 dark:border-slate-800">
                  {current && "error" in current && (
                    <p className="text-xs text-red-600 dark:text-red-400">{current.error}</p>
                  )}
                  <Label text="Name in formulas">
                    <input
                      value={m.id}
                      spellCheck={false}
                      onChange={(e) =>
                        set(i, {
                          ...m,
                          id: e.target.value.replace(/[^A-Za-z0-9_]/g, "_") || "value",
                        })
                      }
                      className={cx(inputClass, "font-mono")}
                    />
                  </Label>
                  <Label text="Description">
                    <input
                      value={m.label ?? ""}
                      onChange={(e) => set(i, clean({ ...m, label: e.target.value || undefined }))}
                      className={inputClass}
                    />
                  </Label>
                  <Label text="Worked out over">
                    <select
                      value={m.dataset ?? ""}
                      onChange={(e) => {
                        const { dataset: _d, range: _r, filters: _f, ...rest } = m;
                        set(i, e.target.value ? { ...rest, dataset: e.target.value } : rest);
                      }}
                      className={inputClass}
                    >
                      <option value="">Other named values only</option>
                      {groups.map((g) => (
                        <optgroup key={g} label={g}>
                          {DATASETS.filter((d) => d.group === g).map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </Label>
                  {dataset?.dateField && (
                    <RangeEditor
                      range={m.range}
                      onChange={(range) => {
                        const { range: _r, ...rest } = m;
                        set(i, range ? { ...rest, range } : rest);
                      }}
                    />
                  )}
                  <FormulaInput
                    label="Formula"
                    value={m.expr}
                    names={names}
                    placeholder={m.dataset ? "sum([Spending])" : "$income - $spent"}
                    onChange={(expr) => set(i, { ...m, expr })}
                  />
                  <FormatSelect
                    value={m.format}
                    onChange={(format) => set(i, clean({ ...m, format }))}
                  />
                  {m.dataset && (
                    <div>
                      <p className="mb-0.5 text-xs font-medium text-slate-600 dark:text-slate-400">
                        Only rows where
                      </p>
                      <ul className="space-y-1.5">
                        {(m.filters ?? []).map((f, n) => (
                          <FilterRow
                            // biome-ignore lint/suspicious/noArrayIndexKey: filters have no identity of their own.
                            key={n}
                            filter={f}
                            query={{ dataset: m.dataset ?? "" }}
                            onChange={(next) => {
                              const filters = [...(m.filters ?? [])];
                              filters[n] = next;
                              set(i, { ...m, filters });
                            }}
                            onRemove={() =>
                              set(i, { ...m, filters: (m.filters ?? []).filter((_, x) => x !== n) })
                            }
                          />
                        ))}
                      </ul>
                      <Button
                        variant="ghost"
                        className="mt-1 px-2 py-1 text-xs"
                        onClick={() =>
                          set(i, {
                            ...m,
                            filters: [
                              ...(m.filters ?? []),
                              { field: dataset?.fields[0]?.id ?? "", op: "eq", value: "" },
                            ],
                          })
                        }
                      >
                        <Plus aria-hidden="true" className="size-3" /> Filter
                      </Button>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs text-red-600 dark:text-red-400"
                    onClick={() => {
                      onChange(metrics.filter((_, n) => n !== i));
                      setOpen(null);
                    }}
                  >
                    <Trash2 aria-hidden="true" className="size-3" /> Remove
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Button
        variant="secondary"
        className="w-full px-2 py-1 text-xs"
        onClick={() => {
          onChange([
            ...metrics,
            {
              id: uniqueId(
                "value",
                metrics.map((m) => m.id),
              ),
              dataset: "transactions",
              range: { preset: "this_month" },
              expr: "sum([Spending])",
            },
          ]);
          setOpen(metrics.length);
        }}
      >
        <Plus aria-hidden="true" className="size-3" /> Named value
      </Button>
    </div>
  );
}
