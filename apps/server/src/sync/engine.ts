import { cleanPayeeName } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import { computeHashes, findDuplicates } from "../import/service.js";
import { upsertPayee } from "../ledger/transactions.js";
import { linkTransfersFor } from "../ledger/transfers.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { localToday } from "../lib/dates.js";

export { localToday };

import { applyInvestmentSync, investSyncSince } from "../invest/service.js";
import { applyMerchantMemory } from "../ledger/memory.js";
import { applyLoanTerms, refreshManualLoans } from "../loans/service.js";
import { rescanRecurring } from "../recurring/service.js";
import { runRulesOn } from "../rules/service.js";
import { type PlaidCreds, PlaidProvider } from "./plaid.js";
import { type TellerCreds, TellerProvider } from "./teller.js";
import {
  type ConnectionInfo,
  type Provider,
  ProviderError,
  type ProviderTransaction,
  type SyncResult,
} from "./types.js";

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];
type Connection = typeof schema.connections.$inferSelect;

export interface Providers {
  plaid?: PlaidProvider;
  teller?: TellerProvider;
}

export function makeProviders(config: Config): Providers {
  return {
    ...(config.plaid && { plaid: new PlaidProvider(config.plaid) }),
    ...(config.teller && { teller: new TellerProvider(config.teller) }),
  };
}

export interface SyncDeps {
  config: Config;
  providers: Providers;
}

export type AnyCreds = PlaidCreds | TellerCreds;

export function providerFor(deps: SyncDeps, provider: string): Provider<AnyCreds> {
  if (provider === "plaid") {
    if (!deps.providers.plaid)
      throw new ProviderError(
        "config",
        "Plaid isn't configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env.",
      );
    return deps.providers.plaid as Provider<AnyCreds>;
  }
  if (provider === "teller") {
    if (!deps.providers.teller)
      throw new ProviderError(
        "config",
        "Teller isn't configured. Add TELLER_APPLICATION_ID to .env.",
      );
    return deps.providers.teller as Provider<AnyCreds>;
  }
  throw new ProviderError("config", `"${provider}" connections don't sync`);
}

function secret(config: Config): Buffer {
  if (!config.secretKey)
    throw new ProviderError(
      "config",
      "MUNY_SECRET_KEY isn't set, so bank credentials can't be stored or read.",
    );
  return config.secretKey;
}

export function sealCreds(config: Config, creds: AnyCreds): string {
  return encryptJson(secret(config), creds);
}

export function openCreds<T extends AnyCreds>(config: Config, conn: Connection): T {
  if (!conn.credentialsEnc)
    throw new ProviderError(
      "reauth_required",
      "This connection has no stored credentials. Reconnect it.",
    );
  try {
    return decryptJson<T>(secret(config), conn.credentialsEnc);
  } catch (e) {
    throw new ProviderError("config", e instanceof Error ? e.message : "Couldn't read credentials");
  }
}

export interface SyncSummary {
  added: number;
  updated: number;
  adopted: number;
  removed: number;
  accountsCreated: number;
  rulesApplied: number;
}

function resolveCategory(tx: Tx, cache: Map<string, string | null>, name: string | null) {
  if (!name) return null;
  const k = name.toLowerCase();
  if (!cache.has(k)) {
    const c = tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(sql`lower(${schema.categories.name}) = ${k}`)
      .get();
    cache.set(k, c?.id ?? null);
  }
  return cache.get(k) ?? null;
}

/** Write provider accounts + transactions into the ledger. Pure DB work; no network. */
export function applySync(
  tx: Tx,
  conn: Pick<Connection, "id" | "provider" | "institutionName" | "ignoredAccountRefs">,
  info: ConnectionInfo,
  result: SyncResult,
): SyncSummary {
  const summary: SyncSummary = {
    added: 0,
    updated: 0,
    adopted: 0,
    removed: 0,
    accountsCreated: 0,
    rulesApplied: 0,
  };
  const a = schema.accounts;
  const t = schema.transactions;
  const ignored = new Set(conn.ignoredAccountRefs ?? []);

  // 1. Accounts: link map, auto-create accounts that appeared since setup, balances.
  const linked = new Map(
    tx
      .select({ id: a.id, ref: a.providerAccountRef })
      .from(a)
      .where(and(eq(a.connectionId, conn.id), isNotNull(a.providerAccountRef)))
      .all()
      .map((r) => [r.ref as string, r.id]),
  );
  const today = localToday();
  for (const pa of info.accounts) {
    if (ignored.has(pa.ref)) continue;
    let accountId = linked.get(pa.ref);
    if (!accountId) {
      accountId = newId();
      tx.insert(a)
        .values({
          id: accountId,
          connectionId: conn.id,
          providerAccountRef: pa.ref,
          name: pa.name.slice(0, 100),
          institutionName: info.institutionName ?? conn.institutionName,
          type: pa.type,
          mask: pa.mask,
          currency: pa.currency,
          balanceSource: "reported",
          currentBalanceCents: pa.balanceCents,
        })
        .run();
      linked.set(pa.ref, accountId);
      summary.accountsCreated++;
    }
    if (pa.balanceCents !== null) {
      tx.update(a)
        .set({ balanceSource: "reported", currentBalanceCents: pa.balanceCents })
        .where(eq(a.id, accountId))
        .run();
      tx.insert(schema.balanceSnapshots)
        .values({ accountId, date: today, balanceCents: pa.balanceCents })
        .onConflictDoUpdate({
          target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
          set: { balanceCents: pa.balanceCents, estimated: false },
        })
        .run();
    }
  }
  const accountIds = [...linked.values()];
  if (accountIds.length === 0) return summary;

  // 2. Existing provider-linked transactions by ref.
  const byRef = new Map(
    tx
      .select({ id: t.id, ref: t.providerTxnRef })
      .from(t)
      .where(and(inArray(t.accountId, accountIds), isNotNull(t.providerTxnRef)))
      .all()
      .map((r) => [r.ref as string, r.id]),
  );

  const upserts = [...result.added, ...result.modified].filter((p) => linked.has(p.accountRef));
  const fresh: ProviderTransaction[] = [];
  for (const p of upserts) {
    const existing = byRef.get(p.ref) ?? (p.pendingRef ? byRef.get(p.pendingRef) : undefined);
    if (!existing) {
      fresh.push(p);
      continue;
    }
    // Provider facts change; the user's category, merchant, notes and tags stay.
    tx.update(t)
      .set({
        postedDate: p.postedDate,
        authorizedDate: p.authorizedDate,
        amountCents: p.amountCents,
        rawDescription: p.description,
        pending: p.pending,
        providerTxnRef: p.ref,
      })
      .where(eq(t.id, existing))
      .run();
    if (p.pendingRef) byRef.delete(p.pendingRef);
    byRef.set(p.ref, existing);
    summary.updated++;
  }

  // 3. New ones: adopt matching history from imports, otherwise insert.
  const dedupeInput = fresh.map((p) => ({
    accountKey: p.accountRef,
    postedDate: p.postedDate,
    authorizedDate: p.authorizedDate,
    amountCents: p.amountCents,
    rawDescription: p.description,
    providerTxnRef: null,
  }));
  const accountFor = (ref: string) => linked.get(ref);
  const hashes = computeHashes(dedupeInput, accountFor);
  const matches = findDuplicates(tx, dedupeInput, hashes, accountFor, { unreferencedOnly: true });
  const categoryCache = new Map<string, string | null>();
  const payeeCache = new Map<string, string>();
  const newIds: string[] = [];
  fresh.forEach((p, i) => {
    const accountId = linked.get(p.accountRef) as string;
    const match = matches[i];
    if (match) {
      tx.update(t).set({ providerTxnRef: p.ref, pending: p.pending }).where(eq(t.id, match)).run();
      byRef.set(p.ref, match);
      summary.adopted++;
      return;
    }
    const merchant = p.merchantName?.trim();
    // Keep provider names like "iHerb" as-is; ALL-CAPS ones get the usual cleanup.
    const payeeName =
      (merchant && (merchant !== merchant.toUpperCase() ? merchant : cleanPayeeName(merchant))) ||
      cleanPayeeName(p.description);
    let payeeId: string | null = null;
    if (payeeName) {
      const k = payeeName.toLowerCase();
      payeeId = payeeCache.get(k) ?? upsertPayee(tx, payeeName.slice(0, 100));
      payeeCache.set(k, payeeId);
    }
    const id = newId();
    const res = tx
      .insert(t)
      .values({
        id,
        accountId,
        postedDate: p.postedDate,
        authorizedDate: p.authorizedDate,
        amountCents: p.amountCents,
        currency: p.currency,
        rawDescription: p.description,
        payeeId,
        categoryId: resolveCategory(tx, categoryCache, p.categoryHint),
        pending: p.pending,
        providerTxnRef: p.ref,
        importHash: `${conn.provider}:${p.ref}`.slice(0, 300),
      })
      .onConflictDoNothing()
      .run();
    if (res.changes > 0) {
      newIds.push(id);
      byRef.set(p.ref, id);
      summary.added++;
    }
  });

  // 4. Removals: explicit ones, plus pending transactions that vanished from a re-read window.
  let removedRefs = result.removed;
  if (result.windowFrom) {
    const seen = new Set(upserts.map((p) => p.ref));
    const stale = tx
      .select({ ref: t.providerTxnRef })
      .from(t)
      .where(
        and(
          inArray(t.accountId, accountIds),
          eq(t.pending, true),
          gte(t.postedDate, result.windowFrom),
          isNotNull(t.providerTxnRef),
        ),
      )
      .all()
      .map((r) => r.ref as string)
      .filter((ref) => !seen.has(ref));
    removedRefs = [...removedRefs, ...stale];
  }
  for (let i = 0; i < removedRefs.length; i += 500) {
    summary.removed += tx
      .delete(t)
      .where(
        and(
          inArray(t.accountId, accountIds),
          inArray(t.providerTxnRef, removedRefs.slice(i, i + 500)),
        ),
      )
      .run().changes;
  }

  summary.rulesApplied = runRulesOn(tx, newIds);
  linkTransfersFor(tx, newIds);
  summary.rulesApplied += applyMerchantMemory(tx, newIds);
  if (newIds.length || summary.removed) rescanRecurring(tx);
  return summary;
}

const inFlight = new Set<string>();

/** Fetch from the provider and apply. Records status/errors on the connection. */
export async function syncConnection(
  db: MunyDb,
  deps: SyncDeps,
  connectionId: string,
): Promise<SyncSummary> {
  const conn = db
    .select()
    .from(schema.connections)
    .where(eq(schema.connections.id, connectionId))
    .get();
  if (!conn) throw new ProviderError("config", "Connection not found");
  if (inFlight.has(connectionId))
    throw new ProviderError("rate_limited", "A sync for this connection is already running");
  inFlight.add(connectionId);
  const setStatus = (patch: Partial<typeof schema.connections.$inferInsert>) =>
    db.update(schema.connections).set(patch).where(eq(schema.connections.id, connectionId)).run();
  try {
    const provider = providerFor(deps, conn.provider);
    const creds = openCreds<AnyCreds>(deps.config, conn);
    const info = await provider.getAccounts(creds);
    let result: SyncResult;
    try {
      result = await provider.syncTransactions(creds, conn.syncCursor);
    } catch (e) {
      // Plaid needs a little while after linking before transactions are ready.
      if (e instanceof ProviderError && e.code === "not_ready") {
        result = { added: [], modified: [], removed: [], cursor: conn.syncCursor };
      } else throw e;
    }
    const summary = db.transaction((tx) => applySync(tx, conn, info, result));
    // Loan terms from the lender, when the login has any loans.
    if (provider.liabilities && info.accounts.some((a) => a.type === "loan")) {
      const terms = await provider.liabilities(creds);
      if (terms?.length) applyLoanTerms(db, connectionId, terms);
    }
    // Manual loans paid from this account: their balances follow the new payments.
    refreshManualLoans(db);
    // Brokerage logins: holdings and investment history (after accounts exist).
    if (provider.syncInvestments) {
      try {
        const inv = await provider.syncInvestments(creds, investSyncSince(db, connectionId));
        if (inv) db.transaction((tx) => applyInvestmentSync(tx, connectionId, info, inv));
      } catch (e) {
        if (!(e instanceof ProviderError && e.code === "not_ready")) throw e;
      }
    }
    setStatus({
      status: "active",
      lastError: null,
      lastSyncAt: new Date(),
      syncCursor: result.cursor,
      institutionName: conn.institutionName ?? info.institutionName,
    });
    return summary;
  } catch (e) {
    const pe =
      e instanceof ProviderError
        ? e
        : new ProviderError("provider_error", "Sync failed unexpectedly. Check the server log.");
    setStatus({
      status: pe.code === "reauth_required" ? "reauth_required" : "error",
      lastError: pe.message.slice(0, 500),
    });
    throw pe;
  } finally {
    inFlight.delete(connectionId);
  }
}

/** Sync every active connection that's due. Errors are recorded per connection. */
export async function syncDue(
  db: MunyDb,
  deps: SyncDeps,
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
) {
  const dueBefore = Date.now() - deps.config.syncIntervalHours * 3_600_000 + 60_000;
  const conns = db
    .select()
    .from(schema.connections)
    .where(inArray(schema.connections.status, ["active", "error"]))
    .all()
    .filter(
      (c) =>
        (c.provider === "plaid" || c.provider === "teller") &&
        (!c.lastSyncAt || c.lastSyncAt.getTime() < dueBefore),
    );
  for (const c of conns) {
    try {
      const s = await syncConnection(db, deps, c.id);
      log?.info({ connection: c.id, provider: c.provider, ...s }, "Bank sync finished");
    } catch (e) {
      log?.warn(
        {
          connection: c.id,
          provider: c.provider,
          error: e instanceof Error ? e.message : String(e),
        },
        "Bank sync failed",
      );
    }
  }
}

export function startSyncScheduler(
  db: MunyDb,
  deps: SyncDeps,
  log: Parameters<typeof syncDue>[2] & object,
) {
  if (deps.config.syncIntervalHours <= 0) return () => {};
  const tick = () => void syncDue(db, deps, log);
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, 15 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

declare module "fastify" {
  interface FastifyInstance {
    syncDeps: SyncDeps;
  }
}
