import { type MunyDb, newId, schema } from "@muny/db";
import {
  type StatementKind,
  type StatementTemplate,
  type StatementTemplateInput,
  TEMPLATE_FIELDS,
  type TemplateFieldType,
} from "@muny/shared";
import { asc, eq } from "drizzle-orm";

/**
 * Statement templates: for a statement whose layout the built-in readers
 * miss, each field is the label its value follows on a line ("New Balance",
 * "Payment Due"). A template applies to statements containing its match text
 * and fills in (or corrects) those fields.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const MONEY = /-?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})/;
const DATE = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})|([A-Z][a-z]{2,8})\.? (\d{1,2}),? (\d{4})/;
const PERCENT = /(\d{1,2}(?:\.\d{1,4})?)\s?%/;

/** The first value of a type in some text. */
export function firstValue(type: TemplateFieldType, text: string): number | string | null {
  if (type === "money") {
    const m = MONEY.exec(text);
    return m ? Number((m[1] as string).replace(/,/g, "")) * 100 + Number(m[2]) : null;
  }
  if (type === "percent") {
    const m = PERCENT.exec(text);
    return m ? Math.round(Number(m[1]) * 100) : null;
  }
  const m = DATE.exec(text);
  if (!m) return null;
  if (m[1]) {
    const y = (m[3] as string).length === 2 ? `20${m[3]}` : (m[3] as string);
    return `${y}-${(m[1] as string).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
  }
  const mo = MONTHS.indexOf((m[4] as string).slice(0, 3).toLowerCase());
  return mo < 0
    ? null
    : `${m[6]}-${String(mo + 1).padStart(2, "0")}-${(m[5] as string).padStart(2, "0")}`;
}

/** A field's value: on the first line with the label, the first value after it. */
export function readField(lines: string[], label: string, type: TemplateFieldType) {
  const want = label.trim().toLowerCase();
  if (!want) return null;
  for (const line of lines) {
    const at = line.toLowerCase().indexOf(want);
    if (at < 0) continue;
    const v = firstValue(type, line.slice(at + want.length));
    if (v !== null) return v;
  }
  return null;
}

const toTemplate = (r: typeof schema.statementTemplates.$inferSelect): StatementTemplate => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  matchText: r.matchText,
  fields: r.fields,
});

export function listTemplates(db: MunyDb, kind?: StatementKind): StatementTemplate[] {
  return db
    .select()
    .from(schema.statementTemplates)
    .orderBy(asc(schema.statementTemplates.name))
    .all()
    .filter((r) => !kind || r.kind === kind)
    .map(toTemplate);
}

export function saveTemplate(
  db: MunyDb,
  input: StatementTemplateInput,
  id?: string,
): StatementTemplate {
  const known = new Set(TEMPLATE_FIELDS[input.kind].map((f) => f.key));
  const fields = Object.fromEntries(
    Object.entries(input.fields).filter(([k, v]) => known.has(k) && v.label.trim()),
  );
  const row = {
    kind: input.kind,
    name: input.name.trim(),
    matchText: input.matchText.trim(),
    fields,
  };
  if (id) {
    db.update(schema.statementTemplates)
      .set({ ...row, updatedAt: new Date() })
      .where(eq(schema.statementTemplates.id, id))
      .run();
    return { id, ...row };
  }
  const newRow = { id: newId(), ...row };
  db.insert(schema.statementTemplates).values(newRow).run();
  return newRow;
}

export function deleteTemplate(db: MunyDb, id: string) {
  return (
    db.delete(schema.statementTemplates).where(eq(schema.statementTemplates.id, id)).run().changes >
    0
  );
}

/**
 * Fill in a read statement from the templates whose match text it contains.
 * A template's fields win over the built-in reader (you taught them).
 * Returns the template names used.
 */
export function applyTemplates<T extends object>(
  db: MunyDb,
  kind: StatementKind,
  lines: string[],
  parsed: T,
): string[] {
  const text = lines.join("\n").toLowerCase();
  const used: string[] = [];
  for (const t of listTemplates(db, kind)) {
    if (!t.matchText || !text.includes(t.matchText.toLowerCase())) continue;
    let hit = false;
    for (const f of TEMPLATE_FIELDS[kind]) {
      const rule = t.fields[f.key];
      if (!rule) continue;
      const v = readField(lines, rule.label, f.type);
      if (v !== null) {
        (parsed as Record<string, unknown>)[f.key] = v;
        hit = true;
      }
    }
    if (hit) used.push(t.name);
  }
  return used;
}
