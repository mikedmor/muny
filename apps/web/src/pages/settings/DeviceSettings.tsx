import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Card } from "../../components/ui.js";
import { useInstall } from "../../lib/device.js";
import { offlineEnabled, offlineSupported, setOfflineEnabled } from "../../lib/offline.js";

/** Settings for the device you're on: installing Muny as an app, and (below) offline use. */
export function DeviceSettings() {
  return (
    <div className="max-w-2xl space-y-6">
      <InstallCard />
      <Card>
        <h2 className="font-semibold">Notifications</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Turn on alerts for this phone or computer in{" "}
          <Link to="/alerts" hash="settings" className="font-medium text-brand-700 underline">
            Alerts → Settings
          </Link>
          . Installed, Muny also shows how many alerts are unread on its icon.
        </p>
      </Card>
      <OfflineCard />
    </div>
  );
}

function OfflineCard() {
  const [on, setOn] = useState(offlineEnabled);
  const [busy, setBusy] = useState(false);
  const supported = offlineSupported();
  return (
    <Card>
      <h2 className="font-semibold">Use offline</h2>
      <label className="mt-3 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={!supported || busy}
          onChange={(e) => {
            const next = e.target.checked;
            setBusy(true);
            void setOfflineEnabled(next)
              .catch(() => {})
              .finally(() => {
                setOn(offlineEnabled());
                setBusy(false);
              });
          }}
          className="mt-0.5 size-4 accent-brand-600"
        />
        <span>
          <span className="font-medium">Keep a copy of my data on this device</span>
          <span className="block text-xs text-slate-500">
            When Muny can't be reached (no signal, VPN off, server down), it opens with what you
            last saw: the pages you've visited, as of then. It's read-only until you're back. The
            copy is encrypted with a key that stays in this browser, and it's deleted when you sign
            out or turn this off. Only turn it on for a phone or computer only you use.
          </span>
          {!supported && (
            <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
              Needs Muny's secure (https://) address.
            </span>
          )}
        </span>
      </label>
    </Card>
  );
}

function InstallCard() {
  const { standalone, canPrompt, install } = useInstall();
  const [declined, setDeclined] = useState(false);
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua);
  const android = /Android/.test(ua);
  return (
    <Card>
      <h2 className="font-semibold">Install the app</h2>
      {standalone ? (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          You're using the installed app. It opens from your home screen or app list in its own
          window, without the browser's address bar.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Add Muny to your home screen or app list. It opens in its own window, shows unread
            alerts on its icon, and has shortcuts to Transactions, Alerts, Budgets and Recurring
            when you long-press it.
          </p>
          {!window.isSecureContext ? (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
              Browsers only install apps from secure (https://) addresses. Open Muny through its
              HTTPS address (for example your Tailscale or reverse proxy name) to install it.
            </p>
          ) : canPrompt ? (
            <Button className="mt-3" onClick={() => void install().then((ok) => setDeclined(!ok))}>
              Install Muny
            </Button>
          ) : (
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              {ios
                ? "In Safari, tap Share, then Add to Home Screen."
                : android
                  ? "In Chrome, open the ⋮ menu and choose Add to home screen (or Install app)."
                  : "In Chrome or Edge, use the install icon at the right of the address bar, or the browser menu's Install Muny."}
            </p>
          )}
          {declined && (
            <p className="mt-2 text-xs text-slate-500">
              Not installed. You can install it later from the browser menu.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
