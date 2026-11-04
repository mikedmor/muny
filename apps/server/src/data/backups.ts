import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MunyDb } from "@muny/db";
import type { BackupInfo } from "@muny/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { requireOwner } from "../auth/plugin.js";
import type { Config } from "../config.js";
import { audit } from "../lib/audit.js";
import { notFound, parse } from "../lib/http.js";

/**
 * SQLite backups using SQLite's online backup API (consistent while the app
 * is running). Files are `muny-YYYYMMDD-HHMMSS.db` in the backup folder,
 * which defaults to `<data>/backups`; the newest `keep` are retained.
 */

const NAME = /^muny-\d{8}-\d{6}\.db$/;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names.filter((n) => NAME.test(n))) {
    const s = await stat(join(dir, name));
    out.push({ name, sizeBytes: s.size, createdAt: Math.round(s.mtimeMs) });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

let running: Promise<BackupInfo> | null = null;

export async function createBackup(db: MunyDb, dir: string, keep: number): Promise<BackupInfo> {
  // One at a time; a second request just waits for the first.
  if (running) return running;
  running = (async () => {
    await mkdir(dir, { recursive: true });
    let name = `muny-${stamp()}.db`;
    if ((await listBackups(dir)).some((b) => b.name === name)) {
      await new Promise((r) => setTimeout(r, 1000));
      name = `muny-${stamp()}.db`;
    }
    const tmp = join(dir, `.${name}.partial`);
    await db.$client.backup(tmp);
    await chmod(tmp, 0o600).catch(() => {}); // not supported on every filesystem
    await rename(tmp, join(dir, name));
    for (const old of (await listBackups(dir)).slice(Math.max(1, keep))) {
      await rm(join(dir, old.name), { force: true });
    }
    const info = (await listBackups(dir)).find((b) => b.name === name);
    if (!info) throw new Error("Backup file missing after write");
    return info;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/** Back up on start if the newest backup is older than the interval, then check hourly. */
export function startBackupScheduler(db: MunyDb, config: Config, log: FastifyBaseLogger) {
  if (config.backupIntervalHours <= 0) {
    log.info("Automatic backups are disabled (MUNY_BACKUP_INTERVAL_HOURS=0)");
    return () => {};
  }
  const tick = async () => {
    try {
      const newest = (await listBackups(config.backupDir))[0];
      if (newest && Date.now() - newest.createdAt < config.backupIntervalHours * 3_600_000) return;
      const b = await createBackup(db, config.backupDir, config.backupKeep);
      log.info({ backup: b.name, sizeBytes: b.sizeBytes }, "Automatic backup written");
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Automatic backup failed",
      );
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function registerBackupRoutes(app: FastifyInstance, db: MunyDb, config: Config) {
  app.get("/api/backups", async (req) => {
    requireOwner(req);
    return {
      dir: config.backupDir,
      keep: config.backupKeep,
      intervalHours: config.backupIntervalHours,
      backups: await listBackups(config.backupDir),
    };
  });

  app.post("/api/backups", async (req, reply) => {
    const user = requireOwner(req);
    const b = await createBackup(db, config.backupDir, config.backupKeep);
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "backup.create",
      details: { name: b.name, sizeBytes: b.sizeBytes },
    });
    return reply.code(201).send(b);
  });

  app.get("/api/backups/:name", async (req, reply) => {
    const user = requireOwner(req);
    const { name } = parse(
      z.object({ name: z.string().regex(NAME, "Invalid backup name") }),
      req.params,
    );
    const b = (await listBackups(config.backupDir)).find((x) => x.name === name);
    if (!b) throw notFound("Backup not found");
    audit(db, {
      actorType: "user",
      actorId: user.id,
      action: "backup.download",
      details: { name },
    });
    return reply
      .header("content-type", "application/vnd.sqlite3")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("content-length", b.sizeBytes)
      .header("cache-control", "no-store")
      .send(createReadStream(join(config.backupDir, name)));
  });
}
