import {
  ACCOUNT_ALERT_TYPES,
  type AlertParams,
  type AlertRule,
  type AlertType,
  type ChannelConfig,
  type ChannelType,
  type NotificationChannel,
} from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Checkbox, MoneyField, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import { ApiError, api } from "../../lib/api.js";
import {
  useAlertRules,
  useCategories,
  useChannels,
  useDeleteChannel,
  useSaveChannel,
  useTestChannel,
  useUpdateAlertRule,
} from "../../lib/queries.js";

const RULES: Record<AlertType, { label: string; description: string }> = {
  bill_due: {
    label: "Bill coming due",
    description: "A subscription or bill is expected in the next few days.",
  },
  low_balance: {
    label: "Low balance",
    description: "A checking or savings balance drops below an amount (once per dip).",
  },
  large_transaction: { label: "Large charge", description: "Money out at or above an amount." },
  unusual_charge: {
    label: "Unusual charge",
    description: "A merchant charges much more than it usually does.",
  },
  duplicate_charge: {
    label: "Possible duplicate",
    description: "Same merchant and amount twice within a few days.",
  },
  price_increase: {
    label: "Price increase",
    description: "A recurring charge went up.",
  },
  budget: {
    label: "Budget",
    description: "A budget reaches a percentage (e.g. 80%, then 100%).",
  },
  charged_after_cancel: {
    label: "Charged after cancelling",
    description: "Something you marked cancelled charged you again.",
  },
  agent_proposal: {
    label: "An assistant suggests a change",
    description: "When changes are waiting in your inbox. It says only that something is waiting.",
  },
  ai_review: {
    label: "Monthly money review (AI)",
    description:
      "Muny AI's short review of last month, when it's turned on in Settings → AI. It includes amounts: add a channel only if you want them sent there.",
  },
  trial_ending: {
    label: "Free trial ending",
    description: "A free trial you are tracking is about to turn into a charge.",
  },
  api_limit: {
    label: "An API reaches its limit",
    description:
      "A service in Settings → API has used up its requests for the day or month. It says when they reset.",
  },
  connection_error: {
    label: "Bank needs attention",
    description: "A bank connection needs you to log in again or failed to sync.",
  },
};

function NumberInput({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text);
          if (Number.isFinite(v) && v >= min && v <= max && v !== value) onCommit(v);
          else setText(String(value));
        }}
        className="w-20 rounded-lg border border-slate-300 bg-surface px-2 py-1 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950"
      />
      {suffix && <span className="text-slate-500">{suffix}</span>}
    </label>
  );
}

/**
 * A short list of numbers (percentages, days before): remove any with ×, add
 * another with the box. At least one stays; at most 10.
 */
function NumberList({
  label,
  values,
  onChange,
  min,
  max,
  suffix,
  descending = false,
}: {
  label: string;
  values: number[];
  onChange: (v: number[]) => void;
  min: number;
  max: number;
  suffix: (v: number) => string;
  descending?: boolean;
}) {
  const [text, setText] = useState("");
  const sorted = [...new Set(values)].sort((a, b) => (descending ? b - a : a - b));
  const add = () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isInteger(v) || v < min || v > max) return;
    if (!sorted.includes(v)) onChange([...sorted, v]);
    setText("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      {sorted.map((v) => (
        <span
          key={v}
          className={cx(
            "inline-flex h-8 items-center gap-0.5 rounded-full bg-slate-100 pl-3 tabular-nums dark:bg-slate-800",
            sorted.length > 1 ? "pr-1" : "pr-3",
          )}
        >
          {suffix(v)}
          {sorted.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${suffix(v)}`}
              onClick={() => onChange(sorted.filter((x) => x !== v))}
              className="flex size-6 items-center justify-center rounded-full leading-none text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-slate-200"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {sorted.length < 10 && (
        <span className="inline-flex items-center gap-1">
          <input
            type="number"
            min={min}
            max={max}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add"
            aria-label={`Add to ${label}`}
            className="h-8 w-20 rounded-lg border border-slate-300 bg-surface px-2 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950"
          />
          {text.trim() !== "" && (
            <button
              type="button"
              onClick={add}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              Add
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function RuleParams({ rule, save }: { rule: AlertRule; save: (params: AlertParams) => void }) {
  const p = rule.params;
  switch (rule.type) {
    case "low_balance":
      return (
        <div className="w-44">
          <MoneyField
            label="Below"
            cents={p.thresholdCents ?? 10_000}
            onChange={(c, ok) => ok && c !== null && c >= 0 && save({ thresholdCents: c })}
          />
        </div>
      );
    case "large_transaction":
      return (
        <div className="w-44">
          <MoneyField
            label="At or above"
            cents={p.minCents ?? 50_000}
            onChange={(c, ok) => ok && c !== null && c > 0 && save({ minCents: c })}
          />
        </div>
      );
    case "unusual_charge":
      return (
        <NumberInput
          label="At least"
          suffix="× the usual"
          value={p.multiplier ?? 3}
          min={1.5}
          max={20}
          step={0.5}
          onCommit={(v) => save({ multiplier: v })}
        />
      );
    case "duplicate_charge":
      return (
        <NumberInput
          label="Within"
          suffix="days"
          value={p.days ?? 3}
          min={1}
          max={14}
          onCommit={(v) => save({ days: v })}
        />
      );
    case "trial_ending":
    case "bill_due":
      return (
        <NumberList
          label="Remind me"
          suffix={(d) => (d === 0 ? "on the day" : `${d} day${d === 1 ? "" : "s"} before`)}
          values={p.reminderDays?.length ? p.reminderDays : [p.daysBefore ?? 3]}
          min={0}
          max={60}
          descending
          onChange={(v) => save({ reminderDays: v })}
        />
      );
    case "budget":
      return (
        <div className="flex flex-wrap items-center gap-3">
          <NumberList
            label="Warn at"
            suffix={(v) => `${v}%`}
            values={p.percents ?? [80, 100]}
            min={1}
            max={500}
            onChange={(v) => save({ percents: v })}
          />
          <MutedBudgets
            ids={p.mutedCategoryIds ?? []}
            onUnmute={(id) =>
              save({ mutedCategoryIds: (p.mutedCategoryIds ?? []).filter((x) => x !== id) })
            }
          />
        </div>
      );
    default:
      return null;
  }
}

/** Categories with budget alerts turned off (from a category's Edit dialog). */
function MutedBudgets({ ids, onUnmute }: { ids: string[]; onUnmute: (id: string) => void }) {
  const categories = useCategories();
  if (!ids.length) return null;
  const name = (id: string) =>
    id === "total"
      ? "Total budget"
      : (categories.data?.flatMap((g) => g.categories).find((c) => c.id === id)?.name ??
        "A deleted category");
  return (
    <p className="basis-full text-xs text-slate-500">
      Off for:{" "}
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          {name(id)}{" "}
          <button
            type="button"
            onClick={() => onUnmute(id)}
            className="text-brand-600 hover:underline"
          >
            (turn on)
          </button>
        </span>
      ))}
    </p>
  );
}

function Rules() {
  const rules = useAlertRules();
  const update = useUpdateAlertRule();
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="font-semibold">What to alert on</h3>
        <p className="text-sm text-slate-500">
          Alerts always show under <span className="font-medium">Alerts</span> in Muny. Choose below
          where else each one goes.
        </p>
      </div>
      {rules.isError && <Alert>{rules.error.message}</Alert>}
      {update.error && (
        <div className="px-4 pt-3">
          <Alert>{update.error.message}</Alert>
        </div>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        <li className="space-y-3 px-4 py-3">
          <div>
            <p className="text-sm font-medium">Account alerts</p>
            <p className="text-sm text-slate-500">
              Low balance, large charges, unusual charges and possible duplicates are set on each
              account: click the bell next to an account on{" "}
              <Link to="/accounts" className="text-brand-600 underline">
                Accounts
              </Link>
              .
            </p>
          </div>
        </li>
        {rules.data
          ?.filter((r) => !ACCOUNT_ALERT_TYPES.includes(r.type))
          .map((r) => {
            const meta = RULES[r.type];
            return (
              <li key={r.type} className="space-y-3 px-4 py-3">
                <Checkbox
                  label={meta.label}
                  description={meta.description}
                  checked={r.enabled}
                  onChange={(enabled) => update.mutate({ type: r.type, enabled })}
                />
                {r.enabled && (
                  <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pl-7">
                    <RuleParams
                      rule={r}
                      save={(params) => update.mutate({ type: r.type, params })}
                    />
                  </div>
                )}
              </li>
            );
          })}
      </ul>
    </Card>
  );
}

/** Where each alert goes: a row per alert, a column per channel (in Muny always). */
function DeliveryGrid({ channels }: { channels: NotificationChannel[] }) {
  const rules = useAlertRules();
  const update = useUpdateAlertRule();
  const list = rules.data ?? [];
  const accountRules = list.filter((r) => ACCOUNT_ALERT_TYPES.includes(r.type));
  const rows: { key: string; label: string; rules: AlertRule[] }[] = [
    ...(accountRules.length
      ? [
          {
            key: "account",
            label: "Account alerts (low balance, large, unusual, duplicate)",
            rules: accountRules,
          },
        ]
      : []),
    ...list
      .filter((r) => !ACCOUNT_ALERT_TYPES.includes(r.type) && r.enabled)
      .map((r) => ({ key: r.type, label: RULES[r.type].label, rules: [r] })),
  ];
  const on = (row: (typeof rows)[number], id: string) =>
    row.rules.every((r) => r.channelIds.includes(id));
  const set = (row: (typeof rows)[number], id: string, value: boolean) => {
    for (const r of row.rules)
      update.mutate({
        type: r.type,
        channelIds: value
          ? [...new Set([...r.channelIds, id])]
          : r.channelIds.filter((x) => x !== id),
      });
  };
  const live = channels.filter((c) => c.enabled);
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="font-semibold">Where each alert goes</h3>
        <p className="text-sm text-slate-500">
          Every alert shows in Muny. Tick the devices and channels each should also reach.
        </p>
      </div>
      {live.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">
          Turn on notifications on this device, or add an email or other channel below, to choose
          here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Alert</th>
                <th className="px-3 py-2 text-center font-medium">In Muny</th>
                {live.map((c) => (
                  <th key={c.id} className="px-3 py-2 text-center font-medium">
                    {c.name}
                    <span className="block font-normal">{TYPE_LABEL[c.type]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="px-4 py-2">{row.label}</td>
                  <td className="px-3 py-2 text-center text-slate-400">✓</td>
                  {live.map((c) => (
                    <td key={c.id} className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Send ${row.label} to ${c.name}`}
                        checked={on(row, c.id)}
                        onChange={(e) => set(row, c.id, e.target.checked)}
                        className="size-4 accent-brand-600"
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="px-4 py-2 text-xs text-slate-500">All of them</td>
                <td />
                {live.map((c) => (
                  <td key={c.id} className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        const all = rows.every((row) => on(row, c.id));
                        for (const row of rows) set(row, c.id, !all);
                      }}
                      className="text-xs text-brand-600 hover:underline dark:text-brand-500"
                    >
                      {rows.every((row) => on(row, c.id)) ? "None" : "All"}
                    </button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** "Android · Chrome", "Windows · Edge"… for naming this device. */
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iPhone"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X/i.test(ua)
          ? "Mac"
          : /Linux/i.test(ua)
            ? "Linux"
            : "This device";
  const br = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${os} · ${br}`;
}

/** Turn on notifications for this phone or computer (Muny installed, or open in the browser). */
function ThisDevice({ channels }: { channels: NotificationChannel[] }) {
  const qc = useQueryClient();
  const [state, setState] = useState<string | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription();
      setMine(sub ? sub.endpoint : null);
    });
  }, [supported]);
  const turnOn = async () => {
    setState("Asking…");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState("Notifications are blocked for Muny in this browser's site settings.");
        return;
      }
      const reg =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const { publicKey } = await api.get<{ publicKey: string }>("/api/alerts/push/key");
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
      const subscribe = () =>
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        try {
          sub = await subscribe();
        } catch {
          // A leftover subscription (or a stale key) can block a new one: clear and try once more.
          await (await reg.pushManager.getSubscription())?.unsubscribe();
          sub = await subscribe();
        }
      }
      const json = sub.toJSON();
      await api.post("/api/alerts/push/subscribe", {
        endpoint: json.endpoint,
        keys: json.keys,
        device: deviceName(),
      });
      setMine(sub.endpoint);
      setState("On. Use Send test on it below.");
      await qc.invalidateQueries();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setState(
        /push service/i.test(msg)
          ? (navigator as { brave?: unknown }).brave
            ? 'Brave blocks push by default: turn on "Use Google services for push messaging" in brave://settings/privacy, restart Brave, and try again.'
            : "This browser couldn't reach its push service. An ad or DNS blocker (Pi-hole, AdGuard, NextDNS) blocking fcm.googleapis.com, android.googleapis.com or push services is the usual cause; allow those, or try Chrome or Edge, and try again."
          : msg || "Couldn't turn them on",
      );
    }
  };
  const isOn = !!mine && channels.some((c) => c.type === "push" && c.enabled);
  return (
    <Card className="space-y-2">
      <h3 className="font-semibold">Notifications on this device</h3>
      {!supported ? (
        <p className="text-sm text-slate-500">
          This browser can't receive notifications here. They need Muny opened over HTTPS (your
          Tailscale address) in Chrome, Edge or Firefox; on Android, install Muny from the browser
          menu (Install app / Add to Home screen) first.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-500">
            On a phone, install Muny first (browser menu → Install app). Alerts arrive like any
            app's, even with Muny closed. Each device you turn on shows up as a channel, so you can
            choose which alerts it gets. They go through this browser's push service (Google,
            Microsoft, Mozilla or Apple), encrypted so only this device can read them.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void turnOn()}>
              {isOn ? "Turn on again" : "Turn on notifications here"}
            </Button>
            {isOn && <span className="text-sm text-emerald-700 dark:text-emerald-400">On</span>}
            {state && <span className="text-sm text-slate-500">{state}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

const TYPE_LABEL: Record<ChannelType, string> = {
  ntfy: "ntfy (phone push)",
  apprise: "Apprise",
  smtp: "Email (SMTP)",
  webhook: "Webhook",
  push: "Device notifications",
};

const TYPE_HELP: Record<ChannelType, string> = {
  push: "Turned on from each device itself (Notifications on this device, above).",
  ntfy: "Install the ntfy app, subscribe to a hard-to-guess topic, and enter it here. Use your own ntfy server if you run one.",
  apprise:
    "The URL of an Apprise API notify endpoint, e.g. http://apprise:8000/notify/muny. Apprise fans out to Discord, Telegram, Pushover and 100+ others.",
  smtp: "Your mail provider's SMTP server. For Gmail, use smtp.gmail.com, port 465 with SSL, and an app password.",
  webhook:
    "Muny POSTs JSON ({ event, type, title, body, url }) to this URL. Add a secret to get an X-Muny-Signature HMAC header.",
};

function AddChannel({ onDone }: { onDone: () => void }) {
  const save = useSaveChannel();
  const [type, setType] = useState<ChannelType>("ntfy");
  const [name, setName] = useState("");
  const [c, setC] = useState<ChannelConfig>({});
  const set = (k: keyof ChannelConfig) => (e: { target: { value: string } }) =>
    setC((o) => ({ ...o, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const config: ChannelConfig = { ...c };
    if (type === "smtp") {
      config.port = Number(c.port ?? 587);
      config.secure = config.port === 465;
    }
    for (const k of Object.keys(config) as (keyof ChannelConfig)[])
      if (config[k] === "") delete config[k];
    save.mutate(
      { type, name: name || TYPE_LABEL[type], config },
      {
        onSuccess: () => {
          setC({});
          setName("");
          onDone();
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 border-t border-slate-200 p-4 dark:border-slate-800"
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ChannelType);
            setC({});
          }}
        >
          {(Object.keys(TYPE_LABEL) as ChannelType[])
            .filter((t) => t !== "push")
            .map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
        </SelectField>
        <Field
          label="Name"
          placeholder={TYPE_LABEL[type]}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <p className="text-xs text-slate-500">{TYPE_HELP[type]}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {type === "ntfy" && (
          <>
            <Field label="Topic" value={c.topic ?? ""} onChange={set("topic")} autoComplete="off" />
            <Field
              label="Server"
              placeholder="https://ntfy.sh"
              value={c.server ?? ""}
              onChange={set("server")}
            />
            <Field
              label="Access token (optional)"
              type="password"
              value={c.token ?? ""}
              onChange={set("token")}
              autoComplete="off"
            />
          </>
        )}
        {(type === "apprise" || type === "webhook") && (
          <Field label="URL" value={c.url ?? ""} onChange={set("url")} className="sm:col-span-2" />
        )}
        {type === "webhook" && (
          <Field
            label="Secret (optional)"
            type="password"
            value={c.secret ?? ""}
            onChange={set("secret")}
            autoComplete="off"
          />
        )}
        {type === "smtp" && (
          <>
            <Field
              label="SMTP server"
              placeholder="smtp.gmail.com"
              value={c.host ?? ""}
              onChange={set("host")}
            />
            <Field
              label="Port"
              inputMode="numeric"
              placeholder="587 (465 = SSL)"
              value={String(c.port ?? "")}
              onChange={set("port")}
            />
            <Field
              label="Username"
              value={c.username ?? ""}
              onChange={set("username")}
              autoComplete="off"
            />
            <Field
              label="Password"
              type="password"
              value={c.password ?? ""}
              onChange={set("password")}
              autoComplete="new-password"
            />
            <Field label="From" type="email" value={c.from ?? ""} onChange={set("from")} />
            <Field label="Send alerts to" type="email" value={c.to ?? ""} onChange={set("to")} />
          </>
        )}
      </div>
      {save.error && (
        <Alert>
          {save.error instanceof ApiError ? save.error.message : "Couldn't save the channel."}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          Add channel
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Channels({ channels }: { channels: NotificationChannel[] }) {
  const [adding, setAdding] = useState(false);
  const save = useSaveChannel();
  const del = useDeleteChannel();
  const test = useTestChannel();
  const [tested, setTested] = useState<string | null>(null);
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <h3 className="font-semibold">Where else to send alerts</h3>
          <p className="text-sm text-slate-500">
            Optional. Muny only contacts a channel you add here, and only sends the alert text
            (title, short description, link). Never account numbers or logins.
          </p>
        </div>
        {!adding && <Button onClick={() => setAdding(true)}>Add channel</Button>}
      </div>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {channels.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block font-medium">
                {c.name}{" "}
                <span className="text-xs font-normal text-slate-500">{TYPE_LABEL[c.type]}</span>
              </span>
              <span className="block truncate text-xs text-slate-500">{c.summary}</span>
              {c.lastError && (
                <span className="block text-xs text-red-600">Last send failed: {c.lastError}</span>
              )}
              {tested === c.id && !test.error && (
                <span className="block text-xs text-emerald-700 dark:text-emerald-400">
                  Test sent. Check that it arrived.
                </span>
              )}
            </span>
            <span className="flex items-center gap-1">
              <Checkbox
                label="On"
                checked={c.enabled}
                onChange={(enabled) => save.mutate({ id: c.id, enabled })}
              />
              <Button
                variant="ghost"
                disabled={test.isPending}
                onClick={() => {
                  setTested(c.id);
                  test.mutate(c.id);
                }}
              >
                Send test
              </Button>
              <Button
                variant="ghost"
                className="text-red-600"
                onClick={() => {
                  if (window.confirm(`Remove ${c.name}?`)) del.mutate(c.id);
                }}
              >
                Remove
              </Button>
            </span>
          </li>
        ))}
        {channels.length === 0 && !adding && (
          <li className="px-4 py-3 text-slate-500">No channels. Alerts only show inside Muny.</li>
        )}
      </ul>
      {test.error && (
        <div className="px-4 pb-3">
          <Alert>Test failed: {test.error.message}</Alert>
        </div>
      )}
      {adding && <AddChannel onDone={() => setAdding(false)} />}
    </Card>
  );
}

export function AlertsSettings() {
  const channels = useChannels();
  const list = channels.data ?? [];
  return (
    <section className="space-y-6">
      <ThisDevice channels={list} />
      <Rules />
      <DeliveryGrid channels={list} />
      <Channels channels={list} />
      <p className="text-xs text-slate-500">
        Links in outbound alerts need <code>MUNY_PUBLIC_URL</code> (the address you open Muny at) in
        the server's <code>.env</code>.
      </p>
    </section>
  );
}
