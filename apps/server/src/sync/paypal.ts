import { parseAmount } from "@muny/shared";
import {
  type ConnectionInfo,
  type Provider,
  ProviderError,
  type ProviderTransaction,
  type SyncResult,
} from "./types.js";

/**
 * PayPal (D-041): your own REST app's client ID and secret (business
 * accounts only; the app needs "Transaction Search" turned on). Read-only:
 * the balance from /v1/reporting/balances and activity from
 * /v1/reporting/transactions (31 days per request, up to 3 years back).
 * Amounts are net of PayPal's fee; only US dollars are kept.
 */

export interface PayPalCreds {
  clientId: string;
  clientSecret: string;
  env: "live" | "sandbox";
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const HOSTS = {
  live: "https://api-m.paypal.com",
  sandbox: "https://api-m.sandbox.paypal.com",
} as const;
const DAY = 86_400_000;
const WINDOW_DAYS = 31;
const HISTORY_DAYS = 3 * 365;

interface TxDetail {
  transaction_info?: {
    transaction_id?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_amount?: { currency_code?: string; value?: string };
    fee_amount?: { currency_code?: string; value?: string };
    transaction_status?: string;
    transaction_subject?: string;
    transaction_note?: string;
  };
  payer_info?: {
    payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string };
  };
  cart_info?: { item_details?: { item_name?: string }[] };
}

/** What a PayPal event code means, for rows without a counterparty name. */
function eventLabel(code: string | undefined): string {
  const c = code ?? "";
  if (c.startsWith("T03")) return "Bank deposit to PayPal";
  if (c.startsWith("T04")) return "Transfer to bank";
  if (c.startsWith("T11")) return "Refund";
  if (c.startsWith("T00")) return "PayPal payment";
  if (c.startsWith("T01")) return "PayPal fee";
  if (c.startsWith("T02")) return "Currency conversion";
  return "PayPal";
}

const cents = (v: string | undefined) => {
  if (!v) return 0;
  try {
    return parseAmount(v, { round: true });
  } catch {
    return 0;
  }
};

export class PayPalProvider implements Provider<PayPalCreds> {
  readonly id = "paypal" as const;
  private tokens = new Map<string, { token: string; until: number }>();
  constructor(private readonly fetchFn: FetchLike = fetch) {}

  private async token(c: PayPalCreds): Promise<string> {
    const key = `${c.env}:${c.clientId}`;
    const hit = this.tokens.get(key);
    if (hit && hit.until > Date.now() + 60_000) return hit.token;
    let res: Response;
    try {
      res = await this.fetchFn(`${HOSTS[c.env]}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProviderError(
        "provider_error",
        "Couldn't reach PayPal. Check the NAS's internet connection.",
      );
    }
    if (res.status === 401)
      throw new ProviderError("reauth_required", "PayPal didn't accept the client ID and secret.");
    if (!res.ok)
      throw new ProviderError("provider_error", `PayPal: sign-in failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new ProviderError("provider_error", "PayPal: no access token");
    this.tokens.set(key, {
      token: body.access_token,
      until: Date.now() + (body.expires_in ?? 3000) * 1000,
    });
    return body.access_token;
  }

  private async get<T>(c: PayPalCreds, path: string): Promise<T> {
    const token = await this.token(c);
    let res: Response;
    try {
      res = await this.fetchFn(`${HOSTS[c.env]}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ProviderError("provider_error", "Couldn't reach PayPal.");
    }
    if (res.status === 401)
      throw new ProviderError("reauth_required", "PayPal: the keys stopped working.");
    if (res.status === 403)
      throw new ProviderError(
        "config",
        "PayPal: this app can't read your activity. Turn on Transaction Search for it in PayPal's developer dashboard (it can take a few hours to start working).",
      );
    if (res.status === 429)
      throw new ProviderError("rate_limited", "PayPal: too many requests; try later.");
    if (!res.ok)
      throw new ProviderError("provider_error", `PayPal: request failed (HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  async getAccounts(c: PayPalCreds): Promise<ConnectionInfo> {
    const r = await this.get<{
      account_id?: string;
      balances?: { currency?: string; primary?: boolean; total_balance?: { value?: string } }[];
    }>(c, "/v1/reporting/balances?currency_code=USD");
    const usd = r.balances?.find((b) => b.currency === "USD") ?? r.balances?.find((b) => b.primary);
    return {
      institutionName: "PayPal",
      providerRef: r.account_id ?? c.clientId.slice(0, 12),
      accounts: [
        {
          ref: r.account_id ?? "paypal",
          name: "PayPal",
          type: "checking",
          mask: null,
          currency: "USD",
          balanceCents: usd?.total_balance?.value ? cents(usd.total_balance.value) : null,
        },
      ],
    };
  }

  private toTxn(d: TxDetail, accountRef: string): ProviderTransaction | null {
    const i = d.transaction_info;
    if (!i?.transaction_id || !i.transaction_initiation_date) return null;
    if (i.transaction_amount?.currency_code && i.transaction_amount.currency_code !== "USD")
      return null;
    const status = i.transaction_status ?? "S";
    if (status !== "S" && status !== "P") return null; // denied, reversed, voided
    const gross = cents(i.transaction_amount?.value);
    const fee = cents(i.fee_amount?.value);
    const net = gross + fee;
    if (net === 0) return null;
    const p = d.payer_info?.payer_name;
    const name =
      p?.alternate_full_name || [p?.given_name, p?.surname].filter(Boolean).join(" ") || null;
    const item = d.cart_info?.item_details?.[0]?.item_name;
    const label = eventLabel(i.transaction_event_code);
    return {
      ref: i.transaction_id,
      accountRef,
      postedDate: i.transaction_initiation_date.slice(0, 10),
      authorizedDate: null,
      amountCents: net,
      currency: "USD",
      description: [name ?? label, item ?? i.transaction_subject]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 500),
      merchantName: name,
      pending: status === "P",
      pendingRef: null,
      categoryHint:
        label === "Transfer to bank" || label === "Bank deposit to PayPal"
          ? "Internal Transfer"
          : null,
    };
  }

  /** Activity from the cursor (a date) or 3 years back, in 31-day windows. */
  async syncTransactions(c: PayPalCreds, cursor: string | null): Promise<SyncResult> {
    const now = Date.now();
    const from = cursor
      ? Math.max(Date.parse(`${cursor}T00:00:00Z`) - 7 * DAY, now - HISTORY_DAYS * DAY)
      : now - HISTORY_DAYS * DAY;
    const accountRef = (await this.getAccounts(c)).accounts[0]?.ref ?? "paypal";
    const added: ProviderTransaction[] = [];
    for (let start = from; start < now; start += WINDOW_DAYS * DAY) {
      const end = Math.min(now, start + WINDOW_DAYS * DAY - 1000);
      for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
        const q = new URLSearchParams({
          start_date: new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"),
          end_date: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z"),
          fields: "transaction_info,payer_info,cart_info",
          page_size: "500",
          page: String(page),
        });
        const r = await this.get<{ transaction_details?: TxDetail[]; total_pages?: number }>(
          c,
          `/v1/reporting/transactions?${q}`,
        );
        pages = r.total_pages ?? 1;
        for (const d of r.transaction_details ?? []) {
          const t = this.toTxn(d, accountRef);
          if (t) added.push(t);
        }
      }
    }
    return {
      added,
      modified: [],
      removed: [],
      cursor: new Date(now).toISOString().slice(0, 10),
      windowFrom: new Date(from).toISOString().slice(0, 10),
    };
  }

  async remove(): Promise<void> {
    // Nothing to revoke: delete the app (or its secret) in PayPal's dashboard.
  }
}
