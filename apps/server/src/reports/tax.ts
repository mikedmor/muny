import { cleanPayeeName } from "@muny/core";
import type { MunyDb } from "@muny/db";
import { type TaxItem, type TaxSection, type TaxYear, toDecimalString } from "@muny/shared";
import { sql } from "drizzle-orm";

/**
 * Tax year summary from your own data. Sections:
 * - income: income-type categories;
 * - deductible: anything tagged like "tax-deductible" (any tag containing "deduct");
 * - mortgage / charity / medical / taxes: spending in categories whose name
 *   matches, as a checklist of totals worth looking at (not tax advice).
 * Split parts count toward their own category. Hidden transactions and
 * matched transfers are left out.
 */

interface Row {
  id: string;
  d: string;
  cents: number;
  raw: string;
  payee: string | null;
  cat: string | null;
  kind: string | null;
  acct: string;
  notes: string | null;
}

const SECTIONS: { key: TaxSection["key"]; title: string; basis: string; match: RegExp }[] = [
  {
    key: "mortgage",
    title: "Mortgage payments",
    basis:
      "Categories like Mortgage or Home Loan. Includes principal and escrow: use Form 1098 for the deductible interest.",
    match: /mortgage|home loan/i,
  },
  {
    key: "charity",
    title: "Charitable giving",
    basis: "Categories like Charity, Donations or Gifts & Donations.",
    match: /charit|donat/i,
  },
  {
    key: "medical",
    title: "Medical & health",
    basis: "Categories like Medical, Health, Pharmacy, Dental or Vision.",
    match: /medical|health|pharm|dental|vision|doctor/i,
  },
  {
    key: "taxes",
    title: "Taxes paid",
    basis: "Categories with Tax in the name (property tax, estimated payments…).",
    match: /\btax/i,
  },
];

export function taxYear(db: MunyDb, year: number): TaxYear {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = db.all<Row>(sql`
    select t.id as id, t.posted_date as d, t.amount_cents as cents, t.raw_description as raw,
           p.display_name as payee, c.name as cat, g.kind as kind, a.name as acct, t.notes as notes
      from transactions t
      join accounts a on a.id = t.account_id
      left join payees p on p.id = t.payee_id
      left join categories c on c.id = t.category_id
      left join category_groups g on g.id = c.group_id
     where t.hidden = 0 and t.transfer_pair_id is null
       and t.posted_date between ${from} and ${to}
       and not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
    union all
    select t.id as id, t.posted_date as d, s.amount_cents as cents, t.raw_description as raw,
           p.display_name as payee, c.name as cat, g.kind as kind, a.name as acct,
           coalesce(s.notes, t.notes) as notes
      from transaction_splits s
      join transactions t on t.id = s.transaction_id
      join accounts a on a.id = t.account_id
      left join payees p on p.id = t.payee_id
      left join categories c on c.id = s.category_id
      left join category_groups g on g.id = c.group_id
     where t.hidden = 0 and t.posted_date between ${from} and ${to}
  `);
  const tagRows = db.all<{ id: string; name: string }>(sql`
    select tt.transaction_id as id, tg.name as name
      from transaction_tags tt join tags tg on tg.id = tt.tag_id
      join transactions t on t.id = tt.transaction_id
     where t.posted_date between ${from} and ${to}
  `);
  const tags = new Map<string, string[]>();
  for (const r of tagRows) tags.set(r.id, [...(tags.get(r.id) ?? []), r.name]);

  const item = (r: Row, sign: 1 | -1): TaxItem => ({
    id: r.id,
    date: r.d,
    name: r.payee ?? cleanPayeeName(r.raw) ?? r.raw,
    cents: sign * Number(r.cents),
    categoryName: r.cat,
    accountName: r.acct,
    notes: r.notes,
    tags: tags.get(r.id) ?? [],
  });
  const build = (
    key: TaxSection["key"],
    title: string,
    basis: string,
    picked: Row[],
    sign: 1 | -1,
  ): TaxSection => {
    const items = picked.map((r) => item(r, sign)).sort((a, b) => a.date.localeCompare(b.date));
    const byCat = new Map<string, number>();
    for (const i of items)
      byCat.set(
        i.categoryName ?? "Uncategorized",
        (byCat.get(i.categoryName ?? "Uncategorized") ?? 0) + i.cents,
      );
    return {
      key,
      title,
      basis,
      totalCents: items.reduce((s, i) => s + i.cents, 0),
      byCategory: [...byCat]
        .map(([name, cents]) => ({ name, cents }))
        .sort((a, b) => b.cents - a.cents),
      items,
    };
  };

  const isDeductTag = (id: string) => (tags.get(id) ?? []).some((n) => /deduct/i.test(n));
  const spending = rows.filter((r) => r.kind !== "income" && r.kind !== "transfer");
  const sections: TaxSection[] = [
    build(
      "income",
      "Income",
      "Transactions in income categories (paychecks, interest, dividends…).",
      rows.filter((r) => r.kind === "income"),
      1,
    ),
    build(
      "deductible",
      "Tagged tax-deductible",
      "Transactions you tagged with a tag containing “deduct” (e.g. #tax-deductible).",
      rows.filter((r) => isDeductTag(r.id) && r.kind !== "income"),
      -1,
    ),
    ...SECTIONS.map((s) =>
      build(
        s.key,
        s.title,
        s.basis,
        spending.filter((r) => r.cat && s.match.test(r.cat)),
        -1,
      ),
    ),
  ];

  const years = db
    .all<{ y: string }>(
      sql`select distinct substr(posted_date, 1, 4) as y from transactions order by y desc`,
    )
    .map((r) => Number(r.y));
  return { year, years, sections, crypto: null };
}

/** CSV of every item in every section (one row per item, by section). */
export function taxYearCsv(t: TaxYear): string {
  const q = (v: string) => {
    const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ["Section", "Date", "Payee", "Category", "Amount", "Account", "Tags", "Notes"].join(","),
  ];
  for (const s of t.sections)
    for (const i of s.items)
      lines.push(
        [
          q(s.title),
          i.date,
          q(i.name),
          q(i.categoryName ?? ""),
          toDecimalString(i.cents, "USD"),
          q(i.accountName),
          q(i.tags.join("; ")),
          q(i.notes ?? ""),
        ].join(","),
      );
  return `${lines.join("\n")}\n`;
}
