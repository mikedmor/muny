import {
  MAIL_CHECK_MINUTES,
  MAIL_FIELDS,
  MAIL_KIND_LABELS,
  MAIL_PROVIDER_INFO,
  MAIL_PROVIDERS,
  type MailCheckResult,
  type MailMessage,
  type MailMessageDetail,
  type MailProvider,
  type MailSettings,
  type MailSettingsInput,
  type MailStatus,
  type MailTemplate,
  type MailTemplateDraft,
  type MailTemplateKind,
} from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Checkbox, Modal, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAuthStatus } from "../../lib/auth.js";
import { useAccounts } from "../../lib/queries.js";
import { useAiSettings } from "./AiSettings.js";

/**
 * Settings → Email: read bank emails from one mailbox folder. Card activity
 * becomes transactions, statement emails update a card, statement PDFs are
 * read and kept. Off until it's set up; Muny never changes the mailbox.
 */

const KEY = ["mail"] as const;
const MESSAGES = ["mail", "messages"] as const;
const TEMPLATES = ["mail", "templates"] as const;

const STATUS: Record<MailStatus, { label: string; tone: string }> = {
  transaction: { label: "Transaction added", tone: "text-emerald-700 dark:text-emerald-400" },
  statement: { label: "Card updated", tone: "text-emerald-700 dark:text-emerald-400" },
  document: { label: "Statement saved", tone: "text-emerald-700 dark:text-emerald-400" },
  unrecognized: { label: "Needs teaching", tone: "text-amber-700 dark:text-amber-400" },
  not_allowed: { label: "Sender not on your list", tone: "text-slate-500" },
  unsigned: { label: "Not signed", tone: "text-slate-500" },
  skipped: { label: "Skipped", tone: "text-slate-500" },
  failed: { label: "Couldn't use", tone: "text-red-600" },
};

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const domainOf = (from: string) => from.split("@")[1] ?? from;

function Connection({ s, owner }: { s: MailSettings; owner: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<MailSettingsInput>({});
  const [password, setPassword] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: start over when saved settings come back
  useEffect(() => {
    setDraft({});
    setPassword("");
  }, [s]);
  const v = { ...s, ...draft };
  const set = (patch: MailSettingsInput) => setDraft((d) => ({ ...d, ...patch }));
  const save = useMutation({
    mutationFn: (body: MailSettingsInput) => api.put<MailSettings>("/api/mail", body),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ folders: string[]; folderFound: boolean }>("/api/mail/test", {}),
  });
  const check = useMutation({
    mutationFn: () => api.post<MailCheckResult>("/api/mail/check", {}),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const dirty = Object.keys(draft).length > 0 || password.trim() !== "";
  const info = MAIL_PROVIDER_INFO[v.provider as MailProvider];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...draft, ...(password.trim() ? { password: password.trim() } : {}) });
  };
  const folders = test.data?.folders ?? [];

  return (
    <form onSubmit={submit}>
      <Card className="space-y-4">
        <h2 className="font-semibold">Mailbox</h2>
        {!s.canStore && (
          <Alert>
            Set MUNY_SECRET_KEY first: the mailbox password and your emails are stored encrypted.
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Email provider"
            value={v.provider}
            disabled={!owner}
            onChange={(e) => {
              const p = e.target.value as MailProvider;
              const i = MAIL_PROVIDER_INFO[p];
              set({ provider: p, host: i.host, port: i.port, secure: true });
            }}
          >
            {MAIL_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {MAIL_PROVIDER_INFO[p].label}
              </option>
            ))}
          </SelectField>
          <Field
            label="Email address (user name)"
            value={v.user}
            autoComplete="off"
            disabled={!owner}
            onChange={(e) => set({ user: e.target.value })}
          />
          <Field
            label={s.hasPassword ? "App password (stored; type to replace)" : "App password"}
            type="password"
            autoComplete="new-password"
            value={password}
            placeholder={s.hasPassword ? "••••••••" : ""}
            disabled={!owner || !s.canStore}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div>
            <Field
              label="Folder or label to read"
              value={v.folder}
              list="mail-folders"
              disabled={!owner}
              onChange={(e) => set({ folder: e.target.value })}
              hint="INBOX, or a folder or Gmail label your bank's emails go into."
            />
            <datalist id="mail-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
        </div>
        <p className="text-xs text-slate-500">{info.help}</p>
        {v.provider === "other" && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="IMAP server"
              value={v.host}
              placeholder="imap.example.com"
              disabled={!owner}
              onChange={(e) => set({ host: e.target.value })}
            />
            <Field
              label="Port"
              type="number"
              value={String(v.port)}
              disabled={!owner}
              onChange={(e) => {
                const port = Number(e.target.value);
                set({ port, secure: port !== 143 && port !== 1143 });
              }}
              hint={v.secure ? "TLS from the start" : "STARTTLS"}
            />
            <div className="pt-6">
              <Checkbox
                label="Allow a self-signed certificate"
                description="For a server on your own network, like Proton Mail Bridge."
                checked={v.allowSelfSigned}
                disabled={!owner}
                onChange={(allowSelfSigned) => set({ allowSelfSigned })}
              />
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Check every"
            value={String(v.checkEveryMinutes)}
            disabled={!owner}
            onChange={(e) => set({ checkEveryMinutes: Number(e.target.value) })}
          >
            {MAIL_CHECK_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m === 60 ? "hour" : `${m} minutes`}
              </option>
            ))}
          </SelectField>
          <Field
            label="On the first check, read back (days)"
            type="number"
            value={String(v.firstDays)}
            disabled={!owner}
            onChange={(e) => set({ firstDays: Math.max(0, Math.min(365, Number(e.target.value))) })}
          />
        </div>
        <Checkbox
          label="Read this mailbox"
          description="Off: Muny never connects to it. On: it checks on the schedule above, read-only. It never marks, moves or deletes your email."
          checked={v.enabled}
          disabled={!owner}
          onChange={(enabled) => set({ enabled })}
        />
        {save.isError && <Alert>{save.error.message}</Alert>}
        {test.isError && <Alert>{test.error.message}</Alert>}
        {check.isError && <Alert>{check.error.message}</Alert>}
        {test.data && (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            Signed in.{" "}
            {test.data.folderFound
              ? `"${v.folder}" is there.`
              : `There's no "${v.folder}" folder; pick one from the list.`}
          </p>
        )}
        {check.data && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Read {check.data.read} new email{check.data.read === 1 ? "" : "s"}:{" "}
            {check.data.transactions} transaction{check.data.transactions === 1 ? "" : "s"},{" "}
            {check.data.statements} statement{check.data.statements === 1 ? "" : "s"},{" "}
            {check.data.unrecognized} to teach.
          </p>
        )}
        {owner && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="secondary"
              disabled={dirty || !s.hasPassword || test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? "Signing in…" : "Test the connection"}
            </Button>
            <Button
              variant="secondary"
              disabled={dirty || !s.hasPassword || check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? "Checking…" : "Check now"}
            </Button>
            {s.hasPassword && (
              <Button
                variant="ghost"
                onClick={() => save.mutate({ password: null, enabled: false })}
              >
                Remove the password
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-slate-500">
          {s.lastCheckAt ? `Last checked ${when(s.lastCheckAt)}.` : "Not checked yet."}
          {s.lastError && <span className="text-red-600"> {s.lastError}</span>}
        </p>
      </Card>
    </form>
  );
}

function Senders({ s, owner }: { s: MailSettings; owner: boolean }) {
  const qc = useQueryClient();
  const [add, setAdd] = useState("");
  const save = useMutation({
    mutationFn: (body: MailSettingsInput) => api.put<MailSettings>("/api/mail", body),
    onSuccess: (data) => {
      qc.setQueryData(KEY, data);
      void qc.invalidateQueries({ queryKey: MESSAGES });
      setAdd("");
    },
  });
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Senders Muny reads</h2>
      <p className="text-sm text-slate-500">
        Email from anyone else in the folder is left alone. Add your bank's alert address, or its
        domain like <code>@yourbank.com</code> for all of its addresses.
      </p>
      <ul className="flex flex-wrap gap-2">
        {s.senders.map((x) => (
          <li
            key={x}
            className="flex items-center gap-1 rounded-full bg-slate-100 py-1 pr-1 pl-3 text-sm dark:bg-slate-800"
          >
            {x}
            {owner && (
              <button
                type="button"
                aria-label={`Remove ${x}`}
                onClick={() => save.mutate({ senders: s.senders.filter((y) => y !== x) })}
                className="rounded-full px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700"
              >
                ×
              </button>
            )}
          </li>
        ))}
        {s.senders.length === 0 && <li className="text-sm text-slate-500">None yet.</li>}
      </ul>
      {owner && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (add.trim()) save.mutate({ senders: [...s.senders, add.trim()] });
          }}
        >
          <input
            aria-label="Sender to add"
            value={add}
            onChange={(e) => setAdd(e.target.value)}
            placeholder="alerts@yourbank.com or @yourbank.com"
            className="w-72 rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <Button type="submit" variant="secondary" disabled={save.isPending || !add.trim()}>
            Add
          </Button>
        </form>
      )}
      {save.isError && <Alert>{save.error.message}</Alert>}
      <Checkbox
        label="Only email the sender's domain signed"
        description="Your mail server checks each email's signature (DKIM). With this on, an email that only claims to be from your bank is ignored. Turn it off only if your bank's real emails show up as Not signed."
        checked={s.requireSigned}
        disabled={!owner}
        onChange={(requireSigned) => save.mutate({ requireSigned })}
      />
    </Card>
  );
}

function Teach({ message, onClose }: { message: MailMessage; onClose: () => void }) {
  const qc = useQueryClient();
  const ai = useAiSettings().data;
  const aiOn = !!ai?.enabled && !!ai.features.statementTemplates;
  const cards = (useAccounts().data ?? []).filter((a) => !a.hidden && a.type !== "loan");
  const detail = useQuery({
    queryKey: [...MESSAGES, message.id],
    queryFn: () => api.get<MailMessageDetail>(`/api/mail/messages/${message.id}`),
  });
  const [kind, setKind] = useState<MailTemplateKind>(
    /statement/i.test(message.subject) ? "summary" : "activity",
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<MailTemplateDraft | null>(null);
  const [name, setName] = useState(
    `${domainOf(message.from)} ${kind === "summary" ? "statements" : "card activity"}`,
  );
  const [fromWhole, setFromWhole] = useState(false);
  const [subject, setSubject] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [accountId, setAccountId] = useState("");
  const check = useMutation({
    mutationFn: () =>
      api.post<MailTemplateDraft>(`/api/mail/messages/${message.id}/draft`, { kind, values }),
    onSuccess: setDraft,
  });
  const fill = useMutation({
    mutationFn: () =>
      api.post<{ values: Record<string, string>; draft: MailTemplateDraft }>(
        `/api/mail/messages/${message.id}/ai`,
        { kind },
      ),
    onSuccess: (r) => {
      setValues(r.values);
      setDraft(r.draft);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api.post<{ used: number; added: number }>("/api/mail/templates", {
        name,
        kind,
        from: fromWhole ? `@${domainOf(message.from)}` : message.from,
        subject: subject.trim() || null,
        direction,
        accountId: accountId || null,
        fields: draft?.fields ?? {},
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["mail"] });
      void qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
  const fields = MAIL_FIELDS[kind];
  const show = (key: string, v: string | number | null) => {
    if (v === null) return "not found";
    const type = fields.find((f) => f.key === key)?.type;
    if (type === "money" && typeof v === "number")
      return (v / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
    return String(v);
  };
  const ready =
    !!draft &&
    fields
      .filter((f) => f.required)
      .every((f) => draft.read[f.key] !== null && draft.read[f.key] !== undefined);

  return (
    <Modal open onClose={onClose} title="Teach Muny this email" wide>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">
            {message.from} · {when(message.receivedAt)}
          </p>
          <p className="mb-2 text-sm font-medium">{message.subject}</p>
          {detail.isError && <Alert>{detail.error.message}</Alert>}
          {detail.data && !detail.data.text && (
            <p className="text-sm text-slate-500">This email isn't kept any more.</p>
          )}
          {detail.data?.text && (
            <pre className="max-h-[28rem] overflow-auto rounded-lg bg-slate-50 p-3 text-xs whitespace-pre-wrap dark:bg-slate-950">
              {detail.data.text}
            </pre>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          {save.isSuccess ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium text-emerald-700 dark:text-emerald-400">Saved.</p>
              <p>
                Muny read {save.data.used} kept email{save.data.used === 1 ? "" : "s"} with it and
                added {save.data.added} transaction{save.data.added === 1 ? "" : "s"}. New ones from{" "}
                {message.from} are read as they arrive.
              </p>
              <Button onClick={onClose}>Done</Button>
            </div>
          ) : (
            <>
              <SelectField
                label="What kind of email is it?"
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as MailTemplateKind;
                  setKind(k);
                  setDraft(null);
                  setName(
                    `${domainOf(message.from)} ${k === "summary" ? "statements" : "card activity"}`,
                  );
                }}
              >
                {(Object.keys(MAIL_KIND_LABELS) as MailTemplateKind[]).map((k) => (
                  <option key={k} value={k}>
                    {MAIL_KIND_LABELS[k]}
                  </option>
                ))}
              </SelectField>
              <p className="text-xs text-slate-500">
                Copy each value from the email exactly as it's written. Muny remembers the words
                around it, so the next email like this is read the same way.
              </p>
              {fields.map((f) => (
                <Field
                  key={f.key}
                  label={`${f.label}${f.required ? "" : " (optional)"}`}
                  value={values[f.key] ?? ""}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [f.key]: e.target.value }));
                    setDraft(null);
                  }}
                  hint={draft ? `Reads: ${show(f.key, draft.read[f.key] ?? null)}` : undefined}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={check.isPending}
                  onClick={() => check.mutate()}
                >
                  {check.isPending ? "Checking…" : "Check what it reads"}
                </Button>
                {aiOn && (
                  <Button variant="ghost" disabled={fill.isPending} onClick={() => fill.mutate()}>
                    {fill.isPending ? "Asking…" : "Fill in with AI"}
                  </Button>
                )}
              </div>
              {check.isError && <Alert>{check.error.message}</Alert>}
              {fill.isError && <Alert>{fill.error.message}</Alert>}
              {draft && draft.missing.length > 0 && (
                <Alert>
                  Couldn't find{" "}
                  {draft.missing
                    .map((k) => fields.find((f) => f.key === k)?.label.toLowerCase())
                    .join(", ")}{" "}
                  in the email as typed.
                </Alert>
              )}
              {draft && (
                <div className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800">
                  <Field
                    label="Template name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <Checkbox
                    label={`Use it for everything from @${domainOf(message.from)}`}
                    description={`Off: only ${message.from}.`}
                    checked={fromWhole}
                    onChange={setFromWhole}
                  />
                  <Field
                    label="Only when the subject contains (optional)"
                    value={subject}
                    placeholder={message.subject.slice(0, 40)}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                  {kind === "activity" && (
                    <SelectField
                      label="It's for"
                      value={direction}
                      onChange={(e) => setDirection(e.target.value as "out" | "in")}
                    >
                      <option value="out">A charge (money out)</option>
                      <option value="in">A payment or refund (money in)</option>
                    </SelectField>
                  )}
                  <SelectField
                    label={
                      draft.read.last4 ? "Card (when the last 4 don't match one)" : "Which card"
                    }
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    <option value="">
                      {draft.read.last4 ? "Go by the last 4" : "Choose a card"}
                    </option>
                    {cards.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.mask ? ` ••${a.mask}` : ""}
                      </option>
                    ))}
                  </SelectField>
                  {save.isError && <Alert>{save.error.message}</Alert>}
                  <Button
                    disabled={!ready || save.isPending || (!draft.read.last4 && !accountId)}
                    onClick={() => save.mutate()}
                  >
                    {save.isPending ? "Saving…" : "Save and read emails like it"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Messages({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: MESSAGES,
    queryFn: () => api.get<MailMessage[]>("/api/mail/messages"),
  });
  const [teach, setTeach] = useState<MailMessage | null>(null);
  const act = useMutation({
    mutationFn: (a: { id: string; what: "skip" | "allow" | "allowDomain" }) =>
      a.what === "skip"
        ? api.post(`/api/mail/messages/${a.id}/skip`, {})
        : api.post(`/api/mail/messages/${a.id}/allow`, { domain: a.what === "allowDomain" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
  });
  const items = list.data ?? [];
  const attention = items.filter((m) => m.status === "unrecognized" || m.status === "failed");
  return (
    <>
      {attention.length > 0 && (
        <Card className="p-0">
          <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
            Needs a look ({attention.length})
          </h2>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {attention.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.subject || "(no subject)"}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {m.from} · {when(m.receivedAt)}
                  </span>
                  {m.note && <span className="block text-xs text-slate-500">{m.note}</span>}
                </span>
                {owner && (
                  <span className="flex gap-1">
                    <Button className="px-2.5 py-1 text-xs" onClick={() => setTeach(m)}>
                      Teach Muny
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => act.mutate({ id: m.id, what: "skip" })}
                    >
                      Skip
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-0">
        <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
          Recent emails
        </h2>
        {list.isError && (
          <div className="p-4">
            <Alert>{list.error.message}</Alert>
          </div>
        )}
        {items.length === 0 && (
          <p className="px-4 py-6 text-sm text-slate-500">
            Nothing read yet. Once the mailbox is set up, emails from your senders show here.
          </p>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.slice(0, 100).map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5 text-sm">
              <span className="w-28 shrink-0 text-xs text-slate-500">{when(m.receivedAt)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{m.subject || "(no subject)"}</span>
                <span className="block truncate text-xs text-slate-500">
                  {m.from}
                  {m.note ? ` · ${m.note}` : ""}
                </span>
              </span>
              <span className={cx("shrink-0 text-xs font-medium", STATUS[m.status].tone)}>
                {STATUS[m.status].label}
              </span>
              {owner && m.status === "not_allowed" && (
                <span className="flex w-full justify-end gap-1 sm:w-auto">
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    onClick={() => act.mutate({ id: m.id, what: "allow" })}
                  >
                    Allow this sender
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    onClick={() => act.mutate({ id: m.id, what: "allowDomain" })}
                  >
                    Allow @{domainOf(m.from)}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {teach && <Teach message={teach} onClose={() => setTeach(null)} />}
    </>
  );
}

function Templates({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: TEMPLATES,
    queryFn: () => api.get<MailTemplate[]>("/api/mail/templates"),
  });
  const accounts = useAccounts().data ?? [];
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/mail/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: TEMPLATES }),
  });
  const items = list.data ?? [];
  if (!items.length) return null;
  return (
    <Card className="p-0">
      <h2 className="border-b border-slate-200 px-4 py-3 font-semibold dark:border-slate-800">
        What Muny has learned
      </h2>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((t) => {
          const card = accounts.find((a) => a.id === t.accountId);
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t.name}</span>
                <span className="block text-xs text-slate-500">
                  {MAIL_KIND_LABELS[t.kind]} · from {t.from}
                  {t.subject ? ` · subject has "${t.subject}"` : ""}
                  {card ? ` · ${card.name}` : " · card by its last 4"}
                </span>
              </span>
              {owner && (
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => remove.mutate(t.id)}
                >
                  Delete
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function EmailSettings() {
  const owner = useAuthStatus().data?.user?.role === "owner";
  const s = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<MailSettings>("/api/mail"),
    enabled: owner,
  });
  if (!owner)
    return (
      <Card className="text-sm text-slate-500">
        Only the household's owner can set up email import.
      </Card>
    );
  if (!s.data) return s.isError ? <Alert>{s.error.message}</Alert> : null;
  return (
    <div className="max-w-4xl space-y-6">
      <Card className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
        <p>
          For cards and accounts that can't sync, Muny can read your bank's emails. Card activity
          alerts become transactions, statement emails update the card's balance, minimum and due
          date, and statement PDFs are read into the card and kept in Documents.
        </p>
        <p>
          Have your bank's emails forwarded to a mailbox you make just for this, or filtered into a
          folder or Gmail label, and Muny reads that folder only. It's read-only: nothing in your
          mailbox is marked, moved or deleted. Emails are kept here encrypted for 60 days.
        </p>
      </Card>
      <Connection s={s.data} owner={owner} />
      <Senders s={s.data} owner={owner} />
      <Messages owner={owner} />
      <Templates owner={owner} />
    </div>
  );
}
