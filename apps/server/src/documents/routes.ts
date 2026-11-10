import { type MunyDb, schema } from "@muny/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/plugin.js";
import { audit } from "../lib/audit.js";
import { badRequest, HttpError, notFound, parse } from "../lib/http.js";
import {
  addFolder,
  cleanFolder,
  DOCUMENT_TYPES,
  deleteDocument,
  documentFolders,
  listDocuments,
  readDocument,
  removeFolder,
  saveDocument,
  updateDocument,
} from "./service.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const IdParams = z.object({ id: z.string().min(1).max(64) });

/** The loan a contract belongs to, and its folder (a slash would make it a subfolder). */
function contractFiling(db: MunyDb, accountId: string | null | undefined, folder?: string | null) {
  // Not tied to a loan: under Contracts, in the folder you're in if it's one of its own.
  if (!accountId)
    return {
      accountId: null,
      lender: null,
      folder: folder && /^Contracts( \/|$)/.test(folder) ? folder : "Contracts",
    };
  const loan = db
    .select({ name: schema.accounts.name, lender: schema.loanDetails.lender })
    .from(schema.loanDetails)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.loanDetails.accountId))
    .where(eq(schema.loanDetails.accountId, accountId))
    .get();
  if (!loan) throw badRequest("That loan wasn't found.");
  return {
    accountId,
    lender: loan.lender,
    folder: `Contracts / ${loan.name.replaceAll("/", "-")}`,
  };
}

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
        folder: z.string().trim().max(120).nullable().optional(),
        /** A contract, filed under the loan it's for. */
        kind: z.literal("contract").optional(),
        accountId: z.string().min(1).max(64).nullable().optional(),
      }),
      req.body,
    );
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (!looksLike(body.mime, bytes)) throw badRequest("That file isn't a PDF, PNG or JPEG.");
    const { accountId, ...details } = body;
    const doc = saveDocument(db, secret, {
      ...details,
      bytes,
      ...(body.kind === "contract" ? contractFiling(db, accountId, body.folder) : {}),
    });
    log(user.id, "document.upload", doc.id);
    return doc;
  });

  const FolderPath = z.object({
    path: z
      .string()
      .max(200)
      .transform(cleanFolder)
      .pipe(z.string().min(1, "Give the folder a name").max(120, "That folder name is too long")),
  });

  app.get("/api/documents/folders", async (req) => {
    requireUser(req);
    return { folders: documentFolders(db) };
  });

  app.post("/api/documents/folders", async (req) => {
    const user = requireUser(req);
    const { path } = parse(FolderPath, req.body);
    let folders: string[];
    try {
      folders = addFolder(db, path);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "Couldn't add that folder");
    }
    log(user.id, "document.folder.add");
    return { path, folders };
  });

  app.delete("/api/documents/folders", async (req) => {
    const user = requireUser(req);
    const { path } = parse(FolderPath, req.query);
    const folders = removeFolder(db, path);
    if (!folders) throw new HttpError(409, "Move or delete what's in this folder first.");
    log(user.id, "document.folder.remove");
    return { folders };
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
        folder: z.string().trim().max(120).nullable().optional(),
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
