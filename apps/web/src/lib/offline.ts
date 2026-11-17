import { type DehydratedState, dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { inAndroidApp } from "./appShell.js";

/**
 * Offline snapshot (opt-in per device, see DECISIONS D-094).
 *
 * With it on, what this device has loaded from Muny is kept in IndexedDB,
 * encrypted (AES-GCM) with a key the browser generated and can't export, so
 * Muny opens with your last data when it can't reach the server. Read-only
 * while offline: saving fails with a clear message. It's wiped when you sign
 * out, when the server says you're signed out, and when you turn it off.
 *
 * Separately, this module tracks whether the server is reachable at all
 * (api.ts reports every request), for the "can't reach Muny" banner.
 */

const FLAG = "muny.offline";
const DB = "muny-offline";
const MAX_AGE_MS = 30 * 86_400_000;
const MAX_BYTES = 25 * 1024 * 1024;
const BUILD = typeof __MUNY_BUILD__ === "string" ? __MUNY_BUILD__ : "dev";

// --- Reachability -----------------------------------------------------------

interface Conn {
  reachable: boolean;
  /** When the server last answered (ms), or when the snapshot was saved. */
  lastOkAt: number | null;
  /** A snapshot was restored at startup. */
  fromSnapshot: boolean;
}

let conn: Conn = { reachable: true, lastOkAt: null, fromSnapshot: false };
const listeners = new Set<() => void>();
const setConn = (next: Partial<Conn>) => {
  const merged = { ...conn, ...next };
  if (
    merged.reachable === conn.reachable &&
    merged.lastOkAt === conn.lastOkAt &&
    merged.fromSnapshot === conn.fromSnapshot
  )
    return;
  conn = merged;
  for (const l of listeners) l();
};

/** api.ts: the server answered (any HTTP status). */
export const markReachable = () => setConn({ reachable: true, lastOkAt: Date.now() });
/** api.ts: the request never reached the server. */
export const markUnreachable = () => setConn({ reachable: false });

export const useConnection = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => conn,
    () => conn,
  );

// --- The setting ------------------------------------------------------------

export const offlineSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "indexedDB" in window &&
  !!globalThis.crypto?.subtle;

/**
 * Off by default in a browser. On by default in the Android app, which asks
 * for fingerprint or screen lock before showing anything; turning it off
 * there is remembered ("0").
 */
export function offlineEnabled(): boolean {
  try {
    if (!offlineSupported()) return false;
    const v = localStorage.getItem(FLAG);
    return v === "1" || (v === null && inAndroidApp());
  } catch {
    return false;
  }
}

let client: QueryClient | null = null;
let unsubscribe: (() => void) | null = null;

export async function setOfflineEnabled(on: boolean) {
  try {
    localStorage.setItem(FLAG, on ? "1" : "0");
  } catch {
    // Storage blocked: stays off.
  }
  if (on && client) {
    startSaving(client);
    await save(client);
  } else {
    stopSaving();
    await wipe();
  }
}

// --- IndexedDB + encryption -------------------------------------------------

interface Stored {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
  savedAt: number;
  /** The build that saved it: data shapes can change between builds. */
  build?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction("kv", mode).objectStore("kv"));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function key(): Promise<CryptoKey> {
  const existing = await kv<CryptoKey | undefined>("readonly", (s) => s.get("key"));
  if (existing) return existing;
  // Not extractable: the page can use it but never read it out.
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await kv("readwrite", (s) => s.put(k, "key"));
  return k;
}

async function wipe() {
  kept = new Map();
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  } catch {
    // Nothing stored.
  }
}

// --- Saving and restoring ---------------------------------------------------

type Query = DehydratedState["queries"][number];
/** Everything in the snapshot, by query hash (survives queries the cache let go of). */
let kept = new Map<string, Query>();

/** The server says nobody's signed in (or a different person is): the snapshot isn't theirs. */
function signedOut(qc: QueryClient): boolean {
  const s = qc.getQueryData<{ user?: { id: string } | null }>(["auth", "status"]);
  return !!s && !s.user;
}

async function save(qc: QueryClient) {
  if (!offlineEnabled()) return;
  if (signedOut(qc)) {
    await wipe();
    return;
  }
  const fresh = dehydrate(qc, {
    shouldDehydrateQuery: (q) => q.state.status === "success" && q.state.data !== undefined,
  }).queries;
  for (const q of fresh) kept.set(q.queryHash, q);
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [h, q] of kept) if (q.state.dataUpdatedAt < cutoff) kept.delete(h);
  let json = JSON.stringify({ mutations: [], queries: [...kept.values()] });
  // Too big: keep the most recently loaded.
  if (json.length > MAX_BYTES) {
    const newest = [...kept.values()].sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    while (newest.length && json.length > MAX_BYTES) {
      newest.splice(Math.floor(newest.length * 0.8));
      json = JSON.stringify({ mutations: [], queries: newest });
    }
    kept = new Map(newest.map((q) => [q.queryHash, q]));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    new TextEncoder().encode(json),
  );
  await kv("readwrite", (s) =>
    s.put({ iv, data, savedAt: Date.now(), build: BUILD } satisfies Stored, "snap"),
  );
}

let timer: ReturnType<typeof setTimeout> | null = null;
function startSaving(qc: QueryClient) {
  if (unsubscribe) return;
  unsubscribe = qc.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.action.type !== "success") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(qc).catch(() => {}), 2_000);
  });
}

function stopSaving() {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * At startup, before the first render: put the snapshot back (if this device
 * keeps one), then keep it up to date.
 */
export async function restoreOffline(qc: QueryClient) {
  client = qc;
  if (!offlineEnabled()) return;
  try {
    const snap = await kv<Stored | undefined>("readonly", (s) => s.get("snap"));
    if (snap && snap.build === BUILD) {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: snap.iv },
        await key(),
        snap.data,
      );
      const state = JSON.parse(new TextDecoder().decode(plain)) as DehydratedState;
      kept = new Map(state.queries.map((q) => [q.queryHash, q]));
      hydrate(qc, state);
      setConn({ lastOkAt: snap.savedAt, fromSnapshot: true });
    }
  } catch {
    // Unreadable (key gone, storage cleared): start fresh.
    await wipe();
  }
  startSaving(qc);
}
