import type { AccountType } from "@muny/shared";
import { parseAmount } from "@muny/shared";
import {
  type ConnectionInfo,
  type Provider,
  ProviderError,
  type ProviderTransaction,
  type SyncResult,
} from "./types.js";

/**
 * SimpleFIN (https://www.simplefin.org): a small, read-only protocol. With
 * SimpleFIN Bridge (about $15 a year) you link your banks and card issuers
 * there, get a one-time setup token, and Muny swaps it for an access URL
 * (kept encrypted) to read balances and transactions. Covers many US banks
 * and card issuers Plaid doesn't. The bridge refreshes about once a day.
 */

export interface SimpleFinCreds {
  /** https://user:pass@host/path (from claiming the setup token). */
  accessUrl: string;
}

type FetchLike = typeof fetch;
const DAY = 86_400;
/** The bridge answers at most about 60 days per request. */
const WINDOW_DAYS = 60;
/** How far back the first sync asks. */
const FIRST_SYNC_DAYS = 365;

interface SfAccount {
  org?: { name?: string; domain?: string };
  id: string;
  name?: string;
  currency?: string;
  balance?: string;
  transactions?: {
    id: string;
    posted?: number;
    transacted_at?: number;
    amount: string;
    description?: string;
    payee?: string;
    memo?: string;
    pending?: boolean;
  }[];
}

const cents = (v: string | undefined) => {
  if (!v) return 0;
  try {
    return parseAmount(v, { round: true });
  } catch {
    return 0;
  }
};
const iso = (unix: number | undefined) =>
  new Date((unix ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

/** SimpleFIN doesn't say what kind of account it is: guess from the name and balance. */
export function guessType(name: string, balanceCents: number): AccountType {
  const n = name.toLowerCase();
  if (/credit|card|visa|mastercard|master card|discover|amex|american express|signature/.test(n))
    return "credit";
  if (/loan|mortgage|auto|student|heloc|line of credit/.test(n)) return "loan";
  if (/brokerage|ira|401k|roth|invest|retire/.test(n)) return "investment";
  if (/saving|money market|cd\b|certificate/.test(n)) return "savings";
  return balanceCents < 0 ? "credit" : "checking";
}

/** Swap a setup token (base64 of a claim URL) for the access URL. */
export async function claimSetupToken(token: string, f: FetchLike = fetch): Promise<string> {
  let claim: URL;
  try {
    claim = new URL(Buffer.from(token.trim(), "base64").toString("utf8").trim());
  } catch {
    throw new ProviderError("config", "That doesn't look like a SimpleFIN setup token.");
  }
  if (claim.protocol !== "https:")
    throw new ProviderError("config", "That doesn't look like a SimpleFIN setup token.");
  const res = await f(claim, {
    method: "POST",
    headers: { "content-length": "0", "user-agent": "Muny (self-hosted)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403)
    throw new ProviderError(
      "config",
      "That setup token was already used or expired. Make a new one at SimpleFIN Bridge.",
    );
  if (!res.ok) throw new ProviderError("provider_error", `SimpleFIN answered ${res.status}`);
  const access = (await res.text()).trim();
  if (!/^https:\/\/[^/\s]+@/.test(access))
    throw new ProviderError("provider_error", "SimpleFIN didn't return an access link.");
  return access;
}

export class SimpleFinProvider implements Provider<SimpleFinCreds> {
  readonly id = "simplefin" as const;
  constructor(private readonly fetchFn: FetchLike = fetch) {}

  private async get(c: SimpleFinCreds, startUnix?: number, endUnix?: number) {
    const u = new URL(c.accessUrl);
    const auth = Buffer.from(
      `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
    ).toString("base64");
    u.username = "";
    u.password = "";
    const url = new URL(`${u.href.replace(/\/+$/, "")}/accounts`);
    if (startUnix !== undefined) url.searchParams.set("start-date", String(startUnix));
    if (endUnix !== undefined) url.searchParams.set("end-date", String(endUnix));
    url.searchParams.set("pending", "1");
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { authorization: `Basic ${auth}`, accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ProviderError("provider_error", "Couldn't reach SimpleFIN");
    }
    if (res.status === 403 || res.status === 401)
      throw new ProviderError(
        "reauth_required",
        "SimpleFIN no longer accepts this connection. Make a new setup token and connect again.",
      );
    if (res.status === 429) throw new ProviderError("rate_limited", "SimpleFIN asked to slow down");
    if (!res.ok) throw new ProviderError("provider_error", `SimpleFIN answered ${res.status}`);
    return (await res.json()) as { errors?: string[]; accounts?: SfAccount[] };
  }

  async getAccounts(c: SimpleFinCreds): Promise<ConnectionInfo> {
    // Balances only: no transactions needed (a tiny window).
    const now = Math.floor(Date.now() / 1000);
    const r = await this.get(c, now - DAY, now);
    const accounts = r.accounts ?? [];
    const orgs = [...new Set(accounts.map((a) => a.org?.name).filter(Boolean))];
    return {
      institutionName: orgs.length === 1 ? (orgs[0] as string) : "SimpleFIN",
      providerRef: new URL(c.accessUrl).host,
      accounts: accounts.map((a) => {
        const balance = cents(a.balance);
        const name = [a.org?.name, a.name].filter(Boolean).join(" · ") || "Account";
        return {
          ref: a.id,
          name: a.name || name,
          type: guessType(`${a.org?.name ?? ""} ${a.name ?? ""}`, balance),
          mask: /(\d{4})\D*$/.exec(a.name ?? "")?.[1] ?? null,
          currency: a.currency && /^[A-Z]{3}$/.test(a.currency) ? a.currency : "USD",
          balanceCents: balance,
        };
      }),
    };
  }

  async syncTransactions(c: SimpleFinCreds, cursor: string | null): Promise<SyncResult> {
    const now = Math.floor(Date.now() / 1000);
    // From a few days before the last sync (pending ones settle), or a year back.
    const from = cursor
      ? Math.floor(Date.parse(`${cursor}T00:00:00Z`) / 1000) - 5 * DAY
      : now - FIRST_SYNC_DAYS * DAY;
    const added: ProviderTransaction[] = [];
    const seen = new Set<string>();
    for (let start = from; start < now; start += WINDOW_DAYS * DAY) {
      const end = Math.min(now, start + WINDOW_DAYS * DAY);
      const r = await this.get(c, start, end);
      for (const a of r.accounts ?? [])
        for (const t of a.transactions ?? []) {
          if (seen.has(`${a.id}:${t.id}`)) continue;
          seen.add(`${a.id}:${t.id}`);
          const amount = cents(t.amount);
          if (amount === 0) continue;
          added.push({
            ref: `${a.id}:${t.id}`,
            accountRef: a.id,
            postedDate: iso(t.posted || t.transacted_at),
            authorizedDate: t.transacted_at ? iso(t.transacted_at) : null,
            amountCents: amount,
            currency: a.currency && /^[A-Z]{3}$/.test(a.currency) ? a.currency : "USD",
            description: (t.description || t.payee || t.memo || "(no description)").slice(0, 500),
            merchantName: t.payee || null,
            pending: !!t.pending || !t.posted,
            pendingRef: null,
            categoryHint: null,
          });
        }
    }
    return {
      added,
      modified: [],
      removed: [],
      cursor: new Date(now * 1000).toISOString().slice(0, 10),
      // Pending ones can come back under a new id once posted: the window replaces them.
      windowFrom: iso(from),
    };
  }

  async remove(): Promise<void> {
    // Access is revoked at SimpleFIN Bridge (your account there); nothing to call.
  }
}
