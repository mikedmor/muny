import { type MunyDb, newId, schema } from "@muny/db";
import {
  type AiCategorizeResult,
  type AiTemplateDraft,
  formatMoney,
  type StatementKind,
  TEMPLATE_FIELDS,
} from "@muny/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { fileFromMuny } from "../agent/proposals.js";
import { budgetMonth } from "../budgets/service.js";
import { localToday } from "../lib/dates.js";
import { readPlan } from "../loans/routes.js";
import { monthlyReport, spendingReport } from "../reports/service.js";
import { addMonths, categoryMeta, monthEnd } from "../reports/spending.js";
import { savingsOpportunities } from "../savings/opportunities.js";
import { readField } from "../statements/templates.js";
import { askJson, askText } from "./call.js";
import { aiConnection } from "./settings.js";

/**
 * What the built-in AI does. Each feature sends the provider only what it
 * needs (said in each function), long digit runs are masked first, and
 * anything that would change data goes to the inbox for a person to approve.
 */

export interface AiDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
}

/** Account and card numbers out: any run of 6 or more digits. */
export const maskDigits = (s: string) => s.replace(/\d{6,}/g, (m) => "#".repeat(m.length));

const MAX_CATEGORIZE = 60;

/**
 * Suggest categories for recent uncategorized transactions. Sent: each one's
 * merchant or description (masked) and amount, and your category names.
 * Suggestions land in the inbox, one per category.
 */
export async function suggestCategories(
  db: MunyDb,
  deps: AiDeps,
  today = localToday(),
): Promise<AiCategorizeResult> {
  const conn = aiConnection(db, deps.secretKey, "categorize");
  const from = `${addMonths(today.slice(0, 7), -3)}-01`;
  const rows = db.all<{ id: string; name: string; cents: number }>(sql`
    select t.id as id, coalesce(p.display_name, t.raw_description) as name, t.amount_cents as cents
      from transactions t
      left join payees p on p.id = t.payee_id
      join accounts a on a.id = t.account_id
     where t.category_id is null and t.hidden = 0 and t.transfer_pair_id is null
       and a.exclude_from_reports = 0
       and t.posted_date >= ${from}
       and not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
     order by t.posted_date desc
     limit ${MAX_CATEGORIZE}`);
  if (!rows.length) return { considered: 0, suggested: 0, filed: 0 };

  const cats = [...categoryMeta(db).values()].filter(
    (c) => !c.hidden && (c.kind === "expense" || c.kind === "income"),
  );
  const label = (c: (typeof cats)[number]) => `${c.groupName} / ${c.name}`;
  const byLabel = new Map(cats.map((c) => [label(c).toLowerCase(), c]));

  const Answer = z.object({
    suggestions: z.array(z.object({ n: z.number().int(), category: z.string().nullable() })),
  });
  const answer = await askJson(
    {
      ...conn,
      fetch: deps.fetch,
      effort: "low",
      maxTokens: 4000,
      system:
        "You sort a household's bank transactions into their own budget categories. Choose only from the categories given, written exactly as listed. When a transaction could fit several, or you can't tell from the name, answer null: a person reviews every suggestion, and a wrong guess costs them more than a skipped one.",
      prompt: `Categories:\n${cats.map((c) => `- ${label(c)}`).join("\n")}\n\nTransactions (number. name, amount; negative is money out):\n${rows
        .map((r, i) => `${i + 1}. ${maskDigits(r.name).slice(0, 80)}, ${formatMoney(r.cents)}`)
        .join(
          "\n",
        )}\n\nAnswer as JSON: {"suggestions": [{"n": <transaction number>, "category": "<Group / Name from the list>" or null}]}, one entry per transaction.`,
    },
    Answer,
  );

  const groups = new Map<string, string[]>();
  for (const s of answer.suggestions) {
    const row = rows[s.n - 1];
    const cat = s.category ? byLabel.get(s.category.trim().toLowerCase()) : undefined;
    if (!row || !cat) continue;
    // Money in goes to income categories, money out to spending ones.
    if (row.cents > 0 !== (cat.kind === "income")) continue;
    const list = groups.get(cat.id) ?? [];
    if (!list.includes(row.id)) list.push(row.id);
    groups.set(cat.id, list);
  }
  let filed = 0;
  for (const [categoryId, ids] of groups) {
    const r = fileFromMuny(
      db,
      today,
      "categorize_transactions",
      { transaction_ids: ids, category: categoryId },
      "Suggested by Muny AI from the merchant names. Check them before approving.",
    );
    if (r.filed) filed++;
  }
  return {
    considered: rows.length,
    suggested: [...groups.values()].reduce((s, l) => s + l.length, 0),
    filed,
  };
}

const monthName = (m: string) =>
  new Date(`${m}-15T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });

/**
 * The numbers a review is written from: totals for the month and the one
 * before, the biggest categories, budgets gone over, and Ways to save. No
 * transactions, merchants, accounts or balances.
 */
export function reviewFacts(db: MunyDb, month: string, today = localToday()): string {
  const prev = addMonths(month, -1);
  const [before, now] = monthlyReport(db, prev, month).months;
  const cats = spendingReport(db, `${month}-01`, monthEnd(month), "category").items.slice(0, 8);
  const prevCats = new Map(
    spendingReport(db, `${prev}-01`, monthEnd(prev), "category").items.map((i) => [i.id, i.cents]),
  );
  const over = budgetMonth(db, month)
    .groups.flatMap((g) => g.lines)
    .filter((l) => l.availableCents !== null && l.availableCents < 0);
  const ways = savingsOpportunities(db, readPlan(db), today).items.slice(0, 5);
  const lines = [
    `Month: ${monthName(month)}`,
    `Income: ${formatMoney(now?.incomeCents ?? 0)} (${monthName(prev)}: ${formatMoney(before?.incomeCents ?? 0)})`,
    `Spending: ${formatMoney(now?.spendingCents ?? 0)} (${monthName(prev)}: ${formatMoney(before?.spendingCents ?? 0)})`,
    "Biggest categories (this month, month before):",
    ...cats.map(
      (c) => `- ${c.name}: ${formatMoney(c.cents)}, ${formatMoney(prevCats.get(c.id) ?? 0)}`,
    ),
    over.length
      ? `Over budget: ${over.map((l) => `${l.name} by ${formatMoney(-(l.availableCents ?? 0))}`).join("; ")}`
      : "Over budget: none",
    ways.length
      ? `Ways to save Muny found: ${ways.map((w) => `${w.title} (about ${formatMoney(w.yearlyCents)} a year)`).join("; ")}`
      : "Ways to save Muny found: none",
  ];
  return lines.join("\n");
}

/**
 * Write a short review of a month and leave it as a notification (it goes
 * to the channels set for "Monthly money review"). Sent: reviewFacts only.
 */
export async function writeReview(
  db: MunyDb,
  deps: AiDeps,
  month: string,
  today = localToday(),
): Promise<string> {
  const conn = aiConnection(db, deps.secretKey, "monthlyReview");
  const text = await askText({
    ...conn,
    fetch: deps.fetch,
    effort: "medium",
    maxTokens: 2000,
    system:
      "You write a short, plain monthly money review for a household, from figures their own finance app worked out. Use only the numbers given and don't invent any. Be warm and direct, not preachy. Plain text: 3 to 5 short lines, each starting with '- ', under 150 words in all, ending with the one thing most worth doing next month.",
    prompt: reviewFacts(db, month, today),
  });
  if (!text) throw new Error("The review came back empty.");
  const body = text.slice(0, 2000);
  const dedupeKey = `ai_review:${month}`;
  // Writing it again replaces the month's review.
  db.delete(schema.notifications).where(eq(schema.notifications.dedupeKey, dedupeKey)).run();
  db.insert(schema.notifications)
    .values({
      id: newId(),
      ruleType: "ai_review",
      dedupeKey,
      severity: "info",
      title: `Your ${monthName(month)} money review`,
      body,
      link: "/savings",
    })
    .run();
  return body;
}

/** Early each month, last month's review (once), if it's turned on and the alert is on. */
export async function monthlyReviewIfDue(db: MunyDb, deps: AiDeps, today = localToday()) {
  if (Number(today.slice(8)) > 7) return false;
  const rule = db
    .select({ enabled: schema.alertRules.enabled })
    .from(schema.alertRules)
    .where(eq(schema.alertRules.type, "ai_review"))
    .get();
  if (rule && !rule.enabled) return false;
  const month = addMonths(today.slice(0, 7), -1);
  const done = db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.ruleType, "ai_review"),
        eq(schema.notifications.dedupeKey, `ai_review:${month}`),
      ),
    )
    .get();
  if (done) return false;
  try {
    aiConnection(db, deps.secretKey, "monthlyReview");
  } catch {
    return false; // off, or not set up
  }
  await writeReview(db, deps, month, today);
  return true;
}

export function startAiScheduler(
  db: MunyDb,
  deps: AiDeps,
  log: { warn: (o: object, msg: string) => void },
) {
  const tick = () =>
    void monthlyReviewIfDue(db, deps).catch((err) =>
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "Monthly AI review failed"),
    );
  const first = setTimeout(tick, 90_000);
  const timer = setInterval(tick, 60 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * Fill in "Teach Muny" from a statement's lines. Sent: the lines, with long
 * digit runs masked. Only labels that really find a value are kept.
 */
export async function draftTemplate(
  db: MunyDb,
  deps: AiDeps,
  kind: StatementKind,
  lines: string[],
): Promise<AiTemplateDraft> {
  const conn = aiConnection(db, deps.secretKey, "statementTemplates");
  const masked = lines.map((l) => maskDigits(l).slice(0, 300)).slice(0, 400);
  const fields = TEMPLATE_FIELDS[kind];
  const Answer = z.object({
    name: z.string(),
    matchText: z.string(),
    fields: z.array(z.object({ key: z.string(), label: z.string().nullable() })),
  });
  const answer = await askJson(
    {
      ...conn,
      fetch: deps.fetch,
      effort: "medium",
      maxTokens: 3000,
      system:
        "You read the text of a bank statement and say where each value is. For each field, give the words that come right before its value on the same line, copied exactly from the text (just the label, not the value). Use null when a field isn't on the statement.",
      prompt: `Fields:\n${fields.map((f) => `- ${f.key}: ${f.label} (${f.type})`).join("\n")}\n\nStatement lines:\n${masked.join("\n")}\n\nAnswer as JSON: {"name": "<the lender or bank's name>", "matchText": "<short text that appears on every statement from this lender, like its web address>", "fields": [{"key": "<field key>", "label": "<label text>" or null}]}.`,
    },
    Answer,
  );
  const out: AiTemplateDraft["fields"] = {};
  for (const f of fields) {
    const label = answer.fields.find((x) => x.key === f.key)?.label?.trim();
    // Kept only if it reads a value from this very statement.
    if (label && readField(lines, label, f.type) !== null)
      out[f.key] = { label: label.slice(0, 60) };
  }
  const text = lines.join("\n").toLowerCase();
  const match = answer.matchText.trim();
  return {
    name: answer.name.trim().slice(0, 80),
    matchText: match && text.includes(match.toLowerCase()) ? match.slice(0, 80) : "",
    fields: out,
  };
}
