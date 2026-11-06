/** API DTOs for accounts and categories. Amounts are integer cents. */

export const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit",
  "loan",
  "investment",
  "cash",
  "asset",
  "other",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit: "Credit card",
  loan: "Loan",
  investment: "Investment",
  cash: "Cash",
  asset: "Property / other asset",
  other: "Other",
};

/** Liability accounts: a positive balance means money owed. */
export const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set(["credit", "loan"]);

export interface Account {
  id: string;
  name: string;
  institutionName: string | null;
  type: AccountType;
  mask: string | null;
  currency: string;
  /**
   * Current balance in cents, signed from the household's perspective:
   * assets positive, debts negative (a card with $50 owed is -5000).
   */
  balanceCents: number;
  balanceSource: "computed" | "reported";
  hidden: boolean;
  excludeFromReports: boolean;
  sortOrder: number;
  provider: "manual" | "file" | "plaid" | "teller" | "simplefin";
  transactionCount: number;
  lastTransactionDate: string | null;
}

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  institutionName?: string | null;
  mask?: string | null;
  currency?: string;
  /** Current balance (signed as in Account.balanceCents). Defaults to 0. */
  balanceCents?: number;
}

export interface UpdateAccountInput {
  name?: string;
  type?: AccountType;
  institutionName?: string | null;
  mask?: string | null;
  hidden?: boolean;
  excludeFromReports?: boolean;
  sortOrder?: number;
  /** Set the current balance; for computed accounts adjusts the opening balance. */
  balanceCents?: number;
}

export type CategoryKind = "expense" | "income" | "transfer";

export interface Category {
  id: string;
  groupId: string;
  name: string;
  icon: string | null;
  color: string | null;
  hidden: boolean;
  sortOrder: number;
  transactionCount: number;
}

export interface CategoryGroup {
  id: string;
  name: string;
  kind: CategoryKind;
  sortOrder: number;
  categories: Category[];
}

/**
 * Default categories created for a new installation. Names line up with
 * Rocket Money's where practical so history imports map cleanly.
 */
export const DEFAULT_CATEGORIES: { group: string; kind: CategoryKind; categories: string[] }[] = [
  {
    group: "Income",
    kind: "income",
    categories: ["Paycheck", "Interest & Dividends", "Refunds & Reimbursements", "Other Income"],
  },
  {
    group: "Housing & Utilities",
    kind: "expense",
    categories: [
      "Rent & Mortgage",
      "Electric",
      "Gas & Heating",
      "Water & Sewer",
      "Trash",
      "Internet",
      "Phone",
      "Home Maintenance",
    ],
  },
  {
    group: "Subscriptions",
    kind: "expense",
    categories: [
      "Streaming",
      "Software & Apps",
      "Cloud & Hosting",
      "Memberships",
      "News & Magazines",
      "Gaming",
    ],
  },
  {
    group: "Food & Dining",
    kind: "expense",
    categories: ["Groceries", "Dining & Drinks", "Coffee", "Food Delivery"],
  },
  {
    group: "Transportation",
    kind: "expense",
    categories: [
      "Gas & Fuel",
      "Auto Payment",
      "Auto Maintenance",
      "Parking & Tolls",
      "Public Transit",
      "Rideshare",
    ],
  },
  {
    group: "Shopping",
    kind: "expense",
    categories: ["General Merchandise", "Clothing", "Electronics", "Home & Garden"],
  },
  {
    group: "Health & Personal",
    kind: "expense",
    categories: ["Medical", "Pharmacy", "Fitness", "Personal Care"],
  },
  {
    group: "Lifestyle",
    kind: "expense",
    categories: [
      "Entertainment",
      "Travel & Vacation",
      "Gifts",
      "Charitable Donations",
      "Pets",
      "Kids & Family",
      "Education",
      "Hobbies",
    ],
  },
  {
    group: "Financial",
    kind: "expense",
    categories: ["Insurance", "Loan Payment", "Fees & Charges", "Taxes", "Business Expenses"],
  },
  {
    group: "Transfers",
    kind: "transfer",
    categories: ["Credit Card Payment", "Internal Transfer", "Savings", "Investments"],
  },
];

/** Display preferences (Settings → Display), shared by the household. */
export interface UiPrefs {
  /** Split chart totals into colored parts (categories, coins, holdings). */
  splitCharts: boolean;
}
