import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api.js";
import { Alert, Button } from "./ui.js";

/** Demo mode: a made-up household fills a fresh install until you start clean. */

const key = ["demo"] as const;

export const useDemo = () =>
  useQuery({ queryKey: key, queryFn: () => api.get<{ active: boolean }>("/api/demo") });

/** A line at the top of every page while the demo household is showing. */
export function DemoBanner() {
  const demo = useDemo();
  if (!demo.data?.active) return null;
  return (
    <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
      You're looking at a made-up demo household. Explore and change anything.{" "}
      <Link to="/settings" hash="data" className="font-medium underline">
        Start clean
      </Link>{" "}
      when you're ready to add your own.
    </p>
  );
}

/** Settings → Data: remove the demo household. */
export function StartClean({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const demo = useDemo();
  const clear = useMutation({
    mutationFn: () => api.post("/api/demo/clear", {}),
    onSuccess: () => qc.invalidateQueries(),
  });
  if (!demo.data?.active) return null;
  return (
    <div>
      <h2 className="text-lg font-semibold">Demo data</h2>
      <p className="mb-3 text-sm text-slate-500">
        Removes the made-up household and anything you've added to it (accounts, transactions,
        budgets, recurring charges, documents), and starts again with the default categories.
        People, settings, themes and tokens stay. It can't be undone.
      </p>
      {clear.error && <Alert>{clear.error.message}</Alert>}
      {owner ? (
        <Button
          variant="secondary"
          disabled={clear.isPending}
          onClick={() => {
            if (window.confirm("Remove the demo household and start clean? This can't be undone."))
              clear.mutate();
          }}
        >
          {clear.isPending ? "Removing…" : "Start clean"}
        </Button>
      ) : (
        <p className="text-sm text-slate-500">Only the household owner can do this.</p>
      )}
    </div>
  );
}
