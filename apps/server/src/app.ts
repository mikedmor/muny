import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { appliedMigrationCount, type MunyDb, pingDb } from "@muny/db";
import type { HealthResponse, MetaResponse } from "@muny/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAlertRoutes } from "./alerts/routes.js";
import type { AlertDeps } from "./alerts/service.js";
import { registerAssetRoutes } from "./assets/routes.js";
import { registerHouseholdRoutes } from "./auth/household.js";
import { registerAuth } from "./auth/plugin.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerBudgetRoutes } from "./budgets/routes.js";
import type { Config } from "./config.js";
import { registerCryptoRoutes } from "./crypto/routes.js";
import { registerBackupRoutes } from "./data/backups.js";
import { registerExportRoutes } from "./data/export.js";
import { registerImportRoutes } from "./import/routes.js";
import { registerInvestRoutes } from "./invest/routes.js";
import { registerAccountRoutes } from "./ledger/accounts.js";
import { registerCategoryRoutes } from "./ledger/categories.js";
import { registerPayeeRoutes } from "./ledger/payees.js";
import { registerTransactionRoutes } from "./ledger/transactions.js";
import { registerErrorHandler } from "./lib/http.js";
import { registerLoanRoutes } from "./loans/routes.js";
import { registerRecurringRoutes } from "./recurring/routes.js";
import { registerReportRoutes } from "./reports/routes.js";
import { registerRuleRoutes } from "./rules/routes.js";
import { registerSavingsRoutes } from "./savings/routes.js";
import { registerPrefsRoutes } from "./settings/prefs.js";
import { makeProviders, type Providers } from "./sync/engine.js";
import { registerSyncRoutes } from "./sync/routes.js";
import { registerTrialRoutes } from "./trials/routes.js";
import { VERSION } from "./version.js";

export interface AppDeps {
  config: Config;
  db: MunyDb;
  /** Bank sync providers; defaults to the ones configured in env. Tests inject fakes. */
  providers?: Providers;
  /** Override outbound HTTP for notification channels (tests). */
  alertFetch?: typeof fetch;
  /** Override outbound HTTP for crypto prices (tests). */
  priceFetch?: typeof fetch;
}

/**
 * Content-Security-Policy. Bank widgets (Plaid Link, Teller Connect) load
 * scripts/frames from their own domains, so those are allowed only when that
 * provider is configured.
 */
export function contentSecurityPolicy(config: Config): string {
  const script = ["'self'"];
  const frame = ["'none'"];
  const connect = ["'self'"];
  if (config.plaid) {
    script.push("https://cdn.plaid.com");
    frame.push("https://cdn.plaid.com", "https://*.plaid.com");
    connect.push("https://*.plaid.com");
  }
  if (config.teller) {
    script.push("https://cdn.teller.io");
    frame.push("https://teller.io", "https://*.teller.io");
    connect.push("https://*.teller.io");
  }
  const frameSrc = frame.length > 1 ? frame.filter((f) => f !== "'none'") : frame;
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    `frame-src ${frameSrc.join(" ")}`,
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/** Build the Fastify app without listening, so tests can use app.inject(). */
export async function buildApp({
  config,
  db,
  providers,
  alertFetch,
  priceFetch,
}: AppDeps): Promise<FastifyInstance> {
  const syncDeps = { config, providers: providers ?? makeProviders(config) };
  const csp = contentSecurityPolicy(config);
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
    // Routes serving files (images) set a stricter, sandboxed policy of their own.
    if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", csp);
  });

  registerAuth(app, db);
  registerAuthRoutes(app, db);
  registerHouseholdRoutes(app, db);
  registerAccountRoutes(app, db);
  registerCategoryRoutes(app, db);
  registerTransactionRoutes(app, db);
  registerImportRoutes(app, db);
  registerPrefsRoutes(app, db);
  registerInvestRoutes(app, db, { fetch: priceFetch });
  registerLoanRoutes(app, db);
  registerAssetRoutes(app, db, {
    fetch: priceFetch,
    secretKey: config.secretKey,
    pollMs: priceFetch ? 0 : undefined,
  });
  registerPayeeRoutes(app, db);
  registerRuleRoutes(app, db);
  registerExportRoutes(app, db);
  registerBackupRoutes(app, db, config);
  registerSyncRoutes(app, db, syncDeps);
  registerRecurringRoutes(app, db);
  registerBudgetRoutes(app, db);
  registerReportRoutes(app, db);
  registerTrialRoutes(app, db);
  registerSavingsRoutes(app, db);
  const alertDeps: AlertDeps = {
    secretKey: config.secretKey,
    publicUrl: config.publicUrl,
    fetch: alertFetch,
  };
  registerAlertRoutes(app, db, alertDeps);
  registerCryptoRoutes(app, db, {
    secretKey: config.secretKey,
    fetch: priceFetch,
    delayMs: priceFetch ? 0 : undefined,
  });
  app.decorate("syncDeps", syncDeps);
  app.decorate("alertDeps", alertDeps);

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
