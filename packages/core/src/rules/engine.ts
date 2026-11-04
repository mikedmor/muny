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

/**
 * Apply rules (already sorted by priority) to one transaction. For category
 * and payee the first matching rule wins; tags accumulate; any match can hide.
 * Returns the new target and whether anything changed.
 */
export function applyRules(
  rules: Pick<RuleDefinition, "match" | "conditions" | "actions">[],
  facts: RuleFacts,
  current: RuleTarget,
): { next: RuleTarget; changed: boolean; matched: number } {
  const next: RuleTarget = { ...current, tags: [...current.tags] };
  let categorySet = false;
  let payeeSet = false;
  let matched = 0;
  for (const rule of rules) {
    if (!ruleMatches(rule, facts)) continue;
    matched++;
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
      }
    }
  }
  const changed =
    next.categoryId !== current.categoryId ||
    (next.payeeName ?? "").toLowerCase() !== (current.payeeName ?? "").toLowerCase() ||
    next.hidden !== current.hidden ||
    next.tags.length !== current.tags.length;
  return { next, changed, matched };
}
