import type { RuleDefinition } from "@muny/shared";
import { describe, expect, it } from "vitest";
import { applyRules, ruleMatches } from "./engine.js";

const facts = {
  description: "SQ *BLUE BOTTLE 0123",
  payee: "Blue Bottle",
  amountCents: -550,
  accountId: "a1",
};
const base = {
  categoryId: null,
  payeeName: "Blue Bottle",
  tags: [],
  hidden: false,
  seriesId: null,
};

describe("rules engine", () => {
  it("matches text case-insensitively with all/any", () => {
    const all: RuleDefinition = {
      match: "all",
      conditions: [
        { field: "payee", op: "equals", value: "blue bottle" },
        { field: "direction", value: "out" },
        { field: "amount", op: "lte", value: 1000 },
      ],
      actions: [],
    };
    expect(ruleMatches(all, facts)).toBe(true);
    expect(
      ruleMatches(
        { ...all, conditions: [...all.conditions, { field: "account", value: "zz" }] },
        facts,
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        {
          match: "any",
          conditions: [
            { field: "account", value: "zz" },
            { field: "description", op: "startsWith", value: "sq *" },
          ],
        },
        facts,
      ),
    ).toBe(true);
    expect(ruleMatches({ match: "all", conditions: [] }, facts)).toBe(false);
    expect(
      ruleMatches(
        { match: "all", conditions: [{ field: "description", op: "contains", value: "  " }] },
        facts,
      ),
    ).toBe(false);
  });

  it("first category/payee wins, tags accumulate, hide sticks", () => {
    const rules: RuleDefinition[] = [
      {
        match: "all",
        conditions: [{ field: "payee", op: "contains", value: "bottle" }],
        actions: [
          { type: "setCategory", categoryId: "coffee" },
          { type: "addTag", name: "treats" },
        ],
      },
      {
        match: "all",
        conditions: [{ field: "direction", value: "out" }],
        actions: [
          { type: "setCategory", categoryId: "other" },
          { type: "addTag", name: "Treats" },
          { type: "hide" },
          { type: "setPayee", name: "Blue Bottle Coffee" },
        ],
      },
    ];
    const r = applyRules(rules, facts, base);
    expect(r).toMatchObject({ changed: true, matched: 2 });
    expect(r.next).toEqual({
      categoryId: "coffee",
      payeeName: "Blue Bottle Coffee",
      tags: ["treats"],
      hidden: true,
      seriesId: null,
    });
  });

  it("reports no change when already in the target state", () => {
    const rules: RuleDefinition[] = [
      {
        match: "all",
        conditions: [{ field: "payee", op: "contains", value: "bottle" }],
        actions: [{ type: "setCategory", categoryId: "coffee" }],
      },
    ];
    expect(applyRules(rules, facts, { ...base, categoryId: "coffee" }).changed).toBe(false);
  });

  it("puts matching transactions in a recurring series, the first rule winning", () => {
    const rules: RuleDefinition[] = [
      {
        match: "all",
        conditions: [{ field: "payee", op: "contains", value: "bottle" }],
        actions: [{ type: "setRecurring", seriesId: "weekly" }],
      },
      {
        match: "all",
        conditions: [{ field: "payee", op: "contains", value: "blue" }],
        actions: [{ type: "setRecurring", seriesId: "other" }],
      },
    ];
    const r = applyRules(rules, facts, base);
    expect(r.next.seriesId).toBe("weekly");
    expect(r.changed).toBe(true);
    expect(applyRules(rules, facts, { ...base, seriesId: "weekly" }).changed).toBe(false);
  });
});
