import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, parse } from "../lib/http.js";
import { describeChange } from "../undo/track.js";
import {
  deletePayDocument,
  detectPayDocument,
  PayError,
  payYear,
  readPayFile,
  uploadPayDocument,
} from "./service.js";

const Year = z.object({ year: z.coerce.number().int().min(1990).max(2200) });
const Doc = z.object({ kind: z.enum(["stubs", "w2"]), id: z.string().min(1).max(64) });
const Upload = z.object({
  filename: z.string().min(1).max(200),
  base64: z.string().min(1).max(15_000_000),
});

export function registerPayRoutes(app: FastifyInstance, db: MunyDb, secret: Buffer | undefined) {
  app.get("/api/pay/:year", async (req) => {
    requireUser(req);
    return payYear(db, parse(Year, req.params).year);
  });

  /** Is this PDF a pay stub or W-2? Nothing is kept. */
  app.post("/api/pay/detect", async (req) => {
    requireUser(req);
    const { base64 } = parse(Upload.pick({ base64: true }), req.body);
    return { kind: await detectPayDocument(base64) };
  });

  app.post("/api/pay/documents", async (req) => {
    const user = requireUser(req);
    const body = parse(Upload, req.body);
    try {
      const added = await uploadPayDocument(db, secret, body);
      describeChange(
        db,
        added.length === 1 ? `Added ${added[0]?.label}` : `Added ${added.length} pay stubs`,
      );
      for (const a of added)
        audit(db, {
          actorType: "user",
          actorId: user.id,
          action: a.kind === "stub" ? "pay.stub_upload" : "pay.w2_upload",
          entityType: "document",
          entityId: a.id,
        });
      return added;
    } catch (e) {
      if (e instanceof PayError) throw badRequest(e.message);
      throw e;
    }
  });

  app.get("/api/pay/:kind/:id/file", async (req, reply) => {
    const user = requireUser(req);
    const { kind, id } = parse(Doc, req.params);
    const download = (req.query as { download?: string }).download === "1";
    let file: ReturnType<typeof readPayFile>;
    try {
      file = readPayFile(db, secret, kind === "stubs" ? "stub" : "w2", id);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Couldn't open the file");
    }
    if (!file) throw badRequest("That document is gone");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: kind === "stubs" ? "pay.stub_view" : "pay.w2_view",
      entityType: "document",
      entityId: id,
    });
    return reply
      .header("content-type", "application/pdf")
      .header(
        "content-disposition",
        `${download ? "attachment" : "inline"}; filename="${file.filename.replace(/"/g, "")}"`,
      )
      .header("x-content-type-options", "nosniff")
      .send(file.body);
  });

  app.delete("/api/pay/:kind/:id", async (req) => {
    const user = requireUser(req);
    const { kind, id } = parse(Doc, req.params);
    if (!deletePayDocument(db, kind === "stubs" ? "stub" : "w2", id))
      throw badRequest("That document is gone");
    describeChange(db, kind === "stubs" ? "Deleted a pay stub" : "Deleted a W-2");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: kind === "stubs" ? "pay.stub_delete" : "pay.w2_delete",
      entityType: "document",
      entityId: id,
    });
    return { ok: true };
  });
}
