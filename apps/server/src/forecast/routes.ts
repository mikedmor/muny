import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { parse } from "../lib/http.js";
import { balanceForecast } from "./service.js";

const Query = z.object({
  accountId: z.string().max(64).optional(),
  days: z.coerce.number().int().min(7).max(120).optional(),
});

export function registerForecastRoutes(app: FastifyInstance, db: MunyDb) {
  app.get("/api/forecast", async (req) => {
    requireUser(req);
    return balanceForecast(db, parse(Query, req.query));
  });
}
