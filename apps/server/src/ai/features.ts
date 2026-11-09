import { type MunyDb, newId, schema } from "@muny/db";
import {
  type AiCategorizeResult,
  type AiTemplateDraft,
  formatMoney,
  type StatementKind,
  TEMPLATE_FIELDS,
} from "@muny/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { fileFromMuny, MUNY_AI } from "../agent/proposals.js";
import { budgetMonth } from "../budgets/service.js";
import { localToday } from "../lib/dates.js";
import { onTransactionsAdded } from "../lib/events.js";
import { readPlan } from "../loans/routes.js";
import { monthlyReport, spendingReport } from "../reports/service.js";
import { addMonths, categoryMeta, monthEnd } from "../reports/spending.js";
import { savingsOpportunities } from "../savings/opportunities.js";
import { readField } from "../statements/templates.js";
import { describeChange, openChange, runAsChange } from "../undo/track.js";
import { type AiCall, AiCallError, askJson, askText } from "./call.js";
import { aiConnection } from "./settings.js";

/**
 * What the built-in AI does. Each feature sends the provider only what it
 * needs (said in each function), long digit runs are masked first, and
 * anything that would change data goes to the inbox for a person to approve.
 */

export interface AiDeps {
  secretKey: Buffer | undefined;
  fetch?: typeof fetch;
  /** For tests: how to wait between tries. */
  sleep?: (seconds: number) => Promise<void>;
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
  wait: Pick<AiCall, "mode" | "onWait"> = {},
): Promise<AiCategorizeResult> {
  const conn = aiConnection(
    db,
    deps.secretKey,
    wait.mode === "background" ? "autoCategorize" : "categorize",
  );
  if (wait.mode === "background") aiConnection(db, deps.secretKey, "categorize");
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
       -- Already waiting in the inbox, or turned down: not again.
       and not exists (
         select 1 from agent_proposals ap, json_each(ap.input, '$.transaction_ids') j
          where ap.tool = 'categorize_transactions' and ap.status in ('pending', 'rejected')
            and j.value = t.id)
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
      ...wait,
      fetch: deps.fetch,
      sleep: deps.sleep,
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

export interface BudgetIdea {
  categoryId: string;
  name: string;
  /** Spent in the month reviewed. */
  spentCents: number;
  /** The median of the three months before. */
  usualCents: number;
  /** The usual, rounded up to $10. */
  amountCents: number;
}

/**
 * The one budget worth suggesting after a month: the category that jumped
 * most above its usual (the median of the three months before), at least 30%
 * and $50 over. Budget: the usual, rounded up to $10, unless the category's
 * budget is already that low. Worked out here, not by the model.
 */
export function budgetIdea(db: MunyDb, month: string, today = localToday()): BudgetIdea | null {
  const spend = (m: string) =>
    new Map(
      spendingReport(db, `${m}-01`, monthEnd(m), "category")
        .items.filter((i) => i.id)
        .map((i) => [i.id as string, i]),
    );
  const now = spend(month);
  const before = [1, 2, 3].map((k) => spend(addMonths(month, -k)));
  const budgets = new Map(
    budgetMonth(db, today.slice(0, 7))
      .groups.flatMap((g) => g.lines)
      .filter((l) => l.categoryId)
      .map((l) => [l.categoryId as string, l.budgetCents]),
  );
  const cats = categoryMeta(db);
  // Turned down in the last three months: leave it be.
  const declined = new Set(
    db
      .all<{ category: string }>(sql`
        select json_extract(input, '$.category') as category from agent_proposals
         where tool = 'set_budget' and status = 'rejected' and token_name = ${MUNY_AI}
           and decided_at > ${Date.now() - 90 * 86_400_000}`)
      .map((r) => r.category),
  );
  let best: (BudgetIdea & { jump: number }) | null = null;
  for (const [id, item] of now) {
    if (cats.get(id)?.kind !== "expense" || declined.has(id)) continue;
    const past = before.map((m) => Math.max(0, m.get(id)?.cents ?? 0)).sort((a, b) => a - b);
    const usual = past[1] ?? 0;
    const jump = item.cents - usual;
    if (usual <= 0 || item.cents < usual * 1.3 || jump < 5_000) continue;
    const amount = Math.ceil(usual / 1_000) * 1_000;
    const budget = budgets.get(id);
    if (budget != null && budget <= amount) continue;
    if (!best || jump > best.jump)
      best = {
        categoryId: id,
        name: item.name,
        spentCents: item.cents,
        usualCents: usual,
        amountCents: amount,
        jump,
      };
  }
  if (!best) return null;
  const { jump: _, ...idea } = best;
  return idea;
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
  const idea = budgetIdea(db, month, today);
  if (idea)
    lines.push(
      `Budget Muny suggests, waiting in the inbox to approve: ${idea.name} at ${formatMoney(idea.amountCents)} a month (it was ${formatMoney(idea.spentCents)} this month, usually about ${formatMoney(idea.usualCents)})`,
    );
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
  wait: Pick<AiCall, "mode" | "onWait"> = {},
): Promise<string> {
  const conn = aiConnection(db, deps.secretKey, "monthlyReview");
  const text = await askText({
    ...conn,
    ...wait,
    fetch: deps.fetch,
    sleep: deps.sleep,
    effort: "medium",
    maxTokens: 2000,
    system:
      "You write a short, plain monthly money review for a household, from figures their own finance app worked out. Use only the numbers given and don't invent any. Be warm and direct, not preachy. Plain text, under 150 words in all: 3 or 4 short lines, each on its own line starting with '- ', then a last line starting 'Next month: ' with the one thing most worth doing. No headings, bold or other markdown. If the figures include a budget Muny suggests, make the Next month line about it.",
    prompt: reviewFacts(db, month, today),
  });
  if (!text) throw new Error("The review came back empty.");
  const body = tidyReview(text).slice(0, 2000);
  const dedupeKey = `ai_review:${month}`;
  // Writing it again replaces the month's review, and it's no longer missing.
  db.delete(schema.notifications)
    .where(inArray(schema.notifications.dedupeKey, [dedupeKey, missedKey(month)]))
    .run();
  db.insert(schema.notifications)
    .values({
      id: newId(),
      ruleType: "ai_review",
      dedupeKey,
      severity: "info",
      title: `Your ${monthName(month)} money review`,
      body,
      link: "/reports#reviews",
    })
    .run();
  // Kept for Reports → Reviews, apart from notifications (which can be cleared).
  db.insert(schema.aiReviews)
    .values({ month, body })
    .onConflictDoUpdate({ target: schema.aiReviews.month, set: { body, createdAt: new Date() } })
    .run();
  const idea = budgetIdea(db, month, today);
  if (idea)
    fileFromMuny(
      db,
      today,
      "set_budget",
      { category: idea.categoryId, amount_cents: idea.amountCents },
      `${idea.name} came to ${formatMoney(idea.spentCents)} in ${monthName(month)}, against about ${formatMoney(idea.usualCents)} most months. A budget keeps an eye on it.`,
    );
  return body;
}

/**
 * The review as plain lines for every channel: "- " points, then "Next
 * month: ...". No markdown. A model that wrote a paragraph anyway gets a
 * point per sentence, and a "Next month:" inside the text its own line.
 */
export function tidyReview(text: string): string {
  const lines = text
    .replace(/\*\*|__/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean);
  const bullet = (l: string) => /^[-•*]\s/.test(l);
  const at = lines.findIndex((l) => /^next month:/i.test(l));
  let body = at >= 0 ? lines.slice(0, at) : lines;
  let next = at >= 0 ? lines.slice(at).join(" ") : null;
  if (!next && !body.some(bullet)) {
    const m = body.join(" ").match(/^(.*?)\s*(Next month:.*)$/i);
    if (m?.[2]) {
      body = m[1] ? [m[1]] : [];
      next = m[2];
    }
  }
  if (body.length && !body.some(bullet))
    body = body
      .join(" ")
      .split(/(?<=[.!?])\s+(?=[A-Z$"“(])/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `- ${p}`);
  return [...body, ...(next ? [next.replace(/^next month:\s*/i, "Next month: ")] : [])].join("\n");
}

/** Early each month, last month's review (once), if it's turned on and the alert is on. */
export async function monthlyReviewIfDue(
  db: MunyDb,
  deps: AiDeps,
  today = localToday(),
  onWait?: AiCall["onWait"],
) {
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
  try {
    // Nobody's waiting on it: sit out a busy server or a model download, within limits.
    await writeReview(db, deps, month, today, { mode: "background", onWait });
  } catch (err) {
    if (err instanceof AiCallError) noteMissedReview(db, month, err, today);
    throw err;
  }
  return true;
}

const missedKey = (month: string) => `ai_review_missed:${month}`;

/**
 * Say once a month that the review couldn't be written yet, and why. It's
 * tried again every hour through the 7th, and the note goes when it lands.
 */
function noteMissedReview(db: MunyDb, month: string, err: AiCallError, today: string) {
  const more = Number(today.slice(8)) < 7;
  db.insert(schema.notifications)
    .values({
      id: newId(),
      ruleType: "ai_review",
      dedupeKey: missedKey(month),
      severity: "warning",
      title: `Couldn't write your ${monthName(month)} money review yet`,
      body: `${err.message} ${
        more
          ? "Muny will keep trying every hour until the 7th."
          : "You can write it from Settings → AI once the AI server is ready."
      }`.slice(0, 2000),
      link: "/settings#ai",
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Suggest categories by itself, after new transactions arrive. Runs in the
 * background (waiting out a busy server), as its own change in the history
 * so its inbox items can be undone apart from the sync that started it.
 */
export async function autoCategorize(
  db: MunyDb,
  deps: AiDeps,
  onWait?: AiCall["onWait"],
): Promise<AiCategorizeResult | null> {
  try {
    aiConnection(db, deps.secretKey, "autoCategorize");
    aiConnection(db, deps.secretKey, "categorize");
  } catch {
    return null; // off, or not set up
  }
  const id = openChange(db, { actorType: "system", actorName: MUNY_AI });
  return runAsChange(id, async () => {
    const out = await suggestCategories(db, deps, localToday(), { mode: "background", onWait });
    if (out.filed) describeChange(db, `Suggested categories for ${out.suggested} new transactions`);
    return out;
  });
}

/** After a sync or import, wait for things to settle (more may follow), then suggest. */
export function startAutoCategorize(
  db: MunyDb,
  deps: AiDeps,
  log: { warn: (o: object, msg: string) => void; info?: (o: object, msg: string) => void },
  settleMs = 2 * 60_000,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const run = () => {
    timer = null;
    if (running) {
      again = true;
      return;
    }
    running = true;
    // Not part of whichever request's sync set this off.
    void runAsChange(null, () =>
      autoCategorize(db, deps, (reason, seconds) =>
        log.info?.({ reason, seconds }, "Category suggestions waiting on the AI server"),
      ),
    )
      .catch((err) =>
        log.warn(
          { err: err instanceof Error ? err.message : "unknown" },
          "Suggesting categories after a sync failed",
        ),
      )
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, settleMs);
    timer.unref?.();
  };
  const off = onTransactionsAdded(() => schedule());
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}

const looksRaw = (name: string) =>
  /[*#_]|\d{3,}|\b(POS|ACH|DEBIT|PURCHASE)\b|^(SQ|TST|PP|SP)\b/.test(name) ||
  (name === name.toUpperCase() && /[A-Z]{3}/.test(name));

const MAX_MERCHANTS = 60;

/**
 * Suggest tidier names for merchants that still look like bank text. Sent:
 * those names, with long digit runs masked. One inbox item with all of them.
 */
export async function suggestMerchantNames(db: MunyDb, deps: AiDeps): Promise<AiCategorizeResult> {
  const conn = aiConnection(db, deps.secretKey, "merchantNames");
  const rows = db
    .all<{ name: string }>(sql`
      select p.display_name as name from payees p
       where exists (select 1 from transactions t where t.payee_id = p.id)
         and not exists (
           select 1 from agent_proposals ap, json_each(ap.input, '$.renames') j
            where ap.tool = 'rename_merchants' and ap.status in ('pending', 'rejected')
              and json_extract(j.value, '$.from') = p.display_name)
       order by (select count(*) from transactions t where t.payee_id = p.id) desc`)
    .filter((r) => looksRaw(r.name))
    .slice(0, MAX_MERCHANTS);
  if (!rows.length) return { considered: 0, suggested: 0, filed: 0 };
  const Answer = z.object({
    names: z.array(z.object({ n: z.number().int(), name: z.string().nullable() })),
  });
  const answer = await askJson(
    {
      ...conn,
      fetch: deps.fetch,
      sleep: deps.sleep,
      effort: "low",
      maxTokens: 3000,
      system:
        "You turn raw bank merchant text into the short name a person would call the business, like 'Corner Cafe' for 'SQ *CORNER CAFE 1234 ANYTOWN'. Drop store numbers, cities, card processors and reference codes. Answer null when you can't tell what the business is: never guess a brand the text doesn't point to. A person reviews every name.",
      prompt: `Merchant text:\n${rows.map((r, i) => `${i + 1}. ${maskDigits(r.name).slice(0, 80)}`).join("\n")}\n\nAnswer as JSON: {"names": [{"n": <number>, "name": "<short name>" or null}]}, one entry per line.`,
    },
    Answer,
  );
  const renames = new Map<string, string>();
  for (const a of answer.names) {
    const from = rows[a.n - 1]?.name;
    const to = a.name?.trim();
    if (!from || !to || to === from || to.length > 60 || /[*#]|^\d+$/.test(to)) continue;
    renames.set(from, to);
  }
  if (!renames.size) return { considered: rows.length, suggested: 0, filed: 0 };
  const r = fileFromMuny(
    db,
    localToday(),
    "rename_merchants",
    { renames: [...renames].map(([from, to]) => ({ from, to })) },
    "Suggested by Muny AI from the bank's text. Check them before approving.",
  );
  return { considered: rows.length, suggested: renames.size, filed: r.filed ? 1 : 0 };
}

/**
 * How the month's budgets are pacing, for the check-in: what's budgeted and
 * spent, and which are ahead of the calendar. Worked out here. Sent: only
 * these figures, by category. Null when there are no budgets to talk about.
 */
export function checkinFacts(db: MunyDb, today = localToday()): string | null {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8));
  const days = Number(monthEnd(month).slice(8));
  const fraction = day / days;
  const b = budgetMonth(db, month);
  const lines = b.groups
    .flatMap((g) => g.lines)
    .filter((l) => l.categoryId && l.kind !== "income" && l.budgetCents && l.budgetCents > 0);
  if (!lines.length) return null;
  const ahead = lines
    .map((l) => ({ l, over: l.spentCents - (l.budgetCents as number) * fraction }))
    .filter(
      (x) => x.l.spentCents > (x.l.budgetCents as number) * fraction * 1.15 && x.over >= 1_000,
    )
    .sort((x, y) => y.over - x.over)
    .slice(0, 5);
  const budget = lines.reduce((s, l) => s + (l.budgetCents as number), 0);
  const spent = lines.reduce((s, l) => s + l.spentCents, 0);
  return [
    `Day ${day} of ${days} in ${monthName(month)}`,
    `Across ${lines.length} budgeted categories: ${formatMoney(spent)} spent of ${formatMoney(budget)}`,
    ahead.length
      ? `Ahead of the calendar: ${ahead
          .map(
            ({ l }) =>
              `${l.name} (${formatMoney(l.spentCents)} of ${formatMoney(l.budgetCents as number)})`,
          )
          .join("; ")}`
      : "Ahead of the calendar: none",
  ].join("\n");
}

/** Write this month's check-in and leave it as a notification. Null when there's nothing to say. */
export async function writeCheckin(
  db: MunyDb,
  deps: AiDeps,
  today = localToday(),
  wait: Pick<AiCall, "mode" | "onWait"> = {},
): Promise<string | null> {
  const conn = aiConnection(db, deps.secretKey, "midMonthCheckin");
  const facts = checkinFacts(db, today);
  if (!facts) return null;
  const text = await askText({
    ...conn,
    ...wait,
    fetch: deps.fetch,
    sleep: deps.sleep,
    effort: "low",
    maxTokens: 800,
    system:
      "You write a short mid-month note on how a household's budgets are pacing, from figures their own finance app worked out. Use only the numbers given and don't invent any. Be warm and direct, not preachy. Plain text, under 70 words: 2 or 3 short lines, each on its own line starting with '- '. No headings, bold or other markdown.",
    prompt: facts,
  });
  if (!text) throw new Error("The check-in came back empty.");
  const month = today.slice(0, 7);
  const body = tidyReview(text).slice(0, 1000);
  const dedupeKey = `ai_checkin:${month}`;
  db.delete(schema.notifications).where(eq(schema.notifications.dedupeKey, dedupeKey)).run();
  db.insert(schema.notifications)
    .values({
      id: newId(),
      ruleType: "ai_checkin",
      dedupeKey,
      severity: "info",
      title: `How ${monthName(month).split(" ")[0]} is going`,
      body,
      link: "/budgets",
    })
    .run();
  return body;
}

/** Around mid-month, this month's check-in (once), if it's turned on and the alert is on. */
export async function midMonthCheckinIfDue(
  db: MunyDb,
  deps: AiDeps,
  today = localToday(),
  onWait?: AiCall["onWait"],
) {
  const day = Number(today.slice(8));
  if (day < 15 || day > 21) return false;
  const rule = db
    .select({ enabled: schema.alertRules.enabled })
    .from(schema.alertRules)
    .where(eq(schema.alertRules.type, "ai_checkin"))
    .get();
  if (rule && !rule.enabled) return false;
  const done = db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(eq(schema.notifications.dedupeKey, `ai_checkin:${today.slice(0, 7)}`))
    .get();
  if (done) return false;
  try {
    aiConnection(db, deps.secretKey, "midMonthCheckin");
  } catch {
    return false; // off, or not set up
  }
  return (await writeCheckin(db, deps, today, { mode: "background", onWait })) !== null;
}

export function startAiScheduler(
  db: MunyDb,
  deps: AiDeps,
  log: { warn: (o: object, msg: string) => void; info?: (o: object, msg: string) => void },
) {
  let running = false;
  const tick = () => {
    // A background review can wait out a busy server for a while; don't start a second one.
    if (running) return;
    running = true;
    const failed = (what: string) => (err: unknown) =>
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, what);
    const waiting = (reason: string, seconds: number) =>
      log.info?.({ reason, seconds }, "A scheduled AI job is waiting on the AI server");
    void monthlyReviewIfDue(db, deps, localToday(), waiting)
      .catch(failed("Monthly AI review failed"))
      .then(() => midMonthCheckinIfDue(db, deps, localToday(), waiting))
      .catch(failed("Mid-month AI check-in failed"))
      .finally(() => {
        running = false;
      });
  };
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
      sleep: deps.sleep,
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
