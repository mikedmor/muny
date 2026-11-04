import type {
  Account,
  BackupInfo,
  BudgetMonth,
  BulkUpdateInput,
  CategoryGroup,
  ConnectionSummary,
  CreateAccountInput,
  CreateTransactionInput,
  Interval,
  LinkResult,
  LinkStart,
  PayeeCleanupPreview,
  PayeeSummary,
  RecurringKind,
  RecurringSeries,
  Rule,
  RuleApplyResult,
  RuleInput,
  SetBudgetInput,
  SplitInput,
  SyncConfigStatus,
  SyncSummary,
  Tag,
  Transaction,
  TransactionPage,
  TransactionQuery,
  TransferPreview,
  UpcomingCharge,
  UpdateAccountInput,
  UpdateRecurringInput,
  UpdateTransactionInput,
} from "@muny/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
    ({ id, ...input }: { id: string; name?: string; hidden?: boolean; groupId?: string }) =>
      api.patch(`/api/categories/${id}`, input),
    [keys.categories],
  );

export const useDeleteCategory = () =>
  useInvalidatingMutation(
    ({ id, reassignTo }: { id: string; reassignTo?: string }) =>
      api.delete(
        `/api/categories/${id}${reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : ""}`,
      ),
    [keys.categories],
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
  plaidLinkToken: () => api.post<{ linkToken: string }>("/api/connections/plaid/link-token"),
  plaidUpdateToken: (id: string) =>
    api.post<{ linkToken: string }>(`/api/connections/${id}/plaid/update-token`),
  plaidExchange: (publicToken: string) =>
    api.post<LinkStart>("/api/connections/plaid/exchange", { publicToken }),
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
    [keys.recurring, keys.transactions],
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
