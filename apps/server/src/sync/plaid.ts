import type { AccountType } from "@muny/shared";
import type { PlaidConfig } from "../config.js";
import {
  type ConnectionInfo,
  type InvestmentSync,
  type Provider,
  type ProviderAccount,
  ProviderError,
  type ProviderTransaction,
  type SyncResult,
} from "./types.js";

/**
 * Plaid provider (https://plaid.com/docs/api/). Uses the JSON API directly
 * with the instance owner's own keys; no SDK. Banks use the Transactions
 * product; brokerage logins use Investments (holdings and history) instead.
 */

export type PlaidProduct = "transactions" | "investments";
export type PlaidLinkKind = "bank" | "brokerage";

export interface PlaidCreds {
  accessToken: string;
  itemId: string;
  /** What this login was linked for; older logins: transactions. */
  products?: PlaidProduct[];
}

const productsFor = (kind: PlaidLinkKind): PlaidProduct[] =>
  kind === "brokerage" ? ["investments"] : ["transactions"];
const has = (creds: PlaidCreds, p: PlaidProduct) =>
  (creds.products ?? ["transactions"]).includes(p);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
} as const;

interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

const REAUTH_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "ACCESS_NOT_GRANTED",
  "NO_ACCOUNTS",
  "USER_PERMISSION_REVOKED",
  "INVALID_ACCESS_TOKEN",
  "ITEM_NOT_FOUND",
]);

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: { current: number | null; available: number | null; iso_currency_code?: string | null };
}

interface PlaidSecurity {
  security_id: string;
  ticker_symbol?: string | null;
  cusip?: string | null;
  name?: string | null;
  type?: string | null;
  is_cash_equivalent?: boolean | null;
}

interface PlaidHolding {
  account_id: string;
  security_id: string;
  quantity: number;
  institution_price?: number | null;
  institution_value?: number | null;
  cost_basis?: number | null;
}

interface PlaidInvestTxn {
  investment_transaction_id: string;
  account_id: string;
  security_id?: string | null;
  date: string;
  name?: string | null;
  quantity?: number | null;
  amount: number;
  price?: number | null;
  fees?: number | null;
  type: string;
  subtype?: string | null;
}

/** A float from Plaid as an exact decimal string (JSON numbers are already rounded). */
function plaidDec(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const s = Math.abs(n) < 1e-6 && n !== 0 ? n.toFixed(12) : String(n);
  return s.includes("e") ? n.toFixed(12).replace(/\.?0+$/, "") : s;
}

const absDec = (s: string | null) => (s?.startsWith("-") ? s.slice(1) : s);

/** Plaid's security type → Muny's. */
export function plaidSecurityType(
  s: PlaidSecurity | undefined,
): InvestmentSync["holdings"][number]["type"] {
  if (!s) return "other";
  if (s.is_cash_equivalent || s.type === "cash") return "cash";
  switch (s.type) {
    case "equity":
      return "equity";
    case "etf":
      return "etf";
    case "mutual fund":
      return "mutual_fund";
    case "fixed income":
      return "bond";
    case "derivative":
      return "option";
    default:
      return "other";
  }
}

/** Plaid's investment transaction type/subtype → Muny's. */
export function plaidInvestTxnType(
  type: string,
  subtype: string | null | undefined,
  quantity: number | null | undefined,
): InvestmentSync["txns"][number]["type"] {
  const sub = (subtype ?? "").toLowerCase();
  if (/split|stock distribution/.test(sub)) return "split";
  if (/dividend|distribution|capital gain/.test(sub) && !/reinvest/.test(sub) && type !== "buy")
    return "dividend";
  if (/interest/.test(sub)) return "interest";
  if (/tax/.test(sub)) return "tax";
  if (type === "buy") return "buy";
  if (type === "sell") return "sell";
  if (type === "fee" || /fee/.test(sub)) return "fee";
  if (/deposit|contribution/.test(sub)) return "deposit";
  if (/withdrawal/.test(sub)) return "withdrawal";
  if (type === "transfer")
    return (quantity ?? 0) < 0 ? "transfer_out" : (quantity ?? 0) > 0 ? "transfer_in" : "other";
  if (type === "cash") return "other";
  return "other";
}

interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name?: string | null;
  original_description?: string | null;
  merchant_name?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
}

/** Plaid floats -> integer cents without float drift. */
export function plaidCents(n: number): number {
  const [whole = "0", frac = ""] = Math.abs(n).toFixed(4).split(".");
  const cents = Number(whole) * 100 + Math.round(Number(`0.${frac}`) * 100);
  return n < 0 ? -cents : cents;
}

export function plaidAccountType(type: string, subtype: string | null | undefined): AccountType {
  switch (type) {
    case "depository":
      return subtype === "savings" ||
        subtype === "money market" ||
        subtype === "cd" ||
        subtype === "hsa"
        ? "savings"
        : "checking";
    case "credit":
      return "credit";
    case "loan":
      return "loan";
    case "investment":
    case "brokerage":
      return "investment";
    default:
      return "other";
  }
}

const LIABILITY = new Set<AccountType>(["credit", "loan"]);

/** Plaid personal finance categories -> Muny default category names. Most specific first. */
const CATEGORY_MAP: [string, string][] = [
  ["FOOD_AND_DRINK_COFFEE", "Coffee"],
  ["FOOD_AND_DRINK_GROCERIES", "Groceries"],
  ["FOOD_AND_DRINK", "Dining & Drinks"],
  ["INCOME_WAGES", "Paycheck"],
  ["INCOME_DIVIDENDS", "Interest & Dividends"],
  ["INCOME_INTEREST_EARNED", "Interest & Dividends"],
  ["INCOME_TAX_REFUND", "Refunds & Reimbursements"],
  ["INCOME", "Other Income"],
  ["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "Credit Card Payment"],
  ["LOAN_PAYMENTS_CAR_PAYMENT", "Auto Payment"],
  ["LOAN_PAYMENTS_MORTGAGE_PAYMENT", "Rent & Mortgage"],
  ["LOAN_PAYMENTS", "Loan Payment"],
  ["TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", "Investments"],
  ["TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", "Investments"],
  ["TRANSFER_IN_SAVINGS", "Savings"],
  ["TRANSFER_OUT_SAVINGS", "Savings"],
  ["TRANSFER_IN_ACCOUNT_TRANSFER", "Internal Transfer"],
  ["TRANSFER_OUT_ACCOUNT_TRANSFER", "Internal Transfer"],
  ["RENT_AND_UTILITIES_RENT", "Rent & Mortgage"],
  ["RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "Electric"],
  ["RENT_AND_UTILITIES_INTERNET_AND_CABLE", "Internet"],
  ["RENT_AND_UTILITIES_TELEPHONE", "Phone"],
  ["RENT_AND_UTILITIES_WATER", "Water & Sewer"],
  ["RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT", "Trash"],
  ["TRANSPORTATION_GAS", "Gas & Fuel"],
  ["TRANSPORTATION_PARKING", "Parking & Tolls"],
  ["TRANSPORTATION_TOLLS", "Parking & Tolls"],
  ["TRANSPORTATION_PUBLIC_TRANSIT", "Public Transit"],
  ["TRANSPORTATION_TAXIS_AND_RIDE_SHARES", "Rideshare"],
  ["TRAVEL", "Travel & Vacation"],
  ["GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES", "Clothing"],
  ["GENERAL_MERCHANDISE_ELECTRONICS", "Electronics"],
  ["GENERAL_MERCHANDISE_PET_SUPPLIES", "Pets"],
  ["GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES", "Gifts"],
  ["GENERAL_MERCHANDISE", "General Merchandise"],
  ["HOME_IMPROVEMENT", "Home & Garden"],
  ["ENTERTAINMENT_TV_AND_MOVIES", "Streaming"],
  ["ENTERTAINMENT_VIDEO_GAMES", "Gaming"],
  ["ENTERTAINMENT", "Entertainment"],
  ["MEDICAL_PHARMACIES_AND_SUPPLEMENTS", "Pharmacy"],
  ["MEDICAL", "Medical"],
  ["PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS", "Fitness"],
  ["PERSONAL_CARE", "Personal Care"],
  ["BANK_FEES", "Fees & Charges"],
  ["GENERAL_SERVICES_INSURANCE", "Insurance"],
  ["GENERAL_SERVICES_EDUCATION", "Education"],
  ["GENERAL_SERVICES_CHILDCARE", "Kids & Family"],
  ["GOVERNMENT_AND_NON_PROFIT_DONATIONS", "Charitable Donations"],
  ["GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT", "Taxes"],
];

export function plaidCategoryHint(pfc: PlaidTxn["personal_finance_category"]): string | null {
  const code = pfc?.detailed ?? pfc?.primary;
  if (!code) return null;
  return CATEGORY_MAP.find(([prefix]) => code.startsWith(prefix))?.[1] ?? null;
}

export class PlaidProvider implements Provider<PlaidCreds> {
  readonly id = "plaid" as const;
  constructor(
    private readonly cfg: PlaidConfig,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${HOSTS[this.cfg.env]}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ProviderError(
        "provider_error",
        "Couldn't reach Plaid. Check the NAS's internet connection.",
      );
    }
    const data = (await res.json().catch(() => ({}))) as T & PlaidErrorBody;
    if (res.ok) return data;
    const code = data.error_code ?? `HTTP_${res.status}`;
    // display_message is meant for end users; error_message is developer-facing but secret-free.
    const msg = `Plaid: ${data.display_message ?? data.error_message ?? "request failed"} (${code})`;
    if (REAUTH_CODES.has(code)) throw new ProviderError("reauth_required", msg);
    if (code === "PRODUCT_NOT_READY") throw new ProviderError("not_ready", msg);
    if (code === "RATE_LIMIT_EXCEEDED" || res.status === 429)
      throw new ProviderError("rate_limited", msg);
    if (
      code === "INVALID_API_KEYS" ||
      data.error_type === "INVALID_INPUT" ||
      data.error_type === "INVALID_REQUEST"
    )
      throw new ProviderError("config", msg);
    throw new ProviderError("provider_error", msg);
  }

  /** Link token for Plaid Link. With an access token it opens update mode (re-login). */
  async createLinkToken(
    userId: string,
    accessToken?: string,
    kind: PlaidLinkKind = "bank",
  ): Promise<string> {
    const body: Record<string, unknown> = {
      client_name: "Muny",
      language: "en",
      country_codes: this.cfg.countryCodes,
      user: { client_user_id: userId },
      ...(this.cfg.redirectUri && { redirect_uri: this.cfg.redirectUri }),
    };
    if (accessToken) body.access_token = accessToken;
    else if (kind === "brokerage") body.products = productsFor(kind);
    else {
      body.products = productsFor(kind);
      body.transactions = { days_requested: 730 };
    }
    const r = await this.call<{ link_token: string }>("/link/token/create", body);
    return r.link_token;
  }

  async exchangePublicToken(
    publicToken: string,
    kind: PlaidLinkKind = "bank",
  ): Promise<PlaidCreds> {
    const r = await this.call<{ access_token: string; item_id: string }>(
      "/item/public_token/exchange",
      { public_token: publicToken },
    );
    return { accessToken: r.access_token, itemId: r.item_id, products: productsFor(kind) };
  }

  async getAccounts(creds: PlaidCreds): Promise<ConnectionInfo> {
    const r = await this.call<{
      accounts: PlaidAccount[];
      item: { institution_id?: string | null };
    }>("/accounts/get", { access_token: creds.accessToken });
    let institutionName: string | null = null;
    if (r.item.institution_id) {
      try {
        const inst = await this.call<{ institution: { name: string } }>("/institutions/get_by_id", {
          institution_id: r.item.institution_id,
          country_codes: this.cfg.countryCodes,
        });
        institutionName = inst.institution.name;
      } catch {
        // Cosmetic only.
      }
    }
    return {
      institutionName,
      providerRef: creds.itemId,
      accounts: r.accounts.map((a): ProviderAccount => {
        const type = plaidAccountType(a.type, a.subtype);
        const cur = a.balances.current;
        const cents = cur === null ? null : plaidCents(cur);
        return {
          ref: a.account_id,
          name: a.name || a.official_name || "Account",
          type,
          mask: a.mask ? a.mask.replace(/\D/g, "").slice(-4) || null : null,
          currency: a.balances.iso_currency_code ?? "USD",
          // Plaid reports what you owe on credit/loans as a positive number.
          balanceCents: cents === null ? null : LIABILITY.has(type) ? -cents : cents,
        };
      }),
    };
  }

  private toTxn(t: PlaidTxn): ProviderTransaction {
    return {
      ref: t.transaction_id,
      accountRef: t.account_id,
      postedDate: t.date,
      authorizedDate: t.authorized_date && t.authorized_date !== t.date ? t.authorized_date : null,
      // Plaid: positive = money out of the account. Muny: negative = money out.
      amountCents: -plaidCents(t.amount),
      currency: t.iso_currency_code ?? t.unofficial_currency_code ?? "USD",
      description: (
        t.original_description ||
        t.name ||
        t.merchant_name ||
        "(no description)"
      ).slice(0, 500),
      merchantName: t.merchant_name ?? null,
      pending: t.pending,
      pendingRef: t.pending_transaction_id ?? null,
      categoryHint: plaidCategoryHint(t.personal_finance_category),
    };
  }

  async syncTransactions(creds: PlaidCreds, cursor: string | null): Promise<SyncResult> {
    // Brokerage logins aren't linked for Transactions: their history comes from Investments.
    if (!has(creds, "transactions")) return { added: [], modified: [], removed: [], cursor };
    // https://plaid.com/docs/api/products/transactions/#transactionssync
    for (let attempt = 0; attempt < 3; attempt++) {
      const added: ProviderTransaction[] = [];
      const modified: ProviderTransaction[] = [];
      const removed: string[] = [];
      let next = cursor;
      try {
        for (let page = 0; page < 200; page++) {
          const r = await this.call<{
            added: PlaidTxn[];
            modified: PlaidTxn[];
            removed: { transaction_id: string }[];
            next_cursor: string;
            has_more: boolean;
          }>("/transactions/sync", {
            access_token: creds.accessToken,
            count: 500,
            options: { include_original_description: true },
            ...(next ? { cursor: next } : {}),
          });
          added.push(...r.added.map((t) => this.toTxn(t)));
          modified.push(...r.modified.map((t) => this.toTxn(t)));
          removed.push(...r.removed.map((x) => x.transaction_id));
          next = r.next_cursor;
          if (!r.has_more) return { added, modified, removed, cursor: next };
        }
        throw new ProviderError("provider_error", "Plaid: too many pages in one sync");
      } catch (e) {
        // Data changed mid-pagination: restart from the original cursor.
        if (
          e instanceof ProviderError &&
          e.message.includes("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")
        )
          continue;
        throw e;
      }
    }
    throw new ProviderError(
      "provider_error",
      "Plaid kept changing data during sync; try again later",
    );
  }

  async syncInvestments(creds: PlaidCreds, since: string | null): Promise<InvestmentSync | null> {
    if (!has(creds, "investments")) return null;
    // https://plaid.com/docs/api/products/investments/
    const h = await this.call<{
      holdings: PlaidHolding[];
      securities: PlaidSecurity[];
    }>("/investments/holdings/get", { access_token: creds.accessToken });
    const secs = new Map<string, PlaidSecurity>();
    const remember = (list: PlaidSecurity[]) => {
      for (const s of list) secs.set(s.security_id, s);
    };
    remember(h.securities);
    const symbolOf = (s: PlaidSecurity | undefined) => {
      if (!s) return null;
      if (plaidSecurityType(s) === "cash") return s.ticker_symbol?.trim().toUpperCase() || "CASH";
      return (s.ticker_symbol || s.cusip || s.name || "").trim().toUpperCase().slice(0, 40) || null;
    };
    const holdings: InvestmentSync["holdings"] = [];
    for (const x of h.holdings) {
      const s = secs.get(x.security_id);
      const symbol = symbolOf(s);
      if (!symbol) continue;
      const type = plaidSecurityType(s);
      const quantity = plaidDec(x.quantity) ?? "0";
      const value =
        x.institution_value !== null && x.institution_value !== undefined
          ? plaidCents(x.institution_value)
          : 0;
      holdings.push({
        accountRef: x.account_id,
        symbol,
        name: (s?.name ?? symbol).slice(0, 200),
        type,
        quantity,
        price: type === "cash" ? "1" : plaidDec(x.institution_price),
        valueCents: value,
        costBasisCents:
          type === "cash"
            ? value
            : x.cost_basis === null || x.cost_basis === undefined
              ? null
              : plaidCents(x.cost_basis),
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 730);
    const txns: InvestmentSync["txns"] = [];
    try {
      for (let offset = 0, page = 0; page < 100; page++) {
        const r = await this.call<{
          investment_transactions: PlaidInvestTxn[];
          securities: PlaidSecurity[];
          total_investment_transactions: number;
        }>("/investments/transactions/get", {
          access_token: creds.accessToken,
          start_date: since ?? from.toISOString().slice(0, 10),
          end_date: today,
          options: { offset, count: 500 },
        });
        remember(r.securities);
        for (const t of r.investment_transactions) {
          const s = t.security_id ? secs.get(t.security_id) : undefined;
          const symbol = symbolOf(s);
          const qty = absDec(plaidDec(t.quantity));
          txns.push({
            ref: t.investment_transaction_id,
            accountRef: t.account_id,
            date: t.date,
            type: plaidInvestTxnType(t.type, t.subtype, t.quantity),
            symbol: symbol === "CASH" ? null : symbol,
            name: s?.name?.slice(0, 200) ?? null,
            quantity: qty && qty !== "0" ? qty : null,
            price: absDec(plaidDec(t.price)),
            // Plaid: positive = cash out of the account. Muny: negative = out.
            amountCents: -plaidCents(t.amount),
            feesCents: Math.abs(plaidCents(t.fees ?? 0)),
            description: [t.subtype, t.name].filter(Boolean).join(" · ").slice(0, 300),
          });
        }
        offset += r.investment_transactions.length;
        if (!r.investment_transactions.length || offset >= r.total_investment_transactions) break;
      }
    } catch (e) {
      // History takes a little while after linking; holdings are enough for now.
      if (!(e instanceof ProviderError && e.code === "not_ready")) throw e;
    }
    return { holdings, txns };
  }

  async remove(creds: PlaidCreds): Promise<void> {
    await this.call("/item/remove", { access_token: creds.accessToken });
  }
}
