import { type MunyDb, newId, schema } from "@muny/db";
import type { ConnectionSummary, LinkableAccount, SyncConfigStatus } from "@muny/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { findMatchingAccount } from "../import/service.js";
import { listAccounts } from "../ledger/accounts.js";
import { audit } from "../lib/audit.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import {
  type AnyCreds,
  openCreds,
  providerFor,
  type SyncDeps,
  sealCreds,
  syncConnection,
} from "./engine.js";
import { type PayPalCreds, PayPalProvider } from "./paypal.js";
import type { PlaidCreds } from "./plaid.js";
import { claimSetupToken, type SimpleFinCreds, SimpleFinProvider } from "./simplefin.js";
import type { TellerCreds } from "./teller.js";
import { type ConnectionInfo, ProviderError } from "./types.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
/** "brokerage": link for Plaid Investments (holdings and history) instead of Transactions. */
const LinkKind = z.object({ kind: z.enum(["bank", "brokerage"]).default("bank") });
const token = z.string().trim().min(1).max(500);
const LinkBody = z.object({
  accounts: z.record(z.string().max(200), z.string().min(1).max(64)),
});

/** ProviderError -> HTTP error the UI can show. */
function asHttp(e: unknown): never {
  if (e instanceof ProviderError) {
    const status = e.code === "config" ? 400 : e.code === "rate_limited" ? 429 : 502;
    throw new HttpError(status, e.message, { code: e.code });
  }
  throw e;
}

export function registerSyncRoutes(app: FastifyInstance, db: MunyDb, deps: SyncDeps) {
  const c = schema.connections;
  const log = (userId: string, action: string, entityId?: string, details?: unknown) =>
    audit(db, {
      actorType: "user",
      actorId: userId,
      action,
      entityType: "connection",
      entityId,
      details,
    });

  const getConn = (id: string) => {
    const conn = db.select().from(c).where(eq(c.id, id)).get();
    if (!conn || !["plaid", "teller", "paypal", "simplefin"].includes(conn.provider))
      throw notFound("Connection not found");
    return conn;
  };

  /** Accounts at the provider, with a suggested existing Muny account for each. */
  const linkable = (info: ConnectionInfo, connectionId: string): LinkableAccount[] => {
    const existing = db.select().from(schema.accounts).all();
    return info.accounts.map((pa) => {
      const already = existing.find(
        (e) => e.connectionId === connectionId && e.providerAccountRef === pa.ref,
      );
      const m =
        already ??
        findMatchingAccount(
          existing.filter((e) => e.connectionId !== connectionId || !e.providerAccountRef),
          { name: pa.name, institutionName: info.institutionName, mask: pa.mask },
        );
      return {
        ref: pa.ref,
        name: pa.name,
        mask: pa.mask,
        type: pa.type,
        balanceCents: pa.balanceCents,
        match: m ? { id: m.id, name: m.name } : null,
      };
    });
  };

  const createConnection = (
    provider: "plaid" | "teller" | "paypal" | "simplefin",
    creds: AnyCreds,
    info: ConnectionInfo,
  ) => {
    const id = newId();
    db.insert(c)
      .values({
        id,
        provider,
        institutionName: info.institutionName,
        providerRef: info.providerRef,
        credentialsEnc: sealCreds(deps.config, creds),
        status: "pending_setup",
      })
      .run();
    return id;
  };

  /** The Plaid login limit of your plan (Plaid's API doesn't report it); null clears it. */
  app.put("/api/sync/plaid-limit", async (req) => {
    const user = requireUser(req);
    const { limit } = parse(
      z.object({ limit: z.number().int().min(1).max(10000).nullable() }),
      req.body,
    );
    setSetting(db, PLAID_LIMIT_KEY, limit);
    log(user.id, "plaid.limit", undefined, { limit });
    return { limit };
  });

  app.get("/api/sync/config", async (): Promise<SyncConfigStatus> => {
    const { plaid, teller } = deps.config;
    return {
      secretKey: !!deps.config.secretKey,
      intervalHours: deps.config.syncIntervalHours,
      plaid: plaid
        ? {
            configured: true,
            env: plaid.env,
            oauth: !!plaid.redirectUri,
            logins: plaidLogins(db, plaid.env),
          }
        : { configured: false },
      teller: teller
        ? {
            configured: true,
            env: teller.env,
            applicationId: teller.applicationId,
            certificate: !!(teller.certPath && teller.keyPath),
          }
        : { configured: false },
    };
  });

  app.get("/api/connections", async (): Promise<ConnectionSummary[]> => {
    const conns = db
      .select()
      .from(c)
      .where(inArray(c.provider, ["plaid", "teller", "paypal", "simplefin"]))
      .orderBy(c.createdAt)
      .all();
    const accounts = listAccounts(db);
    const accRows = db
      .select({ id: schema.accounts.id, connectionId: schema.accounts.connectionId })
      .from(schema.accounts)
      .all();
    return conns.map((x) => ({
      id: x.id,
      provider: x.provider as "plaid" | "teller" | "paypal" | "simplefin",
      institutionName: x.institutionName,
      status: x.status,
      lastSyncAt: x.lastSyncAt ? x.lastSyncAt.getTime() : null,
      lastError: x.lastError,
      ignoredAccounts: (x.ignoredAccountRefs ?? []).length,
      tellerEnrollmentId: x.provider === "teller" ? x.providerRef : null,
      accounts: accounts.filter((a) =>
        accRows.some((r) => r.id === a.id && r.connectionId === x.id),
      ),
    }));
  });

  // --- Plaid -----------------------------------------------------------------

  app.post("/api/connections/plaid/link-token", async (req) => {
    const user = requireUser(req);
    const plaid = deps.providers.plaid;
    if (!plaid)
      throw badRequest("Plaid isn't configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env.");
    try {
      const { kind } = parse(LinkKind, req.body ?? {});
      return { linkToken: await plaid.createLinkToken(user.id, undefined, kind) };
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/api/connections/plaid/exchange", async (req) => {
    const user = requireUser(req);
    const { publicToken, kind } = parse(z.object({ publicToken: token }).merge(LinkKind), req.body);
    const plaid = deps.providers.plaid;
    if (!plaid) throw badRequest("Plaid isn't configured.");
    try {
      const creds = await plaid.exchangePublicToken(publicToken, kind);
      if (deps.config.plaid?.env === "production") countPlaidLogin(db);
      const info = await plaid.getAccounts(creds);
      const id = createConnection("plaid", creds, info);
      log(user.id, "connection.create", id, {
        provider: "plaid",
        institution: info.institutionName,
      });
      return {
        connectionId: id,
        institutionName: info.institutionName,
        accounts: linkable(info, id),
      };
    } catch (e) {
      asHttp(e);
    }
  });

  /** Link token in update mode, to fix a login that needs attention. */
  /** Update mode asking an existing login to share loan details (rate, payment, due date). */
  app.post("/api/connections/:id/plaid/liabilities-token", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const conn = getConn(id);
    if (conn.provider !== "plaid" || !deps.providers.plaid)
      throw badRequest("Not a Plaid connection");
    const creds = openCreds<PlaidCreds>(deps.config, conn);
    try {
      return {
        linkToken: await deps.providers.plaid.createLinkToken(user.id, creds.accessToken, "bank", [
          "liabilities",
        ]),
      };
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/api/connections/:id/plaid/update-token", async (req) => {
    const user = requireUser(req);
    const conn = getConn(parse(IdParams, req.params).id);
    if (conn.provider !== "plaid" || !deps.providers.plaid)
      throw badRequest("Not a Plaid connection");
    try {
      const creds = openCreds<PlaidCreds>(deps.config, conn);
      return { linkToken: await deps.providers.plaid.createLinkToken(user.id, creds.accessToken) };
    } catch (e) {
      asHttp(e);
    }
  });

  // --- Teller ----------------------------------------------------------------

  /** Teller Connect hands the browser an access token; store it server-side. */
  // --- PayPal (your own REST app's keys; read-only) -----------------------------

  // --- SimpleFIN Bridge (your own account there; read-only) -----------------------

  app.post("/api/connections/simplefin", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        setupToken: z.string().trim().min(20, "Paste the setup token").max(2000),
        connectionId: z.string().max(64).optional(),
      }),
      req.body,
    );
    const simplefin = deps.providers.simplefin ?? new SimpleFinProvider();
    try {
      const creds: SimpleFinCreds = { accessUrl: await claimSetupToken(body.setupToken) };
      const info = await simplefin.getAccounts(creds);
      if (body.connectionId) {
        const conn = getConn(body.connectionId);
        db.update(c)
          .set({ credentialsEnc: sealCreds(deps.config, creds), status: "active", lastError: null })
          .where(eq(c.id, conn.id))
          .run();
        log(user.id, "connection.reauth", conn.id);
        return {
          connectionId: conn.id,
          institutionName: info.institutionName,
          accounts: linkable(info, conn.id),
        };
      }
      const id = createConnection("simplefin", creds, info);
      log(user.id, "connection.create", id, { provider: "simplefin" });
      return {
        connectionId: id,
        institutionName: info.institutionName,
        accounts: linkable(info, id),
      };
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/api/connections/paypal", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        clientId: z.string().trim().min(10, "Paste the app's client ID").max(200),
        clientSecret: z.string().trim().min(10, "Paste the app's secret").max(200),
        env: z.enum(["live", "sandbox"]).default("live"),
        connectionId: z.string().max(64).optional(),
      }),
      req.body,
    );
    const paypal = deps.providers.paypal ?? new PayPalProvider();
    const creds: PayPalCreds = {
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      env: body.env,
    };
    try {
      const info = await paypal.getAccounts(creds);
      if (body.connectionId) {
        // New keys for an existing connection.
        const conn = getConn(body.connectionId);
        db.update(c)
          .set({ credentialsEnc: sealCreds(deps.config, creds), status: "active", lastError: null })
          .where(eq(c.id, conn.id))
          .run();
        log(user.id, "connection.reauth", conn.id);
        return {
          connectionId: conn.id,
          institutionName: "PayPal",
          accounts: linkable(info, conn.id),
        };
      }
      const id = createConnection("paypal", creds, info);
      log(user.id, "connection.create", id, { provider: "paypal" });
      return { connectionId: id, institutionName: "PayPal", accounts: linkable(info, id) };
    } catch (e) {
      asHttp(e);
    }
  });

  app.post("/api/connections/teller/enroll", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        accessToken: token,
        enrollmentId: token,
        connectionId: z.string().max(64).optional(),
      }),
      req.body,
    );
    const teller = deps.providers.teller;
    if (!teller) throw badRequest("Teller isn't configured. Add TELLER_APPLICATION_ID to .env.");
    const creds: TellerCreds = { accessToken: body.accessToken, enrollmentId: body.enrollmentId };
    try {
      const info = await teller.getAccounts(creds);
      if (body.connectionId) {
        // Reconnecting an existing enrollment.
        const conn = getConn(body.connectionId);
        db.update(c)
          .set({ credentialsEnc: sealCreds(deps.config, creds), status: "active", lastError: null })
          .where(eq(c.id, conn.id))
          .run();
        log(user.id, "connection.reauth", conn.id);
        return {
          connectionId: conn.id,
          institutionName: info.institutionName,
          accounts: linkable(info, conn.id),
        };
      }
      const id = createConnection("teller", creds, info);
      log(user.id, "connection.create", id, {
        provider: "teller",
        institution: info.institutionName,
      });
      return {
        connectionId: id,
        institutionName: info.institutionName,
        accounts: linkable(info, id),
      };
    } catch (e) {
      asHttp(e);
    }
  });

  // --- Common ------------------------------------------------------------------

  /** Re-read the provider's accounts (to finish or change account mapping). */
  app.get("/api/connections/:id/accounts", async (req) => {
    const conn = getConn(parse(IdParams, req.params).id);
    try {
      const info = await providerFor(deps, conn.provider).getAccounts(openCreds(deps.config, conn));
      return {
        connectionId: conn.id,
        institutionName: info.institutionName,
        accounts: linkable(info, conn.id),
      };
    } catch (e) {
      asHttp(e);
    }
  });

  /**
   * Map provider accounts to Muny accounts ("new", "skip" or an existing
   * account id), then run the first sync. Existing accounts keep their
   * history; matching transactions are adopted rather than duplicated.
   */
  app.post("/api/connections/:id/link", async (req) => {
    const user = requireUser(req);
    const conn = getConn(parse(IdParams, req.params).id);
    const { accounts: map } = parse(LinkBody, req.body);
    let info: ConnectionInfo;
    try {
      info = await providerFor(deps, conn.provider).getAccounts(openCreds(deps.config, conn));
    } catch (e) {
      asHttp(e);
    }
    const a = schema.accounts;
    db.transaction((tx) => {
      const ignored: string[] = [];
      for (const pa of info.accounts) {
        const target = map[pa.ref] ?? "skip";
        const current = tx
          .select({ id: a.id })
          .from(a)
          .where(and(eq(a.connectionId, conn.id), eq(a.providerAccountRef, pa.ref)))
          .get();
        if (target === "skip") {
          ignored.push(pa.ref);
          // Stop syncing it but keep the account and its history.
          if (current)
            tx.update(a).set({ providerAccountRef: null }).where(eq(a.id, current.id)).run();
          continue;
        }
        if (target === "new") {
          if (current) continue;
          tx.insert(a)
            .values({
              id: newId(),
              connectionId: conn.id,
              providerAccountRef: pa.ref,
              name: pa.name.slice(0, 100),
              institutionName: info.institutionName,
              type: pa.type,
              mask: pa.mask,
              currency: pa.currency,
              balanceSource: "reported",
              currentBalanceCents: pa.balanceCents,
            })
            .run();
          continue;
        }
        const existing = tx.select().from(a).where(eq(a.id, target)).get();
        if (!existing) throw badRequest(`Unknown account for "${pa.name}"`);
        if (current && current.id !== target)
          tx.update(a).set({ providerAccountRef: null }).where(eq(a.id, current.id)).run();
        tx.update(a)
          .set({
            connectionId: conn.id,
            providerAccountRef: pa.ref,
            balanceSource: "reported",
            currentBalanceCents: pa.balanceCents ?? existing.currentBalanceCents,
            mask: existing.mask ?? pa.mask,
            institutionName: existing.institutionName ?? info.institutionName,
          })
          .where(eq(a.id, target))
          .run();
      }
      tx.update(schema.connections)
        .set({
          ignoredAccountRefs: ignored,
          status: conn.status === "pending_setup" ? "active" : conn.status,
        })
        .where(eq(schema.connections.id, conn.id))
        .run();
    });
    log(user.id, "connection.link", conn.id, { accounts: Object.keys(map).length });
    try {
      const summary = await syncConnection(db, deps, conn.id);
      log(user.id, "connection.sync", conn.id, summary);
      return { ok: true, summary };
    } catch (e) {
      // Linking succeeded; report the sync problem without failing the request.
      return { ok: true, summary: null, syncError: e instanceof Error ? e.message : "Sync failed" };
    }
  });

  app.post("/api/connections/:id/sync", async (req) => {
    const user = requireUser(req);
    const conn = getConn(parse(IdParams, req.params).id);
    if (conn.status === "pending_setup") throw badRequest("Choose which accounts to sync first.");
    try {
      const summary = await syncConnection(db, deps, conn.id);
      log(user.id, "connection.sync", conn.id, summary);
      return summary;
    } catch (e) {
      asHttp(e);
    }
  });

  /** After the user fixed the login in Plaid Link update mode. */
  app.post("/api/connections/:id/reauthed", async (req) => {
    const user = requireUser(req);
    const conn = getConn(parse(IdParams, req.params).id);
    db.update(c).set({ status: "active", lastError: null }).where(eq(c.id, conn.id)).run();
    log(user.id, "connection.reauth", conn.id);
    try {
      return await syncConnection(db, deps, conn.id);
    } catch (e) {
      asHttp(e);
    }
  });

  /**
   * Disconnect. Accounts and transactions stay; accounts switch to computed
   * balances anchored at their last reported balance.
   */
  app.delete("/api/connections/:id", async (req) => {
    const user = requireUser(req);
    const conn = getConn(parse(IdParams, req.params).id);
    try {
      await providerFor(deps, conn.provider).remove(openCreds(deps.config, conn));
    } catch {
      // Best effort: still forget it locally.
    }
    const a = schema.accounts;
    const t = schema.transactions;
    db.transaction((tx) => {
      for (const acc of tx.select().from(a).where(eq(a.connectionId, conn.id)).all()) {
        const sum = tx
          .select({ s: sql<number>`coalesce(sum(${t.amountCents}), 0)` })
          .from(t)
          .where(and(eq(t.accountId, acc.id), eq(t.pending, false)))
          .get();
        tx.update(a)
          .set({
            connectionId: null,
            providerAccountRef: null,
            balanceSource: "computed",
            openingBalanceCents:
              acc.balanceSource === "reported" && acc.currentBalanceCents !== null
                ? acc.currentBalanceCents - Number(sum?.s ?? 0)
                : acc.openingBalanceCents,
          })
          .where(eq(a.id, acc.id))
          .run();
      }
      // Pending transactions can't be confirmed any more.
      tx.delete(c).where(eq(c.id, conn.id)).run();
    });
    log(user.id, "connection.delete", conn.id, { provider: conn.provider });
    return { ok: true };
  });
}

const PLAID_LIMIT_KEY = "plaid.loginLimit";
const PLAID_CREATED_KEY = "plaid.loginsCreated";

function getSetting<T>(db: MunyDb, key: string): T | undefined {
  return db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get()?.value as T | undefined;
}

function setSetting(db: MunyDb, key: string, value: unknown) {
  db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

/** Logins created so far: the counter, but never fewer than the Plaid connections there are now. */
/** Plaid's Trial plan allows 20 logins; a paid plan can set its own limit. */
const DEFAULT_PLAID_LIMIT = 20;

function plaidLogins(db: MunyDb, env: string): { used: number; limit: number; custom: boolean } {
  const now = db
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(eq(schema.connections.provider, "plaid"))
    .all().length;
  const counted = env === "production" ? (getSetting<number>(db, PLAID_CREATED_KEY) ?? 0) : 0;
  return {
    used: Math.max(now, counted),
    limit: getSetting<number | null>(db, PLAID_LIMIT_KEY) ?? DEFAULT_PLAID_LIMIT,
    custom: (getSetting<number | null>(db, PLAID_LIMIT_KEY) ?? null) !== null,
  };
}

function countPlaidLogin(db: MunyDb) {
  const now = db
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(eq(schema.connections.provider, "plaid"))
    .all().length;
  const counted = getSetting<number>(db, PLAID_CREATED_KEY) ?? 0;
  // The first time, start from the logins that already exist.
  setSetting(db, PLAID_CREATED_KEY, Math.max(counted, now) + 1);
}
