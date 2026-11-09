import { type MunyDb, newId, schema } from "@muny/db";
import type { UndoPreview } from "@muny/shared";
import { eq } from "drizzle-orm";
import { changeParts, changeTitle, noun, type Part, partText, rowName } from "./describe.js";
import { QUIET_COLUMNS, q, runAsChange, type TableMeta, tableMeta } from "./track.js";

/**
 * Undo, the putting-back half. Undoing replays a change's rows backwards:
 * rows it added are removed, rows it removed come back, and the columns it
 * changed get their old values (only those, so later edits to other columns
 * stay). The undo is itself a change, so undoing it redoes.
 */

interface Entry {
  seq: number;
  tbl: string;
  op: "I" | "U" | "D";
  pk: string;
  old_row: string | null;
  new_row: string | null;
}

type Row = Record<string, unknown>;

export class UndoError extends Error {}

const entriesOf = (db: MunyDb, id: string) =>
  db.$client
    .prepare(
      "select seq, tbl, op, pk, old_row, new_row from change_log where changeset_id = ? order by seq",
    )
    .all(id) as Entry[];

const parse = (s: string | null): Row | null => (s ? (JSON.parse(s) as Row) : null);

/** A stored value back into what SQLite takes (hex back into a blob). */
const toDb = (m: TableMeta, col: string, v: unknown) =>
  m.blobs.has(col) && typeof v === "string" ? Buffer.from(v, "hex") : v;

/** A value read now, in the form it was stored. */
const fromDb = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("hex").toUpperCase() : v);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // SQLite writes reals into JSON with 15 digits.
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= Math.abs(a) * 1e-12;
  return false;
}

function where(m: TableMeta, pk: Row) {
  return {
    sql: m.pk.map((c) => (c === "rowid" ? "rowid = ?" : `${q(c)} = ?`)).join(" AND "),
    params: m.pk.map((c) => pk[c]),
  };
}

function current(db: MunyDb, m: TableMeta, pk: Row): Row | null {
  const w = where(m, pk);
  const row = db.$client
    .prepare(
      `select ${m.pk.includes("rowid") ? "rowid, " : ""}* from main.${q(m.name)} where ${w.sql}`,
    )
    .get(...w.params) as Row | undefined;
  return row ?? null;
}

/** Replay the entries backwards. */
function applyInverse(db: MunyDb, meta: Map<string, TableMeta>, entries: Entry[]) {
  const sqlite = db.$client;
  for (const e of [...entries].reverse()) {
    const m = meta.get(e.tbl);
    if (!m) throw new UndoError(`Muny no longer has ${noun(e.tbl, 2)}, so this can't be undone.`);
    const pk = parse(e.pk) ?? {};
    const w = where(m, pk);
    if (e.op === "I") {
      sqlite.prepare(`delete from main.${q(m.name)} where ${w.sql}`).run(...w.params);
    } else if (e.op === "D") {
      const old = parse(e.old_row) ?? {};
      const cols = Object.keys(old).filter((c) => m.cols.includes(c) || c === "rowid");
      sqlite
        .prepare(
          `insert into main.${q(m.name)} (${cols.map((c) => (c === "rowid" ? "rowid" : q(c))).join(", ")}) values (${cols.map(() => "?").join(", ")})`,
        )
        .run(...cols.map((c) => toDb(m, c, old[c])));
    } else {
      const old = parse(e.old_row) ?? {};
      const now = parse(e.new_row) ?? {};
      const cols = Object.keys(old).filter((c) => m.cols.includes(c) && !same(old[c], now[c]));
      if (!cols.length) continue;
      sqlite
        .prepare(
          `update main.${q(m.name)} set ${cols.map((c) => `${q(c)} = ?`).join(", ")} where ${w.sql}`,
        )
        .run(...cols.map((c) => toDb(m, c, old[c])), ...w.params);
    }
  }
}

/** Rows this change left that have been changed since, which undoing would overwrite. */
function findConflicts(db: MunyDb, meta: Map<string, TableMeta>, entries: Entry[]): string[] {
  const rows = new Map<string, { first: Entry; last: Entry }>();
  for (const e of entries) {
    const key = `${e.tbl}\u0000${e.pk}`;
    const r = rows.get(key);
    if (r) r.last = e;
    else rows.set(key, { first: e, last: e });
  }
  const out: string[] = [];
  for (const { first, last } of rows.values()) {
    const m = meta.get(last.tbl);
    if (!m) continue;
    const pk = parse(last.pk) ?? {};
    const now = current(db, m, pk);
    const left = parse(last.new_row);
    const what = () => {
      const name = rowName(left ?? parse(first.old_row));
      const n = noun(m.name, 1);
      return `${n[0]?.toUpperCase()}${n.slice(1)}${name ? ` “${name}”` : ""}`;
    };
    if (last.op === "D") {
      if (now) out.push(`${what()} was added back afterwards.`);
      continue;
    }
    if (!now) {
      out.push(`${what()} was removed afterwards.`);
      continue;
    }
    const before = parse(first.old_row);
    const cols = Object.keys(left ?? {}).filter(
      (c) => !QUIET_COLUMNS.has(c) && (first.op === "I" || !same(before?.[c], left?.[c])),
    );
    if (cols.some((c) => !same(fromDb(now[c]), left?.[c])))
      out.push(`${what()} was changed afterwards.`);
  }
  return out;
}

const ROLLBACK = Symbol("rollback");

/** What undoing would do, worked out by doing it and rolling it back. */
export function previewUndo(db: MunyDb, id: string): UndoPreview {
  const cs = db.select().from(schema.changesets).where(eq(schema.changesets.id, id)).get();
  if (!cs) throw new UndoError("That change isn't in the history any more.");
  const parts = changeParts(db, id);
  const title = changeTitle(db, id, parts);
  const out: UndoPreview = {
    title,
    effects: [],
    conflicts: [],
    conflictCount: 0,
    extra: false,
    error: null,
  };
  if (cs.undoneBy) return { ...out, error: "This has already been undone." };
  const entries = entriesOf(db, id);
  if (!entries.length) return { ...out, error: "This didn't change anything that can be undone." };
  const meta = tableMeta(db);
  const conflicts = findConflicts(db, meta, entries);
  out.conflicts = conflicts.slice(0, 8);
  out.conflictCount = conflicts.length;

  const trial = `trial-${newId()}`;
  const sqlite = db.$client;
  try {
    sqlite.transaction(() => {
      sqlite.pragma("defer_foreign_keys = ON");
      runAsChange(trial, () => applyInverse(db, meta, entries));
      const effects = changeParts(db, trial);
      out.effects = effects.map((p) => partText(p, true));
      // More rows than the change itself touched: something else goes too.
      const expected = new Map<string, number>();
      const inverse = { I: "D", D: "I", U: "U" } as const;
      for (const p of parts) expected.set(`${p.tbl}:${inverse[p.op]}`, p.n);
      out.extra = effects.some((p: Part) => p.n > (expected.get(`${p.tbl}:${p.op}`) ?? 0));
      const broken = sqlite.pragma("foreign_key_check") as { table: string }[];
      if (broken.length) {
        const tables = [...new Set(broken.map((b) => noun(b.table, 2)))].join(", ");
        out.error = `Undoing this would leave ${tables} pointing at something that's gone. Undo the later changes to them first.`;
      }
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) out.error = undoMessage(e);
  }
  return out;
}

function undoMessage(e: unknown): string {
  if (e instanceof UndoError) return e.message;
  const msg = e instanceof Error ? e.message : "";
  if (/UNIQUE constraint/i.test(msg))
    return "Something with the same name or details exists now, so this can't be put back. Remove or rename it first.";
  if (/FOREIGN KEY/i.test(msg))
    return "Something this needs is gone now. Undo the later changes to it first.";
  return "This change can't be undone.";
}

/**
 * Undo change `id` as part of change `undoId` (the request doing it). Without
 * `force`, stops and returns the preview when something changed since or more
 * would go than the change itself touched.
 */
export function undoChange(
  db: MunyDb,
  id: string,
  undoId: string,
  force: boolean,
): { done: true; title: string } | { done: false; preview: UndoPreview } {
  const preview = previewUndo(db, id);
  if (preview.error) throw new UndoError(preview.error);
  if (!force && (preview.conflictCount > 0 || preview.extra)) return { done: false, preview };
  const cs = db.select().from(schema.changesets).where(eq(schema.changesets.id, id)).get();
  const redo = cs?.undoOf ? changeTitle(db, cs.undoOf) : null;
  const title = redo ? `Redid: ${redo}` : `Undid: ${preview.title}`;
  const sqlite = db.$client;
  const meta = tableMeta(db);
  const entries = entriesOf(db, id);
  try {
    sqlite.transaction(() => {
      sqlite.pragma("defer_foreign_keys = ON");
      runAsChange(undoId, () => applyInverse(db, meta, entries));
      runAsChange(null, () => {
        db.update(schema.changesets)
          .set({ label: title.slice(0, 200), undoOf: id })
          .where(eq(schema.changesets.id, undoId))
          .run();
        db.update(schema.changesets)
          .set({ undoneBy: undoId })
          .where(eq(schema.changesets.id, id))
          .run();
        // Undoing an undo puts the original back in force.
        if (cs?.undoOf)
          db.update(schema.changesets)
            .set({ undoneBy: null })
            .where(eq(schema.changesets.id, cs.undoOf))
            .run();
      });
    })();
  } catch (e) {
    throw new UndoError(undoMessage(e));
  }
  return { done: true, title };
}

/** Keep 60 days of history; drop changes that changed nothing. */
export function pruneChanges(db: MunyDb, now = Date.now()) {
  const sqlite = db.$client;
  const cutoff = now - 60 * 86_400_000;
  runAsChange(null, () =>
    sqlite.transaction(() => {
      sqlite
        .prepare(
          "delete from change_log where changeset_id in (select id from changesets where at < ?)",
        )
        .run(cutoff);
      sqlite.prepare("delete from changesets where at < ?").run(cutoff);
      sqlite
        .prepare(
          "delete from changesets where at < ? and not exists (select 1 from change_log l where l.changeset_id = changesets.id)",
        )
        .run(now - 3_600_000);
    })(),
  );
}
