import { formatMoney, type Trial, type TrialInput, type TrialInterval } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { MoneyField, SelectField } from "../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../components/ui.js";
import { MerchantAvatar } from "../components/visuals.js";
import { ApiError, api } from "../lib/api.js";

const KEY = ["trials"] as const;
const INTERVAL_LABEL: Record<TrialInterval, string> = {
  weekly: "week",
  monthly: "month",
  quarterly: "3 months",
  annual: "year",
};

const today = () => new Date().toLocaleDateString("en-CA");
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};
const nice = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

function useTrials() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<Trial[]>("/api/trials") });
}
function useTrialMutation<T>(fn: (input: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: KEY }),
        qc.invalidateQueries({ queryKey: ["notifications"] }),
      ]),
  });
}

function AddTrial({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(plusDays(7));
  const [price, setPrice] = useState<number | null>(null);
  const [interval, setInterval] = useState<TrialInterval>("monthly");
  const [cancelInfo, setCancelInfo] = useState("");
  const add = useTrialMutation((body: TrialInput) => api.post("/api/trials", body));
  const fields = add.error instanceof ApiError ? add.error.fieldErrors() : {};
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate(
      { name, startDate: start, endDate: end, priceCents: price, interval, cancelInfo },
      { onSuccess: onDone },
    );
  };
  const quick = (days: number) => {
    const d = new Date(`${start}T00:00:00`);
    d.setDate(d.getDate() + days);
    setEnd(d.toLocaleDateString("en-CA"));
  };
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <h3 className="font-semibold">Track a free trial</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Service"
            placeholder="e.g. StreamBox"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fields.name}
          />
          <Field
            label="Started"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <div>
            <Field
              label="Free until"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              error={fields.endDate}
            />
            <div className="mt-1 flex gap-2 text-xs">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => quick(d)}
                  className="text-brand-600 hover:underline"
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <MoneyField label="Then costs" cents={price} onChange={(c, ok) => ok && setPrice(c)} />
            <SelectField
              label="Every"
              value={interval}
              onChange={(e) => setInterval(e.target.value as TrialInterval)}
            >
              {(Object.keys(INTERVAL_LABEL) as TrialInterval[]).map((i) => (
                <option key={i} value={i}>
                  {INTERVAL_LABEL[i]}
                </option>
              ))}
            </SelectField>
          </div>
        </div>
        <Field
          label="How to cancel (optional)"
          placeholder="A link or steps, e.g. Settings > Plan > Cancel"
          value={cancelInfo}
          onChange={(e) => setCancelInfo(e.target.value)}
        />
        {add.error && !Object.keys(fields).length && <Alert>{add.error.message}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" disabled={add.isPending || !name.trim()}>
            Add trial
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CancelHow({ info }: { info: string }) {
  const isUrl = /^https?:\/\//i.test(info);
  return isUrl ? (
    <a href={info} target="_blank" rel="noreferrer noopener" className="text-brand-600 underline">
      Cancel here
    </a>
  ) : (
    <span>How to cancel: {info}</span>
  );
}

export function TrialsTab() {
  const trials = useTrials();
  const [adding, setAdding] = useState(false);
  const update = useTrialMutation(({ id, ...body }: Partial<TrialInput> & { id: string }) =>
    api.patch(`/api/trials/${id}`, body),
  );
  const del = useTrialMutation((id: string) => api.delete(`/api/trials/${id}`));
  const all = trials.data ?? [];
  const active = all.filter((t) => t.status === "active").sort((a, b) => a.daysLeft - b.daysLeft);
  const done = all.filter((t) => t.status !== "active");

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Free trials don't show up in your bank until they turn into a charge. Add them here and
          Muny reminds you a few days before they end (see Settings → Alerts).
        </p>
        {!adding && <Button onClick={() => setAdding(true)}>Track a trial</Button>}
      </div>
      {adding && <AddTrial onDone={() => setAdding(false)} />}
      {trials.isError && <Alert>{trials.error.message}</Alert>}
      {(update.error || del.error) && <Alert>{(update.error ?? del.error)?.message}</Alert>}

      <Card className="p-0">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h3 className="font-semibold">Active trials</h3>
        </div>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {active.map((t) => {
            const ended = t.daysLeft < 0;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <MerchantAvatar name={t.name} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t.name}</span>
                  <span
                    className={cx(
                      "block text-xs",
                      ended || t.daysLeft <= 3
                        ? "font-medium text-amber-700 dark:text-amber-400"
                        : "text-slate-500",
                    )}
                  >
                    {ended
                      ? `Ended ${nice(t.endDate)}. Did you cancel it?`
                      : t.daysLeft === 0
                        ? "Ends today"
                        : `Ends ${nice(t.endDate)} (${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"})`}
                    {t.priceCents ? (
                      <>
                        {" "}
                        · then {formatMoney(t.priceCents)}/
                        {t.interval ? INTERVAL_LABEL[t.interval] : "period"}
                      </>
                    ) : null}
                  </span>
                  {t.cancelInfo && (
                    <span className="block truncate text-xs text-slate-500">
                      <CancelHow info={t.cancelInfo} />
                    </span>
                  )}
                </span>
                <span className="flex gap-1">
                  <Button
                    variant="secondary"
                    onClick={() => update.mutate({ id: t.id, status: "cancelled" })}
                  >
                    I cancelled it
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => update.mutate({ id: t.id, status: "kept" })}
                  >
                    Keeping it
                  </Button>
                </span>
              </li>
            );
          })}
          {trials.isSuccess && active.length === 0 && (
            <li className="px-4 py-3 text-slate-500">No active trials.</li>
          )}
        </ul>
      </Card>

      {done.length > 0 && (
        <Card className="p-0">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h3 className="font-semibold">Past trials</h3>
          </div>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {done.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                <MerchantAvatar name={t.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block">{t.name}</span>
                  <span className="text-xs text-slate-500">
                    {t.status === "cancelled" ? "Cancelled" : "Kept"} · ended {nice(t.endDate)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  onClick={() => update.mutate({ id: t.id, status: "active" })}
                >
                  Reopen
                </Button>
                <Button
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => {
                    if (window.confirm(`Delete the ${t.name} trial?`)) del.mutate(t.id);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
