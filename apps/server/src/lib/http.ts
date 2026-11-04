import type { FastifyInstance } from "fastify";
import { ZodError, type z } from "zod";

/** Error with an HTTP status that the error handler turns into a JSON response. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = "Not signed in") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const notFound = (msg = "Not Found") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

/** Validate input with zod, throwing a 400 with field errors on failure. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    req.log.error({ err }, "Unhandled error");
    return reply.code(500).send({ error: "Internal Server Error" });
  });
}
