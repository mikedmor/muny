import { resolve } from "node:path";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  MUNY_HOST: z.string().default("0.0.0.0"),
  MUNY_PORT: z.coerce.number().int().min(1).max(65535).default(8420),
  MUNY_DATA_DIR: z.string().default("./data-local"),
  MUNY_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Base64 key (>= 32 bytes) for encrypting provider credentials. Required once bank sync exists. */
  MUNY_SECRET_KEY: optionalString.refine(
    (v) => v === undefined || Buffer.from(v, "base64").length >= 32,
    "MUNY_SECRET_KEY must be base64 encoding at least 32 bytes",
  ),
  /** Built web UI to serve. Unset in dev (Vite serves the UI). */
  MUNY_WEB_DIR: optionalString,
  /** Drizzle migrations folder. Unset in dev (uses packages/db/migrations). */
  MUNY_MIGRATIONS_DIR: optionalString,
  /** Source code link shown in the UI (AGPL-3.0 §13). */
  MUNY_SOURCE_URL: z.string().url().default("https://github.com/mikedmor/muny"),
  /** Where automatic SQLite backups go. Defaults to <data dir>/backups. */
  MUNY_BACKUP_DIR: optionalString,
  /** How many backups to keep. */
  MUNY_BACKUP_KEEP: z.coerce.number().int().min(1).max(1000).default(14),
  /** Hours between automatic backups; 0 turns them off. */
  MUNY_BACKUP_INTERVAL_HOURS: z.coerce
    .number()
    .min(0)
    .max(24 * 365)
    .default(24),
});

export interface Config {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  logLevel: string;
  secretKey: Buffer | undefined;
  webDir: string | undefined;
  migrationsDir: string | undefined;
  sourceUrl: string;
  backupDir: string;
  backupKeep: number;
  backupIntervalHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.MUNY_DATA_DIR);
  return {
    env: e.NODE_ENV,
    host: e.MUNY_HOST,
    port: e.MUNY_PORT,
    dataDir,
    dbFile: resolve(dataDir, "muny.db"),
    logLevel: e.MUNY_LOG_LEVEL,
    secretKey: e.MUNY_SECRET_KEY ? Buffer.from(e.MUNY_SECRET_KEY, "base64") : undefined,
    webDir: e.MUNY_WEB_DIR ? resolve(e.MUNY_WEB_DIR) : undefined,
    migrationsDir: e.MUNY_MIGRATIONS_DIR ? resolve(e.MUNY_MIGRATIONS_DIR) : undefined,
    sourceUrl: e.MUNY_SOURCE_URL,
    backupDir: e.MUNY_BACKUP_DIR ? resolve(e.MUNY_BACKUP_DIR) : resolve(dataDir, "backups"),
    backupKeep: e.MUNY_BACKUP_KEEP,
    backupIntervalHours: e.MUNY_BACKUP_INTERVAL_HOURS,
  };
}
