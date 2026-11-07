/**
 * What an AI assistant or script may do, set per token. Reads are split by how
 * sensitive they are. The only writes so far are to how things look (cards, themes,
 * layout), never to financial data.
 */

export const AGENT_SCOPES = [
  "read:summary",
  "read:transactions",
  "read:accounts",
  "read:debts",
  "write:dashboard",
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const AGENT_SCOPE_INFO: Record<AgentScope, { label: string; description: string }> = {
  "read:summary": {
    label: "Summaries",
    description:
      "Totals by category and merchant, budgets, recurring charges and upcoming bills. No individual transactions.",
  },
  "read:transactions": {
    label: "Transactions",
    description: "Each transaction: merchant, amount, date, category, notes and tags.",
  },
  "read:accounts": {
    label: "Accounts and investments",
    description:
      "Account names and balances, net worth, stocks, crypto, savings, assets and document names. Never full account numbers.",
  },
  "read:debts": {
    label: "Loans and credit cards",
    description: "Balances, rates, payments and due dates.",
  },
  "write:dashboard": {
    label: "Build cards and themes",
    description:
      "Create and change Overview cards and themes, and arrange your Overview. Can't change any financial data.",
  },
};

export interface ApiToken {
  id: string;
  name: string;
  /** The start of the token, to tell them apart. */
  prefix: string;
  scopes: AgentScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** The whole token, which is only ever shown this once. */
export interface CreatedApiToken extends ApiToken {
  token: string;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: AgentScope[];
  /** Days until it stops working; null for never. */
  expiresInDays: number | null;
}

export interface AgentActivity {
  at: number;
  action: string;
  ok: boolean;
  dryRun: boolean;
}
