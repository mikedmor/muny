import { type MunyDb, newId, schema } from "@muny/db";
import type {
  CardDetailsInput,
  CardPayment,
  CardStatement,
  CardsReport,
  CreditCard,
} from "@muny/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";
import type { CardTerms } from "../sync/types.js";

/**
 * Credit cards: balance and limit, the statement (balance, minimum, due
 * date), the rate, payments to the card, spending since the statement and
 * interest charged. Details come from the bank connection (Plaid
 * liabilities), a statement PDF, or you.
 */

type Db = MunyDb;
const SYNCED = new Set(["plaid", "teller", "paypal"]);

const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** Payments to a card: money in that's a transfer, or says it's a payment. */
const PAYMENT = /payment|pymt|autopay|auto pay|thank you|epay|online pmt/i;
/** Interest charged on a card. */
const INTEREST =
  /interest charge|finance charge|purchase interest|interest on purchases|interest charged/i;

export function cardsReport(db: Db, today = localToday()): CardsReport {
  const all = listAccounts(db);
  const cards = all.filter((a) => a.type === "credit" && !a.hidden);
  const ids = cards.map((a) => a.id);
  const details = new Map(
    (ids.length
      ? db.select().from(schema.cardDetails).where(inArray(schema.cardDetails.accountId, ids)).all()
      : []
    ).map((d) => [d.accountId, d]),
  );
  const conn = new Map(
    db
      .select({ id: schema.accounts.id, connectionId: schema.accounts.connectionId })
      .from(schema.accounts)
      .all()
      .map((r) => [r.id, r.connectionId]),
  );
  const t = schema.transactions;
  const yearAgo = addMonths(today, -12);
  const txns = ids.length
    ? db
        .select({
          id: t.id,
          accountId: t.accountId,
          date: t.postedDate,
          amountCents: t.amountCents,
          raw: t.rawDescription,
          pair: t.transferPairId,
          hidden: t.hidden,
          pending: t.pending,
        })
        .from(t)
        .where(and(inArray(t.accountId, ids), gte(t.postedDate, yearAgo)))
        .all()
    : [];
  // Where paired payments came from.
  const pairIds = txns.map((x) => x.pair).filter((x): x is string => !!x);
  const pairFrom = new Map(
    pairIds.length
      ? db
          .select({ id: t.id, name: schema.accounts.name, mask: schema.accounts.mask })
          .from(t)
          .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
          .where(inArray(t.id, pairIds))
          .all()
          .map((r) => [r.id, r.mask ? `${r.name} ••${r.mask}` : r.name])
      : [],
  );

  // Payments found by their words in your other accounts (when you linked them).
  const linkedPayments = (
    d: (typeof details extends Map<string, infer V> ? V : never) | undefined,
  ) => {
    const words = d?.paymentMatch?.trim();
    if (!words) return [];
    return db
      .select({
        id: t.id,
        date: t.postedDate,
        amount: t.amountCents,
        pair: t.transferPairId,
        name: schema.accounts.name,
        mask: schema.accounts.mask,
      })
      .from(t)
      .innerJoin(schema.accounts, eq(schema.accounts.id, t.accountId))
      .where(
        and(
          gte(t.postedDate, yearAgo),
          sql`${t.amountCents} < 0`,
          sql`${schema.accounts.type} <> 'credit'`,
          eq(t.pending, false),
          sql`instr(lower(${t.rawDescription}), lower(${words})) > 0`,
        ),
      )
      .all();
  };
  const out: CreditCard[] = cards.map((a) => {
    const d = details.get(a.id);
    const mine = txns.filter((x) => x.accountId === a.id && !x.pending);
    const onCard: CardPayment[] = mine
      .filter((x) => x.amountCents > 0 && x.date >= yearAgo && (x.pair || PAYMENT.test(x.raw)))
      .map((x) => ({
        transactionId: x.id,
        date: x.date,
        amountCents: x.amountCents,
        fromAccountName: x.pair ? (pairFrom.get(x.pair) ?? null) : null,
      }));
    // From your other accounts, unless the same payment already shows on the card.
    const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
    const fromOthers: CardPayment[] = linkedPayments(d)
      .filter(
        (p) =>
          !onCard.some(
            (c) => c.amountCents === -p.amount && Math.abs(day(c.date) - day(p.date)) <= 5,
          ),
      )
      .map((p) => ({
        transactionId: p.id,
        date: p.date,
        amountCents: -p.amount,
        fromAccountName: p.mask ? `${p.name} ••${p.mask}` : p.name,
      }));
    const payments = [...onCard, ...fromOthers].sort((x, y) => y.date.localeCompare(x.date));
    const owed = Math.max(0, -a.balanceCents);
    const limit = d?.creditLimitCents ?? null;
    const since = d?.statementDate ?? null;
    const spent = mine
      .filter((x) => x.amountCents < 0 && !x.hidden && !x.pair && (!since || x.date > since))
      .reduce((s, x) => s - x.amountCents, 0);
    const fromTxns = mine
      .filter(
        (x) => x.amountCents < 0 && x.date.startsWith(today.slice(0, 4)) && INTEREST.test(x.raw),
      )
      .reduce((s, x) => s - x.amountCents, 0);
    // The statement's year-to-date figure, when it's this year's and higher.
    const interest =
      d?.interestYtdYear === Number(today.slice(0, 4)) && (d.interestYtdCents ?? 0) > fromTxns
        ? (d.interestYtdCents ?? 0)
        : fromTxns;
    const detected = payments[0];
    const lastPayment =
      d?.lastPaymentDate &&
      d.lastPaymentCents !== null &&
      (!detected || d.lastPaymentDate >= detected.date)
        ? { date: d.lastPaymentDate, amountCents: d.lastPaymentCents }
        : detected
          ? { date: detected.date, amountCents: detected.amountCents }
          : null;
    const connected = SYNCED.has(a.provider);
    return {
      accountId: a.id,
      name: a.name,
      institutionName: a.institutionName,
      mask: a.mask,
      issuer: d?.issuer ?? a.institutionName,
      connected,
      connectionId: connected && a.provider === "plaid" ? (conn.get(a.id) ?? null) : null,
      balanceCents: owed,
      creditLimitCents: limit,
      availableCents: limit !== null ? Math.max(0, limit - owed) : null,
      utilizationPct: limit ? (owed / limit) * 100 : null,
      aprBps: d?.aprBps ?? null,
      statementBalanceCents: d?.statementBalanceCents ?? null,
      statementDate: since,
      minimumPaymentCents: d?.minimumPaymentCents ?? null,
      dueDate: d?.dueDate ?? null,
      lastPayment,
      spentSinceStatementCents: spent,
      interestThisYearCents: interest,
      payments: payments.slice(0, 12),
      source: d?.source ?? null,
      paymentMatch: d?.paymentMatch ?? null,
      minimumOnly:
        d?.minOnlyMonths && d.minOnlyTotalCents
          ? { months: d.minOnlyMonths, totalCents: d.minOnlyTotalCents }
          : null,
    };
  });
  const withLimit = out.filter((c) => c.creditLimitCents);
  const totalLimit = withLimit.reduce((s, c) => s + (c.creditLimitCents ?? 0), 0);
  const upcoming = out
    .filter((c) => c.dueDate && c.dueDate >= today)
    .sort((x, y) => (x.dueDate as string).localeCompare(y.dueDate as string))[0];
  return {
    totalOwedCents: out.reduce((s, c) => s + c.balanceCents, 0),
    totalLimitCents: totalLimit,
    utilizationPct: totalLimit
      ? (withLimit.reduce((s, c) => s + c.balanceCents, 0) / totalLimit) * 100
      : null,
    nextDue: upcoming
      ? {
          accountId: upcoming.accountId,
          name: upcoming.name,
          date: upcoming.dueDate as string,
          amountCents: upcoming.minimumPaymentCents,
        }
      : null,
    interestThisYearCents: out.reduce((s, c) => s + c.interestThisYearCents, 0),
    cards: out.sort((x, y) => y.balanceCents - x.balanceCents),
  };
}

function upsert(
  db: Db,
  accountId: string,
  patch: Partial<typeof schema.cardDetails.$inferInsert>,
  source: "plaid" | "statement" | "manual",
) {
  db.insert(schema.cardDetails)
    .values({ accountId, ...patch, source })
    .onConflictDoUpdate({
      target: schema.cardDetails.accountId,
      set: { ...patch, source, updatedAt: new Date() },
    })
    .run();
}

export function updateCard(db: Db, accountId: string, input: CardDetailsInput): boolean {
  const acc = db
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (acc?.type !== "credit") return false;
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  upsert(db, accountId, patch, "manual");
  return true;
}

/** A card statement: its figures become the card's (only if it's the newest). */
export function applyCardStatement(db: Db, accountId: string, s: CardStatement): boolean {
  const acc = db
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (acc?.type !== "credit") return false;
  const cur = db
    .select({ d: schema.cardDetails.statementDate })
    .from(schema.cardDetails)
    .where(eq(schema.cardDetails.accountId, accountId))
    .get();
  if (cur?.d && s.closingDate && s.closingDate < cur.d) return true; // older: keep the newer
  // (the statement's transactions are added either way; see addStatementTransactions)
  const patch = Object.fromEntries(
    Object.entries({
      statementDate: s.closingDate,
      dueDate: s.dueDate,
      statementBalanceCents: s.newBalanceCents,
      minimumPaymentCents: s.minimumPaymentCents,
      creditLimitCents: s.creditLimitCents,
      aprBps: s.aprBps,
      interestYtdCents: s.interestYtd?.cents ?? null,
      interestYtdYear: s.interestYtd?.year ?? null,
      minOnlyMonths: s.minimumOnly?.months ?? null,
      minOnlyTotalCents: s.minimumOnly?.totalCents ?? null,
    }).filter(([, v]) => v !== null),
  );
  upsert(db, accountId, patch, "statement");
  // What you owed that day, for the card's history.
  if (s.closingDate && s.newBalanceCents !== null)
    db.insert(schema.balanceSnapshots)
      .values({ accountId, date: s.closingDate, balanceCents: -s.newBalanceCents })
      .onConflictDoNothing()
      .run();
  return true;
}

/** Card details from a bank connection (Plaid liabilities and limits). */
export function applyCardTerms(db: Db, connectionId: string, terms: CardTerms[]) {
  const linked = db
    .select({ id: schema.accounts.id, ref: schema.accounts.providerAccountRef })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.connectionId, connectionId), eq(schema.accounts.type, "credit")))
    .all();
  const idOf = new Map(linked.filter((a) => a.ref).map((a) => [a.ref as string, a.id]));
  for (const t of terms) {
    const id = idOf.get(t.accountRef);
    if (!id) continue;
    const { accountRef: _, ...rest } = t;
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== null && v !== undefined),
    );
    if (Object.keys(patch).length) upsert(db, id, patch, "plaid");
  }
}

// ---------------------------------------------------------------------------
// Statement PDFs. US card statements must use the same labels (Regulation Z):
// "New Balance", "Minimum Payment Due", "Payment Due Date", and the rate table.
// ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE = String.raw`(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})`;
const MONEY = String.raw`\$?\s?([\d,]+\.\d{2})`;

function isoOf(s: string | undefined): string | null {
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = (m[3] as string).length === 2 ? `20${m[3]}` : (m[3] as string);
    return `${y}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
  }
  m = s.match(/^([A-Z][a-z]{2,8})\.? (\d{1,2}),? (\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase());
    if (mo < 0) return null;
    return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
  }
  return null;
}
const centsOf = (s: string | undefined) => {
  if (!s) return null;
  const [w = "0", f = ""] = s.replace(/[,$\s]/g, "").split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0").slice(0, 2));
};

/**
 * Transaction lines: "10/05 10/05 Automatic Payment - Thank You REF123 250.00-".
 * Charges are negative; payments and credits (a trailing or leading minus, or
 * under a Payments/Credits heading) positive. The year comes from the closing date.
 */
function statementTransactions(text: string, closing: string | null) {
  const out: { date: string; description: string; amountCents: number }[] = [];
  const closeYear = Number((closing ?? new Date().toISOString()).slice(0, 4));
  const closeMonth = Number((closing ?? new Date().toISOString()).slice(5, 7));
  let section: "credit" | "charge" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (/^(payments?|payments and( other)? credits|credits|other credits)\b/i.test(line))
      section = "credit";
    else if (
      /^(purchases|interest charged|fees( charged)?|transactions|cash advances)\b/i.test(line)
    )
      section = "charge";
    const m = line.match(
      /^(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})? (?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})? )?(.+?) (-)?\$?([\d,]+\.\d{2})(-|CR)?$/i,
    );
    if (!m) continue;
    const desc = (m[3] ?? "").replace(/ [A-Z0-9]{10,}$/, "").trim();
    if (!desc || /^total\b/i.test(desc)) continue;
    const month = Number(m[1]);
    const year = month > closeMonth ? closeYear - 1 : closeYear;
    const cents = centsOf(m[5]) ?? 0;
    const credit =
      !!m[4] || !!m[6] || section === "credit" || /payment|thank you|credit|refund/i.test(desc);
    out.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`,
      description: desc.slice(0, 200),
      amountCents: credit ? cents : -cents,
    });
  }
  return out;
}

export function parseCardStatement(text: string): CardStatement | null {
  const t = text.replace(/\s+/g, " ");
  const find = (re: RegExp) => t.match(re)?.[1];
  const newBalance = centsOf(find(new RegExp(`New Balance(?: Total)?:? ${MONEY}`, "i")));
  const minimum = centsOf(find(new RegExp(`Minimum Payment Due:? ${MONEY}`, "i")));
  // "Payment Due Date AUTO PAY ENABLED 11/05/2026": words may sit between the label and the date.
  const due = isoOf(find(new RegExp(`Payment Due Date:?[^\\d]{0,40}?${DATE}`, "i")));
  const limit = centsOf(
    find(/(?:Total )?Credit (?:Limit|Line|Access Line)(?: Amount)?:? \$?\s?([\d,]+(?:\.\d{2})?)/i),
  );
  const closing =
    // "Opening/Closing Date 09/14/26 - 10/13/26"
    isoOf(find(new RegExp(`Open(?:ing)?/Clos(?:e|ing) Date:? \\S+ ?- ?${DATE}`, "i"))) ??
    isoOf(find(new RegExp(`(?:Statement )?Closing Date:? ${DATE}`, "i"))) ??
    isoOf(find(new RegExp(`Billing Cycle (?:Ending|End Date|Closing Date):? ${DATE}`, "i"))) ??
    isoOf(find(new RegExp(`Statement (?:Date|Period Ending):? ${DATE}`, "i")));
  // "Purchases 24.99%", or a rate table: "Purchases 3,083.68 14.75% (v) ...".
  const apr =
    find(
      /Purchases?(?: APR)?:? (?:\d{1,2}\/\d{1,2}\/\d{2,4} |\$?[\d,]+\.\d{2} )?(\d{1,2}\.\d{2,3})% ?(?:\(v\))?/i,
    ) ?? find(/Annual Percentage Rate[^%]{0,40}?(\d{1,2}\.\d{2,3})%/i);
  const previous = centsOf(find(new RegExp(`Previous Balance:? ${MONEY}`, "i")));
  const paid = centsOf(find(new RegExp(`Payments?(?:, Credits)?:? -?\\s?${MONEY}`, "i")));
  if (newBalance === null && !due) return null;
  const ytd = t.match(/Total Interest charged in (\d{4}):? \$?([\d,]+\.\d{2})/i);
  const minOnly = t.match(/Only the Minimum Payment:? (\d+) (years?|months?) \$?([\d,]+\.\d{2})/i);
  return {
    interestYtd: ytd ? { year: Number(ytd[1]), cents: centsOf(ytd[2]) ?? 0 } : null,
    minimumOnly: minOnly
      ? {
          months: Number(minOnly[1]) * (/^y/i.test(minOnly[2] ?? "") ? 12 : 1),
          totalCents: centsOf(minOnly[3]) ?? 0,
        }
      : null,
    transactions: statementTransactions(text, closing),
    closingDate: closing,
    dueDate: due,
    newBalanceCents: newBalance,
    minimumPaymentCents: minimum,
    creditLimitCents: limit,
    aprBps: apr ? Math.round(Number(apr) * 100) : null,
    previousBalanceCents: previous,
    paymentsCents: paid,
  };
}

/** The card whose last 4 digits the statement shows ("ending in 1234"). */
export function cardForText(db: Db, text: string): string | null {
  const ends = [
    ...text.matchAll(
      /(?:ending in|ending|last 4(?: digits)?|x{3,}|\*{3,}|account number:?[\s\dx*-]*?)\s*(\d{4})\b/gi,
    ),
  ].map((m) => m[1] as string);
  if (!ends.length) return null;
  const cards = db
    .select({ id: schema.accounts.id, mask: schema.accounts.mask })
    .from(schema.accounts)
    .where(eq(schema.accounts.type, "credit"))
    .all();
  return cards.find((c) => c.mask && ends.includes(c.mask))?.id ?? null;
}

/**
 * Add a statement's transactions to the card, skipping any already there (same
 * amount within 3 days). Returns the new transaction ids (for rules and transfers).
 */
export function addStatementTransactions(
  db: Db,
  accountId: string,
  list: CardStatement["transactions"],
): string[] {
  const t = schema.transactions;
  const acc = db
    .select({ currency: schema.accounts.currency })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!acc) return [];
  const existing = db
    .select({ date: t.postedDate, amount: t.amountCents })
    .from(t)
    .where(eq(t.accountId, accountId))
    .all();
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const ids: string[] = [];
  for (const x of list) {
    if (
      existing.some((e) => e.amount === x.amountCents && Math.abs(day(e.date) - day(x.date)) <= 3)
    )
      continue;
    const id = newId();
    db.insert(t)
      .values({
        id,
        accountId,
        postedDate: x.date,
        amountCents: x.amountCents,
        currency: acc.currency,
        rawDescription: x.description,
        importHash: `stmt:${accountId}:${x.date}:${x.amountCents}:${x.description.slice(0, 40)}`,
      })
      .onConflictDoNothing()
      .run();
    existing.push({ date: x.date, amount: x.amountCents });
    ids.push(id);
  }
  return ids;
}
