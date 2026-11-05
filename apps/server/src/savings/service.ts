import { findAlternatives } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import {
  type AlternativeSuggestion,
  type DiyProject,
  formatMoney,
  type InfraCost,
  type Saving,
  type SavingInput,
  type SavingsSummary,
} from "@muny/shared";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { localToday } from "../lib/dates.js";
import { listSeries, merchantKey } from "../recurring/service.js";

/**
 * Savings ledger: every saving action (cancel, downgrade, negotiate, replace)
 * with its monthly amount, verified against later bank data:
 * - cancelled/replaced: verified once an expected charge is clearly missed,
 *   failed if the charge shows up again;
 * - downgraded/negotiated: verified when a charge at (about) the new price
 *   arrives, failed if one at (about) the old price does.
 * DIY replacements record a "replaced" saving when the paid service is
 * cancelled; self-hosting costs are tracked separately so the net is honest.
 */

type Db = MunyDb;
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const INTERVAL_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 31,
  quarterly: 92,
  semiannual: 183,
  annual: 366,
};
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** Whole calendar months from `from` to `to`. */
export function wholeMonths(from: string, to: string): number {
  if (to <= from) return 0;
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let m = (ty - fy) * 12 + (tm - fm);
  if (td < fd) m--;
  return Math.max(0, m);
}

export function listSavings(db: Db, today = localToday()): Saving[] {
  return db
    .select()
    .from(schema.savings)
    .orderBy(desc(schema.savings.effectiveDate))
    .all()
    .map((r) => {
      const monthly = r.beforeMonthlyCents - r.afterMonthlyCents;
      return {
        id: r.id,
        kind: r.kind,
        name: r.name,
        seriesId: r.seriesId,
        beforeMonthlyCents: r.beforeMonthlyCents,
        afterMonthlyCents: r.afterMonthlyCents,
        monthlyCents: monthly,
        effectiveDate: r.effectiveDate,
        status: r.status,
        statusNote: r.statusNote,
        notes: r.notes,
        realizedCents:
          r.status === "verified" ? wholeMonths(r.effectiveDate, today) * Math.max(0, monthly) : 0,
      };
    });
}

function cancelSeries(db: Db, seriesId: string, date: string) {
  db.update(schema.recurringSeries)
    .set({ status: "cancelled", cancelledAt: date, userModified: true })
    .where(eq(schema.recurringSeries.id, seriesId))
    .run();
}

export function createSaving(db: Db, input: SavingInput, today = localToday()): string {
  const series = input.seriesId ? listSeries(db, today, input.seriesId)[0] : undefined;
  if (input.seriesId && !series) throw new Error("Recurring charge not found");
  const before = input.beforeMonthlyCents ?? (series ? Math.abs(series.monthlyCents) : 0);
  const after =
    input.afterMonthlyCents ??
    (input.kind === "cancelled" || input.kind === "replaced" ? 0 : before);
  const date = input.effectiveDate ?? today;
  const id = newId();
  db.insert(schema.savings)
    .values({
      id,
      kind: input.kind,
      name: (input.name?.trim() || series?.name || "Saving").slice(0, 100),
      seriesId: series?.id ?? null,
      beforeMonthlyCents: before,
      afterMonthlyCents: after,
      effectiveDate: date,
      notes: input.notes || null,
    })
    .run();
  if (
    series &&
    (input.kind === "cancelled" || input.kind === "replaced") &&
    input.cancelSeries !== false
  )
    cancelSeries(db, series.id, date);
  return id;
}

/**
 * Check savings against bank data. Returns how many changed status.
 * Projected savings are checked; cancellations Muny verified itself are
 * re-checked too, so a charge that comes back later still flips them to failed.
 * Charges are found by the series link or the same merchant (a downgrade's new
 * price is often too different to be linked to the old series).
 */
export function verifySavings(db: Db, today = localToday()): number {
  const t = schema.transactions;
  const series = new Map(listSeries(db, today).map((s) => [s.id, s]));
  const keys = new Map(
    db
      .select({ id: schema.recurringSeries.id, key: schema.recurringSeries.matchKey })
      .from(schema.recurringSeries)
      .all()
      .map((r) => [r.id, r.key]),
  );
  let changed = 0;
  for (const s of db.select().from(schema.savings).all()) {
    if (!s.seriesId) continue;
    const recheck =
      s.status === "verified" &&
      (s.kind === "cancelled" || s.kind === "replaced") &&
      s.statusNote?.startsWith("No charge since");
    if (s.status !== "projected" && !recheck) continue;
    const ser = series.get(s.seriesId);
    const key = keys.get(s.seriesId);
    const charges = db
      .select({
        date: t.postedDate,
        cents: t.amountCents,
        seriesId: t.recurringSeriesId,
        raw: t.rawDescription,
        payee: schema.payees.displayName,
      })
      .from(t)
      .leftJoin(schema.payees, eq(schema.payees.id, t.payeeId))
      .where(and(gt(t.postedDate, s.effectiveDate), eq(t.pending, false), lt(t.amountCents, 0)))
      .orderBy(asc(t.postedDate))
      .all()
      .filter((c) => c.seriesId === s.seriesId || (!!key && merchantKey(c.payee, c.raw) === key));
    const periodDays = INTERVAL_DAYS[ser?.interval ?? "monthly"] ?? 31;
    // Compare per charge: a yearly series' monthly figure is 1/12 of a charge.
    const perCharge = (monthly: number) =>
      ser
        ? Math.round(
            (monthly * Math.abs(ser.expectedAmountCents)) / Math.max(1, Math.abs(ser.monthlyCents)),
          )
        : monthly;
    let status: "verified" | "failed" | null = null;
    let note = "";
    const first = charges[0];
    if (s.kind === "cancelled" || s.kind === "replaced") {
      if (first) {
        status = "failed";
        note = `Charged ${formatMoney(-first.cents)} on ${shortDate(first.date)} after you cancelled`;
      } else if (
        s.status === "projected" &&
        dayNum(today) - dayNum(s.effectiveDate) > periodDays + 7
      ) {
        status = "verified";
        note = `No charge since ${shortDate(s.effectiveDate)}`;
      }
    } else if (first) {
      const paid = -first.cents;
      if (paid <= perCharge(s.afterMonthlyCents) * 1.1) {
        status = "verified";
        note = `Charged ${formatMoney(paid)} on ${shortDate(first.date)}, the new price`;
      } else if (paid >= perCharge(s.beforeMonthlyCents) * 0.95) {
        status = "failed";
        note = `Still charged ${formatMoney(paid)} on ${shortDate(first.date)}`;
      }
    }
    if (status && status !== s.status) {
      db.update(schema.savings)
        .set({ status, statusNote: note, verifiedAt: new Date() })
        .where(eq(schema.savings.id, s.id))
        .run();
      changed++;
    }
  }
  return changed;
}

// --- DIY ----------------------------------------------------------------------

export function listDiy(db: Db, today = localToday()): DiyProject[] {
  const series = new Map(listSeries(db, today).map((s) => [s.id, s]));
  return db
    .select()
    .from(schema.diyProjects)
    .orderBy(desc(schema.diyProjects.updatedAt))
    .all()
    .map((p) => ({
      id: p.id,
      serviceName: p.serviceName,
      seriesId: p.seriesId,
      serviceMonthlyCents: p.seriesId
        ? Math.abs(series.get(p.seriesId)?.monthlyCents ?? 0) || null
        : null,
      alternative: p.alternative,
      status: p.status,
      effort: p.effort,
      runningMonthlyCents: p.runningMonthlyCents,
      savingId: p.savingId,
      notes: p.notes,
    }));
}

/** Moving a project to "cancelled" records the saving (and cancels the series). */
export function onDiyStatus(db: Db, id: string, today = localToday()) {
  const p = db.select().from(schema.diyProjects).where(eq(schema.diyProjects.id, id)).get();
  if (!p || p.status !== "cancelled" || p.savingId) return;
  const savingId = createSaving(
    db,
    {
      kind: "replaced",
      name: `${p.serviceName} → ${p.alternative}`,
      seriesId: p.seriesId,
      // Gross saving; the alternative's running cost counts under self-hosting costs.
      afterMonthlyCents: 0,
      ...(p.seriesId ? {} : { beforeMonthlyCents: 0 }),
    },
    today,
  );
  db.update(schema.diyProjects).set({ savingId }).where(eq(schema.diyProjects.id, id)).run();
}

// --- Infrastructure -------------------------------------------------------------

export function infraMonthly(
  c: typeof schema.infraCosts.$inferSelect,
  today = localToday(),
): number {
  if (c.startDate > today || (c.endDate && c.endDate < today)) return 0;
  if (c.kind === "power" && c.watts && c.priceDeciCentsPerKwh) {
    // watts × 730 h/month = Wh; × price (0.1¢/kWh) / 1000 Wh/kWh / 10.
    return Math.round((c.watts * 730 * c.priceDeciCentsPerKwh) / 10_000);
  }
  const amount = c.amountCents ?? 0;
  switch (c.period) {
    case "monthly":
      return amount;
    case "annual":
      return Math.round(amount / 12);
    case "once": {
      const months = c.amortizeMonths ?? 36;
      return wholeMonths(c.startDate, today) < months ? Math.round(amount / months) : 0;
    }
    default:
      return 0;
  }
}

export function listInfra(db: Db, today = localToday()): InfraCost[] {
  return db
    .select()
    .from(schema.infraCosts)
    .orderBy(asc(schema.infraCosts.createdAt))
    .all()
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      amountCents: c.amountCents,
      period: c.period,
      amortizeMonths: c.amortizeMonths,
      watts: c.watts,
      priceDeciCentsPerKwh: c.priceDeciCentsPerKwh,
      startDate: c.startDate,
      endDate: c.endDate,
      notes: c.notes,
      monthlyCents: infraMonthly(c, today),
    }));
}

// --- Summary & suggestions --------------------------------------------------------

export function savingsSummary(db: Db, today = localToday()): SavingsSummary {
  const all = listSavings(db, today);
  const sum = (xs: Saving[]) => xs.reduce((s, x) => s + Math.max(0, x.monthlyCents), 0);
  const live = all.filter((s) => s.status !== "failed");
  const diy = sum(live.filter((s) => s.kind === "replaced"));
  const running = listDiy(db, today)
    .filter((p) => p.status === "migrated" || p.status === "cancelled")
    .reduce((s, p) => s + p.runningMonthlyCents, 0);
  const infra = listInfra(db, today).reduce((s, c) => s + c.monthlyCents, 0) + running;
  return {
    verifiedMonthlyCents: sum(all.filter((s) => s.status === "verified")),
    projectedMonthlyCents: sum(all.filter((s) => s.status === "projected")),
    realizedCents: all.reduce((s, x) => s + x.realizedCents, 0),
    diyMonthlyCents: diy,
    infraMonthlyCents: infra,
    diyNetMonthlyCents: diy - infra,
  };
}

export function alternativeSuggestions(db: Db, today = localToday()): AlternativeSuggestion[] {
  const projects = new Map(
    db
      .select({ id: schema.diyProjects.id, seriesId: schema.diyProjects.seriesId })
      .from(schema.diyProjects)
      .all()
      .filter((p) => p.seriesId)
      .map((p) => [p.seriesId as string, p.id]),
  );
  const out: AlternativeSuggestion[] = [];
  for (const s of listSeries(db, today)) {
    if (!s.active || s.status === "ignored" || s.status === "cancelled") continue;
    if (s.expectedAmountCents >= 0) continue;
    const [entry] = findAlternatives(s.name);
    if (!entry) continue;
    out.push({
      seriesId: s.id,
      seriesName: s.name,
      monthlyCents: Math.abs(s.monthlyCents),
      service: entry.service,
      category: entry.category,
      alternatives: entry.alternatives,
      tradeoff: entry.tradeoff ?? null,
      projectId: projects.get(s.id) ?? null,
    });
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents);
}
