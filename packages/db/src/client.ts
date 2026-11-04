import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type MunyDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Location of the generated SQL migrations when running from source. */
export const defaultMigrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export interface OpenDbOptions {
  /** Path to the SQLite file, or ":memory:". */
  filename: string;
  /** Folder containing drizzle migrations. Defaults to this package's folder. */
  migrationsFolder?: string;
}

/** Open the database, apply pragmas and run pending migrations. */
export function openDb({ filename, migrationsFolder }: OpenDbOptions): MunyDb {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle({ client: sqlite, schema, casing: "snake_case" });
  migrate(db, { migrationsFolder: migrationsFolder ?? defaultMigrationsFolder });
  return db;
}

/** Number of migrations recorded as applied. */
export function appliedMigrationCount(db: MunyDb): number {
  const row = db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as {
    n: number;
  };
  return row.n;
}

/** Cheap liveness check used by the health endpoint. */
export function pingDb(db: MunyDb): boolean {
  try {
    db.$client.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}
