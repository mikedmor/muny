import {
  AGENT_SCOPE_INFO,
  AGENT_SCOPES,
  type AgentActivity,
  type AgentScope,
  type ApiToken,
  type CreatedApiToken,
} from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SelectField } from "../../components/forms.js";
import { Alert, Button, Card, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAuthStatus } from "../../lib/auth.js";
import { mcpAddressIsSafe } from "../../lib/mcpAddress.js";

/** Settings → Agents: tokens that let AI assistants and scripts talk to Muny. */

const key = ["agent-tokens"] as const;

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Activity({ id }: { id: string }) {
  const activity = useQuery({
    queryKey: [...key, id, "activity"],
    queryFn: () => api.get<AgentActivity[]>(`/api/agents/tokens/${id}/activity`),
  });
  if (!activity.data) return <p className="text-xs text-slate-500">Loading…</p>;
  if (activity.data.length === 0)
    return <p className="text-xs text-slate-500">It hasn't been used yet.</p>;
  return (
    <ul className="max-h-48 divide-y divide-slate-100 overflow-auto text-xs dark:divide-slate-800">
      {activity.data.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a log has no identity of its own.
        <li key={i} className="flex justify-between gap-3 py-1">
          <span className="font-mono">
            {a.action}
            {a.dryRun && <span className="ml-1 text-slate-500">(dry run)</span>}
            {!a.ok && (
              <span className="ml-1 text-red-600 dark:text-red-400">(refused or failed)</span>
            )}
          </span>
          <span className="shrink-0 text-slate-500">{when(a.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function TokenRow({ token }: { token: ApiToken }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.delete(`/api/agents/tokens/${token.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const expired = token.expiresAt !== null && token.expiresAt <= Date.now();
  const dead = !!token.revokedAt || expired;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {token.name}{" "}
            <span className="font-mono text-xs font-normal text-slate-500">{token.prefix}…</span>
            {token.revokedAt && (
              <span className="ml-2 text-xs text-red-600 dark:text-red-400">Revoked</span>
            )}
            {expired && !token.revokedAt && (
              <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">Expired</span>
            )}
          </p>
          <p className="text-xs text-slate-500">
            {token.scopes.map((s) => AGENT_SCOPE_INFO[s]?.label ?? s).join(", ")}
          </p>
          <p className="text-xs text-slate-500">
            {token.lastUsedAt ? `Last used ${when(token.lastUsedAt)}` : "Never used"}
            {token.expiresAt && !dead && ` · Expires ${when(token.expiresAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Activity
          </Button>
          {!dead && (
            <Button
              variant="secondary"
              className="px-2 py-1 text-xs"
              disabled={revoke.isPending}
              onClick={() => {
                if (window.confirm(`Revoke "${token.name}"? Anything using it stops working.`))
                  revoke.mutate();
              }}
            >
              Revoke
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-2">
          <Activity id={token.id} />
        </div>
      )}
    </li>
  );
}

/** Shown wherever Muny is open without SSL, because that's the address it would hand out. */
function NoSslWarning() {
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p className="font-medium">MCP won't work properly at this address</p>
      <p>
        You're on <span className="font-mono">{window.location.origin}</span>, which has no SSL.
        Assistants need an <span className="font-mono">https://</span> address to connect reliably,
        and without one your token travels unencrypted. Open Muny at an HTTPS address, like your
        Tailscale one, and create your token there so the setup command uses it.
      </p>
    </div>
  );
}

function NewToken({ token, onDone }: { token: CreatedApiToken; onDone: () => void }) {
  const url = `${window.location.origin}/mcp`;
  const command = `claude mcp add --transport http muny ${url} --header "Authorization: Bearer ${token.token}"`;
  const box =
    "mt-1 w-full rounded-lg border border-slate-300 bg-surface p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950";
  return (
    <Card className="space-y-3 border-brand-600">
      <h3 className="font-semibold">Your new token</h3>
      <p className="text-sm">
        Copy it now: this is the only time Muny will show it. Treat it like a password, and don't
        paste it into a chat with an assistant.
      </p>
      <label className="block text-sm font-medium">
        Token
        <textarea
          readOnly
          rows={2}
          value={token.token}
          onFocus={(e) => e.target.select()}
          className={box}
        />
      </label>
      {!mcpAddressIsSafe(window.location.origin) && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          This command uses the address you're on, which has no SSL. Replace it with your{" "}
          <span className="font-mono">https://</span> address before you run it.
        </p>
      )}
      <label className="block text-sm font-medium">
        Connect Claude Code: run this in your own terminal
        <textarea
          readOnly
          rows={3}
          value={command}
          onFocus={(e) => e.target.select()}
          className={box}
        />
      </label>
      <p className="text-xs text-slate-500">
        Other MCP clients connect to <span className="font-mono">{url}</span> with the header{" "}
        <span className="font-mono">Authorization: Bearer</span> and this token. The address has to
        be one the client can reach, like your Tailscale name.
      </p>
      <Button variant="secondary" onClick={onDone}>
        I've saved it
      </Button>
    </Card>
  );
}

export function AgentSettings() {
  const qc = useQueryClient();
  const role = useAuthStatus().data?.user?.role;
  const owner = role === "owner";
  const tokens = useQuery({
    queryKey: key,
    queryFn: () => api.get<ApiToken[]>("/api/agents/tokens"),
    enabled: owner,
  });
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<AgentScope>>(new Set(["read:summary"]));
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedApiToken>("/api/agents/tokens", {
        name: name.trim(),
        scopes: [...scopes],
        expiresInDays: days === "never" ? null : Number(days),
      }),
    onSuccess: (t) => {
      setCreated(t);
      setName("");
      void qc.invalidateQueries({ queryKey: key });
    },
  });

  if (!owner)
    return (
      <Card className="max-w-2xl text-sm text-slate-500">
        Only the household's owner can connect AI assistants.
      </Card>
    );

  const toggle = (s: AgentScope, on: boolean) =>
    setScopes((current) => {
      const next = new Set(current);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });

  return (
    <section className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold">AI assistants</h2>
        <p className="text-sm text-slate-500">
          Let an assistant like Claude read your finances, build cards and themes, and suggest
          changes, over MCP. Muny calls no AI service itself: you choose what connects, and each
          token only reaches what you tick here. Assistants can't move money, and changes to
          financial data wait in your inbox under Alerts until you approve them. Every call shows up
          under Activity.
        </p>
      </div>

      {!mcpAddressIsSafe(window.location.origin) && <NoSslWarning />}

      {created && <NewToken token={created} onDone={() => setCreated(null)} />}

      <Card className="space-y-3">
        <h3 className="font-semibold">New token</h3>
        <Field
          label="Name"
          value={name}
          maxLength={60}
          placeholder="Claude Code on my desktop"
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What it can do</legend>
          {AGENT_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={scopes.has(s)}
                onChange={(e) => toggle(s, e.target.checked)}
                className="mt-0.5 size-4 accent-brand-600"
              />
              <span>
                <span className="font-medium">{AGENT_SCOPE_INFO[s].label}</span>
                <span className="block text-xs text-slate-500">
                  {AGENT_SCOPE_INFO[s].description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <SelectField
          label="Stops working after"
          value={days}
          onChange={(e) => setDays(e.target.value)}
        >
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="never">Never</option>
        </SelectField>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          If the assistant runs on a cloud service, what it reads through this token goes to that
          provider. For full privacy, connect a model running on your own machine.
        </div>
        {create.error && <Alert>{create.error.message}</Alert>}
        <Button
          disabled={!name.trim() || scopes.size === 0 || create.isPending}
          onClick={() => create.mutate()}
        >
          Create token
        </Button>
      </Card>

      <Card>
        <h3 className="font-semibold">Tokens</h3>
        {tokens.isError && <Alert>Couldn't load tokens.</Alert>}
        {tokens.data?.length === 0 && (
          <p className="mt-1 text-sm text-slate-500">None yet, so nothing can connect.</p>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {tokens.data?.map((t) => (
            <TokenRow key={t.id} token={t} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
