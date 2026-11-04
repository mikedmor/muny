import { readFileSync } from "node:fs";
import { request } from "node:https";
import { type AccountType, MoneyParseError, parseAmount } from "@muny/shared";
import type { TellerConfig } from "../config.js";
import {
  type ConnectionInfo,
  type Provider,
  type ProviderAccount,
  ProviderError,
  type ProviderTransaction,
  type SyncResult,
} from "./types.js";

/**
 * Teller provider (https://teller.io/docs/api). Every API call is
 * authenticated with HTTP Basic (access token as the username) plus the
 * application's mTLS client certificate. Teller has no sync cursor, so each
 * sync re-reads a recent window of transactions and upserts them.
 */

export interface TellerCreds {
  accessToken: string;
  enrollmentId: string;
}

export type TellerHttp = (
  path: string,
  accessToken: string,
) => Promise<{ status: number; body: unknown }>;

const API = "https://api.teller.io";
/** Days of history re-read on every sync (catches late edits and pending -> posted). */
export const TELLER_WINDOW_DAYS = 45;

interface TellerAccount {
  id: string;
  enrollment_id: string;
  name: string;
  type: string;
  subtype: string;
  last_four?: string | null;
  currency?: string;
  institution?: { id: string; name: string };
  status?: string;
}

interface TellerTxn {
  id: string;
  account_id: string;
  amount: string;
  date: string;
  description: string;
  status: "posted" | "pending";
  details?: { category?: string | null; counterparty?: { name?: string | null } | null } | null;
}

export function tellerAccountType(type: string, subtype: string): AccountType {
  if (type === "credit") return "credit";
  if (subtype === "savings" || subtype === "money_market" || subtype === "certificate_of_deposit")
    return "savings";
  if (type === "depository") return "checking";
  return "other";
}

const CATEGORY_MAP: Record<string, string> = {
  accommodation: "Travel & Vacation",
  bar: "Dining & Drinks",
  charity: "Charitable Donations",
  clothing: "Clothing",
  dining: "Dining & Drinks",
  education: "Education",
  electronics: "Electronics",
  entertainment: "Entertainment",
  fuel: "Gas & Fuel",
  groceries: "Groceries",
  health: "Medical",
  home: "Home & Garden",
  income: "Other Income",
  insurance: "Insurance",
  investment: "Investments",
  loan: "Loan Payment",
  phone: "Phone",
  shopping: "General Merchandise",
  software: "Software & Apps",
  sport: "Fitness",
  tax: "Taxes",
  transport: "Public Transit",
  transportation: "Public Transit",
  utilities: "Electric",
};

/** Default transport: node:https with the mTLS client certificate. */
export function tellerHttp(cfg: TellerConfig): TellerHttp {
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (cfg.certPath && cfg.keyPath) {
    try {
      tls = { cert: readFileSync(cfg.certPath), key: readFileSync(cfg.keyPath) };
    } catch {
      throw new ProviderError(
        "config",
        "Teller: couldn't read TELLER_CERT_PATH / TELLER_KEY_PATH. Check the files exist and the container can read them.",
      );
    }
  } else if (cfg.env !== "sandbox") {
    throw new ProviderError(
      "config",
      `Teller ${cfg.env} needs a client certificate: set TELLER_CERT_PATH and TELLER_KEY_PATH.`,
    );
  }
  return (path, accessToken) =>
    new Promise((resolve, reject) => {
      const req = request(
        `${API}${path}`,
        {
          method: "GET",
          headers: {
            authorization: `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`,
            accept: "application/json",
          },
          ...(tls ?? {}),
          timeout: 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = null;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              body = null;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () =>
        reject(
          new ProviderError(
            "provider_error",
            "Couldn't reach Teller. Check the NAS's internet connection.",
          ),
        ),
      );
      req.end();
    });
}

function cents(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined || s === "") return null;
  try {
    return parseAmount(String(s), { round: true });
  } catch (e) {
    if (e instanceof MoneyParseError) return null;
    throw e;
  }
}

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export class TellerProvider implements Provider<TellerCreds> {
  readonly id = "teller" as const;
  private http: TellerHttp | undefined;
  constructor(
    private readonly cfg: TellerConfig,
    http?: TellerHttp,
  ) {
    this.http = http;
  }

  private async get<T>(path: string, creds: TellerCreds): Promise<T> {
    this.http ??= tellerHttp(this.cfg);
    const { status, body } = await this.http(path, creds.accessToken);
    if (status >= 200 && status < 300) return body as T;
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    const msg = `Teller: ${err?.message ?? `request failed (HTTP ${status})`}`;
    if (status === 401 || status === 403 || err?.code?.startsWith("enrollment.disconnected"))
      throw new ProviderError("reauth_required", msg);
    if (status === 429) throw new ProviderError("rate_limited", msg);
    if (status === 404) throw new ProviderError("reauth_required", msg);
    throw new ProviderError("provider_error", msg);
  }

  async getAccounts(creds: TellerCreds): Promise<ConnectionInfo> {
    const accounts = await this.get<TellerAccount[]>("/accounts", creds);
    const out: ProviderAccount[] = [];
    for (const a of accounts.filter((x) => x.status !== "closed")) {
      const type = tellerAccountType(a.type, a.subtype);
      let balanceCents: number | null = null;
      try {
        const b = await this.get<{ ledger?: string | null; available?: string | null }>(
          `/accounts/${encodeURIComponent(a.id)}/balances`,
          creds,
        );
        const ledger = cents(b.ledger ?? b.available);
        // Teller reports the amount owed on a credit card as a positive ledger balance.
        balanceCents = ledger === null ? null : type === "credit" ? -ledger : ledger;
      } catch (e) {
        if (e instanceof ProviderError && e.code === "reauth_required") throw e;
      }
      out.push({
        ref: a.id,
        name: a.name,
        type,
        mask: a.last_four ? a.last_four.replace(/\D/g, "").slice(-4) || null : null,
        currency: a.currency ?? "USD",
        balanceCents,
      });
    }
    return {
      institutionName: accounts[0]?.institution?.name ?? null,
      providerRef: creds.enrollmentId,
      accounts: out,
    };
  }

  async syncTransactions(creds: TellerCreds, cursor: string | null): Promise<SyncResult> {
    // First sync pulls everything Teller has; later ones re-read a recent window.
    const windowFrom = cursor ? isoDaysAgo(TELLER_WINDOW_DAYS) : undefined;
    const accounts = await this.get<TellerAccount[]>("/accounts", creds);
    const added: ProviderTransaction[] = [];
    for (const a of accounts.filter((x) => x.status !== "closed")) {
      let fromId: string | undefined;
      for (let page = 0; page < 100; page++) {
        const q = new URLSearchParams({ count: "250" });
        if (fromId) q.set("from_id", fromId);
        const txns = await this.get<TellerTxn[]>(
          `/accounts/${encodeURIComponent(a.id)}/transactions?${q}`,
          creds,
        );
        let reachedWindow = false;
        for (const t of txns) {
          if (windowFrom && t.date < windowFrom) {
            reachedWindow = true;
            continue;
          }
          const amount = cents(t.amount);
          if (amount === null) continue;
          const counterparty = t.details?.counterparty?.name ?? null;
          added.push({
            ref: t.id,
            accountRef: t.account_id,
            postedDate: t.date,
            authorizedDate: null,
            // Teller amounts are signed from the account holder's view: negative = money out.
            amountCents: amount,
            currency: a.currency ?? "USD",
            description: (t.description || counterparty || "(no description)").slice(0, 500),
            merchantName: counterparty,
            pending: t.status === "pending",
            pendingRef: null, // Teller keeps the same id from pending to posted
            categoryHint: t.details?.category ? (CATEGORY_MAP[t.details.category] ?? null) : null,
          });
        }
        const last = txns[txns.length - 1];
        if (reachedWindow || txns.length < 250 || !last) break;
        fromId = last.id;
      }
    }
    return {
      added,
      modified: [],
      removed: [],
      cursor: new Date().toISOString(),
      ...(windowFrom ? { windowFrom } : {}),
    };
  }

  async remove(_creds: TellerCreds): Promise<void> {
    // Teller enrollments are disconnected from the user's side (or expire); nothing to call.
  }
}
