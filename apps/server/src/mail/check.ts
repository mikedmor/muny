import type { MunyDb } from "@muny/db";
import type { MailCheckResult } from "@muny/shared";
import { transactionsAdded } from "../lib/events.js";
import { describeChange, openChange, runAsChange } from "../undo/track.js";
import { imapSource, type MailSource, mailProblem } from "./imap.js";
import { forgetOldMail, handleMail } from "./process.js";
import {
  type MailConnection,
  mailConnection,
  mailRules,
  mailState,
  saveMailState,
} from "./settings.js";

/**
 * Checking the mailbox: on its schedule while it's turned on, and when you
 * press Check now. One check at a time. What a check adds is one change in
 * Settings → History, so it can be undone together.
 */

export interface MailDeps {
  secretKey: Buffer | undefined;
  /** For tests: where emails come from instead of an IMAP server. */
  source?: (c: MailConnection) => MailSource;
}

let running: Promise<MailCheckResult> | null = null;

export function checkMail(db: MunyDb, deps: MailDeps, now = Date.now()): Promise<MailCheckResult> {
  if (running) return running;
  const p = (async () => {
    const conn = mailConnection(db, deps.secretKey);
    const rules = mailRules(db);
    const st = mailState(db);
    const source = (deps.source ?? imapSource)(conn);
    const since = new Date(now - rules.firstDays * 86_400_000);
    let batch: Awaited<ReturnType<MailSource["fetchNew"]>>;
    try {
      batch = await source.fetchNew(st, since);
    } catch (err) {
      const e = mailProblem(err, conn);
      saveMailState(db, { lastCheckAt: now, lastError: e.message });
      throw e;
    }
    const result: MailCheckResult = { read: 0, transactions: 0, statements: 0, unrecognized: 0 };
    let added = 0;
    const change = openChange(db, { actorType: "system", actorName: "Email" });
    await runAsChange(change, async () => {
      for (const m of batch.messages) {
        if (!m.raw.length) continue;
        const out = await handleMail(db, deps.secretKey, m.raw);
        if (!out) continue;
        result.read++;
        added += out.added ?? 0;
        if (out.status === "transaction") result.transactions++;
        if (out.status === "statement" || out.status === "document") result.statements++;
        if (out.status === "unrecognized") result.unrecognized++;
      }
      const parts = [
        result.transactions &&
          `${result.transactions} transaction${result.transactions === 1 ? "" : "s"}`,
        result.statements && `${result.statements} statement${result.statements === 1 ? "" : "s"}`,
      ].filter(Boolean);
      if (parts.length) describeChange(db, `Read ${parts.join(" and ")} from email`);
    });
    const lastUid = batch.messages.at(-1)?.uid;
    saveMailState(db, {
      folder: conn.folder,
      uidValidity: batch.uidValidity,
      ...(lastUid !== undefined ? { lastUid } : {}),
      lastCheckAt: now,
      lastError: null,
    });
    forgetOldMail(db, now);
    if (added || result.transactions) transactionsAdded(db);
    return result;
  })();
  running = p;
  p.finally(() => {
    running = null;
  }).catch(() => {});
  return p;
}

/** Check on schedule while it's turned on. */
export function startMailScheduler(
  db: MunyDb,
  deps: MailDeps,
  log: { warn: (o: object, msg: string) => void },
) {
  const tick = () => {
    const rules = mailRules(db);
    if (!rules.enabled || running) return;
    const last = mailState(db).lastCheckAt ?? 0;
    if (Date.now() - last < rules.checkEveryMinutes * 60_000) return;
    checkMail(db, deps).catch((err) =>
      // Our own short message only; never the server's reply or the address.
      log.warn({ error: err instanceof Error ? err.message : "unknown" }, "Email check failed"),
    );
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  setTimeout(tick, 30_000).unref();
  return () => clearInterval(timer);
}
