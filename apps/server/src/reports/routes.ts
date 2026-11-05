import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { localToday } from "../lib/dates.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import { categoryActivity } from "./category.js";
import {
  monthlyReport,
  netWorthDates,
  netWorthReport,
  overview,
  spendingReport,
} from "./service.js";
import { addMonths } from "./spending.js";
import { spendingOverview } from "./spending-page.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

export function registerReportRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/overview", async () => overview(db));

  /** Spending page: category breakdown, monthly chart, summary, largest purchases. */
  app.get("/api/spending", async (req) => {
    const q = parse(
      z.object({
        month: month.optional(),
        includeBills: z.enum(["true", "false"]).default("true"),
      }),
      req.query,
    );
    return spendingOverview(db, q.month ?? localToday().slice(0, 7), q.includeBills === "true");
  });

  /** One category's monthly totals, budget and stats (category detail page). */
  app.get("/api/categories/:id/activity", async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const thisMonth = localToday().slice(0, 7);
    const q = parse(z.object({ month: month.optional(), end: month.optional() }), req.query);
    const selected = q.month ?? thisMonth;
    const end = q.end ?? (selected > thisMonth ? selected : thisMonth);
    const a = categoryActivity(db, id, selected, end);
    if (!a) throw notFound("Category not found");
    return a;
  });

  app.get("/api/reports/spending", async (req) => {
    const q = parse(
      z.object({
        from: isoDate,
        to: isoDate,
        by: z.enum(["category", "group", "merchant"]).default("category"),
        categoryId: z.string().max(64).optional(),
      }),
      req.query,
    );
    if (q.to < q.from) throw badRequest("The end date is before the start date");
    return spendingReport(db, q.from, q.to, q.by, q.categoryId);
  });

  app.get("/api/reports/monthly", async (req) => {
    const thisMonth = localToday().slice(0, 7);
    const q = parse(z.object({ from: month.optional(), to: month.optional() }), req.query);
    const to = q.to ?? thisMonth;
    const from = q.from ?? addMonths(to, -11);
    if (from > to || from < addMonths(to, -120)) throw badRequest("Choose up to 10 years");
    return monthlyReport(db, from, to);
  });

  app.get("/api/reports/net-worth", async (req) => {
    const q = parse(
      z.object({ months: z.coerce.number().int().min(1).max(240).default(24) }),
      req.query,
    );
    return netWorthReport(db, netWorthDates(q.months));
  });
}
