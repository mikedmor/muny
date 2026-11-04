import type { HouseholdInfo, InviteCreated, UserRole } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { SelectField } from "../../components/forms.js";
import { Alert, Button, Card, Field } from "../../components/ui.js";
import { ApiError, api } from "../../lib/api.js";
import { useAuthStatus } from "../../lib/auth.js";

const ROLE_LABEL: Record<UserRole, string> = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer (read-only)",
};

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () =>
      api.post("/api/auth/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
    },
  });
  const fields = change.error instanceof ApiError ? change.error.fieldErrors() : {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };
  return (
    <Card>
      <h3 className="font-semibold">Change your password</h3>
      <p className="mb-3 text-sm text-slate-500">This also signs you out everywhere else.</p>
      <form onSubmit={submit} className="grid max-w-xl gap-3 sm:grid-cols-2" noValidate>
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={fields.currentPassword}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={fields.newPassword}
          hint="At least 10 characters."
        />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={change.isPending || !current || !next}>
            Change password
          </Button>
          {change.isSuccess && (
            <span className="text-sm text-emerald-700 dark:text-emerald-400">
              Password changed.
            </span>
          )}
          {change.error && !Object.keys(fields).length && (
            <span className="text-sm text-red-600">{change.error.message}</span>
          )}
        </div>
      </form>
    </Card>
  );
}

export function HouseholdSettings() {
  const qc = useQueryClient();
  const me = useAuthStatus().data?.user;
  const owner = me?.role === "owner";
  const h = useQuery({
    queryKey: ["household"],
    queryFn: () => api.get<HouseholdInfo>("/api/household"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["household"] });
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [created, setCreated] = useState<InviteCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useMutation({
    mutationFn: () => api.post<InviteCreated>("/api/household/invites", { role }),
    onSuccess: (i) => {
      setCreated(i);
      setCopied(false);
      void refresh();
    },
  });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => void refresh(),
  });
  const link = created ? `${window.location.origin}${created.path}` : "";

  return (
    <section className="space-y-6">
      <ChangePassword />

      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="font-semibold">Household</h3>
          <p className="text-sm text-slate-500">
            Everyone here shares the same accounts, budgets and transactions.
          </p>
        </div>
        {h.isError && (
          <div className="p-4">
            <Alert>{h.error.message}</Alert>
          </div>
        )}
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {h.data?.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {u.displayName ?? u.email}{" "}
                  {u.isYou && <span className="text-xs font-normal text-slate-500">(you)</span>}
                </span>
                <span className="text-xs text-slate-500">{u.email}</span>
              </span>
              {owner && !u.isYou && u.role !== "owner" ? (
                <span className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${u.email}`}
                    value={u.role}
                    onChange={(e) =>
                      act.mutate(() =>
                        api.patch(`/api/household/users/${u.id}`, { role: e.target.value }),
                      )
                    }
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="member">{ROLE_LABEL.member}</option>
                    <option value="viewer">{ROLE_LABEL.viewer}</option>
                  </select>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${u.email}? They'll be signed out. Shared data stays.`,
                        )
                      )
                        act.mutate(() => api.delete(`/api/household/users/${u.id}`));
                    }}
                  >
                    Remove
                  </Button>
                </span>
              ) : (
                <span className="text-xs text-slate-500">{ROLE_LABEL[u.role]}</span>
              )}
            </li>
          ))}
        </ul>
        {act.error && <p className="px-4 pb-3 text-sm text-red-600">{act.error.message}</p>}
      </Card>

      {owner && (
        <Card className="space-y-3">
          <div>
            <h3 className="font-semibold">Invite someone</h3>
            <p className="text-sm text-slate-500">
              Creates a one-time link that works for 7 days. Send it however you like; Muny doesn't
              send email. They'll need to reach this Muny (same network or VPN) to use it.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label="Access"
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "viewer")}
              className="min-w-56"
            >
              <option value="member">Member: can see and change everything</option>
              <option value="viewer">Viewer: can see, not change</option>
            </SelectField>
            <Button disabled={invite.isPending} onClick={() => invite.mutate()}>
              Create invite link
            </Button>
          </div>
          {invite.error && <Alert>{invite.error.message}</Alert>}
          {created && (
            <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
              <p className="mb-2 text-slate-600 dark:text-slate-400">
                Copy this link now; it won't be shown again.
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={link}
                  aria-label="Invite link"
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {(h.data?.invites.length ?? 0) > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
              {h.data?.invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>
                    Pending {ROLE_LABEL[i.role].toLowerCase()} invite
                    <span className="text-xs text-slate-500">
                      {" "}
                      · expires {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => act.mutate(() => api.delete(`/api/household/invites/${i.id}`))}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </section>
  );
}
