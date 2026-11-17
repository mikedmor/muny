import { api } from "./api.js";

/**
 * The Muny Android app (a WebView, from the app-shell project). On Muny's own
 * origin it gives the page a `window.AppShell` message port; requests are
 * JSON with an `id`, answers come back as `message` events with that `id`.
 * Notifications go through Firebase Cloud Messaging: the app hands us a
 * subscription like a browser's (endpoint `fcm:<token>` + its own encryption
 * keys), which the server registers and encrypts to like Web Push.
 */

interface Port {
  postMessage(message: string): void;
  addEventListener(type: "message", cb: (e: MessageEvent) => void): void;
}

export interface AppSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface Reply {
  id?: string;
  ok: boolean;
  error?: string;
}

export interface AppHello extends Reply {
  app: string;
  version: string;
  /** The app asks for fingerprint or screen lock. */
  lock: boolean;
  push: { available: boolean; permission: boolean; subscription?: AppSubscription };
}

const port = (): Port | undefined => (window as Window & { AppShell?: Port }).AppShell;

/** Running inside the Muny Android app. */
export const inAndroidApp = (): boolean =>
  typeof window !== "undefined" && (!!port() || /\bAppShell\//.test(navigator.userAgent));

let seq = 0;
let listening = false;
const waiting = new Map<string, (r: Reply) => void>();

function ask<T extends Reply>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const p = port();
  if (!p) return Promise.reject(new Error("Not running in the Muny app"));
  if (!listening) {
    listening = true;
    p.addEventListener("message", (e) => {
      let r: Reply;
      try {
        r = JSON.parse(String(e.data)) as Reply;
      } catch {
        return;
      }
      const done = r.id ? waiting.get(r.id) : undefined;
      if (r.id && done) {
        waiting.delete(r.id);
        done(r);
      }
    });
  }
  seq += 1;
  const id = String(seq);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("The app didn't answer"));
    }, timeoutMs);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      resolve(r as T);
    });
    p.postMessage(JSON.stringify({ ...msg, id }));
  });
}

export const appHello = () => ask<AppHello>({ type: "hello" }, 5_000);

/** Asks for notification permission, the push app, then an endpoint (can take a while). */
export const appSubscribe = (vapid: string) =>
  ask<Reply & { subscription?: AppSubscription }>({ type: "push.subscribe", vapid }, 90_000);

/** The app's Server and lock screen. */
export const openAppSettings = () => port()?.postMessage(JSON.stringify({ type: "settings" }));

/** What to tell the user when the app couldn't turn notifications on. */
export function appPushError(error: string | undefined): string {
  switch (error) {
    case "not-configured":
      return "This copy of the app was built without notifications (no Firebase setup).";
    case "denied":
      return "Notifications are off for Muny in Android. Turn them on in Settings → Apps → Muny → Notifications, then try again.";
    case "failed:IOException":
      return "Couldn't reach Google to set up notifications. Check you're online and that Google Play services is up to date, then try again.";
    default:
      return `Couldn't turn them on${error ? ` (${error})` : ""}.`;
  }
}

// --- Keeping the server's copy of this phone's endpoint current ----------------

const REGISTERED = "muny.appPush";

/** Registers this phone with the server and remembers the endpoint it registered. */
export async function registerAppPush(sub: AppSubscription) {
  await api.post("/api/alerts/push/subscribe", {
    endpoint: sub.endpoint,
    keys: sub.keys,
    device: "Android app",
  });
  try {
    localStorage.setItem(REGISTERED, sub.endpoint);
  } catch {
    // Storage blocked: it re-registers next time.
  }
}

/** Turns notifications off on this phone: the server drops its channel, the app its token and keys. */
export async function unregisterAppPush(endpoint: string | null) {
  if (endpoint) await api.post("/api/alerts/push/unsubscribe", { endpoint });
  await ask({ type: "push.unsubscribe" }, 10_000).catch(() => {});
  try {
    localStorage.removeItem(REGISTERED);
  } catch {
    // Nothing kept.
  }
}

/**
 * At startup in the app: Google can change this phone's push token (after a
 * reinstall or a restore). If notifications were turned on here and the
 * endpoint moved, tell the server the new one.
 */
export async function syncAppPush() {
  let registered: string | null = null;
  try {
    registered = localStorage.getItem(REGISTERED);
  } catch {
    return;
  }
  if (!registered || !port()) return;
  const hello = await appHello();
  const sub = hello.push?.subscription;
  if (sub && sub.endpoint !== registered) await registerAppPush(sub);
}
