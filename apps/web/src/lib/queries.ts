import type {
  Account,
  BulkUpdateInput,
  CategoryGroup,
  CreateAccountInput,
  CreateTransactionInput,
  SplitInput,
  Tag,
  Transaction,
  TransactionPage,
  TransactionQuery,
  UpdateAccountInput,
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
const txnKeys = [keys.transactions, keys.accounts, keys.categories, keys.tags] as const;

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
