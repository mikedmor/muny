import { useState } from "react";
import { Checkbox } from "../../components/forms.js";
import { Alert, Button, Card, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useCryptoMutation, useCryptoOverview, useCryptoSettings } from "../../lib/queries.js";
import { CryptoHeader } from "./common.js";

/** Crypto settings: prices (opt-in CoinGecko), API key, coin id overrides. */

export function CryptoSettings() {
  const s = useCryptoSettings();
  const o = useCryptoOverview();
  const save = useCryptoMutation((body: object) => api.put("/api/crypto/settings", body));
  const refresh = useCryptoMutation(() =>
    api.post<{ assets: number; days: number }>("/api/crypto/prices/refresh"),
  );
  const [key, setKey] = useState("");
  const [mapAsset, setMapAsset] = useState("");
  const [mapId, setMapId] = useState("");
  const d = s.data;
  return (
    <>
      <CryptoHeader />
      {s.isError && <Alert>{s.error.message}</Alert>}
      {d && (
        <div className="max-w-3xl space-y-6">
          <Card className="space-y-3">
            <h2 className="font-semibold">Prices</h2>
            <Checkbox
              label="Get prices from CoinGecko"
              description="Off by default. When on, Muny asks CoinGecko for the price of each coin you hold (it sends only coin ids like “bitcoin”, never balances, addresses or wallets) about every 6 hours, and loads about a year of daily history. Older values come from your imported transactions."
              checked={d.pricesEnabled}
              onChange={(pricesEnabled) => save.mutate({ pricesEnabled })}
            />
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
              <span>
                {d.updatedAt
                  ? `Last updated ${new Date(d.updatedAt).toLocaleString()}`
                  : "Never updated"}
              </span>
              {d.pricesEnabled && (
                <Button
                  variant="secondary"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate(undefined)}
                >
                  {refresh.isPending ? "Updating… (can take a minute)" : "Update now"}
                </Button>
              )}
            </div>
            {d.lastError && <Alert>Last update failed: {d.lastError}</Alert>}
            {refresh.error && <Alert>{refresh.error.message}</Alert>}
            {refresh.data && (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">
                Updated {refresh.data.assets} coins ({refresh.data.days} days of history added).
              </p>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="font-semibold">CoinGecko API key (optional)</h2>
            <p className="text-sm text-slate-500">
              The free public API works without a key but is rate-limited. A free CoinGecko “Demo”
              key raises the limits. Stored encrypted; never shown again.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label={d.hasApiKey ? "Replace key" : "Key"}
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button
                disabled={!key || save.isPending}
                onClick={() => save.mutate({ apiKey: key }, { onSuccess: () => setKey("") })}
              >
                Save key
              </Button>
              {d.hasApiKey && (
                <Button
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => save.mutate({ apiKey: null })}
                >
                  Remove key
                </Button>
              )}
            </div>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-semibold">Coin mapping</h2>
            <p className="text-sm text-slate-500">
              Muny knows common coins. For anything else (or a symbol that means a different coin),
              enter the CoinGecko id from the coin&apos;s CoinGecko page URL, e.g.
              coingecko.com/en/coins/<span className="font-mono">livepeer</span>.
              {o.data && o.data.unpricedAssets.length > 0 && (
                <>
                  {" "}
                  Currently without a price:{" "}
                  <span className="font-medium">{o.data.unpricedAssets.join(", ")}</span>.
                </>
              )}
            </p>
            <ul className="space-y-1 text-sm">
              {Object.entries(d.assetIds).map(([a, id]) => (
                <li key={a} className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium">{a}</span> →{" "}
                    <span className="font-mono">{id}</span>
                  </span>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      const next = { ...d.assetIds };
                      delete next[a];
                      save.mutate({ assetIds: next });
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Symbol"
                placeholder="LPT"
                value={mapAsset}
                onChange={(e) => setMapAsset(e.target.value.toUpperCase())}
              />
              <Field
                label="CoinGecko id"
                placeholder="livepeer"
                value={mapId}
                onChange={(e) => setMapId(e.target.value.trim().toLowerCase())}
              />
              <Button
                variant="secondary"
                disabled={!mapAsset || !mapId || save.isPending}
                onClick={() =>
                  save.mutate(
                    { assetIds: { ...d.assetIds, [mapAsset]: mapId } },
                    { onSuccess: () => (setMapAsset(""), setMapId("")) },
                  )
                }
              >
                Add mapping
              </Button>
            </div>
            {save.error && <Alert>{save.error.message}</Alert>}
          </Card>
        </div>
      )}
    </>
  );
}
