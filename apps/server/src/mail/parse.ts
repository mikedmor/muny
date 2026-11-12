import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";

/**
 * One raw email (RFC 822) read into what Muny needs. Its HTML becomes plain
 * text; nothing in it is run or followed, and links aren't opened.
 */

export interface ParsedMail {
  /** SHA-256 of the Message-ID, or of the whole email when it has none. */
  key: string;
  from: string;
  date: Date;
  subject: string;
  /** Plain text, one trimmed line per line, blank lines dropped. */
  text: string;
  pdfs: { name: string; bytes: Buffer }[];
  attachments: { name: string; mime: string; sizeBytes: number }[];
  /** What the receiving server said about the sender domain's signature (DKIM). */
  signed: "pass" | "fail" | "none";
}

const MAX_PDF = 10 * 1024 * 1024;

/** Invisible characters marketing emails are full of, and odd spaces. */
const INVISIBLE = /[\u200b-\u200d\u2060\u00ad\ufeff]|\u034f/g;

export function tidyText(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/[\t  -  　]/g, " ")
        .replace(/\p{Cc}/gu, "")
        .replace(/ {2,}/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

/** The headers block, with folded lines joined. */
function headerLines(raw: Buffer): string[] {
  const s = raw.subarray(0, 256 * 1024).toString("latin1");
  const end = s.search(/\r?\n\r?\n/);
  return (end < 0 ? s : s.slice(0, end)).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

/**
 * The newest Authentication-Results header is the one the receiving server
 * added (anything below it came with the email, and could be made up). Pass
 * only for a DKIM signature from the sender's own domain (or its parent).
 */
export function signatureFor(raw: Buffer, from: string): "pass" | "fail" | "none" {
  const top = headerLines(raw).find((l) => /^authentication-results:/i.test(l));
  if (!top) return "none";
  const domain = from.split("@")[1]?.toLowerCase() ?? "";
  const aligned = (d: string) => !!domain && (domain === d || domain.endsWith(`.${d}`));
  let sawDkim = false;
  for (const m of top.matchAll(/dkim=(\w+)([^;]*)/gi)) {
    sawDkim = true;
    const d = /header\.(?:d|i)=@?([a-z0-9.-]+)/i.exec(m[2] ?? "")?.[1]?.toLowerCase();
    if (m[1]?.toLowerCase() === "pass" && d && aligned(d)) return "pass";
  }
  return sawDkim ? "fail" : "none";
}

export async function parseMail(raw: Buffer): Promise<ParsedMail> {
  const m = await simpleParser(raw, { skipImageLinks: true });
  const from = (m.from?.value[0]?.address ?? "").toLowerCase();
  // An HTML-only email gets its text from the HTML (mailparser does this).
  const text = tidyText(m.text ?? "");
  const pdfs: ParsedMail["pdfs"] = [];
  const attachments: ParsedMail["attachments"] = [];
  for (const a of m.attachments) {
    const name = (a.filename ?? "attachment").replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").slice(0, 120);
    attachments.push({ name, mime: a.contentType, sizeBytes: a.size });
    const isPdf = a.contentType === "application/pdf" || /\.pdf$/i.test(name);
    if (isPdf && a.size <= MAX_PDF && a.content.subarray(0, 4).toString("latin1") === "%PDF")
      pdfs.push({ name: /\.pdf$/i.test(name) ? name : `${name}.pdf`, bytes: a.content });
  }
  return {
    key: createHash("sha256")
      .update(m.messageId ? `id:${m.messageId}` : raw)
      .digest("hex"),
    from,
    date: m.date && !Number.isNaN(m.date.getTime()) ? m.date : new Date(),
    subject: (m.subject ?? "")
      .replace(/\p{Cc}/gu, " ")
      .trim()
      .slice(0, 300),
    text,
    pdfs,
    attachments,
    signed: signatureFor(raw, from),
  };
}
