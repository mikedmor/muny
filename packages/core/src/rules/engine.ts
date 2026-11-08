import type { RuleAction, RuleCondition, RuleDefinition, TextOp } from "@muny/shared";

/** What a rule can look at. */
export interface RuleFacts {
  description: string;
  payee: string | null;
  amountCents: number;
  accountId: string;
}

/** The fields rules can change, before and after. */
export interface RuleTarget {
  categoryId: string | null;
  payeeName: string | null;
  tags: string[];
  hidden: boolean;
  /** The recurring series it belongs to. */
  seriesId: string | null;
}

function textMatch(haystack: string | null, op: TextOp, needle: string): boolean {
  if (haystack === null) return false;
  const h = haystack.toLowerCase().replace(/\s+/g, " ").trim();
  const n = needle.toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return false;
  switch (op) {
    case "contains":
      return h.includes(n);
    case "equals":
      return h === n;
    case "startsWith":
      return h.startsWith(n);
    case "endsWith":
      return h.endsWith(n);
  }
}

export function conditionMatches(c: RuleCondition, f: RuleFacts): boolean {
  switch (c.field) {
    case "description":
      return textMatch(f.description, c.op, c.value);
    case "payee":
      return textMatch(f.payee, c.op, c.value);
    case "amount": {
      const a = Math.abs(f.amountCents);
      return c.op === "eq" ? a === c.value : c.op === "gte" ? a >= c.value : a <= c.value;
    }
    case "direction":
      return c.value === "out" ? f.amountCents < 0 : f.amountCents > 0;
    case "account":
      return f.accountId === c.value;
  }
}

export function ruleMatches(rule: Pick<RuleDefinition, "match" | "conditions">, f: RuleFacts) {
  if (rule.conditions.length === 0) return false; // never match everything by accident
  return rule.match === "all"
    ? rule.conditions.every((c) => conditionMatches(c, f))
    : rule.conditions.some((c) => conditionMatches(c, f));
}

/** Which of a rule's recurring series a transaction belongs to (null: none of them). */
export type SeriesPick = (seriesIds: string[], facts: RuleFacts) => string | null;

export interface SeriesFit {
  id: string;
  accountId: string | null;
  /** Its usual amount, ignoring direction, in cents. */
  amountCents: number;
}

/**
 * The series a transaction fits: one on its account (a paycheck split across
 * accounts has a series on each), the nearest in amount when several share
 * the account. A rule for one series also takes it from another account
 * within a quarter of its amount (the bill moved accounts); a rule naming
 * several goes by account only, so one part of a split paycheck never lands
 * in another's series. Either way a broad rule can't pull a $50 deposit into
 * a $1,700 paycheck.
 */
export function seriesPicker(series: SeriesFit[]): SeriesPick {
  const byId = new Map(series.map((x) => [x.id, x]));
  return (ids, f) => {
    const amt = Math.abs(f.amountCents);
    const gap = (x: SeriesFit) => Math.abs(amt - x.amountCents);
    const opts = ids.map((id) => byId.get(id)).filter((x): x is SeriesFit => !!x);
    const here = opts.filter((x) => !x.accountId || x.accountId === f.accountId);
    const near = (x: SeriesFit) => gap(x) * 4 <= x.amountCents;
    const pool =
      opts.length === 1
        ? here.length
          ? here
          : opts.filter(near)
        : // Several series: on its account and near its amount, so a one-off
          // bonus or adjustment stays out of the regular deposit's series.
          here.filter(near);
    let best: SeriesFit | null = null;
    for (const x of pool) if (!best || gap(x) < gap(best)) best = x;
    return best?.id ?? null;
  };
}

/**
 * Apply rules (already sorted by priority) to one transaction. For category
 * and payee the first matching rule wins; tags accumulate; any match can hide.
 * Returns the new target and whether anything changed.
 */
export function applyRules(
  rules: Pick<RuleDefinition, "match" | "conditions" | "actions">[],
  facts: RuleFacts,
  current: RuleTarget,
  /** Chooses among a rule's recurring series; without it, the first one. */
  pickSeries?: SeriesPick,
): { next: RuleTarget; changed: boolean; matched: number } {
  const next: RuleTarget = { ...current, tags: [...current.tags] };
  let categorySet = false;
  let payeeSet = false;
  let seriesSet = false;
  let matched = 0;
  for (const rule of rules) {
    if (!ruleMatches(rule, facts)) continue;
    matched++;
    let seriesTried = false;
    for (const a of rule.actions as RuleAction[]) {
      if (a.type === "setCategory" && !categorySet) {
        next.categoryId = a.categoryId;
        categorySet = true;
      } else if (a.type === "setPayee" && !payeeSet) {
        next.payeeName = a.name;
        payeeSet = true;
      } else if (a.type === "addTag") {
        if (!next.tags.some((t) => t.toLowerCase() === a.name.toLowerCase()))
          next.tags.push(a.name);
      } else if (a.type === "hide") {
        next.hidden = true;
      } else if (a.type === "setRecurring" && !seriesSet && !seriesTried) {
        // A rule can name several series (one per account); the transaction
        // goes to the one it fits, or on to the next rule if none.
        seriesTried = true;
        const ids = [
          ...new Set(
            (rule.actions as RuleAction[]).flatMap((x) =>
              x.type === "setRecurring" ? [x.seriesId] : [],
            ),
          ),
        ];
        const pick = pickSeries ? pickSeries(ids, facts) : (ids[0] ?? null);
        if (pick) {
          next.seriesId = pick;
          seriesSet = true;
        }
      }
    }
  }
  const changed =
    next.categoryId !== current.categoryId ||
    (next.payeeName ?? "").toLowerCase() !== (current.payeeName ?? "").toLowerCase() ||
    next.hidden !== current.hidden ||
    next.seriesId !== current.seriesId ||
    next.tags.length !== current.tags.length;
  return { next, changed, matched };
}
