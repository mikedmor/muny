/**
 * What an AI assistant or script may do, set per token. Reads are split by how
 * sensitive they are. Writes to how things look (cards, themes, layout) apply
 * directly. Writes to financial data only ever suggest: a person approves each one.
 */

export const AGENT_SCOPES = [
  "read:summary",
  "read:transactions",
  "read:accounts",
  "read:debts",
  "write:dashboard",
  "write:annotations",
  "write:rules",
  "write:setup",
  "write:plans",
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
  "write:annotations": {
    label: "Suggest categories, tags and notes",
    description:
      "Suggest categorizing and tagging transactions, adding notes, and confirming or ignoring recurring charges. Nothing changes unless you approve it.",
  },
  "write:rules": {
    label: "Suggest rules",
    description: "Suggest rules for transactions. Nothing changes unless you approve it.",
  },
  "write:setup": {
    label: "Suggest budgets",
    description: "Suggest monthly budgets. Nothing changes unless you approve it.",
  },
  "write:plans": {
    label: "Suggest savings and replacement plans",
    description:
      "Suggest recording savings and plans to replace paid services. Nothing changes unless you approve it.",
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

/** One thing an approved proposal would change. */
export interface ProposalChange {
  label: string;
  from?: string | null;
  to?: string | null;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired" | "failed";

export interface AgentProposal {
  id: string;
  tool: string;
  tokenName: string;
  status: ProposalStatus;
  /** Written by Muny from the data. */
  summary: string;
  /** The assistant's own words. */
  reason: string | null;
  changes: ProposalChange[];
  warnings: string[];
  createdAt: number;
  decidedAt: number | null;
  /** What happened, once decided. */
  result: string | null;
}

export interface ProposalList {
  pending: AgentProposal[];
  recent: AgentProposal[];
}

export interface ProposalDecision {
  id: string;
  status: ProposalStatus;
  result: string | null;
}
