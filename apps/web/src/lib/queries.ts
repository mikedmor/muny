import type {
  Account,
  AlertParams,
  AlertRule,
  AlertType,
  AlternativeSuggestion,
  BackupInfo,
  BudgetMonth,
  BulkUpdateInput,
  CategoryGroup,
  CategoryUsage,
  ChannelConfig,
  ChannelType,
  ConnectionSummary,
  CreateAccountInput,
  CreateTransactionInput,
  CryptoNft,
  CryptoOverview,
  CryptoReconcile,
  CryptoSettings,
  CryptoSyncRun,
  CryptoTaxReport,
  CryptoTxnPage,
  CryptoTxnQuery,
  CryptoUsage,
  CryptoWallet,
  CryptoWalletDetail,
  DiyInput,
  DiyProject,
  InfraCost,
  InfraInput,
  Interval,
  InvestBackfillResult,
  InvestImportResult,
  InvestSettings,
  InvestSummary,
  InvestTxn,
  LinkResult,
  LinkStart,
  MarketIntraday,
  MarketOverview,
  NotificationChannel,
  NotificationList,
  PayeeCleanupPreview,
  PayeeSummary,
  RecurringKind,
  RecurringSeries,
  Rule,
  RuleApplyResult,
  RuleInput,
  Saving,
  SavingInput,
  SavingsSummary,
  SecurityPricePoint,
  SetBudgetInput,
  SplitInput,
  SyncConfigStatus,
  SyncSummary,
  Tag,
  Transaction,
  TransactionPage,
  TransactionQuery,
  TransferPreview,
  UiPrefs,
  UpcomingCharge,
  UpdateAccountInput,
  UpdateRecurringInput,
  UpdateTransactionInput,
  WatchItem,
} from "@muny/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "./api.js";

export const keys = {
  accounts: ["accounts"] as const,
  categories: ["categories"] as const,
  transactions: ["transactions"] as const,
  tags: ["tags"] as const,
  rules: ["rules"] as const,
  payees: ["payees"] as const,
  backups: ["backups"] as const,
  connections: ["connections"] as const,
  syncConfig: ["sync-config"] as const,
  recurring: ["recurring"] as const,
  budgets: ["budgets"] as const,
  overview: ["overview"] as const,
  reports: ["reports"] as const,
};

export function useAccounts() {
  return useQuery({ queryKey: keys.accounts, queryFn: () => api.get<Account[]>("/api/accounts") });
}

export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: () => api.get<CategoryGroup[]>("/api/categories"),
  });
}

/** Mutation that refreshes the given query keys on success. */
function useInvalidatingMutation<TIn, TOut>(
  fn: (input: TIn) => Promise<TOut>,
  invalidate: readonly (readonly string[])[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useCreateAccount = () =>
  useInvalidatingMutation(
    (input: CreateAccountInput) => api.post<Account>("/api/accounts", input),
    [keys.accounts],
  );

export const useUpdateAccount = () =>
  useInvalidatingMutation(
    ({ id, ...input }: UpdateAccountInput & { id: string }) =>
      api.patch<Account>(`/api/accounts/${id}`, input),
    [keys.accounts],
  );

export const useDeleteAccount = () =>
  useInvalidatingMutation(
    (id: string) => api.delete(`/api/accounts/${id}`),
    [keys.accounts, keys.categories],
  );

export const useCreateGroup = () =>
  useInvalidatingMutation(
    (input: { name: string; kind?: string }) => api.post("/api/category-groups", input),
    [keys.categories],
  );

export const useUpdateGroup = () =>
  useInvalidatingMutation(
    ({ id, ...input }: { id: string; name?: string; kind?: string }) =>
      api.patch(`/api/category-groups/${id}`, input),
    [keys.categories],
  );

export const useDeleteGroup = () =>
  useInvalidatingMutation(
    (id: string) => api.delete(`/api/category-groups/${id}`),
    [keys.categories],
  );

export const useCreateCategory = () =>
  useInvalidatingMutation(
    (input: { groupId: string; name: string }) => api.post("/api/categories", input),
    [keys.categories],
  );

export const useUpdateCategory = () =>
  useInvalidatingMutation(
    ({
      id,
      ...input
    }: {
      id: string;
      name?: string;
      hidden?: boolean;
      excludeFromBudget?: boolean;
      isBill?: boolean;
      groupId?: string;
      /** An emoji; null goes back to the automatic one. */
      icon?: string | null;
    }) => api.patch(`/api/categories/${id}`, input),
    [keys.categories, keys.budgets, keys.overview, keys.reports],
  );

export const useDeleteUnusedCategories = () =>
  useInvalidatingMutation(
    () => api.post<{ deleted: number }>("/api/categories/delete-unused", {}),
    [keys.categories],
  );

/** What deleting a category would move. */
export function useCategoryUsage(id: string | null) {
  return useQuery({
    queryKey: [...keys.categories, "usage", id],
    queryFn: () => api.get<CategoryUsage>(`/api/categories/${id}/usage`),
    enabled: !!id,
  });
}

export const useDeleteCategory = () =>
  useInvalidatingMutation(
    ({ id, reassignTo }: { id: string; reassignTo?: string }) =>
      api.delete(
        `/api/categories/${id}${reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ""}`,
      ),
    [
      keys.categories,
      keys.transactions,
      keys.rules,
      keys.payees,
      keys.recurring,
      keys.budgets,
      keys.overview,
      keys.reports,
    ],
  );

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

function toQueryString(q: TransactionQuery, offset: number) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  p.set("offset", String(offset));
  p.set("limit", String(PAGE_SIZE));
  return p.toString();
}

export function useTransactions(query: TransactionQuery) {
  return useInfiniteQuery({
    queryKey: [...keys.transactions, query],
    queryFn: ({ pageParam }) =>
      api.get<TransactionPage>(`/api/transactions?${toQueryString(query, pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.items.length < last.total ? last.offset + last.limit : undefined,
    placeholderData: keepPreviousData,
  });
}

export function useTags() {
  return useQuery({ queryKey: keys.tags, queryFn: () => api.get<Tag[]>("/api/tags") });
}

/** Transaction changes also move balances and category counts. */
const txnKeys = [
  keys.transactions,
  keys.accounts,
  keys.categories,
  keys.tags,
  keys.recurring,
  keys.budgets,
  keys.overview,
  keys.reports,
] as const;

export const useCreateTransaction = () =>
  useInvalidatingMutation(
    (input: CreateTransactionInput) => api.post<Transaction>("/api/transactions", input),
    txnKeys,
  );

export const useUpdateTransaction = () =>
  useInvalidatingMutation(
    ({ id, ...input }: UpdateTransactionInput & { id: string }) =>
      api.patch<Transaction>(`/api/transactions/${id}`, input),
    txnKeys,
  );

export const useSetSplits = () =>
  useInvalidatingMutation(
    ({ id, splits }: { id: string; splits: SplitInput[] }) =>
      api.put<Transaction>(`/api/transactions/${id}/splits`, { splits }),
    txnKeys,
  );

export const useDeleteTransaction = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/transactions/${id}`), txnKeys);

export const useBulkUpdate = () =>
  useInvalidatingMutation(
    (input: BulkUpdateInput) => api.post<{ updated: number }>("/api/transactions/bulk", input),
    txnKeys,
  );

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function useRules() {
  return useQuery({ queryKey: keys.rules, queryFn: () => api.get<Rule[]>("/api/rules") });
}

export const useSaveRule = () =>
  useInvalidatingMutation(
    ({ id, ...input }: RuleInput & { id?: string }) =>
      id ? api.patch<Rule>(`/api/rules/${id}`, input) : api.post<Rule>("/api/rules", input),
    [keys.rules],
  );

export const useToggleRule = () =>
  useInvalidatingMutation(
    ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Rule>(`/api/rules/${id}`, { enabled }),
    [keys.rules],
  );

export const useMoveRule = () =>
  useInvalidatingMutation(
    ({ id, direction }: { id: string; direction: "up" | "down" }) =>
      api.post<Rule[]>(`/api/rules/${id}/move`, { direction }),
    [keys.rules],
  );

export const useDeleteRule = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/rules/${id}`), [keys.rules]);

export const useApplyRule = () =>
  useInvalidatingMutation(
    ({ id, includeEdited }: { id?: string; includeEdited: boolean }) =>
      api.post<RuleApplyResult>(id ? `/api/rules/${id}/apply` : "/api/rules/run", {
        includeEdited,
      }),
    [...txnKeys, keys.payees],
  );

// ---------------------------------------------------------------------------
// Payees
// ---------------------------------------------------------------------------

export function usePayees() {
  return useQuery({
    queryKey: keys.payees,
    queryFn: () => api.get<PayeeSummary[]>("/api/payees/manage"),
  });
}

export const useRenamePayee = () =>
  useInvalidatingMutation(
    ({ id, displayName }: { id: string; displayName: string }) =>
      api.patch<{ id: string; merged: boolean }>(`/api/payees/${id}`, { displayName }),
    [keys.payees, keys.transactions],
  );

export const useDeletePayee = () =>
  useInvalidatingMutation(
    (id: string) => api.delete(`/api/payees/${id}`),
    [keys.payees, keys.transactions],
  );

export function usePayeeCleanupPreview(enabled: boolean) {
  return useQuery({
    queryKey: [...keys.payees, "cleanup"],
    queryFn: () => api.post<PayeeCleanupPreview>("/api/payees/cleanup/preview"),
    enabled,
  });
}

export const usePayeeCleanup = () =>
  useInvalidatingMutation(
    () => api.post<{ updated: number }>("/api/payees/cleanup"),
    [keys.payees, keys.transactions],
  );

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface BackupStatus {
  dir: string;
  keep: number;
  intervalHours: number;
  backups: BackupInfo[];
}

export function useBackups() {
  return useQuery({
    queryKey: keys.backups,
    queryFn: () => api.get<BackupStatus>("/api/backups"),
  });
}

export const useCreateBackup = () =>
  useInvalidatingMutation(() => api.post<BackupInfo>("/api/backups"), [keys.backups]);

// ---------------------------------------------------------------------------
// Bank connections
// ---------------------------------------------------------------------------

export function useSyncConfig() {
  return useQuery({
    queryKey: keys.syncConfig,
    queryFn: () => api.get<SyncConfigStatus>("/api/sync/config"),
    staleTime: 60_000,
  });
}

export function useConnections() {
  return useQuery({
    queryKey: keys.connections,
    queryFn: () => api.get<ConnectionSummary[]>("/api/connections"),
  });
}

const syncKeys = [keys.connections, ...txnKeys, keys.payees] as const;

export const useLinkAccounts = () =>
  useInvalidatingMutation(
    ({ id, accounts }: { id: string; accounts: Record<string, string> }) =>
      api.post<LinkResult>(`/api/connections/${id}/link`, { accounts }),
    syncKeys,
  );

export const useSyncNow = () =>
  useInvalidatingMutation(
    (id: string) => api.post<SyncSummary>(`/api/connections/${id}/sync`),
    syncKeys,
  );

export const useDisconnect = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/connections/${id}`), syncKeys);

export const linkApi = {
  plaidLinkToken: (kind: "bank" | "brokerage" = "bank") =>
    api.post<{ linkToken: string }>("/api/connections/plaid/link-token", { kind }),
  plaidUpdateToken: (id: string) =>
    api.post<{ linkToken: string }>(`/api/connections/${id}/plaid/update-token`),
  plaidExchange: (publicToken: string, kind: "bank" | "brokerage" = "bank") =>
    api.post<LinkStart>("/api/connections/plaid/exchange", { publicToken, kind }),
  plaidReauthed: (id: string) => api.post<SyncSummary>(`/api/connections/${id}/reauthed`),
  tellerEnroll: (body: { accessToken: string; enrollmentId: string; connectionId?: string }) =>
    api.post<LinkStart>("/api/connections/teller/enroll", body),
  linkable: (id: string) => api.get<LinkStart>(`/api/connections/${id}/accounts`),
};

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const useNotTransfer = () =>
  useInvalidatingMutation(
    (id: string) => api.delete<Transaction>(`/api/transactions/${id}/transfer`),
    txnKeys,
  );

export function useTransferPreview(enabled: boolean) {
  return useQuery({
    queryKey: [...keys.transactions, "transfer-preview"],
    queryFn: () => api.post<TransferPreview>("/api/transfers/preview"),
    enabled,
  });
}

export const useApplyTransfers = () =>
  useInvalidatingMutation(() => api.post<{ paired: number }>("/api/transfers/apply"), txnKeys);

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

export function useRecurring() {
  return useQuery({
    queryKey: keys.recurring,
    queryFn: () => api.get<RecurringSeries[]>("/api/recurring"),
  });
}

export function useUpcoming(from: string, to: string) {
  return useQuery({
    queryKey: [...keys.recurring, "upcoming", from, to],
    queryFn: () => api.get<UpcomingCharge[]>(`/api/recurring/upcoming?from=${from}&to=${to}`),
    placeholderData: keepPreviousData,
  });
}

export function useRecurringHistory(id: string | null) {
  return useQuery({
    queryKey: [...keys.recurring, "history", id],
    queryFn: () => api.get<Transaction[]>(`/api/recurring/${id}/transactions`),
    enabled: !!id,
  });
}

export const useUpdateRecurring = () =>
  useInvalidatingMutation(
    ({ id, ...input }: UpdateRecurringInput & { id: string }) =>
      api.patch<RecurringSeries>(`/api/recurring/${id}`, input),
    [keys.recurring, keys.transactions, keys.budgets, keys.reports, keys.overview],
  );

export const useCreateRecurring = () =>
  useInvalidatingMutation(
    (input: { transactionId: string; interval: Interval; kind?: RecurringKind }) =>
      api.post<RecurringSeries>("/api/recurring", input),
    [keys.recurring, keys.transactions],
  );

export const useDeleteRecurring = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/recurring/${id}`), [keys.recurring]);

export const useRescanRecurring = () =>
  useInvalidatingMutation(
    () => api.post<{ created: number; updated: number; linked: number }>("/api/recurring/rescan"),
    [keys.recurring, keys.transactions],
  );

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const useSetBudget = () =>
  useInvalidatingMutation(
    (input: SetBudgetInput) => api.put<BudgetMonth>("/api/budgets", input),
    [keys.budgets],
  );

export const useDeleteBudget = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/budgets/${id}`), [keys.budgets]);

// ---------------------------------------------------------------------------
// Alerts & notifications
// ---------------------------------------------------------------------------

export const alertKeys = {
  notifications: ["notifications"] as const,
  rules: ["alert-rules"] as const,
  channels: ["alert-channels"] as const,
};

export function useNotifications() {
  return useQuery({
    queryKey: alertKeys.notifications,
    queryFn: () => api.get<NotificationList>("/api/notifications?limit=100"),
    // Alerts are checked on the server every 5 minutes.
    refetchInterval: 60_000,
  });
}

export const useMarkRead = () =>
  useInvalidatingMutation(
    (ids?: string[]) => api.post("/api/notifications/read", ids ? { ids } : {}),
    [alertKeys.notifications],
  );

export const useRunAlerts = () =>
  useInvalidatingMutation(() => api.post("/api/alerts/run"), [alertKeys.notifications]);

export function useAlertRules() {
  return useQuery({
    queryKey: alertKeys.rules,
    queryFn: () => api.get<AlertRule[]>("/api/alerts/rules"),
  });
}

export const useUpdateAlertRule = () =>
  useInvalidatingMutation(
    ({
      type,
      ...body
    }: {
      type: AlertType;
      enabled?: boolean;
      params?: AlertParams;
      channelIds?: string[];
    }) => api.patch<AlertRule>(`/api/alerts/rules/${type}`, body),
    [alertKeys.rules],
  );

export function useChannels() {
  return useQuery({
    queryKey: alertKeys.channels,
    queryFn: () => api.get<NotificationChannel[]>("/api/alerts/channels"),
  });
}

export const useSaveChannel = () =>
  useInvalidatingMutation(
    ({
      id,
      ...body
    }: {
      id?: string;
      type?: ChannelType;
      name?: string;
      enabled?: boolean;
      config?: ChannelConfig;
    }) =>
      id
        ? api.patch<NotificationChannel>(`/api/alerts/channels/${id}`, body)
        : api.post<NotificationChannel>("/api/alerts/channels", body),
    [alertKeys.channels],
  );

export const useDeleteChannel = () =>
  useInvalidatingMutation(
    (id: string) => api.delete(`/api/alerts/channels/${id}`),
    [alertKeys.channels, alertKeys.rules],
  );

export const useTestChannel = () =>
  useInvalidatingMutation(
    (id: string) => api.post(`/api/alerts/channels/${id}/test`),
    [alertKeys.channels],
  );

// ---------------------------------------------------------------------------
// Savings, DIY replacements, self-hosting costs
// ---------------------------------------------------------------------------

export const savingKeys = {
  all: ["savings"] as const,
  diy: ["diy"] as const,
  infra: ["infra"] as const,
};
const savingInvalidates = [savingKeys.all, savingKeys.diy, savingKeys.infra, keys.recurring];

export const useSavings = () =>
  useQuery({
    queryKey: [...savingKeys.all, "list"],
    queryFn: () => api.get<Saving[]>("/api/savings"),
  });
export const useSavingsSummary = () =>
  useQuery({
    queryKey: [...savingKeys.all, "summary"],
    queryFn: () => api.get<SavingsSummary>("/api/savings/summary"),
  });
export const useAlternativeSuggestions = () =>
  useQuery({
    queryKey: [...savingKeys.all, "alternatives"],
    queryFn: () => api.get<AlternativeSuggestion[]>("/api/savings/alternatives"),
  });
export const useDiyProjects = () =>
  useQuery({ queryKey: savingKeys.diy, queryFn: () => api.get<DiyProject[]>("/api/diy") });
export const useInfraCosts = () =>
  useQuery({ queryKey: savingKeys.infra, queryFn: () => api.get<InfraCost[]>("/api/infra") });

export const useRecordSaving = () =>
  useInvalidatingMutation(
    (body: SavingInput) => api.post<Saving>("/api/savings", body),
    savingInvalidates,
  );
export const useUpdateSaving = () =>
  useInvalidatingMutation(
    ({ id, ...body }: { id: string; status?: Saving["status"]; notes?: string | null }) =>
      api.patch<Saving>(`/api/savings/${id}`, body),
    savingInvalidates,
  );
export const useDeleteSaving = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/savings/${id}`), savingInvalidates);

export const useSaveDiy = () =>
  useInvalidatingMutation(
    ({ id, ...body }: DiyInput & { id?: string }) =>
      id ? api.patch<DiyProject>(`/api/diy/${id}`, body) : api.post<DiyProject>("/api/diy", body),
    savingInvalidates,
  );
export const useDeleteDiy = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/diy/${id}`), savingInvalidates);

export const useSaveInfra = () =>
  useInvalidatingMutation(
    ({ id, ...body }: InfraInput & { id?: string }) =>
      id ? api.put<InfraCost>(`/api/infra/${id}`, body) : api.post<InfraCost>("/api/infra", body),
    savingInvalidates,
  );
export const useDeleteInfra = () =>
  useInvalidatingMutation((id: string) => api.delete(`/api/infra/${id}`), savingInvalidates);

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export const cryptoKeys = {
  all: ["crypto"] as const,
  overview: ["crypto", "overview"] as const,
  wallets: ["crypto", "wallets"] as const,
  txns: ["crypto", "txns"] as const,
  settings: ["crypto", "settings"] as const,
  reconcile: ["crypto", "reconcile"] as const,
};

/**
 * While the server is syncing wallets or updating prices (started by a visit
 * or a button), poll every few seconds; when it finishes, reload all crypto
 * data once.
 */
function useCryptoBusy(busy: boolean) {
  const qc = useQueryClient();
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !busy) void qc.invalidateQueries({ queryKey: cryptoKeys.all });
    was.current = busy;
  }, [busy, qc]);
}
const BUSY_POLL_MS = 3000;

export function useCryptoOverview() {
  const q = useQuery({
    queryKey: cryptoKeys.overview,
    queryFn: () => api.get<CryptoOverview>("/api/crypto/overview"),
    refetchInterval: (query) =>
      query.state.data?.syncing || query.state.data?.pricesRefreshing ? BUSY_POLL_MS : false,
  });
  useCryptoBusy(!!(q.data?.syncing || q.data?.pricesRefreshing));
  return q;
}
/** The wallet page: one wallet with counts; polls while it syncs. */
export function useCryptoWallet(id: string) {
  const q = useQuery({
    queryKey: [...cryptoKeys.wallets, id],
    queryFn: () => api.get<CryptoWalletDetail>(`/api/crypto/wallets/${id}`),
    refetchInterval: (query) =>
      query.state.data?.syncing || query.state.data?.queued ? BUSY_POLL_MS : false,
  });
  useCryptoBusy(!!(q.data?.syncing || q.data?.queued));
  return q;
}
export const useCryptoSyncRuns = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: [...cryptoKeys.wallets, id, "syncs"],
    queryFn: () => api.get<CryptoSyncRun[]>(`/api/crypto/wallets/${id}/syncs`),
    enabled,
  });
export const useCryptoReconcile = () =>
  useQuery({
    queryKey: cryptoKeys.reconcile,
    queryFn: () => api.get<CryptoReconcile>("/api/crypto/reconcile"),
  });
export function useCryptoWallets() {
  const q = useQuery({
    queryKey: cryptoKeys.wallets,
    queryFn: () => api.get<CryptoWallet[]>("/api/crypto/wallets"),
    refetchInterval: (query) =>
      query.state.data?.some((w) => w.syncing || w.queued) ? BUSY_POLL_MS : false,
  });
  useCryptoBusy(!!q.data?.some((w) => w.syncing || w.queued));
  return q;
}
export function useCryptoTxns(q: CryptoTxnQuery) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  return useQuery({
    queryKey: [...cryptoKeys.txns, q],
    queryFn: () => api.get<CryptoTxnPage>(`/api/crypto/txns?${p}`),
    placeholderData: keepPreviousData,
  });
}
export const useCryptoSettings = () =>
  useQuery({
    queryKey: cryptoKeys.settings,
    queryFn: () =>
      api.get<
        CryptoSettings & {
          updatedAt: number | null;
          lastError: string | null;
          usage: CryptoUsage[];
        }
      >("/api/crypto/settings"),
  });
export const useCryptoMutation = <TIn, TOut>(fn: (input: TIn) => Promise<TOut>) =>
  useInvalidatingMutation(fn, [cryptoKeys.all]);

/** Possible other sides of a transfer for one transaction ("Mark as transfer"). */
export interface CryptoTransferMatch {
  id: string;
  walletId: string;
  walletName: string;
  at: number;
  asset: string;
  amount: string;
}
export const useCryptoTransferMatches = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: [...cryptoKeys.txns, "matches", id],
    queryFn: () => api.get<CryptoTransferMatch[]>(`/api/crypto/txns/${id}/matches`),
    enabled,
  });

/** The tax view (flows and realized gains for a range; holdings by term). */
export const useCryptoTax = (from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return useQuery({
    queryKey: [...cryptoKeys.all, "tax", from ?? "", to ?? ""],
    queryFn: () => api.get<CryptoTaxReport>(`/api/crypto/tax?${p}`),
    placeholderData: keepPreviousData,
  });
};

/** NFTs in synced wallets. */
export const useCryptoNfts = () =>
  useQuery({
    queryKey: [...cryptoKeys.all, "nfts"],
    queryFn: () => api.get<CryptoNft[]>("/api/crypto/nfts"),
  });

// ---------------------------------------------------------------------------
// Investments (stocks, ETFs, funds)
// ---------------------------------------------------------------------------

export const investKeys = { all: ["invest"] as const };

export const useInvestSummary = () =>
  useQuery({
    queryKey: [...investKeys.all, "summary"],
    queryFn: () => api.get<InvestSummary>("/api/invest/summary"),
  });

export const useInvestTxns = (accountId?: string) =>
  useQuery({
    queryKey: [...investKeys.all, "txns", accountId ?? "all"],
    queryFn: () =>
      api.get<InvestTxn[]>(
        `/api/invest/transactions${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`,
      ),
  });

export const useInvestImport = () =>
  useInvalidatingMutation(
    (b: { content: string; targets: Record<string, string> }) =>
      api.post<InvestImportResult>("/api/invest/import/commit", b),
    [investKeys.all, keys.accounts, keys.overview, keys.reports],
  );

export const useInvestBackfill = () =>
  useInvalidatingMutation(
    () => api.post<InvestBackfillResult>("/api/invest/history/backfill"),
    [investKeys.all, keys.overview, keys.reports],
  );

export const useSecurityPrices = (securityId: string | null) =>
  useQuery({
    queryKey: [...investKeys.all, "prices", securityId ?? ""],
    queryFn: () => api.get<SecurityPricePoint[]>(`/api/invest/securities/${securityId}/prices`),
    enabled: !!securityId,
  });

export const useWatchlist = () =>
  useQuery({
    queryKey: [...investKeys.all, "watchlist"],
    queryFn: () => api.get<{ items: WatchItem[]; stale: boolean }>("/api/invest/watchlist"),
  });

export const useWatchAdd = () =>
  useInvalidatingMutation(
    (symbol: string) => api.post<{ securityId: string }>("/api/invest/watchlist", { symbol }),
    [investKeys.all],
  );

export const useWatchRemove = () =>
  useInvalidatingMutation(
    (id: string) => api.delete(`/api/invest/watchlist/${encodeURIComponent(id)}`),
    [investKeys.all],
  );

export const useWatchRefresh = () =>
  useInvalidatingMutation(
    () => api.post<{ refreshed: number }>("/api/invest/watchlist/refresh"),
    [investKeys.all],
  );

export const useSetHoldingCost = () =>
  useInvalidatingMutation(
    (b: { accountId: string; securityId: string; perShare?: string; clear?: boolean }) =>
      api.put(
        `/api/invest/holdings/${encodeURIComponent(b.accountId)}/${encodeURIComponent(b.securityId)}/cost`,
        b.clear ? { clear: true } : { perShare: b.perShare },
      ),
    [investKeys.all],
  );

export const useInvestSettings = () =>
  useQuery({
    queryKey: [...investKeys.all, "settings"],
    queryFn: () => api.get<InvestSettings>("/api/invest/settings"),
  });

export const useSetInvestSettings = () =>
  useInvalidatingMutation(
    (patch: Partial<InvestSettings>) => api.put<InvestSettings>("/api/invest/settings", patch),
    [investKeys.all],
  );

export const useMarket = (enabled: boolean) =>
  useQuery({
    queryKey: [...investKeys.all, "market"],
    queryFn: () => api.get<MarketOverview>("/api/invest/market"),
    enabled,
    staleTime: 15 * 60_000,
  });

export const useMarketIntraday = (symbol: string, enabled: boolean) =>
  useQuery({
    queryKey: [...investKeys.all, "market", "intraday", symbol],
    queryFn: () =>
      api.get<MarketIntraday>(`/api/invest/market/intraday?symbol=${encodeURIComponent(symbol)}`),
    enabled,
    staleTime: 5 * 60_000,
  });

export const useUiPrefs = () =>
  useQuery({
    queryKey: ["ui-prefs"],
    queryFn: () => api.get<UiPrefs>("/api/settings/ui"),
    staleTime: 5 * 60_000,
  });

export const useSetUiPrefs = () =>
  useInvalidatingMutation(
    (patch: Partial<UiPrefs>) => api.put<UiPrefs>("/api/settings/ui", patch),
    [["ui-prefs"]],
  );
