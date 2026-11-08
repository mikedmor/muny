import { openDb } from "@muny/db";
import { startAiScheduler } from "./ai/features.js";
import { ensureAlertRules, startAlertScheduler } from "./alerts/service.js";
import { buildApp } from "./app.js";
import { anchorAllCards } from "./cards/service.js";
import { loadConfig } from "./config.js";
import { startBackupScheduler } from "./data/backups.js";
import { maybeSeedDemo } from "./demo/seed.js";
import { repairRawAchPayees, repairStubPayees } from "./ledger/payees.js";
import { seedDefaultCategories } from "./ledger/seed.js";
import { pairLoanPayments, pairPayPalFunding } from "./ledger/transfers.js";
import { refreshManualLoans } from "./loans/service.js";
import { rescanRecurring } from "./recurring/service.js";
import { markCategoryMoves } from "./savings/buckets.js";
import { linkStatementDocuments } from "./statements/status.js";
import { startSyncScheduler } from "./sync/engine.js";
import { VERSION } from "./version.js";

async function main() {
  const config = loadConfig();
  const db = openDb({ filename: config.dbFile, migrationsFolder: config.migrationsDir });
  seedDefaultCategories(db);
  ensureAlertRules(db);
  maybeSeedDemo(db, config.demo);
  repairRawAchPayees(db);
  repairStubPayees(db);
  // Cheap (well under a second for years of history); picks up detection improvements after upgrades.
  db.transaction((tx) => {
    pairLoanPayments(tx);
    pairPayPalFunding(tx);
    markCategoryMoves(tx as unknown as typeof db);
    anchorAllCards(tx as unknown as typeof db);
    linkStatementDocuments(tx as unknown as typeof db);
    rescanRecurring(tx);
    refreshManualLoans(tx as unknown as typeof db);
  });
  const app = await buildApp({ config, db });

  app.log.info({ version: VERSION, dataDir: config.dataDir }, "Muny starting");
  if (!config.secretKey) {
    app.log.warn("MUNY_SECRET_KEY is not set. Bank sync will be unavailable until it is.");
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    try {
      await app.close();
    } finally {
      db.$client.close();
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  startBackupScheduler(db, config, app.log);
  startSyncScheduler(db, app.syncDeps, app.log);
  startAlertScheduler(db, app.alertDeps, app.log);
  startAiScheduler(db, { secretKey: config.secretKey }, app.log);
  if (config.plaid) app.log.info({ env: config.plaid.env }, "Plaid sync enabled");
  if (config.teller) app.log.info({ env: config.teller.env }, "Teller sync enabled");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
