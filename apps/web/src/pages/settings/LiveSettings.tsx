import type { LiveSettings, LiveSettingsInput } from "@muny/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Checkbox } from "../../components/forms.js";
import { Alert, Button, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAuthStatus } from "../../lib/auth.js";
import { liveSettingsKey, useLiveSettings } from "../../lib/live.js";

/**
 * Settings → API: live prices for stocks (Yahoo, or Finnhub with a key) and
 * crypto (Coinbase). Each is an outbound connection, so each starts off.
 */

type ServiceProps = {
  name: string;
  purpose: string;
  status: string;
  tone: "good" | "idle" | "suggest";
  startOpen: boolean;
  children: ReactNode;
};

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LiveSettingsInput) => api.put<LiveSettings>("/api/live", body),
    onSuccess: (s) => qc.setQueryData(liveSettingsKey, s),
  });
}

export function LiveStocks({ Service }: { Service: (p: ServiceProps) => ReactNode }) {
  const s = useLiveSettings().data;
  const owner = useAuthStatus().data?.user?.role === "owner";
  const save = useSave();
  const [key, setKey] = useState("");
  if (!s) return null;
  const status = !s.stocks
    ? "Off"
    : s.hasFinnhubKey
      ? "On · Finnhub, live"
      : `On · Yahoo, every ${s.yahooEveryMinutes} min`;
  return (
    <Service
      name="Live stock prices"
      purpose="Prices that update while you look, and price alerts"
      status={status}
      tone={s.stocks ? "good" : "idle"}
      startOpen={false}
    >
      <Checkbox
        label="Live stock prices and alerts"
        description="While a page with stocks is open, or a price alert is set, Muny asks for the latest prices: during market hours, and once after the close. Only tickers are sent."
        checked={s.stocks}
        disabled={!owner}
        onChange={(stocks) => save.mutate({ stocks })}
      />
      <p className="text-sm text-slate-500">
        Without a key, prices come from Yahoo Finance every few minutes (about every{" "}
        {s.yahooEveryMinutes} minutes now; more stocks means less often, to stay within its daily
        limit). With a free Finnhub key they're live, as each trade happens, for up to 50 stocks.
        Make one at finnhub.io, then paste it here.
      </p>
      {owner && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim())
              save.mutate({ finnhubKey: key.trim() }, { onSuccess: () => setKey("") });
          }}
        >
          <Field
            label={
              s.hasFinnhubKey ? "Finnhub key (stored; type to replace)" : "Finnhub key (optional)"
            }
            type="password"
            autoComplete="off"
            value={key}
            placeholder={s.hasFinnhubKey ? "••••••••" : ""}
            disabled={!s.canStoreKey}
            onChange={(e) => setKey(e.target.value)}
            className="w-72"
          />
          <Button type="submit" variant="secondary" disabled={!key.trim() || save.isPending}>
            Save key
          </Button>
          {s.hasFinnhubKey && (
            <Button variant="ghost" onClick={() => save.mutate({ finnhubKey: null })}>
              Remove key
            </Button>
          )}
        </form>
      )}
      {!s.canStoreKey && (
        <p className="text-xs text-slate-500">Set MUNY_SECRET_KEY to store a key.</p>
      )}
      {save.isError && <Alert>{save.error.message}</Alert>}
      {s.lastError && <p className="text-xs text-amber-700 dark:text-amber-400">{s.lastError}</p>}
    </Service>
  );
}

export function LiveCrypto({ Service }: { Service: (p: ServiceProps) => ReactNode }) {
  const s = useLiveSettings().data;
  const owner = useAuthStatus().data?.user?.role === "owner";
  const save = useSave();
  if (!s) return null;
  return (
    <Service
      name="Live crypto prices"
      purpose="Prices that update as coins trade, and price alerts"
      status={s.crypto ? "On · Coinbase" : "Off"}
      tone={s.crypto ? "good" : "idle"}
      startOpen={false}
    >
      <Checkbox
        label="Live crypto prices and alerts"
        description="While Crypto is open, or a coin has a price alert, Muny follows its price on Coinbase's public feed, as it trades. No account or key. Only the coins' symbols are sent; coins Coinbase doesn't list keep their usual prices."
        checked={s.crypto}
        disabled={!owner}
        onChange={(crypto) => save.mutate({ crypto })}
      />
      {save.isError && <Alert>{save.error.message}</Alert>}
    </Service>
  );
}
