import type { MunyDb } from "@muny/db";
import { ASSET_KINDS } from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { BudgetError, budgeted } from "../crypto/budget.js";
import { audit } from "../lib/audit.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import { createAsset, listAssets, updateAsset } from "./service.js";
import {
  dueForLookup,
  refreshAssetValue,
  setValuationKey,
  type ValuationDeps,
  ValuationError,
  valuationSettings,
} from "./valuation.js";
import { vehicleMakes, vehicleModels } from "./vehicles.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const cents = z.number().int().min(0).max(100_000_000_000);
const Fields = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  valueCents: cents.optional(),
  purchasePriceCents: cents.nullable().optional(),
  purchaseDate: isoDate.nullable().optional(),
  address: z.string().trim().max(200).nullable().optional(),
  owedCents: cents.nullable().optional(),
  vehicleYear: z.number().int().min(1900).max(2100).nullable().optional(),
  vehicleMake: z.string().trim().max(40).nullable().optional(),
  vehicleModel: z.string().trim().max(60).nullable().optional(),
  mileage: z.number().int().min(0).max(2_000_000).nullable().optional(),
  vin: z
    .string()
    .trim()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/i, "A VIN is 17 letters and numbers")
    .nullable()
    .optional(),
});

export function registerAssetRoutes(app: FastifyInstance, db: MunyDb, deps: ValuationDeps = {}) {
  const log = (userId: string, action: string, entityId?: string) =>
    audit(db, { actorType: "user", actorId: userId, action, entityType: "asset", entityId });

  app.get("/api/assets", async (req) => {
    requireUser(req);
    return listAssets(db);
  });

  // --- Vehicle make and model suggestions (NHTSA, only while filling in a vehicle) --

  app.get("/api/assets/vehicle-makes", async (req) => {
    requireUser(req);
    try {
      return await vehicleMakes(budgeted(db, "nhtsa", deps.fetch));
    } catch {
      return [];
    }
  });

  app.get("/api/assets/vehicle-models", async (req) => {
    requireUser(req);
    const q = parse(
      z.object({
        make: z.string().trim().min(1).max(40),
        year: z.coerce.number().int().min(1900).max(2100).optional(),
      }),
      req.query,
    );
    try {
      return await vehicleModels(q.make, q.year ?? null, budgeted(db, "nhtsa", deps.fetch));
    } catch {
      return [];
    }
  });

  // --- Automatic values (opt-in, your own keys) --------------------------------

  app.get("/api/assets/valuation", async (req) => {
    requireUser(req);
    return valuationSettings(db, deps.secretKey);
  });

  app.put("/api/assets/valuation/:service", async (req) => {
    const user = requireUser(req);
    const { service } = parse(z.object({ service: z.enum(["apillow", "carapi"]) }), req.params);
    const { key } = parse(
      z.object({ key: z.string().trim().min(8).max(200).nullable() }),
      req.body,
    );
    try {
      const out = setValuationKey(db, deps.secretKey, service, key);
      log(user.id, key ? "asset.valuation.key" : "asset.valuation.key.remove");
      return out;
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Couldn't save the key");
    }
  });

  /** Look an asset's value up now (homes: APillow; vehicles: CarAPI). */
  app.post("/api/assets/:id/lookup", async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    try {
      const r = await refreshAssetValue(db, deps, id);
      log(user.id, "asset.lookup", id);
      return r;
    } catch (e) {
      if (e instanceof ValuationError) throw new HttpError(e.status, e.message);
      if (e instanceof BudgetError) throw badRequest(e.message);
      throw e;
    }
  });

  /** Called when Assets is opened: refresh values over a month old, in the background. */
  app.post("/api/assets/refresh-due", async (req) => {
    requireUser(req);
    const due = dueForLookup(db, deps.secretKey);
    void (async () => {
      for (const id of due) {
        try {
          await refreshAssetValue(db, deps, id);
        } catch {
          // Try again another month; the lookup button shows the reason.
        }
      }
    })();
    return { started: due.length };
  });

  app.post("/api/assets", async (req) => {
    const user = requireUser(req);
    const body = parse(
      Fields.extend({ name: z.string().trim().min(1, "Name it").max(100), valueCents: cents }),
      req.body,
    );
    const id = db.transaction((tx) => createAsset(tx as unknown as MunyDb, body));
    log(user.id, "asset.create", id);
    return { accountId: id };
  });

  app.patch("/api/assets/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const body = parse(Fields, req.body);
    if (!db.transaction((tx) => updateAsset(tx as unknown as MunyDb, id, body)))
      throw notFound("Asset not found");
    log(user.id, "asset.update", id);
    return { ok: true };
  });
}
