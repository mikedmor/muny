import type { MunyDb } from "@muny/db";
import { schema } from "@muny/db";
import { eq } from "drizzle-orm";

/** What each table's rows are called in the history. */
const NOUNS: Record<string, [string, string]> = {
  accounts: ["account", "accounts"],
  account_alerts: ["account alert", "account alerts"],
  agent_proposals: ["inbox item", "inbox items"],
  alert_rules: ["alert setting", "alert settings"],
  api_tokens: ["assistant token", "assistant tokens"],
  app_settings: ["setting", "settings"],
  asset_details: ["asset", "assets"],
  balance_snapshots: ["balance", "balances"],
  budget_amounts: ["budget amount", "budget amounts"],
  budgets: ["budget", "budgets"],
  card_details: ["card", "cards"],
  categories: ["category", "categories"],
  category_groups: ["category group", "category groups"],
  connections: ["bank connection", "bank connections"],
  crypto_tax_docs: ["tax document", "tax documents"],
  crypto_txns: ["crypto transaction", "crypto transactions"],
  crypto_wallets: ["wallet", "wallets"],
  diy_projects: ["DIY project", "DIY projects"],
  document_reviews: ["contract review", "contract reviews"],
  documents: ["document", "documents"],
  mail_templates: ["email template", "email templates"],
  holding_costs: ["cost basis", "cost bases"],
  import_batches: ["import", "imports"],
  infra_costs: ["running cost", "running costs"],
  investment_holdings: ["holding", "holdings"],
  investment_txns: ["investment transaction", "investment transactions"],
  invites: ["invite", "invites"],
  lender_fees: ["lender fee", "lender fees"],
  lender_payments: ["lender payment", "lender payments"],
  loan_details: ["loan", "loans"],
  loan_statement_payments: ["statement payment", "statement payments"],
  notification_channels: ["alert channel", "alert channels"],
  notifications: ["notification", "notifications"],
  payees: ["merchant", "merchants"],
  recurring_series: ["recurring item", "recurring items"],
  rules: ["rule", "rules"],
  savings: ["saving", "savings"],
  savings_buckets: ["savings bucket", "savings buckets"],
  securities: ["security", "securities"],
  statement_templates: ["statement template", "statement templates"],
  tags: ["tag", "tags"],
  transaction_splits: ["split", "splits"],
  transaction_tags: ["transaction tag", "transaction tags"],
  transactions: ["transaction", "transactions"],
  trials: ["trial", "trials"],
  watchlist: ["watchlist item", "watchlist items"],
};

export const noun = (table: string, n: number) => {
  const [one, many] = NOUNS[table] ?? [table.replace(/_/g, " "), table.replace(/_/g, " ")];
  return n === 1 ? one : many;
};

/** Settings rows, by what they hold. */
const SETTINGS: Record<string, string> = {
  "ai.settings": "AI settings",
  "documents.folders": "document folders",
  "mail.settings": "email settings",
  "alerts.perAccount": "account alerts",
  "alerts.vapid": "push notification keys",
  "assets.apillowHomes": "home values",
  "assets.valuationKeys": "value lookup keys",
  "crypto.blockscout_key": "Blockscout key",
  "crypto.coingecko_key": "CoinGecko key",
  "crypto.settings": "crypto settings",
  "crypto.taxdocs.notReceived": "tax documents",
  "crypto.addresses_filled": "wallet addresses",
  "dashboard.cards": "Overview cards",
  "invest.settings": "investment settings",
  "loans.plan": "payoff plan",
  "loans.servicerSplit": "loan payment split",
  "plaid.loginLimit": "Plaid limit",
  "savings.opportunities.dismissed": "Ways to save",
  "savings.planModes": "savings plans",
  "ui.prefs": "appearance settings",
  "ui.themes": "themes",
};

/** What a row is called: its name, or a description. */
export function rowName(row: Record<string, unknown> | null): string | null {
  if (!row) return null;
  for (const k of ["name", "display_name", "title", "description", "raw_description", "symbol"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 60);
  }
  return null;
}

export interface Part {
  tbl: string;
  op: "I" | "U" | "D";
  n: number;
  first: number;
}

/** What a change touched, by table and kind, in the order it touched them. */
export function changeParts(db: MunyDb, id: string): Part[] {
  return db.$client
    .prepare(
      "select tbl, op, count(*) as n, min(seq) as first from change_log where changeset_id = ? group by tbl, op order by first",
    )
    .all(id) as Part[];
}

const DONE = { I: "added", U: "changed", D: "removed" } as const;
const UNDONE = { I: "added back", U: "changed back", D: "removed" } as const;

/** "2 transactions changed". `undoing`: the effects of an undo ("1 rule removed", "changed back"). */
export const partText = (p: Part, undoing = false) =>
  `${p.n} ${noun(p.tbl, p.n)} ${(undoing ? UNDONE : DONE)[p.op]}`;

/** What a route is about, to title its change by that rather than a side effect. */
const ROUTE_TABLES: [string, string][] = [
  ["/api/transactions/:id/splits", "transaction_splits"],
  ["/api/transactions", "transactions"],
  ["/api/transfers", "transactions"],
  ["/api/category-groups", "category_groups"],
  ["/api/categories", "categories"],
  ["/api/accounts", "accounts"],
  ["/api/rules", "rules"],
  ["/api/payees", "payees"],
  ["/api/recurring", "recurring_series"],
  ["/api/budgets", "budget_amounts"],
  ["/api/trials", "trials"],
  ["/api/savings/accounts", "savings_buckets"],
  ["/api/savings", "savings"],
  ["/api/diy", "diy_projects"],
  ["/api/infra", "infra_costs"],
  ["/api/documents", "documents"],
  ["/api/crypto/wallets", "crypto_wallets"],
  ["/api/crypto/txns", "crypto_txns"],
  ["/api/loans", "loan_details"],
  ["/api/cards", "card_details"],
  ["/api/statement-templates", "statement_templates"],
  ["/api/alerts/channels", "notification_channels"],
  ["/api/agents/tokens", "api_tokens"],
  ["/api/household/invites", "invites"],
  ["/api/invest/watchlist", "watchlist"],
  ["/api/connections", "connections"],
];

const routeTable = (route: string | null) => {
  const path = route?.split(" ")[1] ?? "";
  return ROUTE_TABLES.find(([p]) => path === p || path.startsWith(`${p}/`))?.[1];
};

/** A title from what changed: "Changed transaction “Corner Cafe”", "Removed 3 rules". */
export function titleFromParts(db: MunyDb, parts: Part[], route: string | null = null): string {
  const about = routeTable(route);
  const main = parts.find((p) => p.tbl === about) ?? parts[0];
  if (!main) return "A change";
  const verb = { I: "Added", U: "Changed", D: "Removed" }[main.op];
  if (main.n > 1) return `${verb} ${main.n} ${noun(main.tbl, main.n)}`;
  const row = db.$client
    .prepare("select old_row, new_row from change_log where seq = ?")
    .get(main.first) as { old_row: string | null; new_row: string | null } | undefined;
  const data = JSON.parse(row?.new_row ?? row?.old_row ?? "null") as Record<string, unknown> | null;
  if (main.tbl === "app_settings") {
    const what = SETTINGS[String(data?.key)];
    return what ? `${verb} ${what}` : `${verb} settings`;
  }
  const name = rowName(data);
  return `${verb} ${noun(main.tbl, 1)}${name ? ` “${name}”` : ""}`;
}

export function changeTitle(db: MunyDb, id: string, parts = changeParts(db, id)): string {
  const cs = db
    .select({ label: schema.changesets.label, route: schema.changesets.route })
    .from(schema.changesets)
    .where(eq(schema.changesets.id, id))
    .get();
  return cs?.label ?? titleFromParts(db, parts, cs?.route ?? null);
}
