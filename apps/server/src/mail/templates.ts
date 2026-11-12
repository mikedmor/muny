import { type MunyDb, newId, schema } from "@muny/db";
import {
  MAIL_FIELDS,
  type MailAnchor,
  type MailFieldType,
  type MailTemplate,
  type MailTemplateDraft,
  type MailTemplateInput,
  type MailTemplateKind,
} from "@muny/shared";
import { asc, eq } from "drizzle-orm";

/**
 * Reading one sender's emails. A template is taught from one email: for each
 * value (the amount, the merchant…) it keeps the words just before and just
 * after it. Numbers and month names in those words may differ next time, so
 * they match any. Bank alert emails are written from a template, so the same
 * words surround the values in every one.
 */

const MONTH_WORDS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** In an anchor, "any text on the line" (where another field's value sits). */
export const ANY = "{*}";

/**
 * An anchor as a pattern: spaces and line breaks loosely, numbers and months
 * as any, {*} as any text on the line, and whole words only at its ends.
 */
function anchorPattern(a: string): string {
  const t = a.trim();
  const body = t
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return "\\s+";
      if (part === ANY) return "[^\\n]+?";
      // A number ("45.12", "1,203.99", "2026") is any number.
      return part
        .split(/(\d(?:[\d,.]*\d)?)/)
        .map((bit, i) =>
          i % 2
            ? "\\d(?:[\\d,.]*\\d)?"
            : escapeRe(bit).replace(
                new RegExp(`\\b(?:${MONTH_WORDS})\\b`, "gi"),
                `(?:${MONTH_WORDS})`,
              ),
        )
        .join("");
    })
    .join("");
  // "on" mustn't match inside "Transaction".
  return `${/^\w/.test(t) ? "\\b" : ""}${body}${/\w$/.test(t) ? "\\b" : ""}`;
}

/** The raw text of a field: what sits between its two anchors (on one line). */
export function extract(text: string, a: MailAnchor): string | null {
  const before = a.before.trim() ? `${anchorPattern(a.before)}[ \\t]*` : "^[ \\t]*";
  const after = a.after.trim() ? `[ \\t]*${anchorPattern(a.after)}` : "[ \\t]*(?=\\n|$)";
  const m = new RegExp(`${before}([^\\n]+?)${after}`, "im").exec(text);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Cents, from "$1,234.56", "1234.5" or "($12.00)"; always positive (the template says which way). */
export function moneyCents(s: string): number | null {
  const m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(s);
  if (!m) return null;
  const whole = Number((m[1] as string).replace(/,/g, ""));
  const frac = Number(((m[2] ?? "") as string).padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(whole)) return null;
  return whole * 100 + frac;
}

const iso = (y: number, mo: number, d: number) => {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** A date in the usual ways banks write one; a missing year is the email's. */
export function dateIso(s: string, yearOf: number): string | null {
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(s);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearOf;
    return iso(y, Number(m[1]), Number(m[2]));
  }
  // Day first ("3 November 2026") before month first, or "November 2026" reads as the 20th.
  m = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_WORDS})\\.?,?\\s+(\\d{4})`, "i").exec(s);
  if (m) {
    const mo = MONTHS.indexOf((m[2] as string).slice(0, 3).toLowerCase()) + 1;
    return iso(Number(m[3]), mo, Number(m[1]));
  }
  m = new RegExp(
    `\\b(${MONTH_WORDS})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?(?:\\s+(\\d{4}))?`,
    "i",
  ).exec(s);
  if (m) {
    const mo = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase()) + 1;
    return iso(m[3] ? Number(m[3]) : yearOf, mo, Number(m[2]));
  }
  return null;
}

export function readValue(
  type: MailFieldType,
  raw: string,
  yearOf: number,
): string | number | null {
  if (type === "money") return moneyCents(raw);
  if (type === "date") return dateIso(raw, yearOf);
  if (type === "last4") {
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(-4) : null;
  }
  const t = raw
    .replace(/[.,;:]+$/, "")
    .trim()
    .slice(0, 100);
  return t || null;
}

/** Every field a template reads from an email. */
export function readWith(
  kind: MailTemplateKind,
  fields: Record<string, MailAnchor>,
  text: string,
  yearOf: number,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const f of MAIL_FIELDS[kind]) {
    const a = fields[f.key];
    const raw = a ? extract(text, a) : null;
    out[f.key] = raw === null ? null : readValue(f.type, raw, yearOf);
  }
  return out;
}

interface Spot {
  li: number;
  col: number;
  end: number;
}

/**
 * The words before a value: from the end of the value before it on the line
 * (another field's value changes from email to email, so it can't be part of
 * this one's anchor), or the line above when the value starts its line.
 */
function beforeOf(lines: string[], at: Spot, all: Spot[]): string {
  const prev = all
    .filter((s) => s.li === at.li && s.end <= at.col)
    .reduce((e, s) => Math.max(e, s.end), 0);
  const line = lines[at.li] as string;
  let s = clipStart(line.slice(prev, at.col).trim(), 40);
  if (!s && prev === 0 && at.li > 0) s = clipStart((lines[at.li - 1] as string).trim(), 40);
  // A word or two ("on", "at") is too common to find on its own: lead with the
  // words before the value ahead of it ("ending in {*} on").
  if (s.length < 8 && prev > 0) {
    const ahead = all.find((x) => x.li === at.li && x.end === prev) as Spot;
    const lead = clipStart(line.slice(0, ahead.col).trim(), 25);
    if (lead) s = `${lead} ${ANY} ${s}`.trim();
  }
  return s;
}

/** The last `max` characters, not starting halfway through a word. */
function clipStart(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(-max);
  const sp = cut.indexOf(" ");
  return sp > 0 && sp < max / 2 ? cut.slice(sp + 1) : cut;
}

/** The words after a value, up to the next value on the line. */
function afterOf(lines: string[], at: Spot, all: Spot[]): string {
  const line = lines[at.li] as string;
  const next = all
    .filter((s) => s.li === at.li && s.col >= at.end)
    .reduce((c, s) => Math.min(c, s.col), line.length);
  let s = line.slice(at.end, next).trim();
  if (s.length > 20) {
    s = s.slice(0, 20);
    const sp = s.lastIndexOf(" ");
    if (sp > 4) s = s.slice(0, sp);
  }
  return s.trimEnd();
}

/**
 * Teach from one email: find each value as typed, keep the words around it,
 * and read it back the way the template will.
 */
export function draftTemplate(
  kind: MailTemplateKind,
  text: string,
  values: Record<string, string>,
  yearOf: number,
): MailTemplateDraft {
  const lines = text.split("\n");
  const missing: string[] = [];
  const spots = new Map<string, Spot>();
  for (const f of MAIL_FIELDS[kind]) {
    const want = values[f.key]?.trim();
    if (!want) continue;
    let found: Spot | null = null;
    for (const caseless of [false, true]) {
      for (let li = 0; li < lines.length && !found; li++) {
        const line = lines[li] as string;
        const col = caseless ? line.toLowerCase().indexOf(want.toLowerCase()) : line.indexOf(want);
        if (col >= 0) found = { li, col, end: col + want.length };
      }
      if (found) break;
    }
    if (found) spots.set(f.key, found);
    else missing.push(f.key);
  }
  const all = [...spots.values()];
  const fields: Record<string, MailAnchor> = {};
  for (const [key, at] of spots)
    fields[key] = { before: beforeOf(lines, at, all), after: afterOf(lines, at, all) };
  return { fields, read: readWith(kind, fields, text, yearOf), missing };
}

export function senderMatches(pattern: string, from: string): boolean {
  const p = pattern.toLowerCase();
  const f = from.toLowerCase();
  if (!p.startsWith("@")) return p === f;
  const domain = f.split("@")[1] ?? "";
  const want = p.slice(1);
  return domain === want || domain.endsWith(`.${want}`);
}

const toTemplate = (r: typeof schema.mailTemplates.$inferSelect): MailTemplate => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  from: r.fromMatch,
  subject: r.subjectMatch,
  direction: r.direction,
  accountId: r.accountId,
  fields: r.fields,
  createdAt: r.createdAt.getTime(),
});

export function listMailTemplates(db: MunyDb): MailTemplate[] {
  return db
    .select()
    .from(schema.mailTemplates)
    .orderBy(asc(schema.mailTemplates.name))
    .all()
    .map(toTemplate);
}

export function saveMailTemplate(db: MunyDb, input: MailTemplateInput, id?: string): MailTemplate {
  const known = new Set(MAIL_FIELDS[input.kind].map((f) => f.key));
  const fields = Object.fromEntries(
    Object.entries(input.fields).filter(([k, a]) => known.has(k) && (a.before || a.after)),
  );
  const values = {
    name: input.name.trim(),
    kind: input.kind,
    fromMatch: input.from.trim().toLowerCase(),
    subjectMatch: input.subject?.trim() || null,
    direction: input.direction ?? "out",
    accountId: input.accountId ?? null,
    fields,
  };
  if (id) {
    db.update(schema.mailTemplates).set(values).where(eq(schema.mailTemplates.id, id)).run();
  } else {
    id = newId();
    db.insert(schema.mailTemplates)
      .values({ id, ...values })
      .run();
  }
  const row = db.select().from(schema.mailTemplates).where(eq(schema.mailTemplates.id, id)).get();
  if (!row) throw new Error("Template not saved");
  return toTemplate(row);
}

export function deleteMailTemplate(db: MunyDb, id: string) {
  return db.delete(schema.mailTemplates).where(eq(schema.mailTemplates.id, id)).run().changes > 0;
}
