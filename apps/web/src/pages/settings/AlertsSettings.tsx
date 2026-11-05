import type {
  AlertParams,
  AlertRule,
  AlertType,
  ChannelConfig,
  ChannelType,
  NotificationChannel,
} from "@muny/shared";
import { type FormEvent, useState } from "react";
import { Checkbox, MoneyField, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, Field } from "../../components/ui.js";
import { ApiError } from "../../lib/api.js";
import {
  useAlertRules,
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
  trial_ending: {
    label: "Free trial ending",
    description: "A free trial you are tracking is about to turn into a charge.",
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
        className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950"
      />
      {suffix && <span className="text-slate-500">{suffix}</span>}
    </label>
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
        <NumberInput
          label="Notify"
          suffix="days before"
          value={p.daysBefore ?? 3}
          min={0}
          max={30}
          onCommit={(v) => save({ daysBefore: v })}
        />
      );
    case "budget": {
      const [first = 80, second = 100] = p.percents ?? [80, 100];
      return (
        <div className="flex flex-wrap gap-3">
          <NumberInput
            label="Warn at"
            suffix="%"
            value={first}
            min={1}
            max={500}
            onCommit={(v) => save({ percents: [v, second] })}
          />
          <NumberInput
            label="and at"
            suffix="%"
            value={second}
            min={1}
            max={500}
            onCommit={(v) => save({ percents: [first, v] })}
          />
        </div>
      );
    }
    default:
      return null;
  }
}

function Rules({ channels }: { channels: NotificationChannel[] }) {
  const rules = useAlertRules();
  const update = useUpdateAlertRule();
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h3 className="font-semibold">What to alert on</h3>
        <p className="text-sm text-slate-500">
          Alerts always show under <span className="font-medium">Alerts</span> in Muny.
          {channels.length > 0
            ? " Tick a channel to also send it there."
            : " Add a channel below to also get them on your phone or by email."}
        </p>
      </div>
      {rules.isError && <Alert>{rules.error.message}</Alert>}
      {update.error && (
        <div className="px-4 pt-3">
          <Alert>{update.error.message}</Alert>
        </div>
      )}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {rules.data?.map((r) => {
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
                  <RuleParams rule={r} save={(params) => update.mutate({ type: r.type, params })} />
                  {channels.length > 0 && (
                    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                      <legend className="sr-only">Also send to</legend>
                      <span className="text-slate-600 dark:text-slate-400">Also send to</span>
                      {channels.map((c) => (
                        <label key={c.id} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="size-4 accent-brand-600"
                            checked={r.channelIds.includes(c.id)}
                            onChange={(e) =>
                              update.mutate({
                                type: r.type,
                                channelIds: e.target.checked
                                  ? [...r.channelIds, c.id]
                                  : r.channelIds.filter((id) => id !== c.id),
                              })
                            }
                          />
                          {c.name}
                        </label>
                      ))}
                    </fieldset>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const TYPE_LABEL: Record<ChannelType, string> = {
  ntfy: "ntfy (phone push)",
  apprise: "Apprise",
  smtp: "Email (SMTP)",
  webhook: "Webhook",
};

const TYPE_HELP: Record<ChannelType, string> = {
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
          {(Object.keys(TYPE_LABEL) as ChannelType[]).map((t) => (
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
      <Rules channels={list} />
      <Channels channels={list} />
      <p className="text-xs text-slate-500">
        Links in outbound alerts need <code>MUNY_PUBLIC_URL</code> (the address you open Muny at) in
        the server's <code>.env</code>.
      </p>
    </section>
  );
}
