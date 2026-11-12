import { ImapFlow } from "imapflow";
import type { MailConnection } from "./settings.js";

/**
 * Reading a mailbox over IMAP. The folder is opened read-only (EXAMINE), so
 * Muny never marks, moves or deletes anything; it keeps its own place by UID.
 * Nothing about the connection is logged.
 */

export interface MailCursor {
  folder: string | null;
  uidValidity: string | null;
  lastUid: number;
}

export interface MailBatch {
  uidValidity: string;
  messages: { uid: number; raw: Buffer }[];
  /** More new ones are waiting (read next time). */
  more: boolean;
}

export interface MailSource {
  /** New emails since the cursor (or, when starting afresh, since `since`), oldest first. */
  fetchNew(cursor: MailCursor, since: Date): Promise<MailBatch>;
  /** Sign in, and list the folders (to check the settings). */
  folders(): Promise<string[]>;
}

export class MailError extends Error {}

const PER_CHECK = 100;
const MAX_BYTES = 25 * 1024 * 1024;

/** A short message we wrote, from whatever went wrong (never the server's own words). */
export function mailProblem(err: unknown, c: MailConnection): MailError {
  if (err instanceof MailError) return err;
  const e = err as { code?: string; authenticationFailed?: boolean; responseText?: string };
  const code = e?.code ?? "";
  if (e?.authenticationFailed || code === "AUTHENTICATIONFAILED" || /auth/i.test(code))
    return new MailError(
      "The mail server didn't accept the user name or password. Gmail, iCloud and Yahoo need an app password, not your normal one.",
    );
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return new MailError(`Couldn't find a mail server at ${c.host}.`);
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "NoConnection"
  )
    return new MailError(`Couldn't connect to ${c.host} on port ${c.port}.`);
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code))
    return new MailError(
      "The mail server's certificate isn't trusted. For a server on your own network, allow its self-signed certificate.",
    );
  if (code === "NONEXISTENT" || /nonexistent|doesn't exist|not found/i.test(e?.responseText ?? ""))
    return new MailError(`There's no folder named "${c.folder}" in that mailbox.`);
  return new MailError("Couldn't read the mailbox.");
}

function client(c: MailConnection) {
  return new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.password },
    logger: false,
    disableAutoIdle: true,
    clientInfo: { name: "Muny" },
    ...(c.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
  });
}

export function imapSource(c: MailConnection): MailSource {
  return {
    async folders() {
      const imap = client(c);
      try {
        await imap.connect();
        const list = await imap.list();
        return list.map((f) => f.path).sort((a, b) => a.localeCompare(b));
      } catch (err) {
        throw mailProblem(err, c);
      } finally {
        await imap.logout().catch(() => imap.close());
      }
    },

    async fetchNew(cursor, since) {
      const imap = client(c);
      try {
        await imap.connect();
        const lock = await imap.getMailboxLock(c.folder, { readOnly: true });
        try {
          const box = imap.mailbox;
          const uidValidity = String(box && typeof box === "object" ? box.uidValidity : "");
          const fresh = cursor.folder !== c.folder || cursor.uidValidity !== uidValidity;
          const found = fresh
            ? await imap.search({ since }, { uid: true })
            : await imap.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
          const uids = (Array.isArray(found) ? found : [])
            .filter((u) => fresh || u > cursor.lastUid)
            .sort((a, b) => a - b);
          const take = uids.slice(0, PER_CHECK);
          const messages: MailBatch["messages"] = [];
          if (take.length) {
            // Sizes first, so a huge email isn't downloaded.
            const small: number[] = [];
            for await (const m of imap.fetch(
              take.join(","),
              { uid: true, size: true },
              { uid: true },
            ))
              if ((m.size ?? 0) <= MAX_BYTES) small.push(m.uid);
            if (small.length)
              for await (const m of imap.fetch(
                small.join(","),
                { uid: true, source: true },
                { uid: true },
              ))
                if (m.source) messages.push({ uid: m.uid, raw: m.source });
          }
          messages.sort((a, b) => a.uid - b.uid);
          // Even a skipped (too big) email moves the place along.
          const last = take.at(-1);
          if (last !== undefined && !messages.some((m) => m.uid === last))
            messages.push({ uid: last, raw: Buffer.alloc(0) });
          return { uidValidity, messages, more: uids.length > take.length };
        } finally {
          lock.release();
        }
      } catch (err) {
        throw mailProblem(err, c);
      } finally {
        await imap.logout().catch(() => imap.close());
      }
    },
  };
}
