import { CRYPTO_SYNC_CHAINS } from "@muny/shared";
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
  const [bsKey, setBsKey] = useState("");
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
              label="Get crypto prices"
              description="Off by default. When on, Muny asks the price provider below for the price of each coin you hold once a day when you open Crypto (or when you press Refresh), and fills in daily price history back to your first transaction. It sends only coin ids like “bitcoin”, never balances, addresses or wallet names."
              checked={d.pricesEnabled}
              onChange={(pricesEnabled) => save.mutate({ pricesEnabled })}
            />
            <fieldset className="space-y-2 pl-7">
              <legend className="text-sm font-medium">Price provider</legend>
              {(
                [
                  [
                    "defillama",
                    "DefiLlama (recommended)",
                    "Free, no account or key, years of daily history.",
                  ],
                  [
                    "coingecko",
                    "CoinGecko",
                    "About a year of history on the free plan; works best with a free Demo key (below).",
                  ],
                ] as const
              ).map(([value, label, note]) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="provider"
                    value={value}
                    checked={d.provider === value}
                    onChange={() => save.mutate({ provider: value })}
                    className="mt-1 accent-brand-600"
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="block text-xs text-slate-500">{note}</span>
                  </span>
                </label>
              ))}
            </fieldset>
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

          {d.provider === "coingecko" && (
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
          )}

          <Card className="space-y-3">
            <h2 className="font-semibold">Wallet sync servers</h2>
            <p className="text-sm text-slate-500">
              Ethereum and the other EVM chains sync through Blockscout&apos;s public explorers by
              default; enter a URL only for your own Blockscout. Bitcoin, Litecoin, Dogecoin and
              Zcash need a Blockbook server you run or rent (Trezor&apos;s public ones refuse other
              apps). Whichever server you use sees the addresses you sync.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {CRYPTO_SYNC_CHAINS.map((c) => (
                <ServerField
                  key={c.key}
                  chain={c.key}
                  evm={c.evm}
                  label={c.name}
                  value={d.servers[c.key] ?? ""}
                  onSave={(url) => save.mutate({ servers: { ...d.servers, [c.key]: url } })}
                />
              ))}
            </div>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-semibold">Blockscout API key (recommended)</h2>
            <p className="text-sm text-slate-500">
              Without a key, EVM wallets sync through each chain&apos;s public Blockscout site,
              whose limits are shared with everyone. A free key from{" "}
              <a
                href="https://dev.blockscout.com"
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 underline"
              >
                dev.blockscout.com
              </a>{" "}
              gives you your own limits (100K credits a day) on one endpoint for every chain. Stored
              encrypted; never shown again.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label={d.hasBlockscoutKey ? "Replace key" : "Key"}
                type="password"
                autoComplete="off"
                value={bsKey}
                onChange={(e) => setBsKey(e.target.value.trim())}
              />
              <Button
                disabled={!bsKey || save.isPending}
                onClick={() =>
                  save.mutate({ blockscoutKey: bsKey }, { onSuccess: () => setBsKey("") })
                }
              >
                Save key
              </Button>
              {d.hasBlockscoutKey && (
                <Button
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => save.mutate({ blockscoutKey: null })}
                >
                  Remove key
                </Button>
              )}
            </div>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-semibold">Request limits</h2>
            <p className="text-sm text-slate-500">
              Muny counts every request to these free services and stops before their limits, so
              refreshing often can&apos;t get you blocked. Prices and wallets refresh on their own
              at most once a day, only when someone opens Crypto.
            </p>
            <ul className="space-y-2 text-sm">
              {d.usage.map((u) => (
                <li key={u.provider}>
                  <span className="flex justify-between gap-3">
                    <span>{u.label}</span>
                    <span className="tabular-nums text-slate-500">
                      {u.today} / {u.dayLimit} today · {u.month} / {u.monthLimit} this month
                    </span>
                  </span>
                  <span
                    className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                    aria-hidden
                  >
                    <span
                      className="block h-full rounded-full bg-brand-600"
                      style={{
                        width: `${Math.min(100, (Math.max(u.today / u.dayLimit, u.month / u.monthLimit) || 0) * 100)}%`,
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
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
                    {
                      onSuccess: () => {
                        setMapAsset("");
                        setMapId("");
                      },
                    },
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

function ServerField({
  chain,
  evm,
  label,
  value,
  onSave,
}: {
  chain: string;
  evm: boolean;
  label: string;
  value: string;
  onSave: (url: string) => void;
}) {
  const [v, setV] = useState(value);
  return (
    <Field
      label={label}
      name={`server-${chain}`}
      placeholder={evm ? "Default (Blockscout)" : "Required: https://your-blockbook"}
      inputMode="url"
      value={v}
      onChange={(e) => setV(e.target.value.trim())}
      onBlur={() => v !== value && onSave(v)}
    />
  );
}
