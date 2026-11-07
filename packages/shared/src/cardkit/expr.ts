/**
 * The formula language used in custom cards. It's parsed into a small tree here
 * and interpreted by the query engine: there's no eval and no way to reach
 * anything but the fields and functions listed below. Formulas have no loops or
 * user-defined functions, and their size is capped, so they always finish.
 */
import { fromDecimal, type Rat, rat } from "./rational.js";

export const MAX_EXPR_LENGTH = 2000;
const MAX_DEPTH = 40;

export type Expr =
  | { k: "num"; v: Rat }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  /** A field, a calculated column or (at group level) another measure. */
  | { k: "ref"; name: string }
  /** $name: one of the card's named values. */
  | { k: "metric"; name: string }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "neg"; a: Expr }
  | { k: "not"; a: Expr }
  | { k: "bin"; op: BinOp; a: Expr; b: Expr };

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "&"
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

export class ExprError extends Error {}

/** Every function a formula can call, for the editor and for assistants. */
export interface FunctionInfo {
  name: string;
  /** How it's written. */
  usage: string;
  description: string;
  group: "Totals" | "Over rows" | "Math" | "Logic" | "Text" | "Dates";
  /** Totals read the rows in a group; "over rows" read the rows of the result. */
  scope?: "aggregate" | "window";
  min: number;
  max: number;
}

const fn = (
  group: FunctionInfo["group"],
  name: string,
  usage: string,
  description: string,
  min: number,
  max: number,
  scope?: FunctionInfo["scope"],
): FunctionInfo => ({ group, name, usage, description, min, max, ...(scope ? { scope } : {}) });

export const FUNCTIONS: FunctionInfo[] = [
  fn("Totals", "sum", "sum(x, only_if)", "Add up x. only_if is optional.", 1, 2, "aggregate"),
  fn("Totals", "avg", "avg(x, only_if)", "The average of x.", 1, 2, "aggregate"),
  fn("Totals", "min", "min(x, only_if)", "The smallest x.", 1, 2, "aggregate"),
  fn("Totals", "max", "max(x, only_if)", "The largest x.", 1, 2, "aggregate"),
  fn("Totals", "median", "median(x, only_if)", "The middle x.", 1, 2, "aggregate"),
  fn("Totals", "count", "count(only_if)", "How many rows.", 0, 1, "aggregate"),
  fn("Totals", "count_distinct", "count_distinct(x)", "How many different x.", 1, 2, "aggregate"),
  fn("Totals", "first", "first(x)", "x from the first row.", 1, 2, "aggregate"),
  fn("Totals", "last", "last(x)", "x from the last row.", 1, 2, "aggregate"),

  fn("Over rows", "running_sum", "running_sum(x)", "Total so far, row by row.", 1, 1, "window"),
  fn("Over rows", "running_avg", "running_avg(x)", "Average so far, row by row.", 1, 1, "window"),
  fn("Over rows", "moving_avg", "moving_avg(x, n)", "Average of the last n rows.", 2, 2, "window"),
  fn("Over rows", "prev", "prev(x, n)", "x from n rows earlier (default 1).", 1, 2, "window"),
  fn("Over rows", "next", "next(x, n)", "x from n rows later (default 1).", 1, 2, "window"),
  fn("Over rows", "diff", "diff(x)", "Change from the row before.", 1, 1, "window"),
  fn(
    "Over rows",
    "pct_change",
    "pct_change(x)",
    "Change from the row before, as a share.",
    1,
    1,
    "window",
  ),
  fn("Over rows", "pct_of_total", "pct_of_total(x)", "Share of the total of x.", 1, 1, "window"),
  fn("Over rows", "total", "total(x)", "The total of x across all rows.", 1, 1, "window"),
  fn("Over rows", "rank", "rank(x)", "1 for the largest x, 2 for the next…", 1, 1, "window"),
  fn("Over rows", "row_number", "row_number()", "1, 2, 3… in order.", 0, 0, "window"),

  fn("Math", "abs", "abs(x)", "Without the sign.", 1, 1),
  fn("Math", "round", "round(x, places)", "Round to some decimal places (default 0).", 1, 2),
  fn("Math", "floor", "floor(x)", "Round down.", 1, 1),
  fn("Math", "ceil", "ceil(x)", "Round up.", 1, 1),
  fn("Math", "mod", "mod(a, b)", "What's left after dividing a by b.", 2, 2),
  fn("Math", "least", "least(a, b, …)", "The smallest of these values.", 1, 20),
  fn("Math", "greatest", "greatest(a, b, …)", "The largest of these values.", 1, 20),

  fn("Logic", "if", "if(test, then, else)", "Choose a value.", 2, 3),
  fn("Logic", "coalesce", "coalesce(a, b, …)", "The first value that isn't empty.", 1, 20),
  fn("Logic", "is_empty", "is_empty(x)", "True when x has no value.", 1, 1),

  fn("Text", "lower", "lower(t)", "In lower case.", 1, 1),
  fn("Text", "upper", "upper(t)", "In upper case.", 1, 1),
  fn("Text", "trim", "trim(t)", "Without spaces around it.", 1, 1),
  fn("Text", "length", "length(t)", "How many characters.", 1, 1),
  fn("Text", "left", "left(t, n)", "The first n characters.", 2, 2),
  fn("Text", "right", "right(t, n)", "The last n characters.", 2, 2),
  fn("Text", "contains", "contains(t, part)", "True if part appears in t (any case).", 2, 2),
  fn("Text", "starts_with", "starts_with(t, part)", "True if t begins with part (any case).", 2, 2),
  fn("Text", "ends_with", "ends_with(t, part)", "True if t ends with part (any case).", 2, 2),
  fn("Text", "replace", "replace(t, find, with)", "Replace every find in t.", 3, 3),
  fn("Text", "text", "text(x)", "x as text, formatted as money, a percent or a number.", 1, 1),

  fn("Dates", "today", "today()", "Today's date.", 0, 0),
  fn("Dates", "this_month", "this_month()", "This month, like 2026-11.", 0, 0),
  fn("Dates", "last_month", "last_month()", "Last month, like 2026-10.", 0, 0),
  fn("Dates", "year", "year(d)", "The year.", 1, 1),
  fn("Dates", "month", "month(d)", "The month, 1 to 12.", 1, 1),
  fn("Dates", "day", "day(d)", "The day of the month.", 1, 1),
  fn("Dates", "weekday", "weekday(d)", "The day of the week, 1 (Monday) to 7.", 1, 1),
  fn("Dates", "quarter", "quarter(d)", "The quarter, 1 to 4.", 1, 1),
  fn("Dates", "month_key", "month_key(d)", "The month, like 2026-11.", 1, 1),
  fn("Dates", "month_name", "month_name(d)", "The month's name.", 1, 1),
  fn("Dates", "add_days", "add_days(d, n)", "The date n days later.", 2, 2),
  fn("Dates", "add_months", "add_months(d, n)", "The date n months later.", 2, 2),
  fn("Dates", "days_between", "days_between(a, b)", "Days from a to b.", 2, 2),
  fn("Dates", "start_of_month", "start_of_month(d)", "The 1st of that month.", 1, 1),
  fn("Dates", "end_of_month", "end_of_month(d)", "The last day of that month.", 1, 1),
  fn("Dates", "days_in_month", "days_in_month(d)", "How many days that month has.", 1, 1),
];

export const FUNCTION_BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));

type Token =
  | { t: "num"; v: Rat }
  | { t: "str"; v: string }
  | { t: "ref"; v: string }
  | { t: "id"; v: string }
  | { t: "metric"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  if (src.length > MAX_EXPR_LENGTH) throw new ExprError("That formula is too long.");
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new ExprError("A [field name] is missing its closing ].");
      out.push({ t: "ref", v: src.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = "";
      while (j < src.length && src.charAt(j) !== c) {
        if (src.charAt(j) === "\\" && j + 1 < src.length) j++;
        text += src.charAt(j);
        j++;
      }
      if (j >= src.length) throw new ExprError("Some text is missing its closing quote.");
      out.push({ t: "str", v: text });
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (m?.[1]) {
        out.push({ t: "metric", v: m[1] });
        i += m[0].length;
        continue;
      }
      // $100 is simply a number.
      i++;
      continue;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)/.exec(src.slice(i));
    if (num?.[0]) {
      const v = fromDecimal(num[0]);
      if (!v) throw new ExprError(`"${num[0]}" isn't a number.`);
      out.push({ t: "num", v });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id?.[0]) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "!=" || two === "<>" || two === "==") {
      out.push({ t: "op", v: two === "<>" ? "!=" : two === "==" ? "=" : two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>(),%".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Muny doesn't understand "${c}" in a formula.`);
  }
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private tokens: Token[]) {}

  private peek() {
    return this.tokens[this.i];
  }
  private isOp(v: string) {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }
  private isWord(v: string) {
    const t = this.peek();
    return t?.t === "id" && t.v.toLowerCase() === v;
  }

  parse(): Expr {
    if (this.tokens.length === 0) throw new ExprError("The formula is empty.");
    const e = this.or();
    if (this.i < this.tokens.length)
      throw new ExprError("There's something extra at the end of the formula.");
    return e;
  }

  private guard<T>(next: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new ExprError("That formula is nested too deeply.");
    try {
      return next();
    } finally {
      this.depth--;
    }
  }

  private or(): Expr {
    let a = this.and();
    while (this.isWord("or")) {
      this.i++;
      a = { k: "bin", op: "or", a, b: this.and() };
    }
    return a;
  }

  private and(): Expr {
    let a = this.not();
    while (this.isWord("and")) {
      this.i++;
      a = { k: "bin", op: "and", a, b: this.not() };
    }
    return a;
  }

  private not(): Expr {
    if (this.isWord("not")) {
      this.i++;
      return this.guard(() => ({ k: "not", a: this.not() }));
    }
    return this.compare();
  }

  private compare(): Expr {
    const a = this.concat();
    const t = this.peek();
    if (t?.t === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.i++;
      return { k: "bin", op: t.v as BinOp, a, b: this.concat() };
    }
    return a;
  }

  private concat(): Expr {
    let a = this.add();
    while (this.isOp("&")) {
      this.i++;
      a = { k: "bin", op: "&", a, b: this.add() };
    }
    return a;
  }

  private add(): Expr {
    let a = this.mul();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
        this.i++;
        a = { k: "bin", op: t.v, a, b: this.mul() };
      } else return a;
    }
  }

  private mul(): Expr {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
        this.i++;
        a = { k: "bin", op: t.v, a, b: this.unary() };
      } else return a;
    }
  }

  private unary(): Expr {
    if (this.isOp("-")) {
      this.i++;
      return this.guard(() => ({ k: "neg", a: this.unary() }));
    }
    return this.power();
  }

  private power(): Expr {
    const a = this.percent();
    if (this.isOp("^")) {
      this.i++;
      return this.guard(() => ({ k: "bin", op: "^", a, b: this.unary() }));
    }
    return a;
  }

  /** 10% is 0.1. */
  private percent(): Expr {
    let a = this.atom();
    while (this.isOp("%")) {
      this.i++;
      a = { k: "bin", op: "/", a, b: { k: "num", v: rat(100) } };
    }
    return a;
  }

  private atom(): Expr {
    const t = this.peek();
    if (!t) throw new ExprError("The formula stops too early.");
    this.i++;
    switch (t.t) {
      case "num":
        return { k: "num", v: t.v };
      case "str":
        return { k: "str", v: t.v };
      case "ref":
        return { k: "ref", name: t.v };
      case "metric":
        return { k: "metric", name: t.v };
      case "id": {
        const word = t.v.toLowerCase();
        if (this.isOp("(")) return this.call(word);
        if (word === "true") return { k: "bool", v: true };
        if (word === "false") return { k: "bool", v: false };
        if (word === "null") return { k: "null" };
        return { k: "ref", name: t.v };
      }
      case "op":
        if (t.v === "(") {
          const inner = this.guard(() => this.or());
          if (!this.isOp(")")) throw new ExprError("A ( is missing its closing ).");
          this.i++;
          return inner;
        }
        throw new ExprError(`"${t.v}" is in an unexpected place.`);
    }
  }

  private call(name: string): Expr {
    const info = FUNCTION_BY_NAME.get(name);
    if (!info) throw new ExprError(`There's no function called ${name}().`);
    this.i++;
    const args: Expr[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.guard(() => this.or()));
        if (this.isOp(",")) {
          this.i++;
          continue;
        }
        break;
      }
    }
    if (!this.isOp(")")) throw new ExprError(`${name}( is missing its closing ).`);
    this.i++;
    if (args.length < info.min || args.length > info.max)
      throw new ExprError(
        `${info.usage} doesn't take ${args.length} value${args.length === 1 ? "" : "s"}.`,
      );
    return { k: "call", fn: name, args };
  }
}

const parsed = new Map<string, Expr>();

/** Parse a formula; throws ExprError with a sentence people can act on. */
export function parseExpr(src: string): Expr {
  const hit = parsed.get(src);
  if (hit) return hit;
  const e = new Parser(tokenize(src)).parse();
  if (parsed.size > 2000) parsed.clear();
  parsed.set(src, e);
  return e;
}

/** Everything a formula refers to. */
export function exprRefs(
  e: Expr,
  out: { refs: Set<string>; metrics: Set<string> } = { refs: new Set(), metrics: new Set() },
) {
  switch (e.k) {
    case "ref":
      out.refs.add(e.name);
      break;
    case "metric":
      out.metrics.add(e.name);
      break;
    case "call":
      for (const a of e.args) exprRefs(a, out);
      break;
    case "neg":
    case "not":
      exprRefs(e.a, out);
      break;
    case "bin":
      exprRefs(e.a, out);
      exprRefs(e.b, out);
      break;
    default:
      break;
  }
  return out;
}
