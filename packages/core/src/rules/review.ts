import type { RuleAction, RuleCombine, RuleDefinition } from "@muny/shared";
import { applyRules, type RuleFacts, type RuleTarget, ruleMatches } from "./engine.js";

export interface ReviewRule extends RuleDefinition {
  id: string;
  name: string;
  enabled: boolean;
}

const BLANK: RuleTarget = {
  categoryId: null,
  payeeName: null,
  tags: [],
  hidden: false,
  seriesId: null,
};

const outcome = (rules: ReviewRule[], f: RuleFacts) => {
  const n = applyRules(rules, f, BLANK).next;
  return JSON.stringify([
    n.categoryId,
    n.payeeName?.toLowerCase() ?? null,
    n.hidden,
    n.seriesId,
    n.tags.map((t) => t.toLowerCase()).sort(),
  ]);
};

/** Both rules' actions in one list; null when they'd set the same thing two ways. */
function unionActions(a: RuleAction[], b: RuleAction[]): RuleAction[] | null {
  const out = [...a];
  for (const x of b) {
    const same = out.find((y) => y.type === x.type);
    if (x.type === "addTag") {
      if (!out.some((y) => y.type === "addTag" && y.name.toLowerCase() === x.name.toLowerCase()))
        out.push(x);
    } else if (!same) out.push(x);
    else if (JSON.stringify(same) !== JSON.stringify(x)) return null;
  }
  return out;
}

/** Conditions on the bank's own description survive a merchant being renamed; prefer them. */
const steady = (r: RuleDefinition) => r.conditions.some((c) => c.field === "description");
/** Rules Muny made for a recurring series are named "… (recurring)"; keep the person's own. */
const automatic = (r: ReviewRule) => / \(recurring\)$/.test(r.name);

/**
 * Pairs of enabled rules that do one job between them and can be combined into
 * one rule (or where one simply repeats the other), checked against every
 * transaction so nothing would be filed differently afterwards.
 */
export function findCombinable(rules: ReviewRule[], facts: RuleFacts[]): RuleCombine[] {
  const live = rules.filter((r) => r.enabled && r.conditions.length > 0);
  const matched = live.map((r) => {
    const set = new Set<number>();
    facts.forEach((f, i) => {
      if (ruleMatches(r, f)) set.add(i);
    });
    return set;
  });
  const out: RuleCombine[] = [];
  // Each rule goes at most once, and a rule that absorbs another stays.
  const removed = new Set<string>();
  const kept = new Set<string>();
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = [live[i] as ReviewRule, live[j] as ReviewRule];
      if (removed.has(a.id) || removed.has(b.id)) continue;
      const [ma, mb] = [matched[i] as Set<number>, matched[j] as Set<number>];
      let shared = 0;
      for (const x of ma) if (mb.has(x)) shared++;
      if (!shared) continue;
      const touched = [...new Set([...ma, ...mb])].map((k) => facts[k] as RuleFacts);
      const before = touched.map((f) => outcome(live, f));
      // Keep the person's own rule (name, place) when one of them is automatic.
      const keeps = automatic(a) && !automatic(b) ? [b, a] : [a, b];
      const [keep, drop] = keeps as [ReviewRule, ReviewRule];
      if (kept.has(drop.id)) continue;
      // The kept rule's own actions first.
      const actions = unionActions(keep.actions, drop.actions);
      if (!actions) continue;
      const conditionSources = steady(drop) && !steady(keep) ? [drop, keep] : [keep, drop];
      for (const src of conditionSources) {
        const merged: ReviewRule = {
          ...keep,
          match: src.match,
          conditions: src.conditions,
          actions,
        };
        const after = live
          .filter((r) => r.id !== drop.id)
          .map((r) => (r.id === keep.id ? merged : r));
        if (touched.every((f, k) => outcome(after, f) === before[k])) {
          out.push({
            keepId: keep.id,
            removeId: drop.id,
            conditionsFrom: src.id,
            actions,
            sharedCount: shared,
          });
          removed.add(drop.id);
          kept.add(keep.id);
          break;
        }
      }
    }
  return out;
}
