import { useSyncExternalStore } from "react";

/**
 * This device as an installed app: the browser's install prompt (Chrome and
 * Edge offer it before installing; we keep it for an "Install app" button),
 * whether Muny is running installed, and the unread count on the app icon.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Call once at startup, before the browser fires its install events. */
export function watchInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // We show our own button instead of Chrome's mini bar.
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });
}

export const isStandalone = () =>
  installed ||
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export interface InstallState {
  /** Running as the installed app. */
  standalone: boolean;
  /** The browser offered to install; `install()` shows its dialog. */
  canPrompt: boolean;
}

let snapshot: InstallState = { standalone: false, canPrompt: false };
const read = (): InstallState => {
  const next = { standalone: isStandalone(), canPrompt: !!deferred };
  if (next.standalone !== snapshot.standalone || next.canPrompt !== snapshot.canPrompt)
    snapshot = next;
  return snapshot;
};

export function useInstall(): InstallState & { install: () => Promise<boolean> } {
  const state = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    read,
  );
  return {
    ...state,
    install: async () => {
      if (!deferred) return false;
      const e = deferred;
      deferred = null;
      await e.prompt();
      const { outcome } = await e.userChoice;
      emit();
      return outcome === "accepted";
    },
  };
}

/** The unread alert count on the installed app's icon (Android, desktop Chrome/Edge). */
export function setAppBadge(count: number) {
  const n = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void n.setAppBadge?.(count).catch(() => {});
    else void n.clearAppBadge?.().catch(() => {});
  } catch {
    // Not supported here.
  }
}
