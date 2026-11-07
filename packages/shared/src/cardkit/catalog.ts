/**
 * Everything a custom card can read. This list is the whole of it: a card can't
 * name a table, only a dataset here, and each dataset is built field by field on
 * the server. Passwords, sessions, bank credentials, API keys, encrypted wallet
 * addresses and raw provider data are in no dataset, so no card can reach them.
 */

/** money: integer cents. percent: a fraction (0.25 shows as 25%). */
export type FieldType = "money" | "number" | "percent" | "text" | "date" | "month" | "boolean";

export interface FieldInfo {
  id: string;
  label: string;
  type: FieldType;
  hint?: string;
}

export interface DatasetInfo {
  id: string;
  label: string;
  /** How the data browser groups it. */
  group: string;
  description: string;
  /** The field a date range applies to, if it has one. */
  dateField?: string;
  fields: FieldInfo[];
}

const text = (id: string, label: string, hint?: string): FieldInfo => ({
  id,
  label,
  type: "text",
  ...(hint ? { hint } : {}),
});
const money = (id: string, label: string, hint?: string): FieldInfo => ({
  id,
  label,
  type: "money",
  ...(hint ? { hint } : {}),
});
const num = (id: string, label: string, hint?: string): FieldInfo => ({
  id,
  label,
  type: "number",
  ...(hint ? { hint } : {}),
});
const pct = (id: string, label: string, hint?: string): FieldInfo => ({
  id,
  label,
  type: "percent",
  ...(hint ? { hint } : {}),
});
const date = (id: string, label: string, hint?: string): FieldInfo => ({
  id,
  label,
  type: "date",
  ...(hint ? { hint } : {}),
});
const month = (id: string, label: string): FieldInfo => ({ id, label, type: "month" });
const bool = (id: string, label: string, hint?: string): FieldInfo => ({
  id,
  label,
  type: "boolean",
  ...(hint ? { hint } : {}),
});

export const DATASETS: DatasetInfo[] = [
  {
    id: "transactions",
    label: "Transactions",
    group: "Money",
    description:
      "Every transaction, with split transactions as one row per part. Hidden transactions are left out.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      money("amount", "Amount", "Signed: money out is negative."),
      money(
        "spending",
        "Spending",
        "What counts as spending in reports: positive, refunds negative, transfers and income left out.",
      ),
      money("income", "Income", "What counts as income in reports."),
      text("merchant", "Merchant"),
      text("description", "Bank description"),
      text("category", "Category", "Uncategorized when it has none."),
      text("category_group", "Category group"),
      text("category_kind", "Category type", "expense, income or transfer."),
      bool("is_bill", "Bill category"),
      text("account", "Account"),
      text("account_type", "Account type"),
      text("institution", "Institution"),
      bool("pending", "Pending"),
      bool("is_transfer", "Transfer"),
      bool("is_split", "Part of a split"),
      text("recurring", "Recurring charge"),
      text("tags", "Tags"),
      text("notes", "Notes"),
      text("currency", "Currency"),
      bool(
        "is_funding",
        "Only funded another purchase",
        "A bank's withdrawal to PayPal and the like, which the app lists as part of that purchase.",
      ),
      text(
        "merchant_or_description",
        "Merchant and bank description",
        "For finding text in either.",
      ),
      text("category_id", "Category id"),
      text("account_id", "Account id"),
    ],
  },
  {
    id: "accounts",
    label: "Accounts",
    group: "Money",
    description: "Each account you haven't hidden, with its balance now.",
    fields: [
      text("name", "Account"),
      text("type", "Type", "checking, savings, credit, loan, investment, cash, asset or other."),
      text("type_group", "Type group", "Checking, Credit cards, Savings, Investments, Loans…"),
      text("institution", "Institution"),
      text("mask", "Last 4 digits"),
      money("balance", "Balance", "Signed: debts are negative."),
      money("value", "Asset value", "The balance if it's an asset, otherwise 0."),
      money("owed", "Owed", "What you owe if it's a debt, otherwise 0."),
      bool("is_debt", "Debt"),
      bool("in_reports", "Counts in reports"),
      text("provider", "Connected through"),
      num("transaction_count", "Transactions"),
      date("last_transaction", "Latest transaction"),
      text("currency", "Currency"),
    ],
  },
  {
    id: "balance_history",
    label: "Balance history",
    group: "Money",
    description: "Recorded balances, one row per account and date.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("account", "Account"),
      text("account_type", "Account type"),
      money("balance", "Balance"),
      bool("estimated", "Estimated"),
    ],
  },
  {
    id: "net_worth",
    label: "Net worth history",
    group: "Money",
    description:
      "Assets (including crypto), debts, net worth and cash, weekly over the range you choose.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      money("assets", "Assets"),
      money("debts", "Debts"),
      money("net", "Net worth"),
      money("cash", "Cash", "Checking and savings."),
      money("crypto", "Crypto", "Part of Assets."),
      bool(
        "estimated",
        "Estimated",
        "A home, vehicle or similar is between two recorded values here, so its value is worked out.",
      ),
    ],
  },
  {
    id: "categories",
    label: "Categories",
    group: "Money",
    description: "Your categories and how they're set up.",
    fields: [
      text("name", "Category"),
      text("group", "Group"),
      text("kind", "Type", "expense, income or transfer."),
      bool("hidden", "Hidden"),
      bool("is_bill", "Bill"),
      bool("excluded_from_budget", "Left out of budgets"),
    ],
  },
  {
    id: "budgets",
    label: "Budgets",
    group: "Budgets",
    description:
      "One row per month and budget line, for each month in the range. Use Line type to pick category budgets or the overall total.",
    dateField: "month",
    fields: [
      month("month", "Month"),
      text("name", "Budget"),
      text("group", "Group"),
      text(
        "line_type",
        "Line type",
        "category, total (overall spending), income (earnings), bills or other.",
      ),
      money("budget", "Budgeted"),
      money("spent", "Spent", "For the income line: received."),
      money("available", "Left", "Budget plus rollover, minus spent."),
      money("rollover", "Rolled over"),
      money("average", "Past average", "Average over the previous 3 months."),
      bool("has_budget", "Has a budget"),
      bool("is_bill", "Bill"),
    ],
  },
  {
    id: "budget_forecast",
    label: "Budget forecast",
    group: "Budgets",
    description: "What each month in the range should end up looking like, from recurring charges.",
    dateField: "month",
    fields: [
      month("month", "Month"),
      money("income_so_far", "Income so far"),
      money("income_expected", "Income still expected"),
      money("income_average", "Average income"),
      money("recurring_paid", "Bills paid"),
      money("recurring_due", "Bills still due"),
      money("projected_spending", "Projected spending"),
      money("projected_income", "Projected income"),
      money("projected_leftover", "Projected left over"),
    ],
  },
  {
    id: "recurring",
    label: "Recurring charges",
    group: "Bills",
    description: "Subscriptions, bills and income Muny tracks. Ignored ones are left out.",
    fields: [
      text("name", "Name"),
      text("kind", "Kind", "subscription, bill or income."),
      text("status", "Status", "detected, confirmed or cancelled."),
      text("interval", "How often"),
      money("amount", "Expected amount", "Signed: money out is negative."),
      money("monthly", "Per month", "Signed, evened out to one month."),
      money("yearly", "Per year", "Signed, evened out to one year."),
      money("last_amount", "Latest amount"),
      date("first_date", "First charge"),
      date("last_date", "Latest charge"),
      date("next_date", "Next charge"),
      bool("active", "Still running"),
      bool("late", "Late"),
      bool("pending", "Pending now"),
      money("paid_this_month", "Paid this month"),
      num("charge_count", "Charges"),
      text("category", "Category"),
      text("account", "Account"),
      text("notes", "Notes"),
    ],
  },
  {
    id: "upcoming",
    label: "Upcoming charges",
    group: "Bills",
    description:
      "Charges and income expected on each date in the range (the next 30 days if unset).",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("name", "Name"),
      text("kind", "Kind", "subscription, bill or income."),
      money("amount", "Amount", "Signed: money out is negative."),
      text("account", "Account"),
      bool("pending", "Pending now"),
    ],
  },
  {
    id: "trials",
    label: "Free trials",
    group: "Bills",
    description: "Free trials you're tracking.",
    dateField: "end_date",
    fields: [
      text("name", "Name"),
      date("start_date", "Started"),
      date("end_date", "Ends"),
      money("price", "Price after"),
      text("interval", "How often"),
      text("status", "Status", "active, cancelled or kept."),
      num("days_left", "Days left"),
      text("notes", "Notes"),
    ],
  },
  {
    id: "loans",
    label: "Loans",
    group: "Debt",
    description: "Each loan, with what you owe and when it ends.",
    fields: [
      text("name", "Loan"),
      text("lender", "Lender"),
      text("kind", "Kind", "student, mortgage, auto, personal, credit_line or other."),
      money("balance", "Owed"),
      pct("apr", "Interest rate"),
      money("monthly_payment", "Monthly payment"),
      money("minimum_payment", "Minimum payment"),
      date("next_due", "Next due"),
      money("original", "Original amount"),
      date("start_date", "Started"),
      num("term_months", "Term in months"),
      pct("paid_off", "Paid off"),
      money("interest_this_year", "Interest this year"),
      money("interest_remaining", "Interest left to pay"),
      date("payoff_date", "Paid off by"),
      num("payoff_months", "Months left"),
      date("last_payment_date", "Latest payment"),
      money("last_payment", "Latest payment amount"),
      text("institution", "Institution"),
    ],
  },
  {
    id: "loan_payments",
    label: "Loan payments",
    group: "Debt",
    description: "Payments on each loan, up to two years back.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("loan", "Loan"),
      text("lender", "Lender"),
      money("amount", "Paid"),
      money("interest", "To interest"),
      money("principal", "To principal"),
      money("escrow", "To escrow"),
      text("from_account", "Paid from"),
    ],
  },
  {
    id: "loan_history",
    label: "Loan balance history",
    group: "Debt",
    description: "What you owed on each loan after each payment.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("loan", "Loan"),
      text("lender", "Lender"),
      money("balance", "Owed"),
    ],
  },
  {
    id: "credit_cards",
    label: "Credit cards",
    group: "Debt",
    description: "Each card, with its balance, limit and what's due.",
    fields: [
      text("name", "Card"),
      text("issuer", "Issuer"),
      money("balance", "Owed"),
      money("limit", "Limit"),
      money("available", "Available"),
      pct("utilization", "Share of limit used"),
      pct("apr", "Interest rate"),
      money("statement_balance", "Statement balance"),
      date("statement_date", "Statement date"),
      money("minimum_payment", "Minimum payment"),
      date("due_date", "Due"),
      money("spent_since_statement", "Spent since statement"),
      money("interest_this_year", "Interest this year"),
      date("last_payment_date", "Latest payment"),
      money("last_payment", "Latest payment amount"),
      text("institution", "Institution"),
    ],
  },
  {
    id: "card_history",
    label: "Credit card balance history",
    group: "Debt",
    description: "What you owed on each card, by month.",
    dateField: "date",
    fields: [date("date", "Date"), text("card", "Card"), money("balance", "Owed")],
  },
  {
    id: "holdings",
    label: "Stock holdings",
    group: "Investments",
    description: "Each holding, one row per account.",
    fields: [
      text("symbol", "Symbol"),
      text("name", "Name"),
      text("type", "Type", "equity, etf, mutual_fund, bond, option, cash or other."),
      text("account", "Account"),
      num("quantity", "Shares"),
      money("value", "Value"),
      money("cost", "Cost"),
      money("gain", "Gain"),
    ],
  },
  {
    id: "investment_transactions",
    label: "Investment transactions",
    group: "Investments",
    description: "Buys, sales, dividends and more.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("type", "Type", "buy, sell, dividend, interest, deposit, fee…"),
      text("symbol", "Symbol"),
      text("name", "Name"),
      text("account", "Account"),
      num("quantity", "Shares"),
      money("amount", "Cash effect", "Negative for a buy, positive for a sale or dividend."),
      money("fees", "Fees"),
    ],
  },
  {
    id: "crypto_holdings",
    label: "Crypto holdings",
    group: "Investments",
    description: "Each coin across your wallets.",
    fields: [
      text("asset", "Coin"),
      text("name", "Name"),
      num("amount", "Amount"),
      money("value", "Value"),
      money("cost", "Cost"),
      money("gain", "Gain"),
      pct("change_24h", "Change today"),
      pct("allocation", "Share of portfolio"),
    ],
  },
  {
    id: "crypto_history",
    label: "Crypto value history",
    group: "Investments",
    description: "Your whole portfolio's value and cost by day.",
    dateField: "date",
    fields: [date("date", "Date"), money("value", "Value"), money("cost", "Cost")],
  },
  {
    id: "crypto_history_by_asset",
    label: "Crypto value history by coin",
    group: "Investments",
    description: "The value of each of your largest coins by day, plus Other.",
    dateField: "date",
    fields: [date("date", "Date"), text("asset", "Coin"), money("value", "Value")],
  },
  {
    id: "crypto_transactions",
    label: "Crypto transactions",
    group: "Investments",
    description: "Deposits, withdrawals, trades and transfers.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("type", "Type", "deposit, withdrawal, trade or transfer."),
      text("label", "Label", "reward, staking, airdrop and so on."),
      text("wallet", "Wallet"),
      text("sent_asset", "Sent coin"),
      num("sent_amount", "Sent amount"),
      text("received_asset", "Received coin"),
      num("received_amount", "Received amount"),
      money("value", "Value then"),
      money("fee", "Fee value"),
    ],
  },
  {
    id: "crypto_wallets",
    label: "Crypto wallets",
    group: "Investments",
    description: "Your wallets and exchanges. Addresses and keys are not included.",
    fields: [
      text("name", "Wallet"),
      text("kind", "Kind", "blockchain, exchange or manual."),
      text("chain", "Chain"),
      text("status", "Status"),
      bool("archived", "Archived"),
    ],
  },
  {
    id: "savings_accounts",
    label: "Savings accounts",
    group: "Savings",
    description: "Savings accounts with their rates and interest.",
    fields: [
      text("name", "Account"),
      text("institution", "Institution"),
      money("balance", "Balance"),
      pct("apy", "Rate you entered"),
      pct("earned_apy", "Rate earned"),
      money("interest_30_days", "Interest, last 30 days"),
      money("interest_this_year", "Interest this year"),
      money("interest_12_months", "Interest, last 12 months"),
      money("interest_all_time", "Interest, all time"),
      money("average_contribution", "Average added per month"),
    ],
  },
  {
    id: "savings_months",
    label: "Savings by month",
    group: "Savings",
    description: "Each savings account's last 24 months.",
    dateField: "month",
    fields: [
      month("month", "Month"),
      text("account", "Account"),
      money("balance", "Balance"),
      money("interest", "Interest"),
      money("deposits", "Added"),
      money("withdrawals", "Taken out"),
    ],
  },
  {
    id: "savings_buckets",
    label: "Savings categories",
    group: "Savings",
    description: "Categories inside your savings accounts, with their goals.",
    fields: [
      text("name", "Category"),
      text("account", "Account"),
      money("balance", "Balance"),
      money("goal", "Goal"),
      money("monthly_cap", "Saves up to, per month"),
      bool("is_main", "The account's own cash"),
    ],
  },
  {
    id: "money_saved",
    label: "Money saved",
    group: "Savings",
    description: "Subscriptions you cancelled, downgraded or replaced, and what they've saved.",
    dateField: "effective_date",
    fields: [
      text("name", "Name"),
      text("kind", "Kind", "cancelled, downgraded, negotiated, replaced or other."),
      text("status", "Status", "projected, verified or failed."),
      money("before", "Cost before, per month"),
      money("after", "Cost after, per month"),
      money("monthly", "Saved per month"),
      money("saved_so_far", "Saved so far"),
      date("effective_date", "Since"),
    ],
  },
  {
    id: "assets",
    label: "Assets",
    group: "Property",
    description: "Things you own: homes, vehicles and so on.",
    fields: [
      text("name", "Asset"),
      text("kind", "Kind", "home, vehicle or other."),
      money("value", "Value"),
      money("purchase_price", "Paid"),
      date("purchase_date", "Bought"),
      money("owed", "Owed on it"),
      money("equity", "Equity"),
      money("gain", "Gain since buying"),
    ],
  },
  {
    id: "infrastructure_costs",
    label: "Self-hosting costs",
    group: "Property",
    description: "What running your own services costs per month.",
    fields: [
      text("name", "Name"),
      text("kind", "Kind"),
      money("monthly", "Per month"),
      date("start_date", "Since"),
    ],
  },
  {
    id: "documents",
    label: "Documents",
    group: "Records",
    description: "Details of the documents you keep. The files themselves aren't included.",
    dateField: "date",
    fields: [
      text("name", "Name"),
      text("kind", "Kind"),
      text("folder", "Folder"),
      text("lender", "Lender"),
      date("date", "Date"),
      text("account", "Account"),
      num("size_kb", "Size in KB"),
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    group: "Records",
    description: "Alerts Muny has raised.",
    dateField: "date",
    fields: [
      date("date", "Date"),
      text("title", "Title"),
      text("body", "Details"),
      text("type", "Type"),
      text("severity", "Severity", "info or warning."),
      bool("read", "Read"),
    ],
  },
];

export const DATASET_BY_ID = new Map(DATASETS.map((d) => [d.id, d]));

/** Find a field by id or label, any case. */
export function findField(dataset: DatasetInfo, name: string): FieldInfo | undefined {
  const lower = name.trim().toLowerCase();
  return (
    dataset.fields.find((f) => f.id === lower) ??
    dataset.fields.find((f) => f.label.toLowerCase() === lower)
  );
}
