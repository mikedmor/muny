/**
 * Runs a card: filters and groups a dataset's rows, works out formulas, and
 * returns plain numbers and text. It only ever reads what its provider hands it,
 * so it can't change anything, and it's pure, so it's tested without a database.
 *
 * Inside a formula, money is exact dollars (a fraction, never a float), so $100
 * means a hundred dollars. It comes back out as rounded integer cents.
 */
import { DATASET_BY_ID, type DatasetInfo, type FieldType, findField } from "./catalog.js";
import {
  type BlockResult,
  type CardBlock,
  type CardCell,
  type CardDimension,
  type CardDoc,
  type CardFilter,
  type CardMeasure,
  type CardMetric,
  type CardQuery,
  type CardResult,
  type CardTone,
  type DateBucket,
  type DateRange,
  MAX_OUTPUT_ROWS,
  type QueryResult,
  type ResolvedValue,
  type ResultColumn,
} from "./doc.js";
import { type Expr, ExprError, FUNCTION_BY_NAME, parseExpr } from "./expr.js";
import { formatCell } from "./format.js";
import type { Rat } from "./rational.js";
import * as R from "./rational.js";

export type RawValue = string | number | boolean | null | undefined;
export type DataRow = Record<string, RawValue>;

/** Hands over a dataset's rows. A date range lets it skip work; rows outside it are dropped anyway. */
export type DataProvider = (dataset: string, range: { from?: string; to?: string }) => DataRow[];

type Val = Rat | string | boolean | null;

const isRat = (v: Val): v is Rat => typeof v === "object" && v !== null;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const toDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, n: number) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

function daysInMonth(iso: string) {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonthsToMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function addMonthsToDate(iso: string, n: number) {
  const target = addMonthsToMonth(iso.slice(0, 7), n);
  const day = Math.min(Number(iso.slice(8, 10)) || 1, daysInMonth(target));
  return `${target}-${String(day).padStart(2, "0")}`;
}

const endOfMonth = (month: string) => `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;

/** First and last day of a range. All time has neither. */
export function resolveRange(
  range: DateRange | undefined,
  today: string,
): { from?: string; to?: string } {
  if (!range) return {};
  const month = today.slice(0, 7);
  if ("preset" in range) {
    switch (range.preset) {
      case "this_month":
        return { from: `${month}-01`, to: today };
      case "last_month": {
        const m = addMonthsToMonth(month, -1);
        return { from: `${m}-01`, to: endOfMonth(m) };
      }
      case "this_and_last_month":
        return { from: `${addMonthsToMonth(month, -1)}-01`, to: today };
      case "last_3_months":
        return { from: `${addMonthsToMonth(month, -2)}-01`, to: today };
      case "last_6_months":
        return { from: `${addMonthsToMonth(month, -5)}-01`, to: today };
      case "last_12_months":
        return { from: `${addMonthsToMonth(month, -11)}-01`, to: today };
      case "this_year":
        return { from: `${today.slice(0, 4)}-01-01`, to: today };
      case "last_year": {
        const y = Number(today.slice(0, 4)) - 1;
        return { from: `${y}-01-01`, to: `${y}-12-31` };
      }
      case "last_7_days":
        return { from: addDays(today, -6), to: today };
      case "last_30_days":
        return { from: addDays(today, -29), to: today };
      case "last_90_days":
        return { from: addDays(today, -89), to: today };
      case "next_7_days":
        return { from: today, to: addDays(today, 7) };
      case "next_30_days":
        return { from: today, to: addDays(today, 30) };
      case "next_90_days":
        return { from: today, to: addDays(today, 90) };
      case "all_time":
        return {};
    }
  }
  if ("from" in range) return { from: range.from, to: range.to };
  const out: { from?: string; to?: string } = {};
  if (range.last !== undefined)
    out.from =
      range.unit === "days"
        ? addDays(today, -(range.last - 1))
        : `${addMonthsToMonth(month, -(range.last - 1))}-01`;
  if (range.next !== undefined)
    out.to =
      range.unit === "days" ? addDays(today, range.next) : addMonthsToDate(today, range.next);
  if (range.last !== undefined && range.next === undefined) out.to = today;
  if (range.next !== undefined && range.last === undefined) out.from = today;
  return out;
}

function bucketKey(value: string, bucket: DateBucket): CardCell {
  // Month-only fields read as the 1st of the month.
  const iso = value.length === 7 ? `${value}-01` : value.slice(0, 10);
  switch (bucket) {
    case "day":
      return iso;
    case "week": {
      const day = (toDate(iso).getUTCDay() + 6) % 7;
      return addDays(iso, -day);
    }
    case "month":
      return iso.slice(0, 7);
    case "quarter":
      return `${iso.slice(0, 4)}-Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
    case "year":
      return iso.slice(0, 4);
    case "day_of_month":
      return Number(iso.slice(8, 10));
    case "weekday":
      return ((toDate(iso).getUTCDay() + 6) % 7) + 1;
    case "month_of_year":
      return Number(iso.slice(5, 7));
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function toVal(raw: RawValue, type: FieldType): Val {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw;
  if (type === "money" || type === "number" || type === "percent") {
    if (typeof raw === "number") return type === "money" ? R.fromCents(raw) : R.fromNumber(raw);
    return R.fromDecimal(raw);
  }
  if (typeof raw === "number") return R.fromNumber(raw);
  return raw;
}

function toCell(v: Val, type: FieldType): CardCell {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return v;
  if (type === "money") return R.toCents(v);
  if (type === "number" || type === "percent") return R.toNumber(v);
  return R.ratToString(v);
}

const cellToVal = (c: CardCell, type: FieldType): Val =>
  typeof c === "number" ? (toVal(c, type) as Val) : c;

const valText = (v: Val, type: FieldType): string =>
  v === null ? "" : formatCell(toCell(v, type), type);

function truthy(v: Val): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (isRat(v)) return v.n !== 0n;
  return v !== "";
}

function compareVals(a: Val, b: Val): number {
  if (isRat(a) && isRat(b)) return R.cmp(a, b);
  const x = a === null ? "" : isRat(a) ? R.ratToString(a) : String(a);
  const y = b === null ? "" : isRat(b) ? R.ratToString(b) : String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function equalVals(a: Val, b: Val): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return compareVals(a, b) === 0;
}

const textOf = (v: Val): string => (v === null ? "" : isRat(v) ? R.ratToString(v) : String(v));
const num = (v: Val): number => (isRat(v) ? R.toNumber(v) : 0);

// ---------------------------------------------------------------------------
// Types: what a formula's result is, so it's shown properly
// ---------------------------------------------------------------------------

type TypeLookup = { ref: (name: string) => FieldType | null; metric: (name: string) => FieldType };

export function inferType(e: Expr, lookup: TypeLookup): FieldType {
  const of = (x: Expr) => inferType(x, lookup);
  switch (e.k) {
    case "num":
    case "null":
      return "number";
    case "str":
      return "text";
    case "bool":
    case "not":
      return "boolean";
    case "ref":
      return lookup.ref(e.name) ?? "number";
    case "metric":
      return lookup.metric(e.name);
    case "neg":
      return of(e.a);
    case "bin": {
      const a = of(e.a);
      const b = of(e.b);
      switch (e.op) {
        case "+":
        case "-":
          if (a === "money" || b === "money") return "money";
          if (a === "percent" && b === "percent") return "percent";
          return a;
        case "*":
          if (a === "money" || b === "money") return "money";
          return a === "percent" && b === "percent" ? "percent" : "number";
        case "/":
          if (a === "money" && b === "money") return "number";
          if (a === "percent" && b === "percent") return "number";
          return a;
        case "^":
          return a;
        case "&":
          return "text";
        default:
          return "boolean";
      }
    }
    case "call": {
      const first = e.args[0];
      switch (e.fn) {
        case "sum":
        case "avg":
        case "min":
        case "max":
        case "median":
        case "first":
        case "last":
        case "running_sum":
        case "running_avg":
        case "moving_avg":
        case "prev":
        case "next":
        case "diff":
        case "total":
        case "abs":
        case "round":
        case "floor":
        case "ceil":
        case "mod":
        case "least":
        case "greatest":
        case "coalesce":
          return first ? of(first) : "number";
        case "if": {
          const then = e.args[1];
          const otherwise = e.args[2];
          if (then && then.k !== "null") return of(then);
          return otherwise ? of(otherwise) : "number";
        }
        case "pct_change":
        case "pct_of_total":
          return "percent";
        case "is_empty":
        case "contains":
        case "starts_with":
        case "ends_with":
          return "boolean";
        case "lower":
        case "upper":
        case "trim":
        case "left":
        case "right":
        case "replace":
        case "text":
        case "month_name":
          return "text";
        case "today":
        case "add_days":
        case "add_months":
        case "start_of_month":
        case "end_of_month":
          return "date";
        case "this_month":
        case "last_month":
        case "month_key":
          return "month";
        default:
          return "number";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------

interface EvalContext {
  today: string;
  ref(name: string): Val;
  metric(name: string): Val;
  /** A total over rows; not available when working out a single row. */
  aggregate(call: Extract<Expr, { k: "call" }>): Val;
  /** Reads the result's rows; only available when working out a measure. */
  window(call: Extract<Expr, { k: "call" }>): Val;
  typeOf(e: Expr): FieldType;
}

function requireDate(v: Val): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}/.test(v) ? v : null;
}

function evaluate(e: Expr, ctx: EvalContext): Val {
  switch (e.k) {
    case "num":
    case "str":
    case "bool":
      return e.v;
    case "null":
      return null;
    case "ref":
      return ctx.ref(e.name);
    case "metric":
      return ctx.metric(e.name);
    case "neg": {
      const a = evaluate(e.a, ctx);
      return isRat(a) ? R.neg(a) : null;
    }
    case "not":
      return !truthy(evaluate(e.a, ctx));
    case "bin":
      return evalBinary(e, ctx);
    case "call":
      return evalCall(e, ctx);
  }
}

function evalBinary(e: Extract<Expr, { k: "bin" }>, ctx: EvalContext): Val {
  if (e.op === "and") return truthy(evaluate(e.a, ctx)) && truthy(evaluate(e.b, ctx));
  if (e.op === "or") return truthy(evaluate(e.a, ctx)) || truthy(evaluate(e.b, ctx));
  const a = evaluate(e.a, ctx);
  const b = evaluate(e.b, ctx);
  if (e.op === "&") return `${textOf(a)}${textOf(b)}`;
  if (e.op === "=") return equalVals(a, b);
  if (e.op === "!=") return !equalVals(a, b);
  if (e.op === "<" || e.op === "<=" || e.op === ">" || e.op === ">=") {
    if (a === null || b === null) return false;
    const c = compareVals(a, b);
    return e.op === "<" ? c < 0 : e.op === "<=" ? c <= 0 : e.op === ">" ? c > 0 : c >= 0;
  }
  if (!isRat(a) || !isRat(b)) return null;
  switch (e.op) {
    case "+":
      return R.add(a, b);
    case "-":
      return R.sub(a, b);
    case "*":
      return R.mul(a, b);
    case "/":
      return R.div(a, b);
    case "^":
      return R.pow(a, b);
  }
}

function evalCall(e: Extract<Expr, { k: "call" }>, ctx: EvalContext): Val {
  const scope = FUNCTION_BY_NAME.get(e.fn)?.scope;
  if (scope === "aggregate") return ctx.aggregate(e);
  if (scope === "window") return ctx.window(e);

  // These only work out what they need.
  if (e.fn === "if") {
    const [test, then, otherwise] = e.args as [Expr, Expr, Expr | undefined];
    if (truthy(evaluate(test, ctx))) return evaluate(then, ctx);
    return otherwise ? evaluate(otherwise, ctx) : null;
  }
  if (e.fn === "coalesce") {
    for (const a of e.args) {
      const v = evaluate(a, ctx);
      if (v !== null) return v;
    }
    return null;
  }
  if (e.fn === "text") {
    const a = e.args[0] as Expr;
    return valText(evaluate(a, ctx), ctx.typeOf(a));
  }

  const args = e.args.map((a) => evaluate(a, ctx));
  const a = args[0] ?? null;
  const b = args[1] ?? null;
  const today = ctx.today;
  switch (e.fn) {
    case "abs":
      return isRat(a) ? R.abs(a) : null;
    case "round":
      return isRat(a) ? R.round(a, isRat(b) ? num(b) : 0) : null;
    case "floor":
      return isRat(a) ? R.floor(a) : null;
    case "ceil":
      return isRat(a) ? R.ceil(a) : null;
    case "mod": {
      if (!isRat(a) || !isRat(b) || b.n === 0n) return null;
      const q = R.div(a, b) as Rat;
      return R.sub(a, R.mul(b, R.floor(q)));
    }
    case "least":
    case "greatest": {
      const known = args.filter((v) => v !== null);
      if (!known.length) return null;
      return known.reduce((x, y) => {
        const c = compareVals(x, y);
        return (e.fn === "least" ? c <= 0 : c >= 0) ? x : y;
      });
    }
    case "is_empty":
      return a === null || a === "";
    case "lower":
      return textOf(a).toLowerCase();
    case "upper":
      return textOf(a).toUpperCase();
    case "trim":
      return textOf(a).trim();
    case "length":
      return R.rat(textOf(a).length);
    case "left":
      return textOf(a).slice(0, Math.max(0, num(b)));
    case "right": {
      const n = Math.max(0, num(b));
      return n === 0 ? "" : textOf(a).slice(-n);
    }
    case "contains":
      return textOf(a).toLowerCase().includes(textOf(b).toLowerCase());
    case "starts_with":
      return textOf(a).toLowerCase().startsWith(textOf(b).toLowerCase());
    case "ends_with":
      return textOf(a).toLowerCase().endsWith(textOf(b).toLowerCase());
    case "replace":
      return textOf(a)
        .split(textOf(b))
        .join(textOf(args[2] ?? null));
    case "today":
      return today;
    case "this_month":
      return today.slice(0, 7);
    case "last_month":
      return addMonthsToMonth(today.slice(0, 7), -1);
  }

  // Everything left reads a date.
  const d = requireDate(a);
  if (!d) return null;
  const iso = d.length === 7 ? `${d}-01` : d.slice(0, 10);
  switch (e.fn) {
    case "year":
      return R.rat(Number(iso.slice(0, 4)));
    case "month":
      return R.rat(Number(iso.slice(5, 7)));
    case "day":
      return R.rat(Number(iso.slice(8, 10)));
    case "weekday":
      return R.rat(((toDate(iso).getUTCDay() + 6) % 7) + 1);
    case "quarter":
      return R.rat(Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1);
    case "month_key":
      return iso.slice(0, 7);
    case "month_name":
      return toDate(iso).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    case "add_days":
      return isRat(b) ? addDays(iso, Math.trunc(num(b))) : null;
    case "add_months":
      return isRat(b) ? addMonthsToDate(iso, Math.trunc(num(b))) : null;
    case "days_between": {
      const other = requireDate(b);
      if (!other) return null;
      const ms =
        toDate(other.length === 7 ? `${other}-01` : other).getTime() - toDate(iso).getTime();
      return R.rat(Math.round(ms / 86_400_000));
    }
    case "start_of_month":
      return `${iso.slice(0, 7)}-01`;
    case "end_of_month":
      return endOfMonth(iso.slice(0, 7));
    case "days_in_month":
      return R.rat(daysInMonth(iso.slice(0, 7)));
    default:
      throw new ExprError(`${e.fn}() can't be used here.`);
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface PreparedField {
  type: FieldType;
  expr?: Expr;
}

interface Group {
  keys: CardCell[];
  rows: DataRow[];
}

const lookups = new WeakMap<object, ReturnType<typeof buildLookup>>();

/** Formulas ask for this once per row, so it's only built once. */
function fieldLookup(dataset: DatasetInfo, query: Pick<CardQuery, "calculated">) {
  const key = query.calculated ?? dataset;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = buildLookup(dataset, query);
    lookups.set(key, lookup);
  }
  return lookup;
}

function buildLookup(dataset: DatasetInfo, query: Pick<CardQuery, "calculated">) {
  const calc = new Map<string, { id: string; type: FieldType | null; expr: Expr }>();
  for (const c of query.calculated ?? []) {
    const entry = { id: c.id, type: c.format ?? null, expr: parseExpr(c.expr) };
    calc.set(c.id.toLowerCase(), entry);
    if (c.label) calc.set(c.label.toLowerCase(), entry);
  }
  const find = (name: string): { id: string; field?: PreparedField } | null => {
    const hit = calc.get(name.trim().toLowerCase());
    if (hit) return { id: hit.id };
    const f = findField(dataset, name);
    return f ? { id: f.id, field: { type: f.type } } : null;
  };
  return { calc, find };
}

function unknownField(dataset: DatasetInfo, name: string): ExprError {
  return new ExprError(`${dataset.label} has no field called "${name}".`);
}

function matches(v: Val, f: CardFilter, type: FieldType): boolean {
  const value = f.value;
  const asVal = (x: string | number | boolean): Val => {
    if (typeof x === "boolean") return x;
    if (type === "money" || type === "number" || type === "percent") {
      const parsed =
        typeof x === "number" ? R.fromNumber(x) : R.fromDecimal(x.replace(/[$,\s]/g, ""));
      if (!parsed) return String(x);
      return type === "percent" ? (R.div(parsed, R.rat(100)) as Rat) : parsed;
    }
    return String(x);
  };
  switch (f.op) {
    case "is_empty":
      return v === null || v === "";
    case "not_empty":
      return !(v === null || v === "");
    case "is_true":
      return v === true;
    case "is_false":
      return v === false || v === null;
    case "contains":
      return textOf(v)
        .toLowerCase()
        .includes(String(value ?? "").toLowerCase());
    case "not_contains":
      return !value || !textOf(v).toLowerCase().includes(String(value).toLowerCase());
    case "in":
    case "not_in": {
      const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
      if (!list.length) return true;
      const found = list.some((x) => equalVals(v, asVal(x)));
      return f.op === "in" ? found : !found;
    }
  }
  if (value === undefined || value === "") return true;
  if (Array.isArray(value)) return false;
  const target = asVal(value);
  switch (f.op) {
    case "eq":
      return equalVals(v, target);
    case "ne":
      return !equalVals(v, target);
    case "gt":
      return v !== null && compareVals(v, target) > 0;
    case "gte":
      return v !== null && compareVals(v, target) >= 0;
    case "lt":
      return v !== null && compareVals(v, target) < 0;
    case "lte":
      return v !== null && compareVals(v, target) <= 0;
  }
  return false;
}

/** The rows a query or metric reads: in range, calculated, filtered, oldest first. */
function loadRows(
  runner: Runner,
  dataset: DatasetInfo,
  range: DateRange | undefined,
  filters: CardFilter[] | undefined,
  calculated: CardQuery["calculated"],
): { rows: DataRow[]; resolved: { from?: string; to?: string } } {
  const resolved = resolveRange(range, runner.today);
  let rows = runner.provider(dataset.id, resolved);
  const dateField = dataset.dateField ? findField(dataset, dataset.dateField) : undefined;
  if (dateField && (resolved.from || resolved.to)) {
    const monthOnly = dateField.type === "month";
    const from = monthOnly ? resolved.from?.slice(0, 7) : resolved.from;
    const to = monthOnly ? resolved.to?.slice(0, 7) : resolved.to;
    rows = rows.filter((r) => {
      const v = r[dateField.id];
      if (typeof v !== "string") return false;
      return (!from || v >= from) && (!to || v <= to);
    });
  }

  const { calc, find } = fieldLookup(dataset, { calculated });
  if (calc.size) {
    const columns = (calculated ?? []).map((c) => {
      const expr = parseExpr(c.expr);
      return { id: c.id, expr, type: c.format ?? inferRowType(expr, dataset, calculated, runner) };
    });
    rows = rows.map((row) => {
      const out = { ...row };
      const ctx = runnerRowContext(runner, dataset, calculated, out);
      for (const c of columns) out[c.id] = rawFromVal(evaluate(c.expr, ctx), c.type);
      return out;
    });
  }

  for (const f of filters ?? []) {
    const hit = find(f.field);
    if (!hit) throw unknownField(dataset, f.field);
    const type = hit.field?.type ?? calculatedType(hit.id, dataset, calculated, runner);
    rows = rows.filter((r) => matches(toVal(r[hit.id], type), f, type));
  }

  if (dateField) {
    const id = dateField.id;
    rows = [...rows].sort((a, b) => String(a[id] ?? "").localeCompare(String(b[id] ?? "")));
  }
  return { rows, resolved };
}

/** A calculated value, stored on its row the way a real field's would be. */
function rawFromVal(v: Val, type: FieldType): RawValue {
  if (!isRat(v)) return v;
  if (type === "money") return R.toCents(v);
  return R.ratToString(v);
}

function calculatedType(
  id: string,
  dataset: DatasetInfo,
  calculated: CardQuery["calculated"],
  runner: Runner,
): FieldType {
  const c = calculated?.find((x) => x.id === id);
  if (!c) return "number";
  return c.format ?? inferRowType(parseExpr(c.expr), dataset, calculated, runner);
}

function inferRowType(
  expr: Expr,
  dataset: DatasetInfo,
  calculated: CardQuery["calculated"],
  runner: Runner,
): FieldType {
  const { find } = fieldLookup(dataset, { calculated });
  return inferType(expr, {
    ref: (name) => {
      const hit = find(name);
      if (!hit) return null;
      return hit.field?.type ?? calculatedType(hit.id, dataset, calculated, runner);
    },
    metric: (name) => runner.metricType(name),
  });
}

function runnerRowContext(
  runner: Runner,
  dataset: DatasetInfo,
  calculated: CardQuery["calculated"],
  row: DataRow,
): EvalContext {
  const { find } = fieldLookup(dataset, { calculated });
  const typeOf = (name: string, hit: NonNullable<ReturnType<typeof find>>) =>
    hit.field?.type ?? calculatedType(hit.id, dataset, calculated, runner) ?? name;
  return {
    today: runner.today,
    ref(name) {
      const hit = find(name);
      if (!hit) throw unknownField(dataset, name);
      return toVal(row[hit.id], typeOf(name, hit) as FieldType);
    },
    metric: (name) => runner.metricValue(name),
    aggregate(call) {
      throw new ExprError(
        `${call.fn}() works on many rows, so it can't go inside a row's formula.`,
      );
    },
    window(call) {
      throw new ExprError(
        `${call.fn}() reads the result's rows, so it can't go inside a row's formula.`,
      );
    },
    typeOf: (e) => inferRowType(e, dataset, calculated, runner),
  };
}

/** One total over rows, from any aggregate call. */
function aggregateOver(
  call: Extract<Expr, { k: "call" }>,
  rows: DataRow[],
  rowContext: (row: DataRow) => EvalContext,
  fastCents?: (row: DataRow) => number | null,
): Val {
  const fn = call.fn;
  if (fn === "count") {
    const cond = call.args[0];
    if (!cond) return R.rat(rows.length);
    let n = 0;
    for (const row of rows) if (truthy(evaluate(cond, rowContext(row)))) n++;
    return R.rat(n);
  }
  const [arg, cond] = call.args as [Expr, Expr | undefined];

  // The common case, adding up a money field, stays in integers.
  if (fn === "sum" && !cond && fastCents) {
    let cents = 0;
    let any = false;
    for (const row of rows) {
      const c = fastCents(row);
      if (c !== null) {
        cents += c;
        any = true;
      }
    }
    return any ? R.fromCents(cents) : R.ZERO;
  }

  const values: Val[] = [];
  for (const row of rows) {
    const ctx = rowContext(row);
    if (cond && !truthy(evaluate(cond, ctx))) continue;
    const v = evaluate(arg, ctx);
    if (v !== null) values.push(v);
  }
  switch (fn) {
    case "sum": {
      let total = R.ZERO;
      for (const v of values) if (isRat(v)) total = R.add(total, v);
      return total;
    }
    case "avg": {
      const nums = values.filter(isRat);
      if (!nums.length) return null;
      return R.div(
        nums.reduce((x, y) => R.add(x, y), R.ZERO),
        R.rat(nums.length),
      );
    }
    case "min":
    case "max":
      if (!values.length) return null;
      return values.reduce((x, y) => {
        const c = compareVals(x, y);
        return (fn === "min" ? c <= 0 : c >= 0) ? x : y;
      });
    case "median": {
      const nums = values.filter(isRat).sort(R.cmp);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      if (nums.length % 2) return nums[mid] as Rat;
      return R.div(R.add(nums[mid - 1] as Rat, nums[mid] as Rat), R.rat(2));
    }
    case "count_distinct":
      return R.rat(new Set(values.map(textOf)).size);
    case "first":
      return values[0] ?? null;
    case "last":
      return values[values.length - 1] ?? null;
    default:
      throw new ExprError(`${fn}() can't be used here.`);
  }
}

const dimensionLabel = (d: CardDimension, dataset: DatasetInfo, calcLabel?: string) =>
  d.label ?? calcLabel ?? findField(dataset, d.field)?.label ?? d.field;

function compareCells(a: CardCell, b: CardCell): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

const MAX_FILLED_ROWS = 20_000;
const MAX_MOVING_WINDOW = 366;

const TIME_BUCKETS = new Set<DateBucket>(["day", "week", "month", "quarter", "year"]);

/** Every bucket from one date to another. */
function bucketsBetween(from: string, to: string, bucket: DateBucket): CardCell[] {
  const out: CardCell[] = [];
  const seen = new Set<CardCell>();
  const step = bucket === "day" || bucket === "week" ? 7 : 28;
  const push = (iso: string) => {
    const k = bucketKey(iso, bucket);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };
  if (bucket === "day") {
    for (let d = from; d <= to && out.length < MAX_OUTPUT_ROWS; d = addDays(d, 1)) push(d);
    return out;
  }
  for (let d = from; d <= to && out.length < MAX_OUTPUT_ROWS; d = addDays(d, step)) push(d);
  push(to);
  return out;
}

/** Add the buckets with nothing in them, so a chart's axis has no holes. */
function fillGroups(
  groups: Map<string, Group>,
  dims: CardDimension[],
  rows: DataRow[],
  dateId: string,
  resolved: { from?: string; to?: string },
  today: string,
) {
  const bucket = dims[0]?.bucket;
  if (!bucket || dims.length > 2) return;
  const dates = rows.map((r) => r[dateId]).filter((d): d is string => typeof d === "string");
  const series =
    dims.length === 2 ? [...new Set([...groups.values()].map((g) => g.keys[1] ?? null))] : [null];

  let axis: (series: CardCell) => CardCell[];
  if (TIME_BUCKETS.has(bucket)) {
    const toIsoDate = (d: string) => (d.length === 7 ? `${d}-01` : d);
    const first = resolved.from ?? dates[0];
    let last = resolved.to ?? dates[dates.length - 1];
    if (!first || !last) return;
    const latest = dates[dates.length - 1];
    // Don't draw the future unless the data goes there.
    if (last > today && !(latest && latest > today)) last = today;
    const all = bucketsBetween(toIsoDate(first), toIsoDate(last), bucket);
    axis = () => all;
  } else if (bucket === "day_of_month") {
    axis = (s) => {
      let month = typeof s === "string" && /^\d{4}-\d{2}$/.test(s) ? s : null;
      if (!month && resolved.from && resolved.to?.slice(0, 7) === resolved.from.slice(0, 7))
        month = resolved.from.slice(0, 7);
      const end = !month
        ? 31
        : month === today.slice(0, 7)
          ? Number(today.slice(8, 10))
          : daysInMonth(month);
      return Array.from({ length: end }, (_, i) => i + 1);
    };
  } else if (bucket === "weekday") {
    axis = () => [1, 2, 3, 4, 5, 6, 7];
  } else {
    axis = () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  }

  // Daily rows for thousands of merchants would be enormous and unreadable: leave the gaps.
  const planned = series.reduce<number>((sum, s) => sum + axis(s).length, 0);
  if (planned > MAX_FILLED_ROWS) return;

  for (const s of series) {
    for (const k of axis(s)) {
      const keys = dims.length === 2 ? [k, s] : [k];
      const id = JSON.stringify(keys);
      if (!groups.has(id)) groups.set(id, { keys, rows: [] });
    }
  }
}

function runQuery(runner: Runner, query: CardQuery): QueryResult {
  const dataset = DATASET_BY_ID.get(query.dataset);
  if (!dataset) throw new ExprError(`There's no dataset called "${query.dataset}".`);
  const { rows, resolved } = loadRows(
    runner,
    dataset,
    query.range,
    query.filters,
    query.calculated,
  );
  const { calc, find } = fieldLookup(dataset, query);
  const fieldType = (id: string, f?: PreparedField) =>
    f?.type ?? calculatedType(id, dataset, query.calculated, runner);

  // Dimensions
  const dims = query.dimensions ?? [];
  const dimInfo = dims.map((d) => {
    const hit = find(d.field);
    if (!hit) throw unknownField(dataset, d.field);
    return { dim: d, id: hit.id, type: fieldType(hit.id, hit.field) };
  });
  const dimCell = (row: DataRow, info: (typeof dimInfo)[number]): CardCell => {
    const raw = row[info.id] ?? null;
    if (info.dim.bucket && typeof raw === "string") return bucketKey(raw, info.dim.bucket);
    return raw;
  };

  // Group
  const groupMap = new Map<string, Group>();
  if (query.raw) {
    rows.forEach((row, i) => {
      groupMap.set(String(i), { keys: dimInfo.map((d) => dimCell(row, d)), rows: [row] });
    });
  } else {
    for (const row of rows) {
      const keys = dimInfo.map((d) => dimCell(row, d));
      const id = JSON.stringify(keys);
      const g = groupMap.get(id);
      if (g) g.rows.push(row);
      else groupMap.set(id, { keys, rows: [row] });
    }
    const dateId = dimInfo[0]?.id;
    if (query.fill && dateId) fillGroups(groupMap, dims, rows, dateId, resolved, runner.today);
    if (!dims.length && groupMap.size === 0) groupMap.set("[]", { keys: [], rows: [] });
  }
  const groups = [...groupMap.values()];
  // An extra group holding everything, for totals.
  const allIndex = groups.length;
  groups.push({ keys: [], rows });

  // Measures
  const measures: { m: CardMeasure; expr: Expr; explicitType: FieldType | null }[] = (
    query.measures ?? []
  ).map((m) => {
    if (m.expr) return { m, expr: parseExpr(m.expr), explicitType: m.format ?? null };
    const agg = m.agg ?? (m.field ? null : "count");
    if (!m.field || agg === "count") {
      return {
        m,
        expr: { k: "call", fn: "count", args: [] } as Expr,
        explicitType: m.format ?? "number",
      };
    }
    const hit = find(m.field);
    if (!hit) throw unknownField(dataset, m.field);
    const t = fieldType(hit.id, hit.field);
    const numeric = t === "money" || t === "number" || t === "percent";
    const fn = agg ?? (numeric ? "sum" : "first");
    return {
      m,
      expr: { k: "call", fn, args: [{ k: "ref", name: m.field }] } as Expr,
      explicitType: m.format ?? (fn === "count_distinct" ? "number" : t),
    };
  });

  const measureByName = new Map<string, number>();
  measures.forEach(({ m }, i) => {
    measureByName.set(m.id.toLowerCase(), i);
    if (m.label) measureByName.set(m.label.toLowerCase(), i);
  });
  const dimByName = new Map<string, number>();
  dimInfo.forEach((d, i) => {
    dimByName.set(d.id.toLowerCase(), i);
    dimByName.set(d.dim.field.toLowerCase(), i);
    if (d.dim.label) dimByName.set(d.dim.label.toLowerCase(), i);
  });

  const typing: TypeLookup = {
    ref(name) {
      const key = name.trim().toLowerCase();
      const mi = measureByName.get(key);
      if (mi !== undefined) return measureType(mi);
      const di = dimByName.get(key);
      if (di !== undefined) return dimInfo[di]?.dim.bucket ? "text" : (dimInfo[di]?.type ?? "text");
      const hit = find(name);
      return hit ? fieldType(hit.id, hit.field) : null;
    },
    metric: (name) => runner.metricType(name),
  };
  const typeStack = new Set<number>();
  const measureTypes = new Map<number, FieldType>();
  function measureType(i: number): FieldType {
    const known = measureTypes.get(i);
    if (known) return known;
    const entry = measures[i];
    if (!entry) return "number";
    if (entry.explicitType) return entry.explicitType;
    if (typeStack.has(i)) return "number";
    typeStack.add(i);
    const t = inferType(entry.expr, typing);
    typeStack.delete(i);
    measureTypes.set(i, t);
    return t;
  }

  // Rows in the order "over rows" functions read them: along the axis, within each series.
  const partitions = new Map<string, number[]>();
  groups.forEach((g, i) => {
    if (i === allIndex) return;
    const key = JSON.stringify(g.keys.slice(1));
    const list = partitions.get(key);
    if (list) list.push(i);
    else partitions.set(key, [i]);
  });
  for (const list of partitions.values())
    list.sort((a, b) => compareCells(groups[a]?.keys[0] ?? null, groups[b]?.keys[0] ?? null));

  const values = new Map<string, Val>();
  const computing = new Set<string>();
  const windowCache = new Map<Expr, Val[]>();

  const rowCtx = (row: DataRow) => runnerRowContext(runner, dataset, query.calculated, row);

  const fastCents = (call: Extract<Expr, { k: "call" }>) => {
    const arg = call.args[0];
    if (call.fn !== "sum" || arg?.k !== "ref") return undefined;
    const hit = find(arg.name);
    if (hit?.field?.type !== "money") return undefined;
    const id = hit.id;
    return (row: DataRow) => {
      const v = row[id];
      return typeof v === "number" ? v : null;
    };
  };

  function groupCtx(index: number): EvalContext {
    return {
      today: runner.today,
      typeOf: (e) => inferType(e, typing),
      metric: (name) => runner.metricValue(name),
      ref(name) {
        const key = name.trim().toLowerCase();
        const mi = measureByName.get(key);
        if (mi !== undefined) return measureValue(mi, index);
        const di = dimByName.get(key);
        if (di !== undefined) {
          const info = dimInfo[di];
          const cell = groups[index]?.keys[di] ?? null;
          return info ? cellToVal(cell, info.dim.bucket ? "number" : info.type) : null;
        }
        // A field on its own means its total, or its first value if it's text.
        const hit = find(name);
        if (!hit) throw new ExprError(`Muny can't find "${name}" here.`);
        const t = fieldType(hit.id, hit.field);
        const numeric = t === "money" || t === "number" || t === "percent";
        const call: Extract<Expr, { k: "call" }> = {
          k: "call",
          fn: numeric ? "sum" : "first",
          args: [{ k: "ref", name }],
        };
        return aggregateOver(call, groups[index]?.rows ?? [], rowCtx, fastCents(call));
      },
      aggregate: (call) => aggregateOver(call, groups[index]?.rows ?? [], rowCtx, fastCents(call)),
      window(call) {
        if (index === allIndex) return null;
        let table = windowCache.get(call);
        if (!table) {
          table = computeWindow(call);
          windowCache.set(call, table);
        }
        return table[index] ?? null;
      },
    };
  }

  function measureValue(i: number, index: number): Val {
    const key = `${i}:${index}`;
    if (values.has(key)) return values.get(key) ?? null;
    if (computing.has(key)) throw new ExprError("These formulas refer to each other in a circle.");
    computing.add(key);
    const entry = measures[i];
    const v = entry ? evaluate(entry.expr, groupCtx(index)) : null;
    computing.delete(key);
    values.set(key, v);
    return v;
  }

  function computeWindow(call: Extract<Expr, { k: "call" }>): Val[] {
    const out: Val[] = new Array(groups.length).fill(null);
    if (call.fn === "row_number") {
      for (const list of partitions.values())
        list.forEach((g, i) => {
          out[g] = R.rat(i + 1);
        });
      return out;
    }
    const arg = call.args[0] as Expr;
    const second = call.args[1];
    const n = second ? Math.trunc(num(evaluate(second, groupCtx(allIndex)))) : 1;
    for (const list of partitions.values()) {
      const series = list.map((g) => evaluate(arg, groupCtx(g)));
      const known = series.filter(isRat);
      const total = known.reduce((x, y) => R.add(x, y), R.ZERO);
      // Largest first, once, so ranking thousands of rows stays quick.
      const ranks = new Map<Val, number>();
      if (call.fn === "rank") {
        const sorted = [...known].sort((x, y) => R.cmp(y, x));
        sorted.forEach((v, i) => {
          const before = sorted[i - 1];
          ranks.set(v, before && R.cmp(before, v) === 0 ? (ranks.get(before) ?? i + 1) : i + 1);
        });
      }
      let running = R.ZERO;
      let count = 0;
      series.forEach((v, i) => {
        const g = list[i] as number;
        if (isRat(v)) {
          running = R.add(running, v);
          count++;
        }
        switch (call.fn) {
          case "running_sum":
            out[g] = running;
            break;
          case "running_avg":
            out[g] = count ? R.div(running, R.rat(count)) : null;
            break;
          case "moving_avg": {
            const size = Math.min(MAX_MOVING_WINDOW, Math.max(1, n));
            const span = series.slice(Math.max(0, i - size + 1), i + 1).filter(isRat);
            out[g] = span.length
              ? R.div(
                  span.reduce((x, y) => R.add(x, y), R.ZERO),
                  R.rat(span.length),
                )
              : null;
            break;
          }
          case "prev":
            out[g] = series[i - n] ?? null;
            break;
          case "next":
            out[g] = series[i + n] ?? null;
            break;
          case "diff": {
            const p = series[i - 1];
            out[g] = isRat(v) && p !== undefined && isRat(p) ? R.sub(v, p) : null;
            break;
          }
          case "pct_change": {
            const p = series[i - 1];
            out[g] = isRat(v) && p !== undefined && isRat(p) ? R.div(R.sub(v, p), R.abs(p)) : null;
            break;
          }
          case "pct_of_total":
            out[g] = isRat(v) ? R.div(v, total) : null;
            break;
          case "total":
            out[g] = total;
            break;
          case "rank":
            out[g] = isRat(v) ? R.rat(ranks.get(v) ?? 1) : null;
            break;
          default:
            throw new ExprError(`${call.fn}() can't be used here.`);
        }
      });
    }
    return out;
  }

  // Build the output.
  const columns: ResultColumn[] = [
    ...dimInfo.map(
      ({ dim, id, type }): ResultColumn => ({
        id,
        label: dimensionLabel(dim, dataset, calc.get(id.toLowerCase())?.id),
        type: dim.bucket ? "text" : type,
        role: "dimension",
        ...(dim.bucket ? { bucket: dim.bucket } : {}),
      }),
    ),
    ...measures.map(
      ({ m, expr }, i): ResultColumn => ({
        id: m.id,
        label:
          m.label ??
          (m.field ? findField(dataset, m.field)?.label : undefined) ??
          (expr.k === "call" && expr.fn === "count" ? "Count" : m.id),
        type: measureType(i),
        role: "measure",
        ...(m.color ? { color: m.color } : {}),
        ...(m.mark ? { mark: m.mark } : {}),
        ...(m.hidden ? { hidden: true } : {}),
      }),
    ),
  ];

  const indexes = groups.map((_, i) => i).filter((i) => i !== allIndex);
  const cell = (groupIndex: number, column: number): CardCell => {
    if (column < dimInfo.length) return groups[groupIndex]?.keys[column] ?? null;
    const mi = column - dimInfo.length;
    return toCell(measureValue(mi, groupIndex), measureType(mi));
  };

  // Order: as asked; otherwise time and raw lists by date, everything else largest first.
  const sorts = (query.sort ?? []).map((s) => {
    const key = s.by.trim().toLowerCase();
    return {
      col: columns.findIndex((c) => c.id.toLowerCase() === key || c.label.toLowerCase() === key),
      dir: s.dir === "desc" ? -1 : 1,
      by: s.by,
    };
  });
  let ordered = indexes;
  if (sorts.length) {
    // A raw list can sort by any field, shown or not.
    ordered = [...indexes].sort((a, b) => {
      for (const s of sorts) {
        let x: CardCell;
        let y: CardCell;
        if (s.col >= 0) {
          x = cell(a, s.col);
          y = cell(b, s.col);
        } else {
          const hit = find(s.by);
          x = hit ? (groups[a]?.rows[0]?.[hit.id] ?? null) : null;
          y = hit ? (groups[b]?.rows[0]?.[hit.id] ?? null) : null;
        }
        const c = compareCells(x, y);
        if (c) return c * s.dir;
      }
      return 0;
    });
  } else if (query.raw) {
    if (dataset.dateField) ordered = [...indexes].reverse();
  } else if (
    dimInfo[0]?.dim.bucket ||
    dimInfo[0]?.type === "date" ||
    dimInfo[0]?.type === "month"
  ) {
    ordered = [...indexes].sort(
      (a, b) =>
        compareCells(groups[a]?.keys[0] ?? null, groups[b]?.keys[0] ?? null) ||
        compareCells(groups[a]?.keys[1] ?? null, groups[b]?.keys[1] ?? null),
    );
  } else if (dimInfo.length && measures.length) {
    const col = dimInfo.length + measures.findIndex((m) => !m.m.hidden);
    if (col >= dimInfo.length)
      ordered = [...indexes].sort((a, b) => compareCells(cell(b, col), cell(a, col)));
  }

  let shown = ordered;
  let truncated = false;
  const limit = Math.min(query.limit ?? MAX_OUTPUT_ROWS, MAX_OUTPUT_ROWS);
  let otherRow: CardCell[] | null = null;
  if (ordered.length > limit) {
    shown = ordered.slice(0, limit);
    const rest = ordered.slice(limit);
    if (query.other && dimInfo.length) {
      const otherIndex = groups.length;
      groups.push({
        keys: dimInfo.map((_, i) => (i === 0 ? "Other" : null)),
        rows: rest.flatMap((i) => groups[i]?.rows ?? []),
      });
      otherRow = columns.map((_, c) => cell(otherIndex, c));
    } else truncated = !query.limit;
  }

  const outRows = shown.map((g) => columns.map((_, c) => cell(g, c)));
  if (otherRow) outRows.push(otherRow);

  const totals: Record<string, number | null> = {};
  measures.forEach(({ m }, i) => {
    const v = toCell(measureValue(i, allIndex), measureType(i));
    totals[m.id] = typeof v === "number" ? v : null;
  });

  return { columns, rows: outRows, totals, ...(truncated ? { truncated: true } : {}) };
}

// ---------------------------------------------------------------------------
// Whole cards
// ---------------------------------------------------------------------------

class Runner {
  private cache = new Map<string, DataRow[]>();
  private metricState = new Map<string, { value: Val; type: FieldType }>();
  private metricStack = new Set<string>();
  private metricsById: Map<string, CardMetric>;

  constructor(
    doc: CardDoc,
    private rawProvider: DataProvider,
    readonly today: string,
  ) {
    this.metricsById = new Map((doc.metrics ?? []).map((m) => [m.id.toLowerCase(), m]));
  }

  /** Each dataset is read once per card, however many blocks use it. */
  provider = (dataset: string, range: { from?: string; to?: string }): DataRow[] => {
    const key = `${dataset}|${range.from ?? ""}|${range.to ?? ""}`;
    let rows = this.cache.get(key);
    if (!rows) {
      rows = this.rawProvider(dataset, range);
      this.cache.set(key, rows);
    }
    return rows;
  };

  private metric(name: string) {
    const key = name.toLowerCase();
    const known = this.metricState.get(key);
    if (known) return known;
    const m = this.metricsById.get(key);
    if (!m) throw new ExprError(`This card has no value called $${name}.`);
    if (this.metricStack.has(key))
      throw new ExprError(`$${name} is worked out from itself, in a circle.`);
    this.metricStack.add(key);
    try {
      const result = this.computeMetric(m);
      this.metricState.set(key, result);
      return result;
    } finally {
      this.metricStack.delete(key);
    }
  }

  metricValue(name: string): Val {
    return this.metric(name).value;
  }

  metricType(name: string): FieldType {
    return this.metric(name).type;
  }

  private computeMetric(m: CardMetric): { value: Val; type: FieldType } {
    const expr = parseExpr(m.expr);
    if (!m.dataset) {
      const type = m.format ?? inferType(expr, this.plainTyping());
      return { value: evaluate(expr, this.plainContext()), type };
    }
    const dataset = DATASET_BY_ID.get(m.dataset);
    if (!dataset) throw new ExprError(`There's no dataset called "${m.dataset}".`);
    const q = runQuery(this, {
      dataset: m.dataset,
      ...(m.range ? { range: m.range } : {}),
      ...(m.filters ? { filters: m.filters } : {}),
      measures: [{ id: "value", expr: m.expr, ...(m.format ? { format: m.format } : {}) }],
    });
    const type = q.columns[0]?.type ?? "number";
    const cell = q.rows[0]?.[0] ?? null;
    return { value: cellToVal(cell, type), type };
  }

  private plainTyping(): TypeLookup {
    return { ref: () => null, metric: (name) => this.metricType(name) };
  }

  /** Formulas outside a query: metrics, and block settings like a stat's value. */
  plainContext(columns?: Map<string, { value: Val; type: FieldType }>): EvalContext {
    return {
      today: this.today,
      typeOf: (e) => inferType(e, this.blockTyping(columns)),
      metric: (name) => this.metricValue(name),
      ref(name) {
        const hit = columns?.get(name.trim().toLowerCase());
        if (hit) return hit.value;
        throw new ExprError(
          `"${name}" isn't a value here. Named values are written with a $, like $spent.`,
        );
      },
      aggregate(call) {
        throw new ExprError(
          `${call.fn}() needs rows to read. Set a dataset on this value, or use the block's data.`,
        );
      },
      window(call) {
        throw new ExprError(`${call.fn}() needs a block's rows to read.`);
      },
    };
  }

  blockTyping(columns?: Map<string, { value: Val; type: FieldType }>): TypeLookup {
    return {
      ref: (name) => columns?.get(name.trim().toLowerCase())?.type ?? null,
      metric: (name) => this.metricType(name),
    };
  }

  resolve(
    source: string,
    format: FieldType | undefined,
    columns?: Map<string, { value: Val; type: FieldType }>,
  ): { val: Val; type: FieldType; out: ResolvedValue } {
    const expr = parseExpr(source);
    const val = evaluate(expr, this.plainContext(columns));
    const type = format ?? inferType(expr, this.blockTyping(columns));
    const cell = toCell(val, type);
    return { val, type, out: { value: cell, type, text: formatCell(cell, type) } };
  }

  /** {{formula}} anywhere in some text. */
  template(text: string, columns?: Map<string, { value: Val; type: FieldType }>): string {
    return text.replace(/\{\{(.+?)\}\}/g, (_, source: string) => {
      const expr = parseExpr(source);
      const val = evaluate(expr, this.plainContext(columns));
      const type = inferType(expr, this.blockTyping(columns));
      return formatCell(toCell(val, type), type);
    });
  }
}

const TONES = new Set<CardTone>(["normal", "muted", "positive", "negative", "warning"]);

function runBlock(runner: Runner, block: CardBlock): BlockResult {
  const options = block.options ?? {};
  const result: BlockResult = { queries: [] };
  for (const q of [...(block.query ? [block.query] : []), ...(block.layers ?? [])])
    result.queries.push(runQuery(runner, q));

  // Block settings can name the first query's measures: its total, or its one row.
  const first = result.queries[0];
  const columns = new Map<string, { value: Val; type: FieldType }>();
  if (first) {
    const onlyRow = first.rows.length === 1 ? first.rows[0] : null;
    first.columns.forEach((c, i) => {
      if (c.role !== "measure") return;
      const cell = onlyRow ? (onlyRow[i] ?? null) : (first.totals[c.id] ?? null);
      const entry = { value: cellToVal(cell, c.type), type: c.type };
      columns.set(c.id.toLowerCase(), entry);
      columns.set(c.label.toLowerCase(), entry);
    });
  }

  const firstMeasure = first?.columns.find((c) => c.role === "measure" && !c.hidden);
  let value: { val: Val; type: FieldType; out: ResolvedValue } | null = null;
  if (options.value) value = runner.resolve(options.value, options.format, columns);
  else if (firstMeasure && (block.kind === "stat" || block.kind === "progress")) {
    const entry = columns.get(firstMeasure.id.toLowerCase());
    if (entry) {
      const type = options.format ?? entry.type;
      const cell = toCell(entry.value, type);
      value = {
        val: entry.value,
        type,
        out: { value: cell, type, text: formatCell(cell, type) },
      };
    }
  }
  if (value) result.value = value.out;

  if (options.compare) {
    const compare = runner.resolve(options.compare, options.format ?? value?.type, columns);
    result.compare = compare.out;
    if (value && isRat(value.val) && isRat(compare.val)) {
      const delta = R.sub(value.val, compare.val);
      const cell = toCell(delta, value.type);
      result.delta = { value: cell, type: value.type, text: formatCell(cell, value.type) };
    }
  }

  const isColumn = (name: string | undefined) =>
    !!name && !!first?.columns.some((c) => c.id.toLowerCase() === name.toLowerCase());
  if (options.target && !isColumn(options.target))
    result.target = runner.resolve(options.target, options.format ?? value?.type, columns).out;
  if (options.marker && !isColumn(options.marker))
    result.marker = runner.resolve(options.marker, options.format ?? value?.type, columns).out;

  if (options.text) result.text = runner.template(options.text, columns);
  if (options.center) result.center = runner.template(options.center, columns);
  if (options.tone) result.tone = options.tone;
  if (options.toneExpr) {
    const tone = runner.resolve(options.toneExpr, "text", columns).val;
    if (typeof tone === "string" && TONES.has(tone as CardTone)) result.tone = tone as CardTone;
  }
  if (options.references?.length)
    result.references = options.references.map((r) => {
      const ref = runner.resolve(r.expr, undefined, columns);
      const cell = ref.out.value;
      return {
        label: r.label,
        ...(r.color ? { color: r.color } : {}),
        value: typeof cell === "number" ? cell : null,
        type: ref.type,
      };
    });
  return result;
}

/** Run a whole card. A block that fails reports why and the rest still show. */
export function runCardDoc(doc: CardDoc, provider: DataProvider, today: string): CardResult {
  const runner = new Runner(doc, provider, today);
  const metrics: CardResult["metrics"] = {};
  for (const m of doc.metrics ?? []) {
    try {
      const r = runner.resolve(`$${m.id}`, m.format);
      metrics[m.id] = r.out;
    } catch (e) {
      metrics[m.id] = { error: errorText(e) };
    }
  }
  const blocks: CardResult["blocks"] = {};
  for (const block of doc.blocks) {
    try {
      blocks[block.id] = runBlock(runner, block);
    } catch (e) {
      blocks[block.id] = { queries: [], error: errorText(e) };
    }
  }
  return { metrics, blocks, today };
}

function errorText(e: unknown): string {
  if (e instanceof ExprError) return e.message;
  // Anything else is a bug here, and its message is never shown or sent anywhere.
  return "This block couldn't be worked out.";
}
