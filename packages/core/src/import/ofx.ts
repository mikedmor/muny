import { ACCOUNT_TYPE_LABELS, type AccountType, MoneyParseError, parseAmount } from "@muny/shared";
import { parseDate } from "./dates.js";
import type { ParsedAccount, ParseResult } from "./types.js";

/**
 * OFX / QFX / QBO statement parser (OFX 1.x SGML and 2.x XML).
 *
 * SGML OFX leaves out closing tags for leaf elements (`<TRNAMT>-5.00`), so
 * rather than a real XML parser this walks the tags and tracks only the
 * aggregates it cares about. Full account numbers (ACCTID) are reduced to
 * their last 4 digits and never leave this function.
 */

const STATEMENTS = new Set(["STMTRS", "CCSTMTRS", "INVSTMTRS"]);
const CONTEXTS = new Set([
  ...STATEMENTS,
  "STMTTRN",
  "BANKACCTFROM",
  "CCACCTFROM",
  "INVACCTFROM",
  "LEDGERBAL",
  "FI",
]);

type Fields = Record<string, string>;

interface Statement {
  kind: string;
  account: Fields;
  ledger: Fields;
  txns: { line: number; f: Fields }[];
}

export function isOfx(content: string): boolean {
  return /OFXHEADER|<OFX>/i.test(content.slice(0, 4000));
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function accountType(kind: string, acctType: string | undefined): AccountType {
  if (kind === "CCSTMTRS") return "credit";
  if (kind === "INVSTMTRS") return "investment";
  switch ((acctType ?? "").toUpperCase()) {
    case "SAVINGS":
    case "MONEYMRKT":
    case "CD":
      return "savings";
    case "CREDITLINE":
      return "credit";
    default:
      return "checking";
  }
}

const TYPE_LABEL: Record<AccountType, string> = {
  ...ACCOUNT_TYPE_LABELS,
  credit: "Credit Card",
  asset: "Asset",
  other: "Account",
};

export function parseOfx(content: string): ParseResult {
  const result: ParseResult = { format: "ofx", accounts: [], transactions: [], errors: [] };
  const stack: string[] = [];
  const statements: Statement[] = [];
  let org: string | null = null;
  let stmt: Statement | null = null;
  let txn: { line: number; f: Fields } | null = null;

  // Line numbers for error messages.
  const lineAt = (() => {
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
    return (pos: number) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] ?? 0) <= pos) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
  })();

  const re = /<(\/?)([A-Za-z0-9._]+)(?:\s[^>]*)?>([^<]*)/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toUpperCase();
    const value = decode(m[3] ?? "");

    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at === -1) continue; // closing tag for a leaf (OFX 2.x XML)
      while (stack.length > at) {
        const popped = stack.pop();
        if (popped === "STMTTRN" && txn && stmt) {
          stmt.txns.push(txn);
          txn = null;
        } else if (popped && STATEMENTS.has(popped) && stmt) {
          statements.push(stmt);
          stmt = null;
        }
      }
      continue;
    }

    if (value === "") {
      // Aggregate start (or an empty leaf, which is harmless on the stack).
      stack.push(tag);
      if (STATEMENTS.has(tag)) stmt = { kind: tag, account: {}, ledger: {}, txns: [] };
      else if (tag === "STMTTRN") txn = { line: lineAt(m.index), f: {} };
      continue;
    }

    // Leaf value: attribute it to the innermost aggregate we track.
    let ctx: string | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i];
      if (s && CONTEXTS.has(s)) {
        ctx = s;
        break;
      }
    }
    if (ctx === "STMTTRN" && txn) txn.f[tag] ??= value;
    else if (ctx?.endsWith("ACCTFROM") && stmt) stmt.account[tag] = value;
    else if (ctx === "LEDGERBAL" && stmt) stmt.ledger[tag] = value;
    else if (ctx === "FI" && tag === "ORG") org = value;
  }
  // Unterminated SGML files: keep whatever was open.
  if (txn && stmt) stmt.txns.push(txn);
  if (stmt) statements.push(stmt);

  if (statements.length === 0) {
    result.errors.push({ line: 1, message: "No statements found in this OFX/QFX file" });
    return result;
  }

  statements.forEach((s, i) => {
    const type = accountType(s.kind, s.account.ACCTTYPE);
    const mask = (s.account.ACCTID ?? "").replace(/\D/g, "").slice(-4) || null;
    const key = `ofx-${i + 1}`;
    let statementBalance: ParsedAccount["statementBalance"] = null;
    const asOf = parseDate(s.ledger.DTASOF ?? "", "YYYYMMDD");
    if (s.ledger.BALAMT && asOf && s.kind !== "INVSTMTRS") {
      try {
        statementBalance = { cents: parseAmount(s.ledger.BALAMT, { round: true }), asOf };
      } catch {
        // ignore an unreadable balance
      }
    }
    result.accounts.push({
      key,
      name: org?.toLowerCase().includes(TYPE_LABEL[type].toLowerCase())
        ? org
        : `${org ?? "Bank"} ${TYPE_LABEL[type]}`,
      institutionName: org,
      mask,
      type,
      statementBalance,
    });

    for (const { line, f } of s.txns) {
      const postedDate = parseDate(f.DTPOSTED ?? "", "YYYYMMDD");
      if (!postedDate) {
        result.errors.push({ line, message: `Invalid date "${f.DTPOSTED ?? ""}"` });
        continue;
      }
      let amountCents: number;
      try {
        amountCents = parseAmount(f.TRNAMT ?? "", { round: true });
      } catch (e) {
        if (!(e instanceof MoneyParseError)) throw e;
        result.errors.push({ line, message: `Invalid amount "${f.TRNAMT ?? ""}"` });
        continue;
      }
      const name = f.NAME ?? "";
      const memo = f.MEMO ?? "";
      // Many banks truncate NAME to 32 chars and put the full text in MEMO.
      const useMemo = !name || (memo.length > name.length && memo.startsWith(name));
      const description =
        (useMemo ? memo : name) ||
        (f.CHECKNUM ? `Check #${f.CHECKNUM}` : f.TRNTYPE) ||
        "(no description)";
      const authorized = parseDate(f.DTUSER ?? "", "YYYYMMDD");
      result.transactions.push({
        accountKey: key,
        line,
        postedDate,
        authorizedDate: authorized && authorized !== postedDate ? authorized : null,
        amountCents,
        rawDescription: description,
        payeeName: null,
        categoryName: null,
        notes: !useMemo && memo && memo !== name ? memo : null,
        tags: [],
        hidden: false,
        providerTxnRef: f.FITID ? f.FITID.slice(0, 255) : null,
      });
    }
  });
  return result;
}
