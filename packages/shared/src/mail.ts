/**
 * Email import (Settings → Email): Muny reads one mailbox folder over IMAP,
 * read-only, for bank emails you forward or filter there. Card activity
 * emails become transactions, statement emails update a card, and statement
 * PDFs go through the statement reader. Off until you set it up.
 */

export const MAIL_PROVIDERS = [
  "gmail",
  "fastmail",
  "icloud",
  "yahoo",
  "aol",
  "zoho",
  "gmx",
  "other",
] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export const MAIL_PROVIDER_INFO: Record<
  MailProvider,
  { label: string; host: string; port: number; help: string }
> = {
  gmail: {
    label: "Gmail",
    host: "imap.gmail.com",
    port: 993,
    help: "Turn on 2-Step Verification, then make an app password at myaccount.google.com/apppasswords. A Gmail label is a folder here.",
  },
  fastmail: {
    label: "Fastmail",
    host: "imap.fastmail.com",
    port: 993,
    help: "Make an app password under Settings → Privacy & Security → Integrations, with IMAP access.",
  },
  icloud: {
    label: "iCloud Mail",
    host: "imap.mail.me.com",
    port: 993,
    help: "Make an app-specific password at account.apple.com. The user name is your iCloud address.",
  },
  yahoo: {
    label: "Yahoo Mail",
    host: "imap.mail.yahoo.com",
    port: 993,
    help: "Make an app password under Account Info → Account security.",
  },
  aol: {
    label: "AOL Mail",
    host: "imap.aol.com",
    port: 993,
    help: "Make an app password under Account Info → Account security.",
  },
  zoho: {
    label: "Zoho Mail",
    host: "imap.zoho.com",
    port: 993,
    help: "Turn on IMAP access in Zoho Mail's settings, and use an app password if you have two-factor sign-in.",
  },
  gmx: {
    label: "GMX",
    host: "imap.gmx.com",
    port: 993,
    help: "Allow IMAP access in GMX's settings under POP3 & IMAP.",
  },
  other: {
    label: "Another server",
    host: "",
    port: 993,
    help: "Any server with IMAP: a self-hosted one, Proton Mail Bridge and so on. Outlook.com and Microsoft 365 aren't supported yet: they need a sign-in with Microsoft instead of a password.",
  },
};

export const MAIL_CHECK_MINUTES = [5, 15, 30, 60] as const;

export interface MailSettings {
  enabled: boolean;
  provider: MailProvider;
  host: string;
  port: number;
  /** TLS from the start (993); otherwise STARTTLS (143). */
  secure: boolean;
  /** Accept a self-signed certificate (Proton Mail Bridge, a home server). */
  allowSelfSigned: boolean;
  user: string;
  /** A password is stored (it's never sent back). */
  hasPassword: boolean;
  /** MUNY_SECRET_KEY is set, so a password can be stored. */
  canStore: boolean;
  /** The folder Muny reads ("INBOX", or a folder or Gmail label). */
  folder: string;
  checkEveryMinutes: number;
  /** Only email from these is read: an address, or "@bank.com" for a whole domain. */
  senders: string[];
  /** Only email the receiving server says the sender's domain signed (DKIM). */
  requireSigned: boolean;
  /** On the first check, email from this many days back is read. */
  firstDays: number;
  lastCheckAt: number | null;
  lastError: string | null;
}

export interface MailSettingsInput {
  enabled?: boolean;
  provider?: MailProvider;
  host?: string;
  port?: number;
  secure?: boolean;
  allowSelfSigned?: boolean;
  user?: string;
  /** A new password; null removes it; leave it out to keep the stored one. */
  password?: string | null;
  folder?: string;
  checkEveryMinutes?: number;
  senders?: string[];
  requireSigned?: boolean;
  firstDays?: number;
}

export type MailStatus =
  /** A transaction was added from it. */
  | "transaction"
  /** A card's statement balance, minimum and due date were updated from it. */
  | "statement"
  /** A statement PDF in it was saved to Documents (read into the card, if it could be). */
  | "document"
  /** From an allowed sender, but no template reads it yet: teach Muny. */
  | "unrecognized"
  /** The sender isn't on your list. */
  | "not_allowed"
  /** The sender's domain didn't sign it, and signing is required. */
  | "unsigned"
  /** Read, nothing to do (already there, or you said to skip it). */
  | "skipped"
  | "failed";

export interface MailMessage {
  id: string;
  /** unix ms */
  receivedAt: number;
  from: string;
  subject: string;
  status: MailStatus;
  /** What happened, in words. */
  note: string | null;
  /** The receiving server's verdict on the sender's signature. */
  signed: "pass" | "fail" | "none";
  accountId: string | null;
  accountName: string | null;
  transactionId: string | null;
  documentId: string | null;
  templateId: string | null;
}

export interface MailMessageDetail extends MailMessage {
  /** The email's text, while it's kept (60 days). */
  text: string | null;
  attachments: { name: string; mime: string; sizeBytes: number }[];
}

export type MailTemplateKind = "activity" | "summary";

export type MailFieldType = "money" | "date" | "text" | "last4";

/** What each kind of template reads. Required fields must be found for it to apply. */
export const MAIL_FIELDS: Record<
  MailTemplateKind,
  { key: string; label: string; type: MailFieldType; required?: boolean }[]
> = {
  activity: [
    { key: "amount", label: "Amount", type: "money", required: true },
    { key: "merchant", label: "Merchant", type: "text", required: true },
    { key: "date", label: "Date (else the email's date)", type: "date" },
    { key: "last4", label: "Card's last 4 digits (else the account below)", type: "last4" },
  ],
  summary: [
    { key: "balance", label: "Statement balance", type: "money", required: true },
    { key: "minimum", label: "Minimum payment", type: "money" },
    { key: "dueDate", label: "Payment due date", type: "date" },
    { key: "closingDate", label: "Statement date (else the email's date)", type: "date" },
    { key: "creditLimit", label: "Credit limit", type: "money" },
    { key: "last4", label: "Card's last 4 digits (else the account below)", type: "last4" },
  ],
};

export const MAIL_KIND_LABELS: Record<MailTemplateKind, string> = {
  activity: "Card activity (a charge or credit)",
  summary: "Statement summary (balance, minimum, due date)",
};

/** Where a field's value sits: the text just before it and just after it. */
export interface MailAnchor {
  before: string;
  after: string;
}

export interface MailTemplate {
  id: string;
  name: string;
  kind: MailTemplateKind;
  /** The sender it's for: an address or "@domain". */
  from: string;
  /** Only email whose subject contains this (optional). */
  subject: string | null;
  /** Activity: a charge (money out) or a payment or refund (money in). */
  direction: "out" | "in";
  /** The card it's for when the email doesn't say (or as well). */
  accountId: string | null;
  fields: Record<string, MailAnchor>;
  createdAt: number;
}

export interface MailTemplateInput {
  name: string;
  kind: MailTemplateKind;
  from: string;
  subject?: string | null;
  direction?: "out" | "in";
  accountId?: string | null;
  fields: Record<string, MailAnchor>;
}

/** Teaching Muny from one email: where each value was found, and what that reads back. */
export interface MailTemplateDraft {
  fields: Record<string, MailAnchor>;
  /** What the template reads from the email, as it would be used. */
  read: Record<string, string | number | null>;
  /** Values that couldn't be found in the email, as typed. */
  missing: string[];
}

export interface MailCheckResult {
  /** New emails looked at. */
  read: number;
  transactions: number;
  statements: number;
  unrecognized: number;
}
