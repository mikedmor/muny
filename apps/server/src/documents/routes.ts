import type { MunyDb } from "@muny/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound, parse } from "../lib/http.js";
import {
  DOCUMENT_TYPES,
  deleteDocument,
  listDocuments,
  readDocument,
  saveDocument,
  updateDocument,
} from "./service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const IdParams = z.object({ id: z.string().min(1).max(64) });

/** Does the file start like its type says? */
function looksLike(mime: string, b: Buffer) {
  if (mime === "application/pdf") return b.subarray(0, 4).toString("latin1") === "%PDF";
  if (mime === "image/png") return b[0] === 0x89 && b[1] === 0x50;
  if (mime === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8;
  return false;
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  db: MunyDb,
  secret: Buffer | undefined,
) {
  const log = (userId: string, action: string, entityId?: string) =>
    audit(db, { actorType: "user", actorId: userId, action, entityType: "document", entityId });

  app.get("/api/documents", async (req) => {
    requireUser(req);
    return listDocuments(db);
  });

  app.post("/api/documents", async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        mime: z.enum(Object.keys(DOCUMENT_TYPES) as [string, ...string[]]),
        dataBase64: z.string().min(10).max(14_000_000, "The file is too large (10 MB max)"),
        notes: z.string().trim().max(500).nullable().optional(),
        documentDate: isoDate.nullable().optional(),
      }),
      req.body,
    );
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (!looksLike(body.mime, bytes)) throw badRequest("That file isn't a PDF, PNG or JPEG.");
    const doc = saveDocument(db, secret, { ...body, bytes });
    log(user.id, "document.upload", doc.id);
    return doc;
  });

  /** The file itself: shown in the browser, or downloaded with ?download=1. */
  app.get("/api/documents/:id/file", async (req, reply) => {
    requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { download } = parse(z.object({ download: z.string().optional() }), req.query);
    const doc = readDocument(db, secret, id);
    if (!doc) throw notFound("Document not found");
    const ascii = doc.info.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
    reply
      .header("content-type", doc.info.mime)
      .header(
        "content-disposition",
        `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.info.name)}`,
      )
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff");
    return reply.send(doc.bytes);
  });

  app.patch("/api/documents/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        notes: z.string().trim().max(500).nullable().optional(),
        documentDate: isoDate.nullable().optional(),
      }),
      req.body,
    );
    if (!updateDocument(db, id, body)) throw notFound("Document not found");
    log(user.id, "document.update", id);
    return { ok: true };
  });

  app.delete("/api/documents/:id", async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    if (!deleteDocument(db, id)) throw notFound("Document not found");
    log(user.id, "document.delete", id);
    return { ok: true };
  });
}
