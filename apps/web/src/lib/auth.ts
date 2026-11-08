import type { AuthStatusResponse, MetaResponse } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";

export const authKey = ["auth", "status"] as const;

export function useAuthStatus() {
  return useQuery({
    queryKey: authKey,
    queryFn: () => api.get<AuthStatusResponse>("/api/auth/status"),
    staleTime: 60_000,
  });
}

export function useMeta() {
  return useQuery({
    queryKey: ["meta"],
    queryFn: () => api.get<MetaResponse>("/api/meta"),
    // Re-checked now and then, so an update shows up in an open tab.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

function useAuthMutation<T>(fn: (input: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" && q.queryKey[0] !== "meta" });
      await qc.invalidateQueries({ queryKey: authKey });
    },
  });
}

export const useLogin = () =>
  useAuthMutation((b: { email: string; password: string }) => api.post("/api/auth/login", b));

export const useSetup = () =>
  useAuthMutation((b: { email: string; password: string; displayName?: string }) =>
    api.post("/api/auth/setup", b),
  );

export const useAcceptInvite = (token: string) =>
  useAuthMutation((b: { email: string; password: string; displayName?: string }) =>
    api.post(`/api/invites/${token}/accept`, b),
  );

export const useLogout = () => useAuthMutation(() => api.post("/api/auth/logout"));
