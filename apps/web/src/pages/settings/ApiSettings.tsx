import {
  type AssetValuationSettings,
  CRYPTO_SYNC_CHAINS,
  type CryptoUsage,
  describeWait,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, ExternalLink } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiLimitNotice } from "../../components/ApiLimit.js";
import { Checkbox } from "../../components/forms.js";
import { Alert, Button, Card, cx, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import {
  keys,
  useCryptoMutation,
  useCryptoOverview,
  useCryptoSettings,
  useInvestSettings,
  useSetInvestSettings,
  useSyncConfig,
} from "../../lib/queries.js";

/**
 * Every outside service Muny can use, in one place: what it's for, whether it's
 * set up, and how much of its free allowance has been used.
 */

type Tone = "good" | "suggest" | "idle";

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
      <span
        aria-hidden="true"
        className={cx(
          "size-2 rounded-full",
          tone === "good" && "bg-emerald-500",
          tone === "suggest" && "bg-amber-500",
          tone === "idle" && "bg-slate-300 dark:bg-slate-600",
        )}
      />
      {children}
    </span>
  );
}

/** One service: its status always in view, its setup folded away once it's done. */
function Service({
  name,
  purpose,
  status,
  tone,
  startOpen,
  collapseWhen,
  children,
}: {
  name: string;
  purpose: string;
  status: string;
  tone: Tone;
  startOpen: boolean;
  /** Folds the row up the moment this turns true (a key was saved). */
  collapseWhen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(startOpen);
  useEffect(() => {
    if (collapseWhen) setOpen(false);
  }, [collapseWhen]);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <ChevronRight
          aria-hidden="true"
          className={cx("size-4 shrink-0 text-slate-400 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs text-slate-500">{purpose}</span>
        </span>
        <Status tone={tone}>{status}</Status>
      </button>
      {open && <div className="space-y-3 px-4 pt-1 pb-4 sm:pl-11">{children}</div>}
    </li>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      <Card className="p-0">
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">{children}</ul>
      </Card>
    </section>
  );
}

function Outbound({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-brand-600 underline dark:text-brand-500"
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
}

/** Add, replace or remove a key. A saved key is never shown again. */
function KeyForm({
  name,
  hasKey,
  onSave,
  onRemove,
}: {
  name: string;
  hasKey: boolean;
  onSave: (key: string) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setValue("");
      setReplacing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (key) void run(() => onSave(key));
  };
  return (
    <div className="space-y-2">
      {hasKey && !replacing ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600 dark:text-slate-300">
            Your key is saved and encrypted.
          </span>
          <Button
            variant="secondary"
            className="px-3 py-1.5"
            onClick={() => setReplacing(true)}
            disabled={busy}
          >
            Replace
          </Button>
          <Button
            variant="ghost"
            className="px-3 py-1.5 text-red-600"
            onClick={() => void run(onRemove)}
            disabled={busy}
          >
            Remove
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <Field
            label={`${name} API key`}
            className="min-w-56 flex-1"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" disabled={!value.trim() || busy}>
            {busy ? "Saving…" : "Save key"}
          </Button>
          {replacing && (
            <Button variant="ghost" onClick={() => setReplacing(false)}>
              Cancel
            </Button>
          )}
        </form>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function ServerField({
  chain,
  label,
  value,
  onSave,
}: {
  chain: string;
  label: string;
  value: string;
  onSave: (url: string) => void;
}) {
  const [v, setV] = useState(value);
  return (
    <Field
      label={label}
      name={`server-${chain}`}
      placeholder="Default"
      inputMode="url"
      value={v}
      onChange={(e) => setV(e.target.value.trim())}
      onBlur={() => v !== value && onSave(v)}
    />
  );
}

/** What each free plan allows, next to Muny's own cap (which stays under it). */
const PLAN_NOTES: Record<string, string> = {
  apillow:
    "Free plan: 50 different homes a day. Looking the same home up again that day doesn't count.",
  apillowreq:
    "Every request: lookups and checks for their result, at most one every 15 seconds (5 a minute allowed).",
  carapi: "Free plan: 100 requests a month. Each lookup is one request.",
  nhtsa: "Public, no key. Make and model names while you fill in a vehicle, kept for a month.",
};

const share = (u: CryptoUsage) => Math.max(u.today / u.dayLimit, u.month / u.monthLimit) || 0;

function RequestLimits({ usage }: { usage: CryptoUsage[] }) {
  const used = usage.filter((u) => u.month > 0).sort((a, b) => share(b) - share(a));
  const idle = usage.length - used.length;
  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Request limits
      </h3>
      <Card className="space-y-3">
        <p className="text-xs text-slate-500">
          Muny counts every request and stops before each service's limit, so refreshing often can't
          get you blocked or run past a free plan. Counts reset each day and month.
        </p>
        {used.length === 0 && <p className="text-sm text-slate-500">No requests yet this month.</p>}
        <ul className="space-y-3 text-sm">
          {used.map((u) => (
            <li key={u.provider}>
              <span className="block">{u.label}</span>
              {u.limit && (
                <span className="block text-xs font-medium text-amber-700 dark:text-amber-400">
                  {u.limit.period === "day" ? "Daily" : "Monthly"} limit reached · resets in{" "}
                  {describeWait(u.limit.resetsAt - Date.now())}
                </span>
              )}
              <span className="block text-xs tabular-nums text-slate-500">
                {u.today.toLocaleString()} / {u.dayLimit.toLocaleString()} today ·{" "}
                {u.month.toLocaleString()} / {u.monthLimit.toLocaleString()} this month
              </span>
              <span
                className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                aria-hidden="true"
              >
                <span
                  className={cx(
                    "block h-full rounded-full",
                    u.limit ? "bg-amber-500" : "bg-brand-600",
                  )}
                  style={{ width: `${Math.min(100, share(u) * 100)}%` }}
                />
              </span>
              {PLAN_NOTES[u.provider] && (
                <span className="mt-1 block text-xs text-slate-500">{PLAN_NOTES[u.provider]}</span>
              )}
            </li>
          ))}
        </ul>
        {idle > 0 && used.length > 0 && (
          <p className="text-xs text-slate-500">
            {idle} other service{idle === 1 ? "" : "s"} with no requests this month.
          </p>
        )}
      </Card>
    </section>
  );
}

const VALUATION_KEY = [...keys.accounts, "asset-valuation"];

export function ApiSettings() {
  const qc = useQueryClient();
  const crypto = useCryptoSettings();
  const overview = useCryptoOverview();
  const save = useCryptoMutation((body: object) => api.put("/api/crypto/settings", body));
  const refresh = useCryptoMutation(() =>
    api.post<{ assets: number; days: number }>("/api/crypto/prices/refresh"),
  );
  const valuation = useQuery({
    queryKey: VALUATION_KEY,
    queryFn: () => api.get<AssetValuationSettings>("/api/assets/valuation"),
  });
  const invest = useInvestSettings();
  const setInvest = useSetInvestSettings();
  const sync = useSyncConfig();
  const [mapAsset, setMapAsset] = useState("");
  const [mapId, setMapId] = useState("");

  const setValuationKey = async (service: "apillow" | "carapi", key: string | null) => {
    await api.put(`/api/assets/valuation/${service}`, { key });
    await qc.invalidateQueries({ queryKey: VALUATION_KEY });
  };

  const d = crypto.data;
  const v = valuation.data;
  const stocks = invest.data;
  const banks = sync.data;
  if (crypto.isError) return <Alert>{crypto.error.message}</Alert>;
  // Rows open or fold by what's set up, so wait until that's known.
  if (!d || !v || !stocks || !banks) return <p className="text-sm text-slate-500">Loading…</p>;

  const providerName = d.provider === "coingecko" ? "CoinGecko" : "DefiLlama";
  const limited = (...providers: string[]) =>
    d.usage.find((u) => providers.includes(u.provider) && u.limit)?.limit ?? null;
  const priceLimit = limited(d.provider);
  const customServers = Object.values(d.servers).filter(Boolean).length;
  const stockExtras = [
    stocks.logos && "Logos",
    stocks.market && "Market",
    stocks.details && "Details",
  ].filter(Boolean);
  const bankNames = [banks.plaid.configured && "Plaid", banks.teller.configured && "Teller"].filter(
    Boolean,
  );

  return (
    <section className="space-y-4">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold">API</h2>
        <p className="text-sm text-slate-500">
          The outside services Muny can use. Each one stays off until you set it up here. Your keys
          are stored encrypted and only ever sent to their own service.
        </p>
      </div>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-6">
          <Group title="Crypto">
            <Service
              name="Crypto prices"
              purpose="What your coins are worth, today and in the past"
              status={
                priceLimit ? "Limit reached" : d.pricesEnabled ? `On · ${providerName}` : "Off"
              }
              tone={priceLimit ? "suggest" : d.pricesEnabled ? "good" : "idle"}
              startOpen={!d.pricesEnabled || !!priceLimit}
            >
              <Checkbox
                label="Get crypto prices"
                description="Muny asks the provider below once a day when you open Crypto, or when you press Update now, and fills in daily history back to your first transaction. It sends only coin ids like “bitcoin”, never balances, addresses or wallet names."
                checked={d.pricesEnabled}
                onChange={(pricesEnabled) => save.mutate({ pricesEnabled })}
              />
              <fieldset className="space-y-2">
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
                      "About a year of history on the free plan. Works best with a free Demo key.",
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
              {d.provider === "coingecko" && (
                <KeyForm
                  name="CoinGecko"
                  hasKey={d.hasApiKey}
                  onSave={(apiKey) => save.mutateAsync({ apiKey })}
                  onRemove={() => save.mutateAsync({ apiKey: null })}
                />
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
                <span>
                  {d.updatedAt
                    ? `Last updated ${new Date(d.updatedAt).toLocaleString()}`
                    : "Never updated"}
                </span>
                {d.pricesEnabled && (
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5"
                    disabled={refresh.isPending || !!priceLimit}
                    onClick={() => refresh.mutate(undefined)}
                  >
                    {refresh.isPending ? "Updating… (can take a minute)" : "Update now"}
                  </Button>
                )}
              </div>
              {priceLimit && <ApiLimitNotice limit={priceLimit} />}
              {d.lastError && !priceLimit && <Alert>Last update failed: {d.lastError}</Alert>}
              {refresh.error && <Alert>{refresh.error.message}</Alert>}
              {refresh.data && (
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  Updated {refresh.data.assets} coins ({refresh.data.days} days of history added).
                </p>
              )}
            </Service>

            <Service
              name="Coin mapping"
              purpose="Match a symbol to the right coin for prices"
              status={
                Object.keys(d.assetIds).length
                  ? `${Object.keys(d.assetIds).length} mapped`
                  : "Automatic"
              }
              tone="idle"
              startOpen={false}
            >
              <p className="text-sm text-slate-500">
                Muny knows common coins. For anything else, or a symbol that means a different coin,
                enter the id from the coin's CoinGecko page, e.g. coingecko.com/en/coins/
                <span className="font-mono">livepeer</span>.
                {overview.data && overview.data.unpricedAssets.length > 0 && (
                  <>
                    {" "}
                    Currently without a price:{" "}
                    <span className="font-medium">{overview.data.unpricedAssets.join(", ")}</span>.
                  </>
                )}
              </p>
              {Object.keys(d.assetIds).length > 0 && (
                <ul className="space-y-1 text-sm">
                  {Object.entries(d.assetIds).map(([a, id]) => (
                    <li key={a} className="flex items-center justify-between gap-3">
                      <span>
                        <span className="font-medium">{a}</span> →{" "}
                        <span className="font-mono">{id}</span>
                      </span>
                      <Button
                        variant="ghost"
                        className="px-3 py-1.5 text-red-600"
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
              )}
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
            </Service>

            <Service
              name="Blockscout"
              purpose="Faster, more reliable sync for Ethereum-style wallets"
              status={
                limited("blockscout")
                  ? "Limit reached"
                  : d.hasBlockscoutKey
                    ? "Key added"
                    : "Recommended"
              }
              tone={d.hasBlockscoutKey && !limited("blockscout") ? "good" : "suggest"}
              startOpen={!d.hasBlockscoutKey}
              collapseWhen={d.hasBlockscoutKey}
            >
              <p className="text-sm text-slate-500">
                Without a key, these wallets sync through each chain's public Blockscout site, whose
                limits are shared with everyone. A free key gives you your own limits (100K credits
                a day) on one endpoint for every chain.{" "}
                <Outbound href="https://dev.blockscout.com">Get a key</Outbound>
              </p>
              <KeyForm
                name="Blockscout"
                hasKey={d.hasBlockscoutKey}
                onSave={(blockscoutKey) => save.mutateAsync({ blockscoutKey })}
                onRemove={() => save.mutateAsync({ blockscoutKey: null })}
              />
            </Service>

            <Service
              name="Wallet sync servers"
              purpose="Use your own server instead of a public one"
              status={customServers ? `${customServers} custom` : "Public servers"}
              tone="idle"
              startOpen={false}
            >
              <p className="text-sm text-slate-500">
                Muny picks a free public service for each coin. Enter a URL only to use your own
                instance of the same service instead, such as a self-hosted mempool, Blockscout or
                Koios. Whichever server you use sees the addresses you sync.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {CRYPTO_SYNC_CHAINS.map((c) => (
                  <ServerField
                    key={c.key}
                    chain={c.key}
                    label={`${c.name} (${c.coin})`}
                    value={d.servers[c.key] ?? ""}
                    onSave={(url) => save.mutate({ servers: { ...d.servers, [c.key]: url } })}
                  />
                ))}
              </div>
            </Service>
            {save.error && (
              <li className="p-4">
                <Alert>{save.error.message}</Alert>
              </li>
            )}
          </Group>

          <Group title="Assets">
            <Service
              name="APillow"
              purpose="Home values from Zillow data"
              status={
                limited("apillow", "apillowreq")
                  ? "Limit reached"
                  : v.apillow
                    ? "Key added"
                    : "Not set up"
              }
              tone={limited("apillow", "apillowreq") ? "suggest" : v.apillow ? "good" : "idle"}
              startOpen={!v.apillow}
              collapseWhen={v.apillow}
            >
              <p className="text-sm text-slate-500">
                Free plan: 50 lookups a month. Sends only the home's address. Muny looks values up
                when you ask, then about once a month.{" "}
                <Outbound href="https://apillow.co">Get a key</Outbound>
              </p>
              <KeyForm
                name="APillow"
                hasKey={v.apillow}
                onSave={(key) => setValuationKey("apillow", key)}
                onRemove={() => setValuationKey("apillow", null)}
              />
            </Service>
            <Service
              name="CarAPI.dev"
              purpose="Vehicle values"
              status={limited("carapi") ? "Limit reached" : v.carapi ? "Key added" : "Not set up"}
              tone={limited("carapi") ? "suggest" : v.carapi ? "good" : "idle"}
              startOpen={!v.carapi}
              collapseWhen={v.carapi}
            >
              <p className="text-sm text-slate-500">
                Free plan: 100 requests a month. Sends only year, make, model and mileage. Muny
                looks values up when you ask, then about once a month.{" "}
                <Outbound href="https://carapi.dev">Get a key</Outbound>
              </p>
              <KeyForm
                name="CarAPI.dev"
                hasKey={v.carapi}
                onSave={(key) => setValuationKey("carapi", key)}
                onRemove={() => setValuationKey("carapi", null)}
              />
            </Service>
          </Group>

          <Group title="Stocks">
            <Service
              name="Stock extras"
              purpose="Company logos, the market overview, and live details and news on a stock's page"
              status={stockExtras.length ? `On · ${stockExtras.join(", ")}` : "Off"}
              tone={stockExtras.length ? "good" : "idle"}
              startOpen={false}
            >
              <p className="text-sm text-slate-500">
                No key needed. Logos come from Financial Modeling Prep or Parqet, once per ticker,
                and market prices from Yahoo Finance, at most hourly while you look. A stock's page
                gets its live details and news from Yahoo Finance when you open it, kept for 15
                minutes. Only ticker symbols are sent, never your holdings.
              </p>
              <Checkbox
                label="Company logos"
                checked={stocks.logos}
                onChange={(logos) => setInvest.mutate({ logos })}
              />
              <Checkbox
                label="Market overview"
                checked={stocks.market}
                onChange={(market) => setInvest.mutate({ market })}
              />
              <Checkbox
                label="Stock details and news"
                checked={stocks.details}
                onChange={(details) => setInvest.mutate({ details })}
              />
            </Service>
          </Group>

          <Group title="Banks">
            <Service
              name="Plaid and Teller"
              purpose="Automatic bank sync"
              status={bankNames.length ? bankNames.join(", ") : "Not set up"}
              tone={bankNames.length ? "good" : "idle"}
              startOpen={false}
            >
              <p className="text-sm text-slate-500">
                These keys live in your server's <span className="font-mono">.env</span> file, so
                they can't be changed here.{" "}
                <Outbound href="https://github.com/mikedmor/muny/blob/main/guides/bank-sync.md">
                  Bank sync guide
                </Outbound>{" "}
                Connect a bank under{" "}
                <a href="/accounts" className="text-brand-600 underline dark:text-brand-500">
                  Accounts
                </a>
                .
              </p>
            </Service>
          </Group>

          <p className="px-1 text-xs text-slate-500">
            Looking for AI? Assistants connect under{" "}
            <a href="#agents" className="text-brand-600 underline dark:text-brand-500">
              Agents
            </a>
            , and Muny's built-in AI is under{" "}
            <a href="#ai" className="text-brand-600 underline dark:text-brand-500">
              AI
            </a>
            .
          </p>
        </div>

        <div className="lg:sticky lg:top-6">
          <RequestLimits usage={d.usage} />
        </div>
      </div>
    </section>
  );
}
