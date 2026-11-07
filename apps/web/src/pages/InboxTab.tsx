import type { AgentProposal, ProposalDecision, ProposalList } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Button, Card, cx } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAuthStatus } from "../lib/auth.js";

/**
 * Changes an AI assistant has suggested. Nothing here has happened yet: each one
 * waits for a person, and everything shown except the assistant's reason is
 * written by Muny from your data.
 */

const SHOWN = 6;

export const useProposals = () =>
  useQuery({
    queryKey: ["proposals"],
    queryFn: () => api.get<ProposalList>("/api/proposals"),
  });

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const STATUS: Record<AgentProposal["status"], { label: string; className: string }> = {
  pending: { label: "Waiting", className: "text-slate-500" },
  approved: { label: "Approved", className: "text-emerald-700 dark:text-emerald-400" },
  rejected: { label: "Rejected", className: "text-slate-500" },
  expired: { label: "Expired", className: "text-slate-500" },
  failed: { label: "Not applied", className: "text-red-600 dark:text-red-400" },
};

function Changes({ p }: { p: AgentProposal }) {
  const [all, setAll] = useState(false);
  const shown = all ? p.changes : p.changes.slice(0, SHOWN);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">What would change</caption>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {shown.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: these never reorder.
            <tr key={i}>
              <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                {c.label}
              </th>
              <td className="py-1.5 text-right whitespace-nowrap">
                {c.from !== undefined && c.from !== null && (
                  <span className="text-slate-500 line-through">{c.from}</span>
                )}
                {c.from !== undefined && c.from !== null && (
                  <span aria-hidden="true" className="mx-1.5 text-slate-400">
                    →
                  </span>
                )}
                {c.to && <span className="font-medium">{c.to}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.changes.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="mt-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-500"
        >
          {all ? "Show fewer" : `Show all ${p.changes.length}`}
        </button>
      )}
    </div>
  );
}

function ProposalCard({
  p,
  busy,
  canDecide,
  onDecide,
}: {
  p: AgentProposal;
  busy: boolean;
  canDecide: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  return (
    <Card className="space-y-3" id={`proposal-${p.id}`}>
      <div>
        <h3 className="font-semibold">{p.summary}</h3>
        <p className="text-xs text-slate-500">
          From {p.tokenName} · {when(p.createdAt)}
        </p>
      </div>
      {p.reason && (
        <blockquote className="border-l-2 border-slate-300 pl-3 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          <span className="block text-xs text-slate-500">The assistant says:</span>
          {p.reason}
        </blockquote>
      )}
      {p.warnings.map((w) => (
        <p key={w} className="text-sm text-amber-700 dark:text-amber-400">
          {w}
        </p>
      ))}
      {p.changes.length > 0 && <Changes p={p} />}
      {canDecide && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => onDecide("approve")}>
            Approve
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onDecide("reject")}>
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

export function InboxTab() {
  const qc = useQueryClient();
  const list = useProposals();
  const canDecide = useAuthStatus().data?.user?.role !== "viewer";
  const decide = useMutation({
    mutationFn: (body: { ids: string[]; decision: "approve" | "reject" }) =>
      api.post<ProposalDecision[]>("/api/proposals/decide", body),
    // An approval can change almost anything on screen.
    onSuccess: () => qc.invalidateQueries(),
  });
  const pending = list.data?.pending ?? [];
  const recent = list.data?.recent ?? [];
  const failures = (decide.data ?? []).filter((d) => d.status === "failed");

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-slate-500">
        Changes an AI assistant has suggested. Nothing here has happened: each one waits for you,
        and suggestions you leave expire after 30 days. Assistants connect in{" "}
        <a href="/settings#agents" className="text-brand-600 underline dark:text-brand-500">
          Settings → Agents
        </a>
        .
      </p>
      {list.isError && <Alert>Couldn't load the inbox.</Alert>}
      {decide.error && <Alert>{decide.error.message}</Alert>}
      {failures.map((f) => (
        <Alert key={f.id}>{f.result ?? "That couldn't be applied."}</Alert>
      ))}

      {pending.length > 1 && canDecide && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{pending.length} waiting</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => {
                if (window.confirm(`Approve all ${pending.length} suggestions?`))
                  decide.mutate({ ids: pending.map((p) => p.id), decision: "approve" });
              }}
            >
              Approve all
            </Button>
            <Button
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => {
                if (window.confirm(`Reject all ${pending.length} suggestions?`))
                  decide.mutate({ ids: pending.map((p) => p.id), decision: "reject" });
              }}
            >
              Reject all
            </Button>
          </div>
        </div>
      )}

      {pending.map((p) => (
        <ProposalCard
          key={p.id}
          p={p}
          busy={decide.isPending}
          canDecide={canDecide}
          onDecide={(decision) => decide.mutate({ ids: [p.id], decision })}
        />
      ))}
      {list.data && pending.length === 0 && (
        <Card className="text-center text-sm text-slate-500">Nothing waiting for you.</Card>
      )}

      {recent.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Decided</h2>
          <Card className="p-0">
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {recent.map((p) => (
                <li key={p.id} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0">{p.summary}</span>
                    <span
                      className={cx("shrink-0 text-xs font-medium", STATUS[p.status].className)}
                    >
                      {STATUS[p.status].label}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {p.tokenName} · {when(p.decidedAt ?? p.createdAt)}
                  </p>
                  {p.status === "failed" && p.result && (
                    <p className="text-xs text-slate-500">{p.result}</p>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}
