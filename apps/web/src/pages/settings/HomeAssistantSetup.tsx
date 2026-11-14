import { type AgentScope, type CreatedApiToken, HA_SENSORS, haYaml } from "@muny/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SelectField } from "../../components/forms.js";
import { Alert, Button, Card, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";

/**
 * Settings → Agents → Home Assistant (D-091): a read-only token for HA and the
 * configuration.yaml for its REST integration, which polls Muny for sensors
 * like spent this month, budget left, the next bill and net worth.
 */

const box =
  "mt-1 w-full rounded-lg border border-slate-300 bg-surface p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950";

export function HomeAssistantSetup() {
  const qc = useQueryClient();
  const [accounts, setAccounts] = useState(true);
  const [url, setUrl] = useState(window.location.origin);
  const [minutes, setMinutes] = useState("15");
  const [token, setToken] = useState<string | null>(null);
  const scopes: AgentScope[] = accounts ? ["read:summary", "read:accounts"] : ["read:summary"];
  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedApiToken>("/api/agents/tokens", {
        name: "Home Assistant",
        scopes,
        expiresInDays: null,
      }),
    onSuccess: (t) => {
      setToken(t.token);
      void qc.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });
  const yaml = haYaml({ url, scopes, scanSeconds: Number(minutes) * 60 });
  const secret = `muny_token: "Bearer ${token ?? "PASTE_YOUR_MUNY_TOKEN_HERE"}"`;
  const plain = url.startsWith("http://");
  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold">Home Assistant</h3>
        <p className="text-sm text-slate-500">
          Show Muny on your Home Assistant dashboards and use it in automations: spent this month,
          budget left, bills due this week, the next bill, unread alerts and, if you allow it, net
          worth, cash and the lowest balance ahead. Home Assistant asks Muny for them with a
          read-only token; nothing is sent anywhere else.
        </p>
      </div>
      <ul className="flex flex-wrap gap-1.5 text-xs">
        {HA_SENSORS.filter((s) => scopes.includes(s.scope)).map((s) => (
          <li key={s.key} className="rounded bg-slate-100 px-2 py-0.5 dark:bg-slate-800">
            {s.name}
          </li>
        ))}
        {accounts && (
          <li className="rounded bg-slate-100 px-2 py-0.5 dark:bg-slate-800">Balance headed low</li>
        )}
      </ul>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={accounts}
          onChange={(e) => setAccounts(e.target.checked)}
          className="mt-0.5 size-4 accent-brand-600"
        />
        <span>
          Include balances
          <span className="block text-xs text-slate-500">
            Net worth, cash, the balance forecast and each account&apos;s name and balance (the
            Accounts permission).
          </span>
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field
          label="Muny's address, as Home Assistant reaches it"
          value={url}
          onChange={(e) => setUrl(e.target.value.trim())}
          hint="Often your NAS's address and port, like http://192.168.1.10:8420"
        />
        <SelectField
          label="Check every"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        >
          <option value="5">5 minutes</option>
          <option value="15">15 minutes</option>
          <option value="30">30 minutes</option>
          <option value="60">hour</option>
        </SelectField>
      </div>
      {plain && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This address has no SSL, so the token travels unencrypted. That&apos;s usually fine
          between two machines on your home network, but not over the internet.
        </p>
      )}
      {!token && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={create.isPending} onClick={() => create.mutate()}>
            Create a token for Home Assistant
          </Button>
          <span className="text-xs text-slate-500">
            Read-only, never expires; revoke it in the list above any time.
          </span>
        </div>
      )}
      {create.error && <Alert>{create.error.message}</Alert>}
      {token && (
        <p className="rounded-lg border border-brand-600 px-3 py-2 text-sm">
          Token created. Copy the line below into <span className="font-mono">secrets.yaml</span>{" "}
          now: Muny won&apos;t show it again.
        </p>
      )}
      <label className="block text-sm font-medium">
        1. Add to <span className="font-mono">secrets.yaml</span>
        <textarea
          readOnly
          rows={1}
          value={secret}
          onFocus={(e) => e.target.select()}
          className={box}
        />
      </label>
      <label className="block text-sm font-medium">
        2. Add to <span className="font-mono">configuration.yaml</span>
        <textarea
          readOnly
          rows={Math.min(24, yaml.split("\n").length)}
          value={yaml}
          onFocus={(e) => e.target.select()}
          className={box}
        />
      </label>
      <p className="text-xs text-slate-500">
        3. In Home Assistant, check the configuration and restart (or reload the REST entities). The
        sensors appear as <span className="font-mono">sensor.muny_…</span>; the balance alert is{" "}
        <span className="font-mono">binary_sensor.muny_balance_headed_low</span>. Each account is an
        attribute of the request, for templates. If you already have a token with the Summaries
        permission, you can use it instead.
      </p>
    </Card>
  );
}
