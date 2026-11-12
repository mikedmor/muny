import { type MunyDb, schema } from "@muny/db";
import {
  MAIL_PROVIDER_INFO,
  type MailProvider,
  type MailSettings,
  type MailSettingsInput,
} from "@muny/shared";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/crypto.js";

/**
 * Settings → Email, kept in app settings. The mailbox password is stored
 * encrypted with MUNY_SECRET_KEY and only ever sent to that mail server.
 * The last check's time and error are kept apart (a counter, not a change).
 */

const KEY = "mail.settings";
const STATE_KEY = "mail.state";

interface Stored {
  enabled: boolean;
  provider: MailProvider;
  host: string;
  port: number;
  secure: boolean;
  allowSelfSigned: boolean;
  user: string;
  folder: string;
  checkEveryMinutes: number;
  senders: string[];
  requireSigned: boolean;
  firstDays: number;
  /** encryptJson({ password }) */
  passwordEnc: string | null;
}

/** Where reading stopped, and how the last check went. */
export interface MailState {
  /** The folder and its UIDVALIDITY the UIDs below belong to. */
  folder: string | null;
  uidValidity: string | null;
  lastUid: number;
  lastCheckAt: number | null;
  lastError: string | null;
}

const DEFAULTS: Stored = {
  enabled: false,
  provider: "gmail",
  host: MAIL_PROVIDER_INFO.gmail.host,
  port: 993,
  secure: true,
  allowSelfSigned: false,
  user: "",
  folder: "INBOX",
  checkEveryMinutes: 15,
  senders: [],
  requireSigned: true,
  firstDays: 30,
  passwordEnc: null,
};

function readKey<T>(db: MunyDb, key: string): Partial<T> {
  const row = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get();
  return (row?.value ?? {}) as Partial<T>;
}

function writeKey(db: MunyDb, key: string, value: unknown) {
  db.insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
    .run();
}

function read(db: MunyDb): Stored {
  return { ...DEFAULTS, ...readKey<Stored>(db, KEY) };
}

export function mailState(db: MunyDb): MailState {
  return {
    folder: null,
    uidValidity: null,
    lastUid: 0,
    lastCheckAt: null,
    lastError: null,
    ...readKey<MailState>(db, STATE_KEY),
  };
}

export function saveMailState(db: MunyDb, patch: Partial<MailState>) {
  writeKey(db, STATE_KEY, { ...mailState(db), ...patch });
}

export function mailSettings(db: MunyDb, secret: Buffer | undefined): MailSettings {
  const { passwordEnc, ...s } = read(db);
  const st = mailState(db);
  return {
    ...s,
    hasPassword: !!passwordEnc,
    canStore: !!secret,
    lastCheckAt: st.lastCheckAt,
    lastError: st.lastError,
  };
}

export class MailSetupError extends Error {}

/** "Alerts@Bank.com" stays an address; "bank.com" or "@bank.com" is a whole domain. */
export function cleanSender(s: string): string | null {
  const v = s
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "");
  if (!v) return null;
  if (/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return v;
  const domain = v.replace(/^@/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? `@${domain}` : null;
}

export function updateMailSettings(
  db: MunyDb,
  secret: Buffer | undefined,
  input: MailSettingsInput,
): MailSettings {
  const now = read(db);
  const next: Stored = { ...now };
  for (const k of [
    "enabled",
    "provider",
    "host",
    "port",
    "secure",
    "allowSelfSigned",
    "user",
    "folder",
    "checkEveryMinutes",
    "requireSigned",
    "firstDays",
  ] as const)
    if (input[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = input[k];
  if (input.host !== undefined) next.host = input.host.trim().toLowerCase();
  if (input.user !== undefined) next.user = input.user.trim();
  if (input.folder !== undefined) next.folder = input.folder.trim() || "INBOX";
  // Picking a provider fills in its server, unless one was given.
  if (input.provider && input.provider !== now.provider && input.host === undefined) {
    const p = MAIL_PROVIDER_INFO[input.provider];
    next.host = p.host;
    next.port = p.port;
    next.secure = true;
  }
  if (input.senders !== undefined) {
    const list: string[] = [];
    for (const raw of input.senders) {
      const s = cleanSender(raw);
      if (!s) throw new MailSetupError(`"${raw.slice(0, 60)}" isn't an email address or a domain.`);
      if (!list.includes(s)) list.push(s);
    }
    next.senders = list;
  }
  if (input.password === null) next.passwordEnc = null;
  else if (input.password?.trim()) {
    if (!secret)
      throw new MailSetupError("Set MUNY_SECRET_KEY first: the password is stored encrypted.");
    next.passwordEnc = encryptJson(secret, { password: input.password.trim() });
  }
  if (next.enabled && (!next.host || !next.user || !next.passwordEnc))
    throw new MailSetupError("Fill in the server, user name and password before turning it on.");
  if (!secret && next.enabled)
    throw new MailSetupError("Set MUNY_SECRET_KEY first: emails are kept encrypted.");
  // A different mailbox or folder starts reading afresh (emails already read aren't read again).
  if (next.host !== now.host || next.user !== now.user || next.folder !== now.folder)
    saveMailState(db, { folder: null, uidValidity: null, lastUid: 0, lastError: null });
  writeKey(db, KEY, next);
  return mailSettings(db, secret);
}

/** What a connection needs (the password decrypted only here). */
export interface MailConnection {
  host: string;
  port: number;
  secure: boolean;
  allowSelfSigned: boolean;
  user: string;
  password: string;
  folder: string;
}

export function mailConnection(db: MunyDb, secret: Buffer | undefined): MailConnection {
  const s = read(db);
  if (!s.host || !s.user) throw new MailSetupError("Fill in the server and user name first.");
  if (!s.passwordEnc || !secret) throw new MailSetupError("Enter the mailbox password first.");
  const { password } = decryptJson<{ password: string }>(secret, s.passwordEnc);
  return {
    host: s.host,
    port: s.port,
    secure: s.secure,
    allowSelfSigned: s.allowSelfSigned,
    user: s.user,
    password,
    folder: s.folder,
  };
}

/** The settings that decide what's read (no secrets). */
export function mailRules(db: MunyDb) {
  const s = read(db);
  return {
    enabled: s.enabled,
    senders: s.senders,
    requireSigned: s.requireSigned,
    firstDays: s.firstDays,
    checkEveryMinutes: s.checkEveryMinutes,
  };
}
