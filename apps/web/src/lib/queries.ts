import type { Account, CategoryGroup, CreateAccountInput, UpdateAccountInput } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";

export const keys = {
  accounts: ["accounts"] as const,
  categories: ["categories"] as const,
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
