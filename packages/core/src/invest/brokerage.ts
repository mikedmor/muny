/**
 * Brokerage CSV exports → positions and activity.
 *
 * Every broker lays its exports out differently (title lines above the header,
 * disclaimers below, holdings and history in one file), so instead of one
 * parser per broker this finds each header row, maps its columns by the names
 * brokers use, and classifies each activity row from its action text.
 * Quantities and prices are exact decimal strings; money is integer cents.
 */
import { parseAmount } from "@muny/shared";
import { normDec, toFixed, valueCents } from "../crypto/decimal.js";
import { parseCsv } from "../import/csv.js";
import { detectDateFormat, parseDate } from "../import/dates.js";

export type SecurityType = "equity" | "etf" | "mutual_fund" | "bond" | "option" | "cash" | "other";

export type InvestTxnType =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "split"
  | "transfer_in"
  | "transfer_out"
  | "deposit"
  | "withdrawal"
  | "fee"
  | "tax"
  | "other";

export interface BrokeragePosition {
  /** Which account (as the file names it; "" when the file is one account). */
  accountRef: string;
  symbol: string;
  name: string;
  type: SecurityType;
  quantity: string;
  /** Price per share (decimal string), when given. */
  price: string | null;
  valueCents: number;
  /** Total cost basis the broker reports, when given. */
  costBasisCents: number | null;
}

export interface BrokerageActivity {
  accountRef: string;
  date: string;
  type: InvestTxnType;
  symbol: string | null;
  name: string | null;
  /** Shares, always positive (the type says which way). */
  quantity: string | null;
  price: string | null;
  /** Cash effect on the account: negative for a buy, positive for a sale or dividend. */
  amountCents: number;
  feesCents: number;
  description: string;
  /** Stable id for dedupe: a hash of the row (with a counter for identical rows). */
  externalId: string;
}

export interface BrokerageAccountRef {
  ref: string;
  label: string;
  /** Last 4 digits, when the file shows an account number. */
  mask: string | null;
}

export interface BrokerageFile {
  broker: string;
  accounts: BrokerageAccountRef[];
  positions: BrokeragePosition[];
  activity: BrokerageActivity[];
  /** Rows that couldn't be read (line and reason; never the row itself). */
  skipped: { line: number; reason: string }[];
}

type Col =
  | "date"
  | "action"
  | "symbol"
  | "description"
  | "quantity"
  | "price"
  | "amount"
  | "fees"
  | "commission"
  | "account"
  | "accountName"
  | "value"
  | "cost"
  | "status"
  | "secType"
  | "side";

/** Header names brokers use, lowercased with "($)" and "(Quantity)"-style notes removed. */
const ALIASES: Record<Col, string[]> = {
  date: ["run date", "activity date", "trade date", "date", "transaction date", "filled time"],
  action: ["action", "trans code", "transaction type", "activity"],
  side: ["side"],
  symbol: ["symbol", "instrument", "ticker", "symbol/cusip"],
  description: [
    "description",
    "investment name",
    "security description",
    "name",
    "transaction description",
  ],
  quantity: ["quantity", "qty", "shares", "filled", "share quantity"],
  price: ["avg price", "price", "share price", "last price", "price per share"],
  amount: ["amount", "net amount", "total amount"],
  fees: ["fees", "fees & comm", "commission fees", "fee"],
  commission: ["commission"],
  account: ["account number", "account", "account #"],
  accountName: ["account name", "account"],
  value: ["current value", "market value", "mkt val", "total value", "value", "market value ($)"],
  cost: ["cost basis total", "cost basis", "total cost basis", "cost basis ($)", "total cost"],
  status: ["status"],
  secType: ["security type", "asset type", "investment type"],
};

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/\((?:\$|%|quantity|market value|price)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

function mapHeader(cells: string[]): Partial<Record<Col, number>> {
  const out: Partial<Record<Col, number>> = {};
  const names = cells.map(norm);
  for (const col of Object.keys(ALIASES) as Col[])
    for (const alias of ALIASES[col]) {
      const i = names.indexOf(alias);
      if (i >= 0 && !Object.values(out).includes(i)) {
        out[col] = i;
        break;
      }
    }
  return out;
}

/** A header row: names a symbol and either an action (history) or a quantity (positions). */
function headerKind(m: Partial<Record<Col, number>>): "activity" | "positions" | null {
  const hasSym = m.symbol !== undefined || m.description !== undefined;
  if (m.date !== undefined && (m.action !== undefined || m.side !== undefined) && hasSym)
    return "activity";
  if (
    m.symbol !== undefined &&
    m.quantity !== undefined &&
    (m.value !== undefined || m.price !== undefined)
  )
    return "positions";
  return null;
}

function detectBroker(headers: string[], preamble: string): string {
  const h = headers.map(norm).join("|");
  const p = preamble.toLowerCase();
  if (/run date|last price change/.test(h)) return "Fidelity";
  if (/trans code|activity date/.test(h)) return "Robinhood";
  if (/fees & comm|mkt val/.test(h) || /schwab/.test(p)) return "Schwab";
  if (/investment name|principal amount|share price/.test(h)) return "Vanguard";
  if (/filled time|placed time/.test(h)) return "Webull";
  if (/public\.com|open to the public/.test(p)) return "Public";
  return "Brokerage";
}

const money = (s: string | undefined): number | null => {
  const v = (s ?? "").replace(/[*]/g, "").trim();
  if (!v || v === "--" || /^n\/?a$/i.test(v)) return null;
  try {
    return parseAmount(v, { round: true });
  } catch {
    return null;
  }
};

const dec = (s: string | undefined): string | null => {
  const v = (s ?? "").replace(/[$,*\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!v || v === "--") return null;
  try {
    return normDec(v);
  } catch {
    return null;
  }
};

const abs = (d: string) => (d.startsWith("-") ? d.slice(1) : d);

/** Money market and sweep funds count as cash. */
function isCash(symbol: string, name: string): boolean {
  return (
    /\*\*$/.test(symbol) ||
    /^(cash|usd|core|fcash)$/i.test(symbol) ||
    /money market|cash & cash|sweep|cash reserves|federal money|treasury money|core position/i.test(
      name,
    )
  );
}

function securityType(symbol: string, name: string, hint: string): SecurityType {
  const t = `${hint} ${name}`.toLowerCase();
  if (isCash(symbol, name)) return "cash";
  if (/\bcall\b|\bput\b|option/.test(t) || /^[A-Z]{1,6}\d{6}[CP]\d+/.test(symbol)) return "option";
  if (/\betf\b|exchange traded|ishares|spdr|vanguard .* etf|invesco qqq/.test(t)) return "etf";
  if (/mutual fund|admiral|investor shares|institutional|index fund|fund$/.test(t))
    return "mutual_fund";
  if (/bond|treasury|note|cd\b|certificate of deposit/.test(t)) return "bond";
  return "equity";
}

/** Classify an activity row from the broker's action text (and Robinhood's codes). */
export function classifyAction(
  action: string,
  description: string,
  hasShares: boolean,
  amountCents: number | null,
): InvestTxnType {
  const a = action.trim().toLowerCase();
  const all = `${a} ${description.toLowerCase()}`;
  // Robinhood transaction codes.
  const codes: Record<string, InvestTxnType> = {
    buy: "buy",
    sell: "sell",
    cdiv: "dividend",
    mdiv: "dividend",
    int: "interest",
    slip: "interest",
    spl: "split",
    sxch: "split",
    rec: "transfer_in",
    acati: "transfer_in",
    acato: "transfer_out",
    dtax: "tax",
    gold: "fee",
    afee: "fee",
    dfee: "fee",
    mint: "interest",
  };
  if (codes[a]) return codes[a];
  if (/reinvest/.test(all) && hasShares) return "buy";
  if (/\bsplit\b|reverse split|stock dividend/.test(all)) return "split";
  if (/you bought|^buy|\bbought\b|purchase|^b$|buy to (open|close)/.test(all)) return "buy";
  if (/you sold|^sell|\bsold\b|redemption|^s$|sell to (open|close)|sell short/.test(all))
    return "sell";
  if (/dividend|\bdiv\b|cap(ital)? gain|distribution/.test(all)) return "dividend";
  if (/interest|\bint\b/.test(all)) return "interest";
  if (/tax withh|foreign tax|withholding|nra/.test(all)) return "tax";
  if (/\bfee\b|fees|commission|adr/.test(all)) return "fee";
  if (/transfer|journal|acat|shares (in|out)|received|delivered|conversion/.test(all) && hasShares)
    return amountCents !== null && amountCents < 0
      ? "transfer_out"
      : /out|deliver/.test(all)
        ? "transfer_out"
        : "transfer_in";
  if (
    /deposit|contribution|ach|eft|electronic funds|wire|transfer|journal|withdraw|disbursement/.test(
      all,
    )
  )
    return amountCents !== null && amountCents < 0
      ? "withdrawal"
      : /withdraw|disburse/.test(all)
        ? "withdrawal"
        : "deposit";
  return "other";
}

/** FNV-1a 64-bit, hex: a stable, platform-neutral id for imported rows. */
function hash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const maskOf = (s: string) => {
  const d = s.replace(/\D/g, "");
  return d.length >= 3 ? d.slice(-4) : null;
};

/** Read a brokerage CSV export (positions, activity, or both). */
export function parseBrokerageCsv(input: string): BrokerageFile {
  const rows = parseCsv(input);
  const skipped: BrokerageFile["skipped"] = [];
  const positions: BrokeragePosition[] = [];
  const activity: BrokerageActivity[] = [];
  const accounts = new Map<string, BrokerageAccountRef>();
  let broker = "Brokerage";
  const preamble: string[] = [];
  // Schwab names the account in a title line above the header ("…Individual ...123").
  let titleRef = "";

  const seen = new Map<string, number>();
  let i = 0;
  while (i < rows.length) {
    const cells = (rows[i] ?? []).map((c) => c.trim());
    const m = mapHeader(cells);
    const kind = headerKind(m);
    if (!kind) {
      const line = cells.filter(Boolean).join(" ");
      if (line) {
        preamble.push(line);
        const t = /(?:account|positions for)\b.*?(\.{2,3}\s?\d{3,4}|x{2,}-?\d{3,4}|\d{4})\b/i.exec(
          line,
        );
        if (t?.[1]) titleRef = t[1];
      }
      i++;
      continue;
    }
    if (broker === "Brokerage") broker = detectBroker(cells, preamble.join(" "));
    // The block runs until a blank row or the next header.
    const block: { line: number; cells: string[] }[] = [];
    let j = i + 1;
    for (; j < rows.length; j++) {
      const r = (rows[j] ?? []).map((c) => c.trim());
      if (!r.some(Boolean)) {
        if (block.length) break;
        continue;
      }
      if (headerKind(mapHeader(r))) break;
      block.push({ line: j + 1, cells: r });
    }
    const get = (r: string[], c: Col) => (m[c] === undefined ? "" : (r[m[c] as number] ?? ""));
    const accountOf = (r: string[]) => {
      const num = get(r, "account");
      const name = get(r, "accountName");
      const ref = num || name || titleRef || "";
      if (!accounts.has(ref))
        accounts.set(ref, {
          ref,
          label:
            [name, num && maskOf(num) ? `••${maskOf(num)}` : num].filter(Boolean).join(" ") ||
            broker,
          mask: maskOf(num || titleRef),
        });
      return ref;
    };

    if (kind === "positions") {
      for (const { line, cells: r } of block) {
        const symbol = get(r, "symbol").replace(/\*+$/, "").trim();
        const name = get(r, "description");
        const rawSym = get(r, "symbol");
        if (!symbol && !/cash/i.test(name)) continue;
        if (/^(account total|total|pending activity)/i.test(symbol)) continue;
        const value = money(get(r, "value"));
        const qty = dec(get(r, "quantity"));
        const cash = isCash(rawSym, name) || /cash/i.test(symbol);
        if (value === null && (qty === null || cash)) {
          skipped.push({ line, reason: "No value or quantity" });
          continue;
        }
        const price = dec(get(r, "price"));
        const quantity = qty ?? (cash && value !== null ? normDec((value / 100).toFixed(2)) : "0");
        const v = value ?? (price !== null ? valueCents(quantity, price) : null);
        if (v === null) {
          skipped.push({ line, reason: "No value" });
          continue;
        }
        positions.push({
          accountRef: accountOf(r),
          symbol: (cash && /s/.test(symbol)) || !symbol ? "CASH" : symbol.toUpperCase(),
          name: name || symbol,
          type: cash ? "cash" : securityType(symbol, name, get(r, "secType")),
          quantity: cash && qty === null ? quantity : quantity,
          price: cash ? "1" : price,
          valueCents: v,
          costBasisCents: cash ? v : money(get(r, "cost")),
        });
      }
    } else {
      const fmt = detectDateFormat(block.map((b) => get(b.cells, "date"))) ?? "MM/DD/YYYY";
      for (const { line, cells: r } of block) {
        const status = get(r, "status");
        if (status && !/fill|exec|complete/i.test(status)) continue; // Webull: cancelled orders
        const date = parseDate(get(r, "date"), fmt);
        if (!date) {
          skipped.push({ line, reason: "No date" });
          continue;
        }
        const action = get(r, "action") || get(r, "side");
        const description = get(r, "description");
        const symbol = get(r, "symbol").replace(/\*+$/, "").trim().toUpperCase() || null;
        const qtyRaw = dec(get(r, "quantity"));
        const quantity = qtyRaw && toFixed(qtyRaw) !== 0n ? abs(qtyRaw) : null;
        const price = dec(get(r, "price"));
        const fees =
          Math.abs(money(get(r, "fees")) ?? 0) + Math.abs(money(get(r, "commission")) ?? 0);
        let amount = money(get(r, "amount"));
        const type = classifyAction(action, description, !!quantity && !!symbol, amount);
        if (type === "other" && amount === null && !quantity) {
          skipped.push({ line, reason: "Not a transaction" });
          continue;
        }
        if (amount === null) {
          // Webull and others: work out the cash from shares × price.
          const gross = quantity && price ? valueCents(quantity, abs(price)) : 0;
          amount = type === "buy" ? -(gross + fees) : type === "sell" ? gross - fees : 0;
        } else if (type === "buy" && amount > 0) amount = -amount;
        else if (type === "sell" && amount < 0) amount = -amount;
        const accountRef = accountOf(r);
        const key = [accountRef, date, type, symbol, quantity, price, amount, description].join(
          "|",
        );
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        activity.push({
          accountRef,
          date,
          type,
          symbol,
          name: description || null,
          quantity,
          price: price ? abs(price) : null,
          amountCents: amount,
          feesCents: fees,
          description: [action, description].filter(Boolean).join(" · ").slice(0, 300),
          externalId: `csv:${hash(`${key}#${n}`)}`,
        });
      }
    }
    i = j;
  }
  if (!positions.length && !activity.length)
    throw new Error(
      "This doesn't look like a brokerage export: no positions or transactions found. Export positions or account history as CSV from your broker's website.",
    );
  return { broker, accounts: [...accounts.values()], positions, activity, skipped };
}
