import { cleanPayeeName } from "@muny/core";
import { type MunyDb, newId, schema } from "@muny/db";
import type { CardStatement, MailStatus, MailTemplate } from "@muny/shared";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  addStatementTransactions,
  anchorCardBalance,
  applyCardStatement,
  cardForText,
} from "../cards/service.js";
import { saveDocument } from "../documents/service.js";
import { applyMerchantMemory } from "../ledger/memory.js";
import { payeesByShape, upsertPayee } from "../ledger/transactions.js";
import { linkTransfersFor } from "../ledger/transfers.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { localToday } from "../lib/dates.js";
import { transactionsAdded } from "../lib/events.js";
import { pdfLines } from "../loans/statements.js";
import { rescanRecurring } from "../recurring/service.js";
import { runRulesOn } from "../rules/service.js";
import { detectStatement } from "../statements/detect.js";
import { type ParsedMail, parseMail } from "./parse.js";
import { mailRules } from "./settings.js";
import { listMailTemplates, readWith, senderMatches } from "./templates.js";

/**
 * What each email becomes. In order: not from a sender on your list, or not
 * signed when that's required → left alone; a statement PDF → read into the
 * card (when it's a card's and Muny can tell which) and kept in Documents; a
 * template for the sender that finds its values → a transaction, or the
 * card's statement numbers; else it waits for you to teach Muny.
 *
 * The email itself is kept encrypted for 60 days, so it can be taught from,
 * or read again once a template or sender is added; then only its row stays.
 */

export const KEEP_DAYS = 60;
/** Bigger than this isn't kept (it's read once, as it arrives). */
const MAX_KEEP_BYTES = 15 * 1024 * 1024;

type Tx = Parameters<Parameters<MunyDb["transaction"]>[0]>[0];

interface Outcome {
  status: MailStatus;
  note: string | null;
  accountId?: string | null;
  transactionId?: string | null;
  documentId?: string | null;
  templateId?: string | null;
  /** New transactions (for rules, alerts and the like once everything's in). */
  added?: number;
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

function accountName(db: MunyDb, id: string) {
  const a = db
    .select({ name: schema.accounts.name, mask: schema.accounts.mask })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id))
    .get();
  return a ? `${a.name}${a.mask ? ` ••${a.mask}` : ""}` : "the account";
}

/** The card an email is about: its last 4, else the template's card, else digits in the text. */
function accountFor(
  db: MunyDb,
  last4: string | null,
  t: MailTemplate,
  text: string,
): string | null {
  if (last4) {
    const hits = db
      .select({ id: schema.accounts.id, type: schema.accounts.type })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.mask, last4), eq(schema.accounts.hidden, false)))
      .all();
    const pick = hits.find((h) => h.type === "credit") ?? (hits.length === 1 ? hits[0] : undefined);
    if (pick) return pick.id;
  }
  if (t.accountId) return t.accountId;
  return cardForText(db, text);
}

function applyActivity(
  db: MunyDb,
  mail: ParsedMail,
  t: MailTemplate,
  read: Record<string, string | number | null>,
): Outcome {
  const accountId = accountFor(db, (read.last4 as string | null) ?? null, t, mail.text);
  if (!accountId)
    return {
      status: "unrecognized",
      note: "Muny couldn't tell which card this is for. Choose the card on its template.",
      templateId: t.id,
    };
  const cents = read.amount as number;
  const amountCents = t.direction === "in" ? cents : -cents;
  const date = (read.date as string | null) ?? localToday(mail.date);
  const merchant = String(read.merchant).slice(0, 200);
  const tr = schema.transactions;
  // A statement or import that already brought it in (same amount within 3 days).
  const there = db
    .select({ id: tr.id, date: tr.postedDate, hash: tr.importHash })
    .from(tr)
    .where(and(eq(tr.accountId, accountId), eq(tr.amountCents, amountCents)))
    .all()
    .find((x) => !x.hash.startsWith("email:") && Math.abs(dayNum(x.date) - dayNum(date)) <= 3);
  if (there)
    return {
      status: "skipped",
      note: `Already on ${accountName(db, accountId)} (from a statement or import).`,
      accountId,
      transactionId: there.id,
      templateId: t.id,
    };
  const id = newId();
  db.transaction((tx: Tx) => {
    const known = payeesByShape(tx)(merchant);
    const payeeId = known ?? upsertPayee(tx, (cleanPayeeName(merchant) || merchant).slice(0, 100));
    const acc = tx
      .select({ currency: schema.accounts.currency })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    tx.insert(tr)
      .values({
        id,
        accountId,
        postedDate: date,
        amountCents,
        currency: acc?.currency ?? "USD",
        rawDescription: merchant,
        payeeId,
        importHash: `email:${mail.key.slice(0, 32)}`,
      })
      .onConflictDoNothing()
      .run();
    runRulesOn(tx, [id]);
    linkTransfersFor(tx, [id]);
    applyMerchantMemory(tx, [id]);
    rescanRecurring(tx);
  });
  return {
    status: "transaction",
    note: `Added ${merchant} to ${accountName(db, accountId)}.`,
    accountId,
    transactionId: id,
    templateId: t.id,
    added: 1,
  };
}

function applySummary(
  db: MunyDb,
  mail: ParsedMail,
  t: MailTemplate,
  read: Record<string, string | number | null>,
): Outcome {
  const accountId = accountFor(db, (read.last4 as string | null) ?? null, t, mail.text);
  if (!accountId)
    return {
      status: "unrecognized",
      note: "Muny couldn't tell which card this is for. Choose the card on its template.",
      templateId: t.id,
    };
  const s: CardStatement = {
    closingDate: (read.closingDate as string | null) ?? localToday(mail.date),
    dueDate: (read.dueDate as string | null) ?? null,
    newBalanceCents: read.balance as number,
    minimumPaymentCents: (read.minimum as number | null) ?? null,
    creditLimitCents: (read.creditLimit as number | null) ?? null,
    aprBps: null,
    previousBalanceCents: null,
    paymentsCents: null,
    interestYtd: null,
    minimumOnly: null,
    transactions: [],
  };
  if (!applyCardStatement(db, accountId, s))
    return {
      status: "failed",
      note: `${accountName(db, accountId)} isn't a credit card, so its statement numbers weren't set.`,
      accountId,
      templateId: t.id,
    };
  anchorCardBalance(db, accountId);
  return {
    status: "statement",
    note: `Updated ${accountName(db, accountId)}'s statement balance${s.dueDate ? " and due date" : ""}.`,
    accountId,
    templateId: t.id,
  };
}

/** A statement PDF: read into its card when Muny can, and kept in Documents either way. */
async function applyPdf(
  db: MunyDb,
  secret: Buffer | undefined,
  pdf: { name: string; bytes: Buffer },
  mail: ParsedMail,
): Promise<Outcome> {
  const keep = (
    folder: string,
    extra: {
      kind?: "card_statement" | "other";
      lender?: string | null;
      documentDate?: string | null;
      accountId?: string | null;
    },
  ) =>
    saveDocument(db, secret, {
      name: pdf.name,
      mime: "application/pdf",
      bytes: pdf.bytes,
      folder,
      documentDate: localToday(mail.date),
      notes: `From ${mail.from}`,
      ...extra,
    });
  let rows: string[][] | null = null;
  try {
    rows = await pdfLines(new Uint8Array(pdf.bytes));
  } catch {
    rows = null;
  }
  if (!rows) {
    const doc = keep("Email", {});
    return {
      status: "document",
      note: "Saved to Documents → Email. Muny couldn't read it; it may be locked with a password.",
      documentId: doc.id,
    };
  }
  const p = detectStatement(db, rows);
  if (p.kind === "card" && p.accountId) {
    const accountId = p.accountId;
    let added = 0;
    db.transaction((tx: Tx) => {
      const d = tx as unknown as MunyDb;
      applyCardStatement(d, accountId, p.card);
      const ids = addStatementTransactions(d, accountId, p.card.transactions);
      runRulesOn(tx, ids);
      linkTransfersFor(tx, ids);
      added = ids.length;
    });
    anchorCardBalance(db, accountId);
    const doc = keep("", {
      kind: "card_statement",
      lender: db
        .select({ name: schema.accounts.name })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get()?.name,
      documentDate: p.card.closingDate ?? p.date ?? localToday(mail.date),
      accountId,
    });
    return {
      status: "document",
      note: `Read the statement into ${accountName(db, accountId)}${added ? `, with ${added} new transaction${added === 1 ? "" : "s"}` : ""}.`,
      accountId,
      documentId: doc.id,
      added,
    };
  }
  if (p.accountId) {
    const name = accountName(db, p.accountId);
    const acct = db
      .select({ name: schema.accounts.name })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, p.accountId))
      .get();
    const doc = keep(`Statements / ${(acct?.name ?? "Email").replace(/\//g, "-")}`, {
      documentDate: p.date ?? localToday(mail.date),
      accountId: p.accountId,
    });
    return {
      status: "document",
      note: `Saved the statement to Documents for ${name}. Muny only reads card statements from email; import this one from its page to update it.`,
      accountId: p.accountId,
      documentId: doc.id,
    };
  }
  const doc = keep("Email", { documentDate: p.date ?? localToday(mail.date) });
  return {
    status: "document",
    note: "Saved to Documents → Email. Muny couldn't tell which account it's for.",
    documentId: doc.id,
  };
}

/** Decide what an email becomes, and do it. */
async function decide(db: MunyDb, secret: Buffer | undefined, mail: ParsedMail): Promise<Outcome> {
  const rules = mailRules(db);
  if (!mail.from || !rules.senders.some((p) => senderMatches(p, mail.from)))
    return { status: "not_allowed", note: "Not from a sender on your list." };
  if (rules.requireSigned && mail.signed !== "pass")
    return {
      status: "unsigned",
      note:
        mail.signed === "fail"
          ? "The sender's domain didn't sign it, so it may not really be from them."
          : "Your mail server didn't say whether the sender's domain signed it.",
    };

  if (mail.pdfs.length) {
    const outcomes: Outcome[] = [];
    for (const pdf of mail.pdfs) outcomes.push(await applyPdf(db, secret, pdf, mail));
    const first = outcomes.find((o) => o.accountId) ?? (outcomes[0] as Outcome);
    return {
      ...first,
      note: outcomes.map((o) => o.note).join(" "),
      added: outcomes.reduce((s, o) => s + (o.added ?? 0), 0),
    };
  }

  const subject = mail.subject.toLowerCase();
  const year = mail.date.getFullYear();
  const candidates = listMailTemplates(db).filter(
    (t) =>
      senderMatches(t.from, mail.from) && (!t.subject || subject.includes(t.subject.toLowerCase())),
  );
  for (const t of candidates) {
    const read = readWith(t.kind, t.fields, mail.text, year);
    if (t.kind === "activity" && read.amount !== null && read.merchant !== null)
      return applyActivity(db, mail, t, read);
    if (t.kind === "summary" && read.balance !== null) return applySummary(db, mail, t, read);
  }
  return {
    status: "unrecognized",
    note: candidates.length
      ? "A template for this sender didn't find its values in this email. Teach Muny this one too."
      : "No template reads this sender's emails yet. Teach Muny from it.",
  };
}

const keepRaw = (secret: Buffer | undefined, raw: Buffer) =>
  secret && raw.length <= MAX_KEEP_BYTES
    ? encryptJson(secret, { raw: raw.toString("base64") })
    : null;

/** One new email from the mailbox. Returns its outcome, or null if it was read before. */
export async function handleMail(
  db: MunyDb,
  secret: Buffer | undefined,
  raw: Buffer,
): Promise<Outcome | null> {
  const mail = await parseMail(raw);
  const m = schema.mailMessages;
  if (db.select({ id: m.id }).from(m).where(eq(m.messageKey, mail.key)).get()) return null;
  let out: Outcome;
  try {
    out = await decide(db, secret, mail);
  } catch {
    out = { status: "failed", note: "Something went wrong reading this email." };
  }
  db.insert(m)
    .values({
      id: newId(),
      messageKey: mail.key,
      receivedAt: mail.date,
      fromAddress: mail.from.slice(0, 200),
      subject: mail.subject,
      status: out.status,
      note: out.note,
      signed: mail.signed,
      bodyEnc: keepRaw(secret, raw),
      accountId: out.accountId ?? null,
      transactionId: out.transactionId ?? null,
      documentId: out.documentId ?? null,
      templateId: out.templateId ?? null,
    })
    .onConflictDoNothing()
    .run();
  return out;
}

/** The email as it arrived, while it's kept. */
export function rawOf(secret: Buffer | undefined, bodyEnc: string | null): Buffer | null {
  if (!bodyEnc || !secret) return null;
  try {
    return Buffer.from(decryptJson<{ raw: string }>(secret, bodyEnc).raw, "base64");
  } catch {
    return null;
  }
}

/**
 * Read kept emails again (after a template or sender was added): the ones
 * that weren't used, newest last. Returns how many now did something.
 */
export async function rereadMail(
  db: MunyDb,
  secret: Buffer | undefined,
  ids?: string[],
): Promise<{ read: number; used: number; added: number }> {
  const m = schema.mailMessages;
  const rows = db
    .select({ id: m.id, bodyEnc: m.bodyEnc })
    .from(m)
    .where(
      and(
        inArray(m.status, ["unrecognized", "not_allowed", "unsigned", "failed"]),
        sql`${m.bodyEnc} is not null`,
        ...(ids ? [inArray(m.id, ids)] : []),
      ),
    )
    .orderBy(m.receivedAt)
    .all();
  let used = 0;
  let added = 0;
  for (const r of rows) {
    const raw = rawOf(secret, r.bodyEnc);
    if (!raw) continue;
    const mail = await parseMail(raw);
    let out: Outcome;
    try {
      out = await decide(db, secret, mail);
    } catch {
      out = { status: "failed", note: "Something went wrong reading this email." };
    }
    if (!["unrecognized", "not_allowed", "unsigned", "failed"].includes(out.status)) used++;
    added += out.added ?? 0;
    db.update(m)
      .set({
        status: out.status,
        note: out.note,
        accountId: out.accountId ?? null,
        transactionId: out.transactionId ?? null,
        documentId: out.documentId ?? null,
        templateId: out.templateId ?? null,
      })
      .where(eq(m.id, r.id))
      .run();
  }
  if (added) transactionsAdded(db);
  return { read: rows.length, used, added };
}

/** Drop kept emails older than KEEP_DAYS (their rows stay, so they aren't read again). */
export function forgetOldMail(db: MunyDb, now = Date.now()) {
  const m = schema.mailMessages;
  db.update(m)
    .set({ bodyEnc: null })
    .where(
      and(lt(m.receivedAt, new Date(now - KEEP_DAYS * 86_400_000)), sql`${m.bodyEnc} is not null`),
    )
    .run();
}
