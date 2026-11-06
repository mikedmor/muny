import { type MunyDb, newId, schema } from "@muny/db";
import { ACCOUNT_TYPES, type Account } from "@muny/shared";
import { asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { localToday } from "../lib/dates.js";
import { notFound, parse } from "../lib/http.js";

const cents = z.number().int().safe();
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const CreateBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  type: z.enum(ACCOUNT_TYPES),
  institutionName: nullableText(100),
  mask: z
    .string()
    .trim()
    .regex(/^\d{2,4}$/, "Use the last 2–4 digits only")
    .nullish()
    .or(z.literal(""))
    .transform((v) => (v ? v : null)),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
  balanceCents: cents.default(0),
});

const UpdateBody = CreateBody.omit({ currency: true, balanceCents: true }).partial().extend({
  hidden: z.boolean().optional(),
  excludeFromReports: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  balanceCents: cents.optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

/** Accounts with balance and activity summary. */
export function listAccounts(db: MunyDb, id?: string): Account[] {
  const t = schema.transactions;
  const a = schema.accounts;
  const rows = db
    .select({
      account: a,
      provider: schema.connections.provider,
      txnSum: sql<number>`coalesce(sum(case when ${t.pending} = 0 then ${t.amountCents} end), 0)`,
      txnCount: sql<number>`count(${t.id})`,
      lastDate: sql<string | null>`max(${t.postedDate})`,
    })
    .from(a)
    .leftJoin(schema.connections, eq(schema.connections.id, a.connectionId))
    .leftJoin(t, eq(t.accountId, a.id))
    .where(id ? eq(a.id, id) : undefined)
    .groupBy(a.id)
    .orderBy(asc(a.sortOrder), asc(a.name))
    .all();

  return rows.map(({ account: r, provider, txnSum, txnCount, lastDate }) => ({
    id: r.id,
    name: r.name,
    institutionName: r.institutionName,
    type: r.type,
    mask: r.mask,
    currency: r.currency,
    balanceCents:
      r.balanceSource === "reported"
        ? (r.currentBalanceCents ?? 0)
        : r.openingBalanceCents + Number(txnSum),
    balanceSource: r.balanceSource,
    hidden: r.hidden,
    excludeFromReports: r.excludeFromReports,
    sortOrder: r.sortOrder,
    provider: provider ?? "manual",
    transactionCount: Number(txnCount),
    lastTransactionDate: lastDate,
  }));
}

function getAccount(db: MunyDb, id: string): Account {
  const acc = listAccounts(db, id)[0];
  if (!acc) throw notFound("Account not found");
  return acc;
}

export function registerAccountRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/accounts", async () => listAccounts(db));

  app.get("/api/accounts/:id", async (req) => getAccount(db, parse(IdParams, req.params).id));

  app.post("/api/accounts", async (req, reply) => {
    const user = requireUser(req);
    const body = parse(CreateBody, req.body);
    const id = newId();
    db.insert(schema.accounts)
      .values({
        id,
        name: body.name,
        type: body.type,
        institutionName: body.institutionName,
        mask: body.mask,
        currency: body.currency,
        balanceSource: "computed",
        openingBalanceCents: body.balanceCents,
      })
      .run();
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "account.create",
      entityType: "account",
      entityId: id,
      details: { name: body.name, type: body.type },
    });
    return reply.code(201).send(getAccount(db, id));
  });

  app.patch("/api/accounts/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(UpdateBody, req.body);
    const current = getAccount(db, id);

    const { balanceCents, ...fields } = body;
    const update: Partial<typeof schema.accounts.$inferInsert> = { ...fields };
    if (balanceCents !== undefined && balanceCents !== current.balanceCents) {
      if (current.balanceSource === "computed") {
        // Shift the opening balance so opening + transactions = requested balance.
        const row = db
          .select({ opening: schema.accounts.openingBalanceCents })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, id))
          .get();
        update.openingBalanceCents = (row?.opening ?? 0) + (balanceCents - current.balanceCents);
      } else {
        update.currentBalanceCents = balanceCents;
      }
    }
    if (Object.keys(update).length > 0) {
      db.update(schema.accounts).set(update).where(eq(schema.accounts.id, id)).run();
      if (balanceCents !== undefined && balanceCents !== current.balanceCents) {
        // Value history for net worth (e.g. a house or car you update by hand).
        db.insert(schema.balanceSnapshots)
          .values({ accountId: id, date: localToday(), balanceCents })
          .onConflictDoUpdate({
            target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
            set: { balanceCents, estimated: false },
          })
          .run();
      }
      audit(db, {
        actorType: "user",
        actorId: user.id,
        action: "account.update",
        entityType: "account",
        entityId: id,
        details: { fields: Object.keys(body) },
      });
    }
    return getAccount(db, id);
  });

  app.delete("/api/accounts/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const current = getAccount(db, id);
    db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "account.delete",
      entityType: "account",
      entityId: id,
      details: { name: current.name, transactionsDeleted: current.transactionCount },
    });
    return { ok: true };
  });
}
