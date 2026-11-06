import { type MunyDb, newId, schema } from "@muny/db";
import type { Asset, AssetInput, AssetKind } from "@muny/shared";
import { eq, inArray } from "drizzle-orm";
import { listAccounts } from "../ledger/accounts.js";
import { localToday } from "../lib/dates.js";

/**
 * Assets (D-042): things you own that aren't accounts, such as a home or a
 * car. Each is an account of type "asset" whose value you update (each update
 * is a balance snapshot, so it's in net worth and its history), plus its
 * details. Loans can say which asset they pay for, to show equity.
 */

export function listAssets(db: MunyDb): Asset[] {
  const accounts = listAccounts(db);
  const assets = accounts.filter((a) => a.type === "asset" && !a.hidden);
  const ids = assets.map((a) => a.id);
  if (!ids.length) return [];
  const details = new Map(
    db
      .select()
      .from(schema.assetDetails)
      .where(inArray(schema.assetDetails.accountId, ids))
      .all()
      .map((d) => [d.accountId, d]),
  );
  const snaps = db
    .select()
    .from(schema.balanceSnapshots)
    .where(inArray(schema.balanceSnapshots.accountId, ids))
    .orderBy(schema.balanceSnapshots.date)
    .all();
  const loans = db
    .select({
      accountId: schema.loanDetails.accountId,
      property: schema.loanDetails.propertyAccountId,
    })
    .from(schema.loanDetails)
    .where(inArray(schema.loanDetails.propertyAccountId, ids))
    .all();
  return assets.map((a) => {
    const d = details.get(a.id);
    const mine = loans
      .filter((l) => l.property === a.id)
      .map((l) => {
        const acc = accounts.find((x) => x.id === l.accountId);
        return {
          accountId: l.accountId,
          name: acc?.name ?? "",
          balanceCents: Math.abs(acc?.balanceCents ?? 0),
        };
      });
    return {
      accountId: a.id,
      name: a.name,
      kind: (d?.kind ?? "other") as AssetKind,
      valueCents: a.balanceCents,
      purchasePriceCents: d?.purchasePriceCents ?? null,
      purchaseDate: d?.purchaseDate ?? null,
      address: d?.address ?? null,
      history: snaps
        .filter((s) => s.accountId === a.id)
        .map((s) => ({ date: s.date, valueCents: s.balanceCents })),
      loans: mine,
      owedCents: d?.owedCents ?? null,
      // Linked loans say what's owed; otherwise what you entered (e.g. $0, paid off).
      equityCents:
        a.balanceCents -
        (mine.length ? mine.reduce((s, l) => s + l.balanceCents, 0) : (d?.owedCents ?? 0)),
    };
  });
}

/** Record a value for today (the account's balance and a snapshot). */
function setValue(db: MunyDb, accountId: string, valueCents: number, today: string) {
  db.update(schema.accounts)
    .set({ currentBalanceCents: valueCents, balanceSource: "reported" })
    .where(eq(schema.accounts.id, accountId))
    .run();
  db.insert(schema.balanceSnapshots)
    .values({ accountId, date: today, balanceCents: valueCents })
    .onConflictDoUpdate({
      target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date],
      set: { balanceCents: valueCents, estimated: false },
    })
    .run();
}

export function createAsset(
  db: MunyDb,
  input: AssetInput & { name: string; valueCents: number },
  today = localToday(),
): string {
  const id = newId();
  db.insert(schema.accounts)
    .values({ id, name: input.name.trim().slice(0, 100), type: "asset", balanceSource: "reported" })
    .run();
  db.insert(schema.assetDetails)
    .values({
      accountId: id,
      kind: input.kind ?? "other",
      purchasePriceCents: input.purchasePriceCents ?? null,
      purchaseDate: input.purchaseDate ?? null,
      address: input.address ?? null,
    })
    .run();
  // The purchase is the first point in its history.
  if (input.purchasePriceCents && input.purchaseDate && input.purchaseDate < today)
    db.insert(schema.balanceSnapshots)
      .values({ accountId: id, date: input.purchaseDate, balanceCents: input.purchasePriceCents })
      .onConflictDoNothing()
      .run();
  setValue(db, id, input.valueCents, today);
  return id;
}

export function updateAsset(
  db: MunyDb,
  accountId: string,
  input: AssetInput,
  today = localToday(),
) {
  const acc = db
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (acc?.type !== "asset") return false;
  if (input.name)
    db.update(schema.accounts)
      .set({ name: input.name.trim().slice(0, 100) })
      .where(eq(schema.accounts.id, accountId))
      .run();
  const patch = Object.fromEntries(
    Object.entries({
      kind: input.kind,
      purchasePriceCents: input.purchasePriceCents,
      purchaseDate: input.purchaseDate,
      address: input.address,
      owedCents: input.owedCents,
    }).filter(([, v]) => v !== undefined),
  );
  db.insert(schema.assetDetails)
    .values({ accountId, ...patch })
    .onConflictDoUpdate({
      target: schema.assetDetails.accountId,
      set: { ...patch, updatedAt: new Date() },
    })
    .run();
  if (input.valueCents !== undefined) setValue(db, accountId, input.valueCents, today);
  return true;
}
