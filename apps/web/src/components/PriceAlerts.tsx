import {
  type LiveKind,
  liveKey,
  PRICE_ALERT_CONDITIONS,
  PRICE_ALERT_LABELS,
  type PriceAlert,
  type PriceAlertCondition,
} from "@muny/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, BellRing, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.js";
import { useAuthStatus } from "../lib/auth.js";
import {
  fmtLive,
  liveSettingsKey,
  priceAlertsKey,
  useLiveSettings,
  usePriceAlerts,
} from "../lib/live.js";
import { Checkbox, Modal, SelectField } from "./forms.js";
import { Alert, Button, cx, Field } from "./ui.js";

/**
 * Price alerts on a stock or coin: a bell that shows whether any are set,
 * and a window to add, pause or remove them. They're checked as live prices
 * arrive, and go out through the "Price alerts" alert's channels.
 */

const describe = (a: PriceAlert) => {
  const m = PRICE_ALERT_LABELS[a.condition];
  const v = a.value === null ? "" : m.unit === "price" ? ` ${fmtLive(a.value)}` : ` ${a.value}%`;
  return `${m.label}${v}`;
};

function AlertsDialog({
  kind,
  symbol,
  price,
  onClose,
}: {
  kind: LiveKind;
  symbol: string;
  price: number | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const live = useLiveSettings().data;
  const owner = useAuthStatus().data?.user?.role === "owner";
  const all = usePriceAlerts().data ?? [];
  const mine = all.filter((a) => a.kind === kind && a.symbol === symbol);
  const conditions = PRICE_ALERT_CONDITIONS.filter(
    (c) => kind === "stock" || !PRICE_ALERT_LABELS[c].stocksOnly,
  );
  const [condition, setCondition] = useState<PriceAlertCondition>("above");
  const [value, setValue] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [note, setNote] = useState("");
  const done = () => qc.invalidateQueries({ queryKey: priceAlertsKey });
  const add = useMutation({
    mutationFn: () =>
      api.post<PriceAlert>("/api/price-alerts", {
        kind,
        symbol,
        condition,
        value: PRICE_ALERT_LABELS[condition].unit ? Number(value) : null,
        repeat,
        note: note.trim() || null,
        basePrice: price,
      }),
    onSuccess: () => {
      setValue("");
      setNote("");
      void done();
    },
  });
  const toggle = useMutation({
    mutationFn: (a: PriceAlert) =>
      api.put(`/api/price-alerts/${a.id}`, {
        kind: a.kind,
        symbol: a.symbol,
        condition: a.condition,
        value: a.value,
        note: a.note,
        repeat: a.repeat,
        enabled: !a.enabled,
      }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/price-alerts/${id}`),
    onSuccess: done,
  });
  const turnOn = useMutation({
    mutationFn: () => api.put("/api/live", kind === "stock" ? { stocks: true } : { crypto: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: liveSettingsKey }),
  });
  const on = kind === "stock" ? live?.stocks : live?.crypto;
  const unit = PRICE_ALERT_LABELS[condition].unit;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <Modal open onClose={onClose} title={`Alerts for ${symbol}`}>
      <div className="space-y-4 text-left text-sm">
        {live && !on && (
          <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <p>
              Alerts are checked against live prices, which are off for{" "}
              {kind === "stock" ? "stocks" : "crypto"}.{" "}
              {kind === "stock"
                ? "Muny would ask Yahoo Finance (or Finnhub, with your key) for the price, sending only the ticker."
                : "Muny would follow the price on Coinbase, sending only the coin's symbol."}
            </p>
            {owner ? (
              <Button className="px-2.5 py-1 text-xs" onClick={() => turnOn.mutate()}>
                Turn on live prices for {kind === "stock" ? "stocks" : "crypto"}
              </Button>
            ) : (
              <p>Ask the household's owner to turn them on in Settings → API.</p>
            )}
          </div>
        )}
        {price !== null && (
          <p className="text-slate-500">
            {symbol} is at{" "}
            <span className="font-medium text-slate-800 dark:text-slate-100">{fmtLive(price)}</span>
            .
          </p>
        )}
        {mine.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {mine.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-2">
                <span className={cx("min-w-0 flex-1", !a.enabled && "text-slate-400")}>
                  <span className="block">{describe(a)}</span>
                  <span className="block text-xs text-slate-500">
                    {a.repeat ? "Up to once a day" : "Once"}
                    {a.lastFiredAt
                      ? ` · last at ${a.lastFiredPrice !== null ? fmtLive(a.lastFiredPrice) : "—"} on ${new Date(a.lastFiredAt).toLocaleDateString()}`
                      : ""}
                    {!a.enabled ? " · off" : ""}
                    {a.note ? ` · ${a.note}` : ""}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => toggle.mutate(a)}
                >
                  {a.enabled ? "Pause" : "Turn on"}
                </Button>
                <button
                  type="button"
                  aria-label={`Remove: ${describe(a)}`}
                  onClick={() => remove.mutate(a.id)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          onSubmit={submit}
          className="space-y-3 border-t border-slate-200 pt-3 dark:border-slate-800"
        >
          <SelectField
            label="Tell me when"
            value={condition}
            onChange={(e) => setCondition(e.target.value as PriceAlertCondition)}
          >
            {conditions.map((c) => (
              <option key={c} value={c}>
                {PRICE_ALERT_LABELS[c].label}
              </option>
            ))}
          </SelectField>
          {unit && (
            <Field
              label={unit === "price" ? "Price (USD)" : "Percent"}
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={value}
              placeholder={
                unit === "price" && price ? price.toFixed(2) : unit === "percent" ? "5" : ""
              }
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <Field
            label="Note (optional)"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
          <Checkbox
            label="Keep it on"
            description="Off: it tells you once, then turns off. On: at most once a day."
            checked={repeat}
            onChange={setRepeat}
          />
          {add.isError && <Alert>{add.error.message}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={add.isPending || (!!unit && !(Number(value) > 0))}>
              {add.isPending ? "Adding…" : "Add alert"}
            </Button>
            <span className="text-xs text-slate-500">
              Sent to the channels for Price alerts in{" "}
              <Link to="/alerts" hash="settings" className="underline" onClick={onClose}>
                alert settings
              </Link>
              .
            </span>
          </div>
        </form>
      </div>
    </Modal>
  );
}

/** The bell for a stock or coin: lit when it has alerts on. */
export function PriceAlertButton({
  kind,
  symbol,
  price,
  className,
}: {
  kind: LiveKind;
  symbol: string;
  price: number | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const all = usePriceAlerts().data ?? [];
  const k = liveKey(kind, symbol);
  const active = all.filter((a) => a.enabled && liveKey(a.kind, a.symbol) === k).length;
  const Icon = active ? BellRing : Bell;
  return (
    <>
      <button
        type="button"
        title={
          active
            ? `${active} alert${active === 1 ? "" : "s"} on ${symbol}`
            : `Add an alert for ${symbol}`
        }
        aria-label={active ? `Alerts for ${symbol} (${active} on)` : `Add an alert for ${symbol}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cx(
          "rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800",
          active ? "text-brand-600 dark:text-brand-500" : "text-slate-400 hover:text-slate-700",
          className,
        )}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
      {open && (
        <AlertsDialog kind={kind} symbol={symbol} price={price} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
