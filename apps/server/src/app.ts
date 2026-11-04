import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { appliedMigrationCount, type MunyDb, pingDb } from "@muny/db";
import type { HealthResponse, MetaResponse } from "@muny/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  config: Config;
  db: MunyDb;
}

/** Build the Fastify app without listening, so tests can use app.inject(). */
export async function buildApp({ config, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.env === "test"
        ? false
        : {
            level: config.logLevel,
            // Never log credentials or session tokens.
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'res.headers["set-cookie"]',
              ],
              censor: "[redacted]",
            },
          },
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // room for large CSV imports later
  });

  app.get("/api/health", async (_req, reply) => {
    const dbOk = pingDb(db);
    const body: HealthResponse = {
      status: dbOk ? "ok" : "degraded",
      version: VERSION,
      db: dbOk ? "ok" : "error",
      migrations: dbOk ? appliedMigrationCount(db) : 0,
    };
    return reply.code(dbOk ? 200 : 503).send(body);
  });

  app.get("/api/meta", async () => {
    const body: MetaResponse = {
      name: "Muny",
      version: VERSION,
      sourceUrl: config.sourceUrl,
      license: "AGPL-3.0-only",
    };
    return body;
  });

  const indexHtml = config.webDir ? join(config.webDir, "index.html") : undefined;
  const serveWeb = config.webDir !== undefined && indexHtml !== undefined && existsSync(indexHtml);
  if (serveWeb && config.webDir) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  }

  // Unknown /api routes get a JSON 404; everything else falls back to the SPA.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/api" || !serveWeb) {
      return reply.code(404).send({ error: "Not Found" });
    }
    return reply.type("text/html").sendFile("index.html");
  });

  return app;
}
