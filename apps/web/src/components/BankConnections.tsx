import {
  ACCOUNT_TYPE_LABELS,
  type ConnectionSummary,
  formatMoney,
  LIABILITY_TYPES,
  type LinkStart,
  type SyncConfigStatus,
} from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api.js";
import { openPlaidLink, openTellerConnect } from "../lib/bankWidgets.js";
import {
  keys,
  linkApi,
  useAccounts,
  useConnections,
  useDisconnect,
  useLinkAccounts,
  useSyncConfig,
  useSyncNow,
} from "../lib/queries.js";
import { Modal } from "./forms.js";
import { Alert, Button, Card, cx } from "./ui.js";

const STATUS: Record<ConnectionSummary["status"], { label: string; className: string }> = {
  active: {
    label: "Connected",
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  pending_setup: {
    label: "Finish setup",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  error: {
    label: "Sync error",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  reauth_required: {
    label: "Needs login",
    className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  },
  disabled: {
    label: "Paused",
    className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
};

function ago(ms: number | null) {
  if (!ms) return "never synced";
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "synced just now";
  if (min < 60) return `synced ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `synced ${h} h ago`;
  return `synced ${new Date(ms).toLocaleDateString()}`;
}

const owed = (type: string, cents: number) => (LIABILITY_TYPES.has(type as never) ? -cents : cents);

/** Map each bank account to a new account, an existing one, or skip. */
export function LinkAccountsForm({ start, onDone }: { start: LinkStart; onDone: () => void }) {
  const accounts = useAccounts();
  const link = useLinkAccounts();
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      start.accounts.map((a) => [a.ref, a.match?.id ?? (a.type === "investment" ? "skip" : "new")]),
    ),
  );

  if (link.data) {
    const s = link.data.summary;
    return (
      <div className="space-y-3 text-sm">
        {s ? (
          <p>
            Synced: <strong>{s.added}</strong> new transactions
            {s.adopted > 0 && <>, {s.adopted} matched to history you already had</>}
            {s.rulesApplied > 0 && <>, {s.rulesApplied} changed by your rules</>}.
          </p>
        ) : (
          <Alert>Accounts linked, but the first sync failed: {link.data.syncError}</Alert>
        )}
        <p className="text-slate-500">
          New transactions can take a few minutes to appear after connecting a bank for the first
          time. Muny checks again automatically.
        </p>
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Choose where each {start.institutionName ?? "bank"} account goes. Linking to an account you
        already have keeps its history; transactions you already imported are matched, not
        duplicated.
      </p>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        {start.accounts.map((a) => (
          <li key={a.ref} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="font-medium">
                {a.name}
                {a.mask && <span className="text-slate-500"> ••{a.mask}</span>}
              </p>
              <p className="text-xs text-slate-500">
                {ACCOUNT_TYPE_LABELS[a.type]}
                {a.balanceCents !== null && ` · ${formatMoney(owed(a.type, a.balanceCents))}`}
              </p>
            </div>
            <select
              aria-label={`Link ${a.name} to`}
              value={map[a.ref]}
              onChange={(e) => setMap((m) => ({ ...m, [a.ref]: e.target.value }))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="new">Add as a new account</option>
              {accounts.data?.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  Link to: {acc.name}
                  {acc.mask ? ` ••${acc.mask}` : ""}
                  {acc.id === a.match?.id ? " (match)" : ""}
                </option>
              ))}
              <option value="skip">Don't track</option>
            </select>
          </li>
        ))}
      </ul>
      {link.error && <Alert>{link.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Later
        </Button>
        <Button
          disabled={link.isPending}
          onClick={() => link.mutate({ id: start.connectionId, accounts: map })}
        >
          {link.isPending ? "Syncing…" : "Save and sync"}
        </Button>
      </div>
    </div>
  );
}

function SetupHelp({ cfg }: { cfg: SyncConfigStatus }) {
  return (
    <Card className="space-y-2 text-sm">
      <p className="font-medium">Connect your banks for automatic updates</p>
      <p className="text-slate-600 dark:text-slate-400">
        Muny syncs through <strong>Plaid</strong> or <strong>Teller</strong> using your own free
        developer account; nothing is shared with anyone else. Add the keys to the <code>.env</code>{" "}
        file next to Muny's <code>compose.yaml</code> on the NAS and redeploy. Step-by-step
        instructions are in <code>docs/DEPLOYMENT.md</code> under "Bank sync".
      </p>
      {!cfg.secretKey && (
        <p className="text-amber-700 dark:text-amber-400">
          MUNY_SECRET_KEY is also missing; it's needed to store bank logins encrypted.
        </p>
      )}
    </Card>
  );
}

export function BankConnections() {
  const qc = useQueryClient();
  const cfg = useSyncConfig();
  const connections = useConnections();
  const sync = useSyncNow();
  const disconnect = useDisconnect();
  const [linking, setLinking] = useState<LinkStart | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paypal, setPaypal] = useState<{ connectionId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const c = cfg.data;
  if (!c) return null;
  const plaid = c.plaid.configured;
  const teller = c.teller.configured ? c.teller : null;
  const list = connections.data ?? [];

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: keys.connections });
    }
  };

  const connectPlaid = (kind: "bank" | "brokerage" = "bank") =>
    run(kind === "brokerage" ? "brokerage" : "plaid", async () => {
      const { linkToken } = await linkApi.plaidLinkToken(kind);
      const publicToken = await openPlaidLink(linkToken);
      if (publicToken) setLinking(await linkApi.plaidExchange(publicToken, kind));
    });

  const connectTeller = (conn?: ConnectionSummary) =>
    run(conn ? conn.id : "teller", async () => {
      if (!teller) return;
      const e = await openTellerConnect({
        applicationId: teller.applicationId,
        environment: teller.env,
        enrollmentId: conn?.tellerEnrollmentId ?? undefined,
      });
      if (!e) return;
      const start = await linkApi.tellerEnroll({
        accessToken: e.accessToken,
        enrollmentId: e.enrollment.id,
        ...(conn ? { connectionId: conn.id } : {}),
      });
      if (!conn) setLinking(start);
      else void qc.invalidateQueries({ queryKey: keys.accounts });
    });

  const fixPlaid = (conn: ConnectionSummary) =>
    run(conn.id, async () => {
      const { linkToken } = await linkApi.plaidUpdateToken(conn.id);
      if (await openPlaidLink(linkToken)) {
        await linkApi.plaidReauthed(conn.id);
        void qc.invalidateQueries({ queryKey: keys.transactions });
      }
    });

  const chooseAccounts = (conn: ConnectionSummary) =>
    run(conn.id, async () => {
      setLinking(await linkApi.linkable(conn.id));
    });

  return (
    <section className="mb-8 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Bank connections
        </h2>
        <div className="flex gap-2">
          {plaid && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => connectPlaid()}>
              {busy === "plaid" ? "Opening…" : teller ? "Connect with Plaid" : "Connect a bank"}
            </Button>
          )}
          {plaid && (
            <Button
              variant="secondary"
              disabled={busy !== null}
              title="Stocks, ETFs and funds: holdings and history through Plaid Investments"
              onClick={() => connectPlaid("brokerage")}
            >
              {busy === "brokerage" ? "Opening…" : "Connect a brokerage"}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy !== null}
            title="Your PayPal activity through PayPal's own API (business accounts)"
            onClick={() => setPaypal({})}
          >
            Connect PayPal
          </Button>
          {teller && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => connectTeller()}>
              {busy === "teller" ? "Opening…" : plaid ? "Connect with Teller" : "Connect a bank"}
            </Button>
          )}
        </div>
      </div>

      {c.plaid.configured && c.plaid.env === "production" && (
        <PlaidLogins logins={c.plaid.logins} />
      )}
      {!plaid && !teller && <SetupHelp cfg={c} />}
      <Modal open={paypal !== null} onClose={() => setPaypal(null)} title="Connect PayPal">
        {paypal && (
          <PayPalForm
            connectionId={paypal.connectionId}
            onDone={(start) => {
              setPaypal(null);
              if (start && !paypal.connectionId) setLinking(start);
              void qc.invalidateQueries({ queryKey: keys.connections });
            }}
          />
        )}
      </Modal>
      {(plaid || teller) && !c.secretKey && (
        <Alert>
          MUNY_SECRET_KEY isn't set, so bank logins can't be stored. Add it to .env and redeploy.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {sync.error && <Alert>{sync.error.message}</Alert>}

      {list.map((conn) => {
        const st = STATUS[conn.status];
        const needsLogin = conn.status === "reauth_required";
        return (
          <Card key={conn.id} className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <div className="min-w-0">
                <p className="font-medium">
                  {conn.institutionName ?? "Bank"}{" "}
                  <span className="text-xs font-normal text-slate-500">
                    via{" "}
                    {conn.provider === "plaid"
                      ? "Plaid"
                      : conn.provider === "paypal"
                        ? "PayPal API"
                        : "Teller"}
                  </span>
                </p>
                <p className="text-xs text-slate-500">
                  <span className={cx("mr-2 rounded px-1.5 py-0.5 font-medium", st.className)}>
                    {st.label}
                  </span>
                  {ago(conn.lastSyncAt)}
                  {conn.ignoredAccounts > 0 &&
                    ` · ${conn.ignoredAccounts} account${conn.ignoredAccounts === 1 ? "" : "s"} not tracked`}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {conn.status === "pending_setup" ? (
                  <Button disabled={busy !== null} onClick={() => chooseAccounts(conn)}>
                    Choose accounts
                  </Button>
                ) : needsLogin ? (
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      conn.provider === "plaid"
                        ? fixPlaid(conn)
                        : conn.provider === "paypal"
                          ? setPaypal({ connectionId: conn.id })
                          : connectTeller(conn)
                    }
                  >
                    {busy === conn.id
                      ? "Opening…"
                      : conn.provider === "paypal"
                        ? "Update keys"
                        : "Log in again"}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={sync.isPending || busy !== null}
                    onClick={() => sync.mutate(conn.id)}
                  >
                    {sync.isPending && sync.variables === conn.id ? "Syncing…" : "Sync now"}
                  </Button>
                )}
                {conn.status !== "pending_setup" && (
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => chooseAccounts(conn)}
                  >
                    Accounts
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="text-red-600"
                  disabled={disconnect.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Disconnect ${conn.institutionName ?? "this bank"}? Accounts and transactions stay in Muny; they just stop updating.`,
                      )
                    )
                      disconnect.mutate(conn.id);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
            {conn.lastError && conn.status !== "active" && (
              <p className="border-b border-slate-200 px-4 py-2 text-xs text-red-600 dark:border-slate-800">
                {conn.lastError}
              </p>
            )}
            {conn.accounts.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                {conn.accounts.map((a) => (
                  <li key={a.id} className="flex justify-between gap-3 px-4 py-2">
                    <span className="truncate">
                      {a.name}
                      {a.mask && <span className="text-slate-500"> ••{a.mask}</span>}
                    </span>
                    <span className="tabular-nums">
                      {formatMoney(owed(a.type, a.balanceCents))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}

      <Modal
        open={linking !== null}
        onClose={() => setLinking(null)}
        title={`Link ${linking?.institutionName ?? "bank"} accounts`}
      >
        {linking && (
          <LinkAccountsForm
            key={linking.connectionId}
            start={linking}
            onDone={() => setLinking(null)}
          />
        )}
      </Modal>
    </section>
  );
}

/**
 * How many Plaid logins this Muny has used, against your plan's limit (which
 * Plaid's API doesn't report, so you set it once).
 */
function PlaidLogins({ logins }: { logins: { used: number; limit: number; custom: boolean } }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [paid, setPaid] = useState(logins.custom);
  const [text, setText] = useState(String(logins.limit));
  const save = async (limit: number | null) => {
    await api.put("/api/sync/plaid-limit", { limit });
    setEditing(false);
    void qc.invalidateQueries({ queryKey: keys.syncConfig });
  };
  const left = logins.limit - logins.used;
  const pct = Math.min(100, (logins.used / Math.max(1, logins.limit)) * 100);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
      <span>
        <span className="font-medium">Plaid logins:</span> {logins.used} used of {logins.limit}
        <span className="text-slate-500">{logins.custom ? " (your plan)" : " (Trial plan)"}</span>
      </span>
      <span
        className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        aria-hidden="true"
      >
        <span
          className={cx(
            "block h-full",
            left <= 1 ? "bg-red-500" : left <= 3 ? "bg-amber-500" : "bg-brand-600",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={cx("text-xs", left <= 1 ? "text-red-600" : "text-slate-500")}>
        {left > 0 ? `${left} left` : "None left"}
      </span>
      {editing ? (
        <span className="inline-flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
              className="accent-brand-600"
            />
            I have a paid Plaid plan
          </label>
          {paid ? (
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(text);
                if (Number.isInteger(n) && n > 0) void save(n);
              }}
            >
              <input
                aria-label="Your Plaid plan's login limit"
                value={text}
                onChange={(e) => setText(e.target.value)}
                inputMode="numeric"
                className="w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-950"
              />
              <Button type="submit" className="px-2 py-0.5 text-xs">
                Save
              </Button>
            </form>
          ) : (
            logins.custom && (
              <Button className="px-2 py-0.5 text-xs" onClick={() => void save(null)}>
                Back to the Trial plan (20)
              </Button>
            )
          )}
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-slate-500 hover:underline"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          Change plan
        </button>
      )}
      <span className="w-full text-xs text-slate-500">
        Each bank or brokerage login uses one, and on the Trial plan removing a login doesn't give
        it back. Plaid doesn't report which plan you're on, so Muny assumes the Trial plan's 20
        unless you say otherwise.
      </span>
    </div>
  );
}

/** Your PayPal REST app's keys (read-only activity), with how to make them. */
function PayPalForm({
  connectionId,
  onDone,
}: {
  connectionId?: string;
  onDone: (start: LinkStart | null) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [sandbox, setSandbox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const start = await api.post<LinkStart>("/api/connections/paypal", {
        clientId,
        clientSecret: secret,
        env: sandbox ? "sandbox" : "live",
        ...(connectionId ? { connectionId } : {}),
      });
      onDone(start);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4 text-sm" noValidate>
      <ol className="list-decimal space-y-1 pl-5 text-slate-600 dark:text-slate-400">
        <li>
          Your PayPal account must be a <strong>business</strong> account (switching is free in
          PayPal's settings).
        </li>
        <li>
          Sign in at{" "}
          <a
            href="https://developer.paypal.com/dashboard/applications/live"
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 underline"
          >
            developer.paypal.com
          </a>{" "}
          → Apps &amp; Credentials → <strong>Live</strong> → Create App.
        </li>
        <li>
          In the app's features, turn on <strong>Transaction Search</strong> and save. It can take a
          few hours before PayPal lets the app read your activity.
        </li>
        <li>Copy the app's Client ID and Secret here.</li>
      </ol>
      <p className="text-xs text-slate-500">
        Muny only reads your balance and activity; it never sends money. The keys are stored
        encrypted and sent only to PayPal. PayPal Credit purchases show in your activity; PayPal
        Credit's own balance isn't available this way.
      </p>
      {error && <Alert>{error}</Alert>}
      <label className="block">
        <span className="font-medium">Client ID</span>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          autoComplete="off"
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="font-medium">Secret</span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-slate-500">
        <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
        These are sandbox (test) keys
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={busy || clientId.trim().length < 10 || secret.trim().length < 10}
        >
          {busy ? "Checking…" : connectionId ? "Update keys" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
