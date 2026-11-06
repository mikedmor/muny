import type { MunyDb } from "@muny/db";
import { ASSET_KINDS } from "@muny/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";
import { createAsset, listAssets, updateAsset } from "./service.js";

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
});

export function registerAssetRoutes(app: FastifyInstance, db: MunyDb) {
  const log = (userId: string, action: string, entityId?: string) =>
    audit(db, { actorType: "user", actorId: userId, action, entityType: "asset", entityId });

  app.get("/api/assets", async (req) => {
    requireUser(req);
    return listAssets(db);
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
