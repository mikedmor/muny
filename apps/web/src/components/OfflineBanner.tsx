import { useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { offlineEnabled, useConnection } from "../lib/offline.js";

const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** Muny can't be reached: say what you're looking at, and check again now and then. */
export function OfflineBanner() {
  const { reachable, lastOkAt } = useConnection();
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      await api.get("/api/meta");
      // Back: load everything on screen again.
      await qc.invalidateQueries();
    } catch {
      // Still unreachable.
    } finally {
      setChecking(false);
    }
  }, [qc]);

  useEffect(() => {
    if (reachable) return;
    const id = setInterval(() => void check(), 20_000);
    const onOnline = () => void check();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, [reachable, check]);

  if (reachable) return null;
  const snapshot = offlineEnabled();
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {snapshot && lastOkAt
          ? `Offline: showing your data as of ${when(lastOkAt)}. Changes can't be saved until Muny is reachable again.`
          : "Can't reach Muny. What's on screen may be out of date, and changes can't be saved."}
      </span>
      <button
        type="button"
        disabled={checking}
        onClick={() => void check()}
        className="font-medium underline disabled:opacity-60"
      >
        {checking ? "Checking…" : "Try again"}
      </button>
    </div>
  );
}
