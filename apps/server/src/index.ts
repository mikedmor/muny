import { openDb } from "@muny/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { startBackupScheduler } from "./data/backups.js";
import { seedDefaultCategories } from "./ledger/seed.js";
import { VERSION } from "./version.js";

async function main() {
  const config = loadConfig();
  const db = openDb({ filename: config.dbFile, migrationsFolder: config.migrationsDir });
  seedDefaultCategories(db);
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
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
