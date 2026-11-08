import { addInterval } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import { eq, sql } from "drizzle-orm";
import { setBudget } from "../budgets/service.js";
import { updateCard } from "../cards/service.js";
import { commitImport } from "../import/service.js";
import { localToday } from "../lib/dates.js";
import { createManualLoan } from "../loans/service.js";
import { rescanRecurring } from "../recurring/service.js";
import { setAccountApy } from "../savings/accounts.js";

/**
 * Demo mode (MUNY_DEMO=true): a fresh install starts with a made-up
 * household, so people can try Muny without connecting anything. Every
 * name, number and merchant here is invented. It goes in through the same
 * importer as a real export, so merchants, categories and recurring charges
 * behave as they would with real data. "Start clean" (clearDemo) removes it.
 */

const SEEDED = "demo.household";
const CLEARED = "demo.cleared";

/** A small fixed-seed random generator: the same household every time. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Acct {
  type: string;
  name: string;
  last4: string;
  institution: string;
}
const CHECKING: Acct = {
  type: "Cash",
  name: "Everyday Checking",
  last4: "0101",
  institution: "Sample Credit Union",
};
const SAVINGS: Acct = {
  type: "Cash",
  name: "Rainy Day Savings",
  last4: "0202",
  institution: "Sample Credit Union",
};
const CARD: Acct = {
  type: "Credit Card",
  name: "Sample Rewards Card",
  last4: "0303",
  institution: "Example Card Co",
};

/** Rocket Money export rows (money out is positive there). */
function household(today: string): string[][] {
  const rand = rng(20261107);
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));
  const rows: string[][] = [];
  const add = (a: Acct, date: string, outCents: number, name: string, category: string) => {
    if (date > today) return;
    rows.push([
      date,
      date,
      a.type,
      a.name,
      a.last4,
      a.institution,
      name,
      "",
      (outCents / 100).toFixed(2),
      name,
      category,
      "",
      "",
      "",
      "",
    ]);
  };
  const months: string[] = [];
  for (let i = 6; i >= 0; i--) months.push(addInterval(today, "monthly", -i).slice(0, 7));
  const day = (m: string, d: number) => `${m}-${String(d).padStart(2, "0")}`;

  // Paid every two weeks.
  for (let d = `${months[0]}-03`; d <= today; d = addInterval(d, "biweekly")) {
    add(CHECKING, d, -245_000, "ACME CORP PAYROLL", "Paycheck");
  }
  months.forEach((m, i) => {
    // Home & utilities.
    add(CHECKING, day(m, 1), 165_000, "SAMPLE PROPERTY MGMT", "Rent & Mortgage");
    add(CHECKING, day(m, 5), between(8_200, 14_100), "CITY POWER AND LIGHT", "Electric");
    add(CHECKING, day(m, 18), between(4_400, 5_300), "CITY WATER UTILITY", "Water & Sewer");
    add(CHECKING, day(m, 12), 6_500, "FIBERNET HOME", "Internet");
    add(CHECKING, day(m, 20), 7_000, "MOBILEONE WIRELESS", "Phone");
    // Saving, and the student loan.
    add(CHECKING, day(m, 2), 30_000, "TRANSFER TO SAVINGS", "Savings");
    add(SAVINGS, day(m, 2), -30_000, "TRANSFER FROM CHECKING", "Savings");
    add(SAVINGS, day(m, 28), -between(3_900, 4_500), "INTEREST PAYMENT", "Interest & Dividends");
    add(CHECKING, day(m, 15), 21_000, "SAMPLE LOAN SERVICING", "Loan Payment");
    // Subscriptions on the card; Streamflix went up three months ago.
    add(CARD, day(m, 7), i < 4 ? 1_399 : 1_599, "STREAMFLIX", "Streaming");
    add(CARD, day(m, 9), 1_099, "TUNEBOX MUSIC", "Streaming");
    add(CARD, day(m, 11), 1_199, "DROPBOX", "Cloud & Hosting");
    add(CARD, day(m, 3), 3_999, "IRONWORKS GYM", "Fitness");
    // Everyday spending.
    const spend = (d: number, cents: number, name: string, category: string) =>
      add(CARD, day(m, d), cents, name, category);
    for (const d of [4, 11, 18, 25])
      spend(d, between(6_000, 14_500), "GREENLEAF MARKET", "Groceries");
    for (const d of [6, 13, 21, 27])
      spend(d, between(1_400, 4_800), "NOODLE BAR", "Dining & Drinks");
    for (const d of [8, 16, 23]) spend(d, between(450, 750), "THE COFFEE SPOT", "Coffee");
    for (const d of [10, 20, 28]) spend(d, between(3_500, 5_600), "QUICKFUEL", "Gas & Fuel");
    spend(14, between(2_500, 9_000), "BIG BOX STORE", "General Merchandise");
    if (i % 2 === 0) spend(22, between(1_500, 3_500), "BOOK NOOK", "Hobbies");
    if (i === 4) spend(26, 1_842, "INTEREST CHARGE ON PURCHASES", "Fees & Charges");
    // Last month's card bill, paid from checking.
    if (i > 0) {
      const bill = 58_000 + between(0, 9_000);
      add(CHECKING, day(m, 25), bill, "SAMPLE CARD PAYMENT", "Credit Card Payment");
      add(CARD, day(m, 25), -bill, "PAYMENT THANK YOU", "Credit Card Payment");
    }
  });
  return rows;
}

const HEADER =
  "Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags";

const csv = (rows: string[][]) =>
  [
    HEADER,
    ...rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")),
  ].join("\n");

const flag = (db: MunyDb, key: string) =>
  !!db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get();

export const demoActive = (db: MunyDb) => flag(db, SEEDED) && !flag(db, CLEARED);

/**
 * Fill a fresh install with the demo household: once, only when demo mode is
 * on, the owner exists, nothing has been added yet and it wasn't cleared.
 */
export function maybeSeedDemo(db: MunyDb, enabled: boolean, today = localToday()): boolean {
  if (!enabled || flag(db, SEEDED) || flag(db, CLEARED)) return false;
  const owner = db.select({ id: schema.users.id }).from(schema.users).get();
  const hasAccounts = db.select({ id: schema.accounts.id }).from(schema.accounts).get();
  if (!owner || hasAccounts) return false;

  commitImport(
    db,
    { filename: "demo-household.csv", content: csv(household(today)), accountMap: {} },
    owner.id,
  );
  const accounts = db.select().from(schema.accounts).all();
  const id = (name: string) => accounts.find((a) => a.name === name)?.id as string;
  // Balances today: the opening balance makes up the difference.
  const target: [string, number][] = [
    [CHECKING.name, 624_018],
    [SAVINGS.name, 1_250_000],
    [CARD.name, -84_233],
  ];
  for (const [name, cents] of target) {
    const sum = db.get<{ s: number }>(
      sql`select coalesce(sum(amount_cents), 0) as s from transactions where account_id = ${id(name)}`,
    );
    db.update(schema.accounts)
      .set({ openingBalanceCents: cents - Number(sum?.s ?? 0) })
      .where(eq(schema.accounts.id, id(name)))
      .run();
  }
  setAccountApy(db, id(SAVINGS.name), 400);
  updateCard(db, id(CARD.name), { creditLimitCents: 500_000, aprBps: 2_499 });
  createManualLoan(
    db,
    {
      name: "Student Loan",
      lender: "Sample Loan Servicing",
      kind: "student",
      startBalanceCents: 1_850_000,
      startDate: addInterval(today, "monthly", -6),
      aprBps: 550,
      monthlyPaymentCents: 21_000,
      paymentMatch: "sample loan servicing",
    },
    today,
  );
  const cats = db.select().from(schema.categories).all();
  const cat = (n: string) => cats.find((c) => c.name === n)?.id;
  const fromMonth = addInterval(today, "monthly", -6).slice(0, 7);
  db.transaction((tx) => {
    for (const [name, cents] of [
      ["Rent & Mortgage", 165_000],
      ["Electric", 13_000],
      ["Groceries", 45_000],
      ["Dining & Drinks", 12_000],
      ["Coffee", 2_500],
      ["Gas & Fuel", 15_000],
      ["Streaming", 2_500],
      ["General Merchandise", 6_000],
    ] as const) {
      const categoryId = cat(name);
      if (categoryId) setBudget(tx, { categoryId, amountCents: cents, fromMonth });
    }
    rescanRecurring(tx, today);
  });
  db.insert(schema.appSettings)
    .values({ key: SEEDED, value: { at: new Date().toISOString() } })
    .onConflictDoNothing()
    .run();
  return true;
}

/** Kept by "Start clean": who you are, how Muny is set up, and the audit trail. */
const KEEP = new Set([
  "users",
  "sessions",
  "invites",
  "api_tokens",
  "app_settings",
  "alert_rules",
  "notification_channels",
  "audit_log",
  "__drizzle_migrations",
]);
/** Settings that describe the demo data rather than your setup. */
const DATA_SETTINGS = [
  SEEDED,
  "seed.default_categories",
  "loans.plan",
  "savings.opportunities.dismissed",
  "alerts.state",
];

/**
 * Remove the demo household and everything added since, keeping accounts
 * for people, settings and the audit log; then start over with the default
 * categories. Demo mode won't fill it again.
 */
export function clearDemo(db: MunyDb, reseed: (db: MunyDb) => void) {
  const tables = db
    .all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
    )
    .map((t) => t.name)
    .filter((n) => !KEEP.has(n));
  const client = db.$client;
  client.pragma("foreign_keys = OFF");
  try {
    db.transaction((tx) => {
      for (const t of tables) tx.run(sql.raw(`delete from "${t.replace(/"/g, "")}"`));
      for (const key of DATA_SETTINGS)
        tx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
      tx.insert(schema.appSettings)
        .values({ key: CLEARED, value: { at: new Date().toISOString() } })
        .onConflictDoNothing()
        .run();
    });
  } finally {
    client.pragma("foreign_keys = ON");
  }
  reseed(db);
}
