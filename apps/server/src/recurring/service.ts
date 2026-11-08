import {
  addInterval,
  cleanPayeeName,
  detectRecurring,
  monthlyCents,
  normalizeDescription,
  type RecurringInput,
  type RecurringInterval,
  ruleMatches,
} from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type {
  RecurringKind,
  RecurringScanResult,
  RecurringSeries,
  RuleAction,
  RuleDefinition,
  UpcomingCharge,
} from "@muny/shared";
import { formatMoney } from "@muny/shared";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { notFound } from "../lib/http.js";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Db = MunyDb | Tx;

const DAYS: Record<RecurringInterval, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.44,
  quarterly: 91.31,
  semiannual: 182.62,
  annual: 365.25,
};
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const grace = (i: RecurringInterval) => DAYS[i] * 1.5 + 7;

/** Merchant key for a transaction: its merchant name, else a cleaned description. */
export function merchantKey(payee: string | null, raw: string): string {
  return (payee ?? cleanPayeeName(raw) ?? normalizeDescription(raw)).toLowerCase().trim();
}

const BILL_WORDS =
  /rent|mortgage|insurance|loan|electric|water|sewer|trash|gas & heating|internet|phone|utilit|bill|auto payment|tax/i;

function kindFor(
  direction: "out" | "in",
  fixedAmount: boolean,
  categoryName: string | null | undefined,
): RecurringKind {
  if (direction === "in") return "income";
  return !fixedAmount || BILL_WORDS.test(categoryName ?? "") ? "bill" : "subscription";
}

interface Row {
  id: string;
  accountId: string;
  postedDate: string;
  amountCents: number;
  rawDescription: string;
  payee: string | null;
  payeeId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  recurringSeriesId: string | null;
}

/** Transactions that can be part of a recurring series (no transfers or hidden; pending only when asked). */
function loadRows(db: Db, pending = false): Row[] {
  const t = schema.transactions;
  return db
    .select({
      id: t.id,
      accountId: t.accountId,
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      rawDescription: t.rawDescription,
      payee: schema.payees.displayName,
      payeeId: t.payeeId,
      categoryId: t.categoryId,
      categoryName: schema.categories.name,
      recurringSeriesId: t.recurringSeriesId,
    })
    .from(t)
    .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
    .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
    .leftJoin(schema.categories, eq(schema.categories.id, t.categoryId))
    .leftJoin(schema.categoryGroups, eq(schema.categoryGroups.id, schema.categories.groupId))
    .where(
      and(
        eq(t.pending, pending),
        eq(t.hidden, false),
        // A bank's withdrawal that only paid for a PayPal purchase: the purchase recurs.
        isNull(t.fundsTransactionId),
        sql`${schema.accounts.type} <> 'loan'`,
        or(
          isNull(t.transferPairId),
          and(
            sql`${schema.categoryGroups.kind} is not null`,
            sql`${schema.categoryGroups.kind} <> 'transfer'`,
          ),
        ),
        or(isNull(schema.categoryGroups.kind), sql`${schema.categoryGroups.kind} <> 'transfer'`),
      ),
    )
    .all();
}

/**
 * Loan accounts' own entries (interest charged, payments received) aren't
 * bills or income: the payment from checking is the bill. Series detected
 * there (not ones you confirmed) are removed.
 */
function dropLoanSeries(tx: Tx) {
  const s = schema.recurringSeries;
  const loanIds = tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.type, "loan"))
    .all()
    .map((a) => a.id);
  if (!loanIds.length) return;
  const stale = tx
    .select({ id: s.id })
    .from(s)
    .where(and(inArray(s.accountId, loanIds), eq(s.status, "detected"), eq(s.userModified, false)))
    .all()
    .map((x) => x.id);
  if (!stale.length) return;
  tx.update(schema.transactions)
    .set({ recurringSeriesId: null })
    .where(inArray(schema.transactions.recurringSeriesId, stale))
    .run();
  tx.delete(s).where(inArray(s.id, stale)).run();
}

/**
 * Funding (a bank's withdrawal to PayPal for a PayPal purchase) never belongs
 * to a recurring series: the purchase does. Detach it; a series left with no
 * charges was only ever that funding (a duplicate of the purchase's series),
 * so it goes (or, if you edited it, is ignored).
 */
function dropFundingSeries(tx: Tx) {
  const s = schema.recurringSeries;
  const t = schema.transactions;
  const hit = [
    ...new Set(
      tx
        .select({ id: t.recurringSeriesId })
        .from(t)
        .where(and(isNotNull(t.fundsTransactionId), isNotNull(t.recurringSeriesId)))
        .all()
        .map((r) => r.id as string),
    ),
  ];
  if (!hit.length) return;
  tx.update(t)
    .set({ recurringSeriesId: null })
    .where(and(isNotNull(t.fundsTransactionId), inArray(t.recurringSeriesId, hit)))
    .run();
  const left = new Set(
    tx
      .select({ id: t.recurringSeriesId })
      .from(t)
      .where(inArray(t.recurringSeriesId, hit))
      .all()
      .map((r) => r.id as string),
  );
  const empty = tx
    .select({ id: s.id, userModified: s.userModified })
    .from(s)
    .where(inArray(s.id, hit))
    .all()
    .filter((x) => !left.has(x.id));
  const drop = empty.filter((x) => !x.userModified).map((x) => x.id);
  const ignore = empty.filter((x) => x.userModified).map((x) => x.id);
  if (drop.length) tx.delete(s).where(inArray(s.id, drop)).run();
  if (ignore.length) tx.update(s).set({ status: "ignored" }).where(inArray(s.id, ignore)).run();
}

const near = (a: number, b: number, pct: number) => Math.abs(a - b) <= Math.max(a, b) * pct;

/** Words too common in bank descriptions to say two merchants are the same. */
const COMMON_WORDS = new Set(
  "payment payments online mobile bank card credit debit transfer deposit loan loans service services purchase from with bill autopay auto recurring monthly corp company inc llc the and orig name entry descr trace".split(
    " ",
  ),
);

/** Distinctive words of a merchant key (4+ letters, not boilerplate). */
function keyWords(key: string): Set<string> {
  return new Set(
    key
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !COMMON_WORDS.has(w)),
  );
}

/**
 * Detect recurring series across the whole ledger and reconcile with what's
 * stored: update known series, add new ones, link member transactions.
 * Ignored series stay ignored; user-edited fields are kept.
 */
/** Two merchant names that read as one: a shared word, or the same letters ("Duke Energy", "Dukeenergy"). */
function sameMerchantName(a: string, b: string): boolean {
  const wordsA = keyWords(a);
  const wordsB = keyWords(b);
  if ([...wordsA].some((w) => wordsB.has(w))) return true;
  const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const within = (words: Set<string>, other: string) =>
    words.size > 0 && [...words].every((w) => letters(other).includes(w));
  return within(wordsA, b) || within(wordsB, a);
}

/** How far a charge can stray from a series. Bills that vary, vary a lot. */
const amountFits = (
  cents: number,
  e: { anchorCents: number; lastAmountCents: number; fixedAmount: boolean },
) => {
  const room = e.fixedAmount ? 0.1 : 0.35;
  return near(cents, e.anchorCents, room) || near(cents, Math.abs(e.lastAmountCents), room);
};

/**
 * A bank can reword a merchant from one charge to the next. Left alone, the new
 * wording either tracks nothing, or joins another account's series that happens to
 * have that name. Charges like that are read as the running series on their own
 * account: same direction, a name that fits, an amount that fits, and due by then.
 */
function renamedMerchants(tx: Tx, rows: Row[], today: string): Map<string, string> {
  const s = schema.recurringSeries;
  const byAccount = new Map<string, Map<string, number>>();
  const latestOn = new Map<string, string>();
  for (const r of rows) {
    if (!r.recurringSeriesId) continue;
    const counts = byAccount.get(r.recurringSeriesId) ?? new Map<string, number>();
    counts.set(r.accountId, (counts.get(r.accountId) ?? 0) + 1);
    byAccount.set(r.recurringSeriesId, counts);
  }
  const homeOf = (id: string) =>
    [...(byAccount.get(id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const r of rows) {
    const id = r.recurringSeriesId;
    if (!id || homeOf(id) !== r.accountId) continue;
    if (r.postedDate > (latestOn.get(id) ?? "")) latestOn.set(id, r.postedDate);
  }
  const all = tx.select().from(s).all();
  const keyOfSeries = new Map(all.map((e) => [e.id, e.matchKey]));
  // Series whose own name is still on some of their charges. When none are (the
  // merchant was renamed outright), the series follows the new name instead.
  const nameStillUsed = new Set<string>();
  for (const r of rows) {
    const id = r.recurringSeriesId;
    if (
      id &&
      homeOf(id) === r.accountId &&
      merchantKey(r.payee, r.rawDescription) === keyOfSeries.get(id)
    )
      nameStillUsed.add(id);
  }
  const series = all
    .filter((e) => e.status !== "ignored" && e.status !== "cancelled" && latestOn.has(e.id))
    .map((e) => ({ ...e, home: homeOf(e.id), last: latestOn.get(e.id) as string }))
    .filter((e) => dayNum(today) - dayNum(e.last) <= grace(e.interval as RecurringInterval));

  const out = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => a.postedDate.localeCompare(b.postedDate))) {
    const key = merchantKey(r.payee, r.rawDescription);
    // Already with a series on its own account: it stays there, on every later scan too.
    if (r.recurringSeriesId && homeOf(r.recurringSeriesId) === r.accountId) {
      const own = keyOfSeries.get(r.recurringSeriesId);
      if (own && own !== key && nameStillUsed.has(r.recurringSeriesId)) out.set(r.id, own);
      continue;
    }
    const cents = Math.abs(r.amountCents);
    const direction = r.amountCents < 0 ? "out" : "in";
    const fits = series.filter(
      (e) => e.home === r.accountId && e.direction === direction && amountFits(cents, e),
    );
    if (fits.some((e) => e.matchKey === key)) continue;
    const target = fits
      .filter(
        (e) =>
          sameMerchantName(key, e.matchKey) &&
          dayNum(r.postedDate) - dayNum(e.last) >= DAYS[e.interval as RecurringInterval] * 0.5,
      )
      .sort((a, b) => b.last.localeCompare(a.last))[0];
    if (!target) continue;
    out.set(r.id, target.matchKey);
    target.last = r.postedDate;
  }
  return out;
}

/** Rule + series pairs the person took apart: never put back automatically. */
export const DECLINED_RULE_SERIES = "rules.recurring.declined";

/**
 * A rule you made for a bill or paycheck (to file it as Trash, say) is about
 * that series, so it gets "Count as recurring" by itself. Only when it plainly
 * is: it matches 3+ of the series' charges, every charge it matches that's in
 * any series is in this one, most of what it matches is this series, and the
 * direction agrees. Broad rules ("contains PAYPAL") span several series and
 * are left alone, and so is any pair the person removed.
 */
function adoptRulesForSeries(tx: Tx, rows: Row[]): number {
  const series = new Map(
    tx
      .select()
      .from(schema.recurringSeries)
      .all()
      .filter((x) => x.status !== "ignored")
      .map((x) => [x.id, x]),
  );
  if (!series.size) return 0;
  const declinedRow = tx
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, DECLINED_RULE_SERIES))
    .get();
  const declined = new Set(
    Array.isArray(declinedRow?.value) ? (declinedRow.value as string[]) : [],
  );
  let adopted = 0;
  for (const r of tx.select().from(schema.rules).where(eq(schema.rules.enabled, true)).all()) {
    const actions = r.actions as RuleAction[];
    if (actions.some((a) => a.type === "setRecurring")) continue;
    const cond = r.conditions as { match?: "all" | "any"; items?: RuleDefinition["conditions"] };
    const rule = { match: cond.match ?? "all", conditions: cond.items ?? [] };
    const matched = rows.filter((x) =>
      ruleMatches(rule, {
        description: x.rawDescription,
        payee: x.payee,
        amountCents: x.amountCents,
        accountId: x.accountId,
      }),
    );
    const inSeries = matched.filter((x) => x.recurringSeriesId && series.has(x.recurringSeriesId));
    const ids = new Set(inSeries.map((x) => x.recurringSeriesId as string));
    if (ids.size !== 1 || inSeries.length < 3) continue;
    const sid = [...ids][0] as string;
    const e = series.get(sid);
    if (!e || declined.has(`${r.id}:${sid}`)) continue;
    if (inSeries.length / matched.length < 0.6) continue;
    const dir = (x: Row) => (x.amountCents < 0 ? "out" : "in");
    if (matched.some((x) => dir(x) !== e.direction)) continue;
    tx.update(schema.rules)
      .set({ actions: [...actions, { type: "setRecurring", seriesId: sid }] })
      .where(eq(schema.rules.id, r.id))
      .run();
    audit(tx as unknown as MunyDb, {
      actorType: "system",
      action: "rule.auto_recurring",
      entityType: "rule",
      entityId: r.id,
      details: { seriesId: sid },
    });
    adopted++;
  }
  return adopted;
}

/**
 * The steady part of a bank description, as it literally appears: cut at the
 * first number or reference marker ("ACME PAYROLL PPD ID: 123" -> "ACME
 * PAYROLL"). Null when too little is left to be specific.
 */
export function steadyDescription(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/);
  const kept: string[] = [];
  for (const [i, tok] of tokens.entries()) {
    // The first word stays even with a digit in it ("SD1 SEWER"); after that,
    // numbers, dates and reference markers are what changes from charge to charge.
    if (i > 0 && (/\d/.test(tok) || /^#|^(?:PPD|CCD|WEB|ACH|ID|ID:|REF|CONF)$/i.test(tok))) break;
    kept.push(tok);
  }
  const text = kept
    .join(" ")
    .replace(/[\s:;,.*#-]+$/, "")
    .trim();
  return text.replace(/[^a-z]/gi, "").length >= 2 && text.length >= 3 ? text : null;
}

/**
 * Every confirmed series gets a rule of its own ("Count as recurring"), so its
 * charges stay with it whatever the bank calls the merchant. Built from the
 * newest charge: its steady description, direction and account. Skipped when
 * a rule already places the series, when you removed one before, or when the
 * rule wouldn't be specific (it would miss most of the series' charges, or
 * pull in another series' charges).
 */
function ensureSeriesRules(tx: Tx, rows: Row[], today: string): number {
  const placed = new Set<string>();
  for (const r of tx.select({ actions: schema.rules.actions }).from(schema.rules).all())
    for (const a of r.actions as RuleAction[])
      if (a.type === "setRecurring") placed.add(a.seriesId);
  const declinedRow = tx
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, DECLINED_RULE_SERIES))
    .get();
  const declined = new Set(
    Array.isArray(declinedRow?.value) ? (declinedRow.value as string[]) : [],
  );
  const bySeries = new Map<string, Row[]>();
  for (const r of rows)
    if (r.recurringSeriesId)
      bySeries.set(r.recurringSeriesId, [...(bySeries.get(r.recurringSeriesId) ?? []), r]);
  let priority = Number(
    tx
      .select({ m: sql<number>`coalesce(max(${schema.rules.priority}), 0)` })
      .from(schema.rules)
      .get()?.m ?? 0,
  );
  const all = tx.select().from(schema.recurringSeries).all();
  const running = new Set(
    all
      .filter((x) => dayNum(today) - dayNum(x.lastDate) <= grace(x.interval as RecurringInterval))
      .map((x) => x.id),
  );
  // Series can share a name (a paycheck and a bonus deposit, two loans): then
  // the rule's name says which, by account or else by amount.
  const accountName = new Map(
    tx
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .all()
      .map((a) => [a.id, a.name]),
  );
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const ruleName = (e: (typeof all)[number]) => {
    const twins = all.filter(
      (x) => x.id !== e.id && x.status !== "ignored" && same(x.name, e.name),
    );
    const acct = e.accountId ? accountName.get(e.accountId) : undefined;
    const label = !twins.length
      ? e.name
      : acct && twins.every((x) => x.accountId !== e.accountId)
        ? `${e.name} · ${acct}`
        : `${e.name} · ${formatMoney(Math.abs(e.expectedAmountCents))}`;
    return `${label.slice(0, 88)} (recurring)`;
  };
  // Muny's own rules still under their first name follow along.
  const automatic = new Set(
    tx
      .select({ id: schema.auditLog.entityId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "rule.auto_create"))
      .all()
      .map((x) => x.id),
  );
  const byId = new Map(all.map((x) => [x.id, x]));
  for (const r of tx.select().from(schema.rules).all()) {
    const actions = r.actions as RuleAction[];
    const only = actions.length === 1 ? actions[0] : undefined;
    if (!automatic.has(r.id) || only?.type !== "setRecurring") continue;
    const e = byId.get(only.seriesId);
    if (!e || r.name !== `${e.name} (recurring)`.slice(0, 100)) continue;
    const name = ruleName(e);
    if (name !== r.name)
      tx.update(schema.rules).set({ name }).where(eq(schema.rules.id, r.id)).run();
  }
  let made = 0;
  for (const e of all) {
    if (e.status !== "confirmed" || placed.has(e.id) || declined.has(`auto:${e.id}`)) continue;
    const own = (bySeries.get(e.id) ?? []).sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    const latest = own[own.length - 1];
    if (!latest || own.length < 2) continue;
    const words = steadyDescription(latest.rawDescription);
    if (!words) continue;
    const base: RuleDefinition["conditions"] = [
      { field: "description", op: "contains", value: words },
      { field: "direction", value: e.direction === "out" ? "out" : "in" },
      { field: "account", value: latest.accountId },
    ];
    // Two series can share a description (two loans with one servicer): then
    // the rule also names a price range around this one's amount.
    const anchor = Math.abs(latest.amountCents);
    const ranged: RuleDefinition["conditions"] = [
      ...base,
      { field: "amount", op: "gte", value: Math.floor((anchor * 4) / 5) },
      { field: "amount", op: "lte", value: Math.ceil((anchor * 5) / 4) },
    ];
    const conditions = [base, ranged].find((conds) => {
      const matched = rows.filter((x) =>
        ruleMatches(
          { match: "all", conditions: conds },
          {
            description: x.rawDescription,
            payee: x.payee,
            amountCents: x.amountCents,
            accountId: x.accountId,
          },
        ),
      );
      const mine = matched.filter((x) => x.recurringSeriesId === e.id).length;
      // Charges of another series still running mean the rule is too broad; an
      // ended series by the same words is an earlier run of this one.
      const other = (x: Row) => !!x.recurringSeriesId && x.recurringSeriesId !== e.id;
      const others = matched.filter(
        (x) => other(x) && running.has(x.recurringSeriesId as string),
      ).length;
      const ended = matched.filter(
        (x) => other(x) && !running.has(x.recurringSeriesId as string),
      ).length;
      // Specific enough: covers some of the series, and nothing of another live one.
      return others === 0 && mine >= 2 && mine + ended >= matched.length * 0.6;
    });
    if (!conditions) continue;
    priority += 10;
    const id = newId();
    tx.insert(schema.rules)
      .values({
        id,
        name: ruleName(e),
        enabled: true,
        priority,
        conditions: { match: "all", items: conditions },
        actions: [{ type: "setRecurring", seriesId: e.id }],
      })
      .run();
    audit(tx as unknown as MunyDb, {
      actorType: "system",
      action: "rule.auto_create",
      entityType: "rule",
      entityId: id,
      details: { seriesId: e.id },
    });
    placed.add(e.id);
    made++;
  }
  return made;
}

/** A series is gone: rules stop pointing at it, and a rule left with nothing to do goes too. */
export function forgetSeriesInRules(db: Db, seriesId: string) {
  for (const r of db.select().from(schema.rules).all()) {
    const actions = r.actions as RuleAction[];
    const kept = actions.filter((a) => !(a.type === "setRecurring" && a.seriesId === seriesId));
    if (kept.length === actions.length) continue;
    if (kept.length === 0) db.delete(schema.rules).where(eq(schema.rules.id, r.id)).run();
    else db.update(schema.rules).set({ actions: kept }).where(eq(schema.rules.id, r.id)).run();
  }
}

/**
 * "Count as recurring" rules: which transactions you've said belong to which
 * series. These win over every guess from merchant names, on every scan. The
 * first matching rule (by priority) decides; rules for ignored or missing
 * series are skipped.
 */
function ruleSeriesLinks(tx: Tx, rows: Row[]): Map<string, string> {
  const live = new Set(
    tx
      .select({ id: schema.recurringSeries.id, status: schema.recurringSeries.status })
      .from(schema.recurringSeries)
      .all()
      .filter((x) => x.status !== "ignored")
      .map((x) => x.id),
  );
  const rules = tx
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.enabled, true))
    .orderBy(asc(schema.rules.priority), asc(schema.rules.createdAt))
    .all()
    .map((r) => {
      const cond = r.conditions as { match?: "all" | "any"; items?: RuleDefinition["conditions"] };
      const target = (r.actions as RuleAction[]).find((a) => a.type === "setRecurring");
      return {
        match: cond.match ?? "all",
        conditions: cond.items ?? [],
        seriesId: target?.type === "setRecurring" ? target.seriesId : null,
      };
    })
    .filter((r): r is typeof r & { seriesId: string } => !!r.seriesId && live.has(r.seriesId));
  const out = new Map<string, string>();
  if (!rules.length) return out;
  for (const r of rows) {
    const facts = {
      description: r.rawDescription,
      payee: r.payee,
      amountCents: r.amountCents,
      accountId: r.accountId,
    };
    const hit = rules.find((rule) => ruleMatches(rule, facts));
    if (hit) out.set(r.id, hit.seriesId);
  }
  return out;
}

export function rescanRecurring(tx: Tx, today = localToday()): RecurringScanResult {
  dropLoanSeries(tx);
  dropFundingSeries(tx);
  const rows = loadRows(tx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const renamed = renamedMerchants(tx, rows, today);
  // Your own rules for a series come first; then every confirmed series gets one.
  adoptRulesForSeries(tx, rows);
  ensureSeriesRules(tx, rows, today);
  const ruled = ruleSeriesLinks(tx, rows);
  const keyOfSeriesId = new Map(
    tx
      .select({ id: schema.recurringSeries.id, key: schema.recurringSeries.matchKey })
      .from(schema.recurringSeries)
      .all()
      .map((x) => [x.id, x.key]),
  );
  const ruledKey = (id: string) => {
    const sid = ruled.get(id);
    return sid ? keyOfSeriesId.get(sid) : undefined;
  };
  const input: RecurringInput[] = rows.map((r) => ({
    id: r.id,
    key: ruledKey(r.id) ?? renamed.get(r.id) ?? merchantKey(r.payee, r.rawDescription),
    date: r.postedDate,
    amountCents: r.amountCents,
    accountId: r.accountId,
  }));
  const keyOf = new Map(input.map((i) => [i.id, i.key]));
  const candidates = detectRecurring(input, today);
  const s = schema.recurringSeries;
  const t = schema.transactions;
  const existing = tx.select().from(s).all();
  const touched = new Set<string>();
  const result: RecurringScanResult = { created: 0, updated: 0, linked: 0 };

  const link = (seriesId: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 500) {
      result.linked += tx
        .update(t)
        .set({ recurringSeriesId: seriesId })
        .where(
          and(
            inArray(t.id, ids.slice(i, i + 500)),
            or(isNull(t.recurringSeriesId), sql`${t.recurringSeriesId} <> ${seriesId}`),
          ),
        )
        .run().changes;
    }
  };

  /** Share of a candidate's charges already linked to a series. */
  const owned = (seriesId: string, ids: string[]) =>
    ids.filter((id) => byId.get(id)?.recurringSeriesId === seriesId).length / (ids.length || 1);

  // Newest charge date each rule-held series took from a candidate this scan.
  const ruledNewest = new Map<string, string>();
  for (const c of candidates) {
    // Charges a rule holds go to that series. A price change splits them into
    // several candidates; the newest decides the price, older ones only link.
    const votes = new Map<string, number>();
    for (const id of c.transactionIds) {
      const sid = ruled.get(id);
      if (sid) votes.set(sid, (votes.get(sid) ?? 0) + 1);
    }
    const top = [...votes].sort((a, b) => b[1] - a[1])[0];
    const held =
      top && top[1] * 2 >= c.transactionIds.length
        ? existing.find((e) => e.id === top[0])
        : undefined;
    if (held) {
      const seen = ruledNewest.get(held.id);
      if (seen && seen >= c.lastDate) continue;
      ruledNewest.set(held.id, c.lastDate);
      touched.delete(held.id);
    }
    const match =
      held ??
      existing.find(
        (e) =>
          !touched.has(e.id) &&
          e.matchKey === c.key &&
          e.direction === c.direction &&
          near(e.anchorCents, c.anchorCents, 0.3),
      ) ??
      // The merchant's name changed (renamed, or a better name cleanup): the
      // series that already holds most of these charges keeps them.
      existing.find(
        (e) =>
          !touched.has(e.id) && e.direction === c.direction && owned(e.id, c.transactionIds) >= 0.5,
      );
    const latest = byId.get(c.transactionIds[c.transactionIds.length - 1] ?? "");
    if (match) {
      touched.add(match.id);
      if (match.matchKey !== c.key) {
        tx.update(s).set({ matchKey: c.key }).where(eq(s.id, match.id)).run();
        match.matchKey = c.key;
      }
      if (match.status === "ignored") continue;
      tx.update(s)
        .set({
          anchorCents: c.anchorCents,
          firstDate: c.firstDate < match.firstDate ? c.firstDate : match.firstDate,
          lastDate: c.lastDate,
          lastAmountCents: c.lastAmountCents,
          accountId: c.accountId,
          ...(match.userModified
            ? {}
            : {
                interval: c.interval,
                expectedAmountCents: c.expectedAmountCents,
                fixedAmount: c.fixedAmount,
                categoryId: latest?.categoryId ?? match.categoryId,
                // Categories often arrive after detection (rules, edits); keep the type in step.
                kind: kindFor(c.direction, c.fixedAmount, latest?.categoryName),
              }),
        })
        .where(eq(s.id, match.id))
        .run();
      link(match.id, c.transactionIds);
      result.updated++;
      continue;
    }
    // Only start tracking things that are still running, or ended within the last two years.
    if (!c.active && dayNum(today) - dayNum(c.lastDate) > 730) continue;
    // A yearly charge that varies is plausible for taxes or insurance, not for
    // (say) an annual vacation; only track those when the category says bill.
    if (
      !c.fixedAmount &&
      (c.interval === "annual" || c.interval === "semiannual") &&
      !BILL_WORDS.test(latest?.categoryName ?? "")
    )
      continue;
    const kind = kindFor(c.direction, c.fixedAmount, latest?.categoryName);
    const id = newId();
    tx.insert(s)
      .values({
        id,
        name: (latest?.payee ?? cleanPayeeName(latest?.rawDescription ?? "") ?? c.key).slice(
          0,
          100,
        ),
        matchKey: c.key,
        direction: c.direction,
        anchorCents: c.anchorCents,
        kind,
        interval: c.interval,
        expectedAmountCents: c.expectedAmountCents,
        fixedAmount: c.fixedAmount,
        firstDate: c.firstDate,
        lastDate: c.lastDate,
        lastAmountCents: c.lastAmountCents,
        accountId: c.accountId,
        payeeId: latest?.payeeId ?? null,
        categoryId: latest?.categoryId ?? null,
      })
      .run();
    touched.add(id);
    link(id, c.transactionIds);
    result.created++;
  }

  // Attach newer charges detection didn't group with a series: manual series,
  // too few charges yet, or the same bill under a different description (a
  // bank sync often words it differently from the imported history, e.g.
  // "Citizens Mtg" vs "ORIG CO NAME:CITIZENS ... DESCR:MTG").
  const linkedNow = new Set(
    tx
      .select({ id: t.id })
      .from(t)
      .where(sql`${t.recurringSeriesId} is not null`)
      .all()
      .map((r) => r.id),
  );
  const claimed = new Set<string>();
  for (const e of tx.select().from(s).all()) {
    if (e.status === "ignored") continue;
    const words = keyWords(e.matchKey);
    const minGap = DAYS[e.interval as RecurringInterval] * 0.5;
    const newer = rows
      .filter((r) => {
        if (r.postedDate <= e.lastDate || claimed.has(r.id)) return false;
        // A rule said where this one goes.
        if (ruled.has(r.id) && ruled.get(r.id) !== e.id) return false;
        if (r.recurringSeriesId !== null && r.recurringSeriesId !== e.id) return false;
        if (r.recurringSeriesId === null && linkedNow.has(r.id)) return false;
        if ((r.amountCents < 0 ? "out" : "in") !== e.direction) return false;
        const key = keyOf.get(r.id) ?? "";
        if (key === e.matchKey)
          return near(Math.abs(r.amountCents), e.anchorCents, e.fixedAmount ? 0.3 : 0.35);
        // Different wording: demand much more agreement before calling it the same bill.
        return (
          r.accountId === e.accountId &&
          dayNum(r.postedDate) - dayNum(e.lastDate) >= minGap &&
          (near(Math.abs(r.amountCents), e.anchorCents, 0.1) ||
            near(Math.abs(r.amountCents), Math.abs(e.lastAmountCents), 0.1)) &&
          [...keyWords(key)].some((w) => words.has(w))
        );
      })
      .sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    for (const r of newer) claimed.add(r.id);
    const last = newer[newer.length - 1];
    if (!last) continue;
    tx.update(s)
      .set({
        lastDate: last.postedDate,
        lastAmountCents: last.amountCents,
        accountId: last.accountId,
      })
      .where(eq(s.id, e.id))
      .run();
    link(
      e.id,
      newer.map((r) => r.id),
    );
    result.updated++;
  }

  // Rules have the last word: their charges belong to their series, and the
  // series' dates follow them, so a renamed paycheck is never "late".
  const bySeries = new Map<string, Row[]>();
  for (const [id, sid] of ruled) {
    const r = byId.get(id);
    if (r) bySeries.set(sid, [...(bySeries.get(sid) ?? []), r]);
  }
  for (const [sid, list] of bySeries) {
    const e = tx.select().from(s).where(eq(s.id, sid)).get();
    if (!e) continue;
    link(
      sid,
      list.map((r) => r.id),
    );
    const sorted = [...list].sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    const newest = sorted[sorted.length - 1] as Row;
    const oldest = sorted[0] as Row;
    const dates = {
      ...(newest.postedDate > e.lastDate && {
        lastDate: newest.postedDate,
        lastAmountCents: newest.amountCents,
      }),
      ...(oldest.postedDate < e.firstDate && { firstDate: oldest.postedDate }),
    };
    if (Object.keys(dates).length) tx.update(s).set(dates).where(eq(s.id, sid)).run();
  }
  foldEmptiedSeries(tx, rows, ruled);
  return result;
}

/**
 * Two rules sending the same charges to two series say those series are one.
 * A new (unconfirmed) series left with no charges, because every charge its rule matches
 * went to one other series, folds into that series: its rules point there, and
 * it goes.
 */
function foldEmptiedSeries(tx: Tx, rows: Row[], ruled: Map<string, string>) {
  const s = schema.recurringSeries;
  const t = schema.transactions;
  const counts = new Map(
    tx
      .select({ sid: t.recurringSeriesId, n: sql<number>`count(*)` })
      .from(t)
      .where(sql`${t.recurringSeriesId} is not null`)
      .groupBy(t.recurringSeriesId)
      .all()
      .map((x) => [x.sid as string, Number(x.n)]),
  );
  const rules = tx.select().from(schema.rules).all();
  for (const e of tx.select().from(s).all()) {
    if (e.status !== "detected" || e.source !== "detected" || counts.get(e.id)) continue;
    const mine = rules.filter((r) =>
      (r.actions as RuleAction[]).some((a) => a.type === "setRecurring" && a.seriesId === e.id),
    );
    if (!mine.length) continue;
    const dests = new Set<string>();
    for (const r of mine) {
      const cond = r.conditions as { match?: "all" | "any"; items?: RuleDefinition["conditions"] };
      const rule = { match: cond.match ?? "all", conditions: cond.items ?? [] };
      for (const x of rows) {
        const sid = ruled.get(x.id);
        if (
          sid &&
          sid !== e.id &&
          ruleMatches(rule, {
            description: x.rawDescription,
            payee: x.payee,
            amountCents: x.amountCents,
            accountId: x.accountId,
          })
        )
          dests.add(sid);
      }
    }
    if (dests.size !== 1) continue;
    const into = [...dests][0] as string;
    for (const r of mine) {
      const seen = new Set<string>();
      const actions = (r.actions as RuleAction[])
        .map((a) =>
          a.type === "setRecurring" && a.seriesId === e.id ? { ...a, seriesId: into } : a,
        )
        .filter((a) => {
          if (a.type !== "setRecurring") return true;
          if (seen.has(a.seriesId)) return false;
          seen.add(a.seriesId);
          return true;
        });
      tx.update(schema.rules).set({ actions }).where(eq(schema.rules.id, r.id)).run();
      r.actions = actions;
    }
    tx.delete(s).where(eq(s.id, e.id)).run();
    audit(tx as unknown as MunyDb, {
      actorType: "system",
      action: "recurring.merge",
      entityType: "recurring_series",
      entityId: into,
      details: { merged: e.id, name: e.name },
    });
  }
}

/** Confirm, ignore or cancel a series. Ignoring detaches its charges so they read as ordinary transactions. */
export function setSeriesStatus(
  db: Db,
  id: string,
  status: "confirmed" | "ignored" | "cancelled",
  today = localToday(),
) {
  const s = schema.recurringSeries;
  const current = db.select().from(s).where(eq(s.id, id)).get();
  if (!current) throw notFound("Recurring charge not found");
  db.update(s)
    .set({
      status,
      cancelledAt: status === "cancelled" ? (current.cancelledAt ?? today) : null,
    })
    .where(eq(s.id, id))
    .run();
  if (status === "ignored")
    db.update(schema.transactions)
      .set({ recurringSeriesId: null })
      .where(eq(schema.transactions.recurringSeriesId, id))
      .run();
}

/** Create a series by hand from one transaction ("this is a subscription"). */
export function createFromTransaction(
  tx: Tx,
  txnId: string,
  interval: RecurringInterval,
  kind: RecurringKind | undefined,
): string | null {
  const row = loadRows(tx).find((r) => r.id === txnId);
  if (!row) return null;
  const id = newId();
  tx.insert(schema.recurringSeries)
    .values({
      id,
      name: (row.payee ?? cleanPayeeName(row.rawDescription) ?? row.rawDescription).slice(0, 100),
      matchKey: merchantKey(row.payee, row.rawDescription),
      direction: row.amountCents < 0 ? "out" : "in",
      anchorCents: Math.abs(row.amountCents),
      kind: kind ?? (row.amountCents > 0 ? "income" : "subscription"),
      status: "confirmed",
      interval,
      expectedAmountCents: row.amountCents,
      fixedAmount: true,
      firstDate: row.postedDate,
      lastDate: row.postedDate,
      lastAmountCents: row.amountCents,
      accountId: row.accountId,
      payeeId: row.payeeId,
      categoryId: row.categoryId,
      source: "manual",
      userModified: true,
    })
    .run();
  tx.update(schema.transactions)
    .set({ recurringSeriesId: id })
    .where(eq(schema.transactions.id, txnId))
    .run();
  // Pick up earlier/later charges of the same thing.
  rescanRecurring(tx);
  return id;
}

/** Stored series + computed fields (next date, monthly cost, lateness...). */
export function listSeries(db: Db, today = localToday(), id?: string): RecurringSeries[] {
  const s = schema.recurringSeries;
  const rows = db
    .select({
      s,
      accountName: schema.accounts.name,
      categoryName: schema.categories.name,
      count: sql<number>`(select count(*) from transactions x where x.recurring_series_id = "recurring_series"."id")`,
    })
    .from(s)
    .leftJoin(schema.accounts, eq(schema.accounts.id, s.accountId))
    .leftJoin(schema.categories, eq(schema.categories.id, s.categoryId))
    .where(id ? eq(s.id, id) : undefined)
    .all();

  // Price history for fixed-price series: last two distinct amounts.
  const ids = rows.map((r) => r.s.id);
  const history = new Map<string, { date: string; cents: number }[]>();
  if (ids.length) {
    for (const r of db
      .select({
        sid: schema.transactions.recurringSeriesId,
        date: schema.transactions.postedDate,
        cents: schema.transactions.amountCents,
      })
      .from(schema.transactions)
      .where(inArray(schema.transactions.recurringSeriesId, ids))
      .orderBy(schema.transactions.postedDate)
      .all()) {
      const k = r.sid as string;
      history.set(k, [...(history.get(k) ?? []), { date: r.date, cents: r.cents }]);
    }
  }

  // Pending charges that look like a series' next one (same rules as newer charges).
  const pendingRows = rows.length ? loadRows(db, true) : [];
  const pendingFor = (r: (typeof rows)[number]["s"]) => {
    if (r.status === "ignored") return null;
    const words = keyWords(r.matchKey);
    const hit = pendingRows
      .filter((x) => {
        if (x.postedDate < r.lastDate || (x.amountCents < 0 ? "out" : "in") !== r.direction)
          return false;
        const cents = Math.abs(x.amountCents);
        const key = merchantKey(x.payee, x.rawDescription);
        if (key === r.matchKey) return near(cents, r.anchorCents, 0.3);
        return (
          x.accountId === r.accountId &&
          (near(cents, r.anchorCents, 0.1) || near(cents, Math.abs(r.lastAmountCents), 0.1)) &&
          [...keyWords(key)].some((w) => words.has(w))
        );
      })
      .sort((a, b) => a.postedDate.localeCompare(b.postedDate))[0];
    return hit
      ? { transactionId: hit.id, date: hit.postedDate, amountCents: hit.amountCents }
      : null;
  };

  const t = dayNum(today);
  return rows.map(({ s: r, accountName, categoryName, count }) => {
    const interval = r.interval as RecurringInterval;
    const next = addInterval(r.lastDate, interval);
    const pending = pendingFor(r);
    const sinceLast = t - dayNum(r.lastDate);
    const active = sinceLast <= grace(interval) && r.status !== "cancelled";
    let priceChange: RecurringSeries["priceChange"] = null;
    const h = history.get(r.id) ?? [];
    if (r.fixedAmount && h.length >= 2) {
      const last = h[h.length - 1] as { date: string; cents: number };
      for (let i = h.length - 2; i >= 0; i--) {
        const prev = h[i] as { date: string; cents: number };
        if (prev.cents !== last.cents) {
          // Only a real price change, not a one-off (the change must have stuck).
          const firstAtNew = h[i + 1] as { date: string; cents: number };
          // Only recent changes are news.
          if (t - dayNum(firstAtNew.date) <= 365)
            priceChange = { fromCents: prev.cents, toCents: last.cents, date: firstAtNew.date };
          break;
        }
      }
    }
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      interval,
      expectedAmountCents: r.expectedAmountCents,
      fixedAmount: r.fixedAmount,
      monthlyCents: monthlyCents(r.expectedAmountCents, interval),
      annualCents: monthlyCents(r.expectedAmountCents, interval) * 12,
      firstDate: r.firstDate,
      lastDate: r.lastDate,
      lastAmountCents: r.lastAmountCents,
      nextDate: next,
      active,
      late: active && next < today && !pending,
      chargedAfterCancel: r.status === "cancelled" && !!r.cancelledAt && r.lastDate > r.cancelledAt,
      accountId: r.accountId,
      accountName,
      categoryId: r.categoryId,
      categoryName,
      source: r.source,
      cancelledAt: r.cancelledAt,
      notes: r.notes,
      transactionCount: Number(count),
      priceChange,
      pending,
      paidThisMonth: (() => {
        const mine = h.filter((x) => x.date.startsWith(today.slice(0, 7)) && x.date <= today);
        return {
          cents: mine.reduce((a, x) => a + x.cents, 0),
          count: mine.length,
          lastDate: mine[mine.length - 1]?.date ?? null,
        };
      })(),
    };
  });
}

/**
 * Expected charges between two dates for active, non-ignored, non-cancelled
 * series. A pending charge stands for the next one (it's already been charged);
 * with `withPending` it's listed too, marked pending.
 */
export function upcoming(
  db: Db,
  from: string,
  to: string,
  today = localToday(),
  withPending = false,
): UpcomingCharge[] {
  const out: UpcomingCharge[] = [];
  for (const s of listSeries(db, today)) {
    if (!s.active || s.status === "ignored" || s.status === "cancelled") continue;
    if (s.pending && withPending) {
      const date = s.pending.date < from ? from : s.pending.date;
      if (date <= to)
        out.push({
          seriesId: s.id,
          name: s.name,
          kind: s.kind,
          date,
          amountCents: s.pending.amountCents,
          accountName: s.accountName,
          pending: true,
        });
    }
    // A late charge is still expected; show it on today.
    const dates: string[] = s.nextDate < today && !s.pending ? [today] : [];
    for (let i = s.pending ? 2 : 1; i <= 400; i++) {
      const d = addInterval(s.lastDate, s.interval, i);
      if (d < today) continue;
      if (d > to) break;
      dates.push(d);
    }
    for (const date of dates.filter((d) => d >= from && d <= to))
      out.push({
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        date,
        amountCents: s.expectedAmountCents,
        accountName: s.accountName,
      });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
