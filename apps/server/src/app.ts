import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { appliedMigrationCount, type MunyDb, pingDb } from "@muny/db";
import type { HealthResponse, MetaResponse } from "@muny/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth/plugin.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import { registerImportRoutes } from "./import/routes.js";
import { registerAccountRoutes } from "./ledger/accounts.js";
import { registerCategoryRoutes } from "./ledger/categories.js";
import { registerTransactionRoutes } from "./ledger/transactions.js";
import { registerErrorHandler } from "./lib/http.js";
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

  registerErrorHandler(app);
  await app.register(fastifyCookie);

  // Baseline security headers for every response.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  registerAuth(app, db);
  registerAuthRoutes(app, db);
  registerAccountRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerTransactionRoutes(app, db);
  registerImportRoutes(app, db);

  // Polled by the Docker healthcheck every 30s; only log problems.
  app.get("/api/health", { logLevel: "warn" }, async (_req, reply) => {
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
