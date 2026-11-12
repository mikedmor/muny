import type { LiveKey, LiveQuote, LiveSettings, PriceAlert } from "@muny/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "./api.js";

/**
 * Live prices in the browser: one stream from Muny (server-sent events) for
 * every price any open part of the page wants. The server does the fetching;
 * the browser only ever talks to Muny.
 */

const quotes = new Map<LiveKey, LiveQuote>();
const wanted = new Map<LiveKey, number>();
const listeners = new Set<() => void>();
let version = 0;
let source: EventSource | null = null;
let current = "";
let timer: ReturnType<typeof setTimeout> | null = null;

function changed() {
  version++;
  for (const fn of listeners) fn();
}

/** Reopen the stream for the prices wanted now (shortly, so a page's parts settle first). */
function reconnect() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const keys = [...wanted.keys()].sort().join(",");
    if (keys === current) return;
    current = keys;
    source?.close();
    source = null;
    if (!keys || typeof EventSource === "undefined") return;
    source = new EventSource(`/api/live/stream?keys=${encodeURIComponent(keys)}`);
    source.onmessage = (e) => {
      try {
        const q = JSON.parse(e.data) as LiveQuote;
        quotes.set(q.key, q);
        changed();
      } catch {
        // not a price
      }
    };
  }, 300);
}

function want(keys: LiveKey[]) {
  for (const k of keys) wanted.set(k, (wanted.get(k) ?? 0) + 1);
  reconnect();
  return () => {
    for (const k of keys) {
      const n = (wanted.get(k) ?? 1) - 1;
      if (n > 0) wanted.set(k, n);
      else wanted.delete(k);
    }
    reconnect();
  };
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const liveSettingsKey = ["live"] as const;

export const useLiveSettings = () =>
  useQuery({
    queryKey: liveSettingsKey,
    queryFn: () => api.get<LiveSettings>("/api/live"),
    staleTime: 60_000,
  });

/** Live prices for these, while the component is shown (nothing while live prices are off). */
export function useLiveQuotes(keys: LiveKey[]): Map<LiveKey, LiveQuote> {
  const s = useLiveSettings().data;
  const on = keys.filter((k) => (k.startsWith("stock:") ? s?.stocks : s?.crypto));
  const sig = on.slice().sort().join(",");
  useEffect(() => {
    if (!sig) return;
    return want(sig.split(",") as LiveKey[]);
  }, [sig]);
  const v = useSyncExternalStore(subscribe, () => version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new map when a price arrives
  return useMemo(() => {
    const out = new Map<LiveKey, LiveQuote>();
    for (const k of on) {
      const q = quotes.get(k);
      if (q) out.set(k, q);
    }
    return out;
  }, [sig, v]);
}

export const priceAlertsKey = ["price-alerts"] as const;

/** Every price alert, to show which symbols have one. */
export const usePriceAlerts = () =>
  useQuery({
    queryKey: priceAlertsKey,
    queryFn: () => api.get<PriceAlert[]>("/api/price-alerts"),
  });

/** A price for display: more decimals under a dollar. */
export const fmtLive = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 1 ? 6 : 2,
  });
