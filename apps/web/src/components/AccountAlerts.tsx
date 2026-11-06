import {
  type Account,
  type AccountAlertSettings,
  DEFAULT_ACCOUNT_ALERTS,
  LIABILITY_TYPES,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.js";
import { Checkbox, Modal, MoneyField } from "./forms.js";
import { Alert, Button, cx } from "./ui.js";

/**
 * Alerts set on each account: a low balance, large charges, unusual and
 * duplicate charges. Where they're sent (phone, email) is on Alerts → Settings.
 */

export const accountAlertsKey = ["account-alerts"] as const;

export function useAccountAlerts() {
  return useQuery({
    queryKey: accountAlertsKey,
    queryFn: () => api.get<Record<string, AccountAlertSettings>>("/api/account-alerts"),
  });
}

/** Is anything on beyond the defaults? (shown as a ringing bell) */
const anyOn = (s: AccountAlertSettings) =>
  s.lowBalanceCents !== null || s.largeChargeCents !== null;

/** The bell next to an account on the Accounts page. */
export function AccountAlertsButton({
  account,
  settings,
}: {
  account: Account;
  settings: AccountAlertSettings | undefined;
}) {
  const [open, setOpen] = useState(false);
  const s = settings ?? DEFAULT_ACCOUNT_ALERTS;
  const on = anyOn(s);
  const Icon = on ? BellRing : Bell;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Alerts for ${account.name}`}
        title={on ? "Alerts on (click to change)" : "Set alerts for this account"}
        className={cx(
          "shrink-0 rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800",
          on ? "text-brand-600 dark:text-brand-500" : "text-slate-400",
        )}
      >
        <Icon aria-hidden="true" className="size-4" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Alerts for ${account.name}`}>
        {open && <AccountAlertsForm account={account} settings={s} onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function AccountAlertsForm({
  account,
  settings,
  onDone,
}: {
  account: Account;
  settings: AccountAlertSettings;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [s, setS] = useState(settings);
  const [lowOn, setLowOn] = useState(settings.lowBalanceCents !== null);
  const [largeOn, setLargeOn] = useState(settings.largeChargeCents !== null);
  const [low, setLow] = useState<number | null>(settings.lowBalanceCents ?? 10_000);
  const [large, setLarge] = useState<number | null>(settings.largeChargeCents ?? 50_000);
  const [error, setError] = useState<string | null>(null);
  const debt = LIABILITY_TYPES.has(account.type);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((lowOn && (low === null || low < 0)) || (largeOn && (large === null || large <= 0)))
      return setError("Enter the amounts, like 100.00.");
    const body: AccountAlertSettings = {
      ...s,
      lowBalanceCents: lowOn ? low : null,
      largeChargeCents: largeOn ? large : null,
    };
    try {
      await api.put(`/api/account-alerts/${account.id}`, body);
      await qc.invalidateQueries({ queryKey: accountAlertsKey });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="space-y-2">
        <Checkbox
          label="Large charges"
          description="Money out of this account at or above an amount."
          checked={largeOn}
          onChange={setLargeOn}
        />
        {largeOn && (
          <div className="w-44 pl-7">
            <MoneyField label="At or above" cents={large} onChange={(c, ok) => ok && setLarge(c)} />
          </div>
        )}
      </div>
      {!debt && (
        <div className="space-y-2">
          <Checkbox
            label="Low balance"
            description="When the balance drops below an amount (once each time it dips)."
            checked={lowOn}
            onChange={setLowOn}
          />
          {lowOn && (
            <div className="w-44 pl-7">
              <MoneyField label="Below" cents={low} onChange={(c, ok) => ok && setLow(c)} />
            </div>
          )}
        </div>
      )}
      <Checkbox
        label="Unusual charges"
        description="A merchant charges much more than it usually does."
        checked={s.unusualCharge}
        onChange={(v) => setS((x) => ({ ...x, unusualCharge: v }))}
      />
      <Checkbox
        label="Possible duplicates"
        description="The same merchant and amount twice within a few days."
        checked={s.duplicateCharge}
        onChange={(v) => setS((x) => ({ ...x, duplicateCharge: v }))}
      />
      <p className="text-xs text-slate-500">
        Alerts show under Alerts in Muny. To also get them on your phone or by email, add a channel
        on Alerts → Settings.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
