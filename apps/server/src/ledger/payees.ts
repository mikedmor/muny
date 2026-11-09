import { cleanPayeeName } from "@muny/core";
import { type MunyDb, schema } from "@muny/db";
import type { PayeeCleanupPreview, PayeeSummary } from "@muny/shared";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";
import { upsertPayee } from "./transactions.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const RenameBody = z.object({ displayName: z.string().trim().min(1).max(100) });

const t = schema.transactions;
const p = schema.payees;

/** Transactions without a payee, grouped by the cleaned name they'd get. */
function planCleanup(db: MunyDb) {
  const rows = db
    .select({ id: t.id, raw: t.rawDescription })
    .from(t)
    .where(isNull(t.payeeId))
    .all();
  const byName = new Map<string, { name: string; ids: string[]; raws: Map<string, number> }>();
  for (const r of rows) {
    const name = cleanPayeeName(r.raw);
    if (!name) continue;
    const k = name.toLowerCase();
    const g = byName.get(k) ?? { name, ids: [] as string[], raws: new Map<string, number>() };
    g.ids.push(r.id);
    g.raws.set(r.raw, (g.raws.get(r.raw) ?? 0) + 1);
    byName.set(k, g);
  }
  return [...byName.values()];
}

/**
 * Earlier versions saved raw ACH text ("Orig Co Name:lender Co Entry Descr:...")
 * as the merchant for synced transactions. Re-derive those names with the
 * current cleanup (even on edited transactions: nobody typed that name), drop the old
 * merchants. Idempotent; runs at startup.
 */
export function repairRawAchPayees(db: MunyDb): number {
  return db.transaction((tx) => {
    const bad = tx
      .select({ id: p.id })
      .from(p)
      .where(sql`lower(${p.displayName}) like 'orig co name%'`)
      .all()
      .map((r) => r.id);
    if (!bad.length) return 0;
    let n = 0;
    const rows = tx
      .select({ id: t.id, raw: t.rawDescription })
      .from(t)
      .where(inArray(t.payeeId, bad))
      .all();
    for (const r of rows) {
      const name = cleanPayeeName(r.raw);
      if (!name || /^orig co name/i.test(name)) continue;
      n += tx
        .update(t)
        .set({ payeeId: upsertPayee(tx, name) })
        .where(eq(t.id, r.id))
        .run().changes;
    }
    tx.delete(p)
      .where(
        and(
          inArray(p.id, bad),
          sql`not exists (select 1 from transactions x where x.payee_id = ${p.id})`,
        ),
      )
      .run();
    return n;
  });
}

/**
 * Older name cleanup cut some merchants to a stub: "WD7 512-555-0142 TX 01/06"
 * became "Tx", "GOOGLE *FI ..." became "Fi". Re-derive names for merchants of
 * at most 3 characters when today's cleanup gives a longer one, unless you
 * renamed that merchant yourself. Idempotent; runs at startup.
 */
export function repairStubPayees(db: MunyDb): number {
  return db.transaction((tx) => {
    const renamed = new Set(
      tx
        .select({ id: schema.auditLog.entityId })
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.action} in ('payee.rename', 'payee.merge')`)
        .all()
        .map((r) => r.id),
    );
    const stubs = tx
      .select({ id: p.id, name: p.displayName })
      .from(p)
      .where(sql`length(${p.displayName}) <= 3`)
      .all()
      // All-caps ones ("KFC", "BP") are real names, not stubs.
      .filter((s) => !renamed.has(s.id) && s.name !== s.name.toUpperCase());
    if (!stubs.length) return 0;
    const stubName = new Map(stubs.map((s) => [s.id, s.name]));
    let n = 0;
    for (const r of tx
      .select({ id: t.id, raw: t.rawDescription, payeeId: t.payeeId })
      .from(t)
      .where(inArray(t.payeeId, [...stubName.keys()]))
      .all()) {
      const old = stubName.get(r.payeeId ?? "") ?? "";
      const name = cleanPayeeName(r.raw);
      if (!name || name.length <= old.length || name.toLowerCase() === old.toLowerCase()) continue;
      const to = upsertPayee(tx, name);
      n += tx.update(t).set({ payeeId: to }).where(eq(t.id, r.id)).run().changes;
      // The remembered category comes along.
      tx.update(p)
        .set({
          defaultCategoryId: sql`(select x.default_category_id from payees x where x.id = ${r.payeeId})`,
        })
        .where(and(eq(p.id, to), isNull(p.defaultCategoryId)))
        .run();
    }
    // Recurring series follow their transactions on the next rescan.
    tx.delete(p)
      .where(
        and(
          inArray(p.id, [...stubName.keys()]),
          sql`not exists (select 1 from transactions x where x.payee_id = ${p.id})`,
        ),
      )
      .run();
    return n;
  });
}

/** Rename a merchant; if another already has that name, merge into it. */
export function renamePayee(
  db: MunyDb,
  id: string,
  displayName: string,
): { id: string; merged: boolean } {
  const other = db
    .select({ id: p.id })
    .from(p)
    .where(and(sql`lower(${p.displayName}) = lower(${displayName})`, ne(p.id, id)))
    .get();
  if (other) {
    db.transaction((tx) => {
      tx.update(t).set({ payeeId: other.id }).where(eq(t.payeeId, id)).run();
      tx.delete(p).where(eq(p.id, id)).run();
    });
    return { id: other.id, merged: true };
  }
  db.update(p).set({ displayName }).where(eq(p.id, id)).run();
  return { id, merged: false };
}

export function registerPayeeRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "payee",
      entityId,
      details,
    });

  app.get(
    "/api/payees/manage",
    async (): Promise<PayeeSummary[]> =>
      db
        .select({
          id: p.id,
          displayName: p.displayName,
          transactionCount: sql<number>`(select count(*) from transactions tx where tx.payee_id = "payees"."id")`,
        })
        .from(p)
        .orderBy(sql`lower(${p.displayName})`)
        .all()
        .map((r) => ({ ...r, transactionCount: Number(r.transactionCount) })),
  );

  /** Rename; if another payee already has that name, merge into it. */
  app.patch("/api/payees/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { displayName } = parse(RenameBody, req.body);
    const current = db.select().from(p).where(eq(p.id, id)).get();
    if (!current) throw notFound("Payee not found");
    const out = renamePayee(db, id, displayName);
    if (out.merged) log(user.id, "payee.merge", id, { into: out.id });
    else log(user.id, "payee.rename", id);
    return out;
  });

  app.delete("/api/payees/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const res = db.delete(p).where(eq(p.id, id)).run(); // transactions: ON DELETE SET NULL
    if (res.changes === 0) throw notFound("Payee not found");
    log(user.id, "payee.delete", id);
    return { ok: true };
  });

  /** Dry run of the payee cleanup. */
  app.post("/api/payees/cleanup/preview", async (): Promise<PayeeCleanupPreview> => {
    const groups = planCleanup(db);
    return {
      transactions: groups.reduce((s, g) => s + g.ids.length, 0),
      payees: groups.length,
      sample: groups
        .sort((a, b) => b.ids.length - a.ids.length)
        .slice(0, 25)
        .map((g) => {
          const [raw] = [...g.raws.entries()].sort((a, b) => b[1] - a[1])[0] ?? [""];
          return { raw, cleaned: g.name, count: g.ids.length };
        }),
    };
  });

  /** Give every transaction without a payee a cleaned-up one. Doesn't touch edited ones. */
  app.post("/api/payees/cleanup", async (req) => {
    const user = requireUser(req);
    const updated = db.transaction((tx) => {
      let n = 0;
      for (const g of planCleanup(db)) {
        const pid = upsertPayee(tx, g.name);
        for (let i = 0; i < g.ids.length; i += 500) {
          n += tx
            .update(t)
            .set({ payeeId: pid })
            .where(and(inArray(t.id, g.ids.slice(i, i + 500)), isNull(t.payeeId)))
            .run().changes;
        }
      }
      return n;
    });
    log(user.id, "payee.cleanup", undefined, { updated });
    return { updated };
  });
}
