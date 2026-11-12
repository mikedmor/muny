import { AsyncLocalStorage } from "node:async_hooks";
import { type MunyDb, newId, schema } from "@muny/db";
import { eq } from "drizzle-orm";

/**
 * Undo, the recording half. While a change is being made (a request that
 * writes), temporary triggers on every table write each row's before and
 * after into change_log, tagged with the change. They're TEMP triggers, so
 * they live only on Muny's own connection: nothing else that opens the
 * database (a backup, a support script) needs to know about them.
 *
 * Which change a write belongs to comes from muny_change(), a function the
 * triggers call. It answers from AsyncLocalStorage, so a request's writes are
 * tagged with that request even while others run between its awaits.
 */

interface ChangeContext {
  id: string;
  /** Writes after this (a timer started by the request, say) aren't part of it. */
  until: number;
  /** Not offered for undo straight away (still in the history). */
  quiet: boolean;
}

const als = new AsyncLocalStorage<ChangeContext>();

/** The change being made right now, if any. */
export function currentChange(): ChangeContext | undefined {
  const c = als.getStore();
  return c && Date.now() < c.until ? c : undefined;
}

/** Run `fn` with its writes recorded as change `id` (or not recorded, with null). */
export function runAsChange<T>(id: string | null, fn: () => T, quiet = false): T {
  if (id === null) return als.exit(fn);
  return als.run({ id, until: Number.POSITIVE_INFINITY, quiet }, fn);
}

/** Not worth undoing or offering: credentials, logs, caches, counters. */
const UNTRACKED = new Set([
  "users", // never undo a password change back
  "sessions",
  "audit_log",
  "change_log",
  "changesets",
  "crypto_prices",
  "security_prices",
  "security_logos",
  "crypto_sync_runs",
  "mail_messages", // a record of what was read, so nothing is read twice
  "__drizzle_migrations",
]);

/** Settings rows that are counters or caches. */
const UNTRACKED_SETTINGS = [
  "crypto.usage",
  "crypto.price_state",
  "alerts.state",
  "invest.watchlist.refreshed",
  "plaid.loginsCreated",
  "mail.state",
];

/** A change to only these isn't a change anyone would undo. */
export const QUIET_COLUMNS = new Set(["updated_at", "last_used_at", "last_seen_at"]);

export interface TableMeta {
  name: string;
  cols: string[];
  /** Primary key columns; ["rowid"] for a table without one. */
  pk: string[];
  blobs: Set<string>;
}

export const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

export function tableMeta(db: MunyDb): Map<string, TableMeta> {
  const sqlite = db.$client;
  const tables = sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all() as { name: string }[];
  const out = new Map<string, TableMeta>();
  for (const { name } of tables) {
    const info = sqlite.prepare(`pragma table_info(${q(name)})`).all() as {
      name: string;
      type: string;
      pk: number;
    }[];
    const pk = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    out.set(name, {
      name,
      cols: info.map((c) => c.name),
      pk: pk.length ? pk : ["rowid"],
      blobs: new Set(info.filter((c) => /blob/i.test(c.type)).map((c) => c.name)),
    });
  }
  return out;
}

/** The row as a JSON object in SQL, blobs as hex; nested so wide tables stay under SQLite's argument limit. */
function rowJson(alias: string, cols: string[], m: TableMeta): string {
  const v = (c: string) =>
    c === "rowid"
      ? `${alias}.rowid`
      : m.blobs.has(c)
        ? `CASE WHEN ${alias}.${q(c)} IS NULL THEN NULL ELSE hex(${alias}.${q(c)}) END`
        : `${alias}.${q(c)}`;
  const pairs = cols.map((c) => `'${c.replace(/'/g, "''")}', ${v(c)}`);
  let sql = `json_object(${pairs.slice(0, 50).join(", ")})`;
  for (let i = 50; i < pairs.length; i += 50) {
    const more = cols.slice(i, i + 50).map((c) => `'$.${c}', ${v(c)}`);
    sql = `json_set(${sql}, ${more.join(", ")})`;
  }
  return sql;
}

/** Register muny_change() and (re)create the triggers. Call once per connection, after migrations. */
export function installChangeTracking(db: MunyDb) {
  const sqlite = db.$client;
  sqlite.function("muny_change", { deterministic: false }, () => currentChange()?.id ?? null);
  // REPLACE deleting a row should be recorded too.
  sqlite.pragma("recursive_triggers = ON");
  const meta = tableMeta(db);
  const sql: string[] = [];
  for (const m of meta.values()) {
    if (UNTRACKED.has(m.name)) continue;
    const t = q(m.name);
    const name = (op: string) => q(`muny_undo_${m.name}_${op}`);
    const filter = (alias: string) =>
      m.name === "app_settings"
        ? ` AND ${alias}.key NOT IN (${UNTRACKED_SETTINGS.map((k) => `'${k}'`).join(", ")})`
        : "";
    const log = (op: string, pkAlias: string, oldRow: string, newRow: string) =>
      `INSERT INTO main.change_log (changeset_id, tbl, op, pk, old_row, new_row) VALUES (muny_change(), '${m.name}', '${op}', ${rowJson(pkAlias, m.pk, m)}, ${oldRow}, ${newRow});`;
    const all = m.cols;
    const changed = all.filter((c) => !QUIET_COLUMNS.has(c));
    for (const op of ["i", "u", "d"]) sql.push(`DROP TRIGGER IF EXISTS temp.${name(op)};`);
    sql.push(
      `CREATE TEMP TRIGGER ${name("i")} AFTER INSERT ON main.${t} WHEN muny_change() IS NOT NULL${filter("NEW")} BEGIN ${log("I", "NEW", "NULL", rowJson("NEW", all, m))} END;`,
      `CREATE TEMP TRIGGER ${name("d")} AFTER DELETE ON main.${t} WHEN muny_change() IS NOT NULL${filter("OLD")} BEGIN ${log("D", "OLD", rowJson("OLD", all, m), "NULL")} END;`,
    );
    if (changed.length)
      sql.push(
        `CREATE TEMP TRIGGER ${name("u")} AFTER UPDATE ON main.${t} WHEN muny_change() IS NOT NULL${filter("NEW")} AND (${changed.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(" OR ")}) BEGIN ${log("U", "NEW", rowJson("OLD", all, m), rowJson("NEW", all, m))} END;`,
      );
  }
  sqlite.exec(sql.join("\n"));
}

/** Start recording a change: its row in the history, filled in as it's described. */
export function openChange(
  db: MunyDb,
  values: {
    actorType: "user" | "agent" | "system";
    actorId?: string | null;
    actorName?: string | null;
    route?: string | null;
  },
): string {
  const id = newId();
  db.insert(schema.changesets)
    .values({ id, ...values })
    .run();
  return id;
}

/**
 * Name the change being made, for the history and the Undo offer, and say who
 * made it when it wasn't the signed-in person (an assistant, Muny itself).
 */
export function describeChange(
  db: MunyDb,
  label: string,
  actor?: { type: "agent" | "system"; id?: string | null; name: string },
) {
  const c = currentChange();
  if (!c) return;
  db.update(schema.changesets)
    .set({
      label: label.slice(0, 200),
      ...(actor ? { actorType: actor.type, actorId: actor.id ?? null, actorName: actor.name } : {}),
    })
    .where(eq(schema.changesets.id, c.id))
    .run();
}
