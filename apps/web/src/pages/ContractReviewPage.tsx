import type {
  ContractFinding,
  ContractFindingKind,
  ContractReviewResult,
  ContractReviewState,
} from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Alert, Button, Card, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * What the AI made of a contract in Documents. Everything it quotes has been
 * looked up in the contract's own text; what couldn't be found says so.
 */

const GROUPS: { kind: ContractFindingKind; title: string; blurb: string }[] = [
  { kind: "exit", title: "Ways out", blurb: "Cancelling, transferring or ending it early." },
  { kind: "savings", title: "Ways to save", blurb: "Paying less under the contract's own terms." },
  { kind: "risk", title: "Watch out for", blurb: "Terms that could cost you." },
  {
    kind: "mismatch",
    title: "Looks off",
    blurb: "Things that don't add up or seem to be missing.",
  },
];

const pageList = (pages: number[]) => {
  const runs: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i] as number;
    let end = start;
    while (pages[i + 1] === end + 1) {
      end++;
      i++;
    }
    runs.push(start === end ? `${start}` : `${start}–${end}`);
  }
  return `${pages.length === 1 ? "page" : "pages"} ${runs.join(", ")}`;
};

function Finding({ f, href }: { f: ContractFinding; href: string }) {
  return (
    <li className="px-4 py-3 text-sm">
      <p className="font-medium">{f.title}</p>
      <p className="mt-1 text-slate-600 dark:text-slate-300">{f.explanation}</p>
      {f.quote && (
        <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 text-xs text-slate-500 italic dark:border-slate-700">
          “{f.quote}”
          {f.page !== null && (
            <a
              href={`${href}#page=${f.page}`}
              target="_blank"
              rel="noopener"
              className="ml-2 inline-flex items-center gap-1 text-brand-600 not-italic hover:underline dark:text-brand-500"
            >
              Page {f.page}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          )}
        </blockquote>
      )}
      {f.quote && !f.verified && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          Muny couldn't find these words in the contract. The model may have got this wrong, so
          don't rely on it until you've found the clause yourself.
        </p>
      )}
      {!f.quote && (
        <p className="mt-2 text-xs text-slate-500">
          About something the contract leaves out, so there's no clause to point to.
        </p>
      )}
      {f.nextStep && (
        <p className="mt-2">
          <span className="font-medium">What you could do: </span>
          {f.nextStep}
        </p>
      )}
    </li>
  );
}

function Result({ r, href }: { r: ContractReviewResult; href: string }) {
  const read = r.pages - r.unreadablePages.length;
  return (
    <div className="space-y-5">
      <Card className="space-y-3 text-sm">
        {r.focus && <p className="text-xs text-slate-500">You asked: {r.focus}</p>}
        <p className="whitespace-pre-line">{r.summary}</p>
        <p className="text-xs text-slate-500">
          Read {read} of {r.pages} {r.pages === 1 ? "page" : "pages"} with {r.model}.
        </p>
        {r.unreadablePages.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            No text on {pageList(r.unreadablePages)} (blank or scanned), so anything printed there
            wasn't read.
          </p>
        )}
        {r.skippedPages.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            The model didn't give a usable answer for {pageList(r.skippedPages)}, so this review
            leaves them out. Running it again may fill them in.
          </p>
        )}
      </Card>

      {r.nextSteps.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 font-semibold">Worth doing first</h2>
          <Card className="text-sm">
            <ol className="list-decimal space-y-1.5 pl-5">
              {r.nextSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </Card>
        </section>
      )}

      {GROUPS.map((g) => {
        const items = r.findings.filter((f) => f.kind === g.kind);
        return (
          items.length > 0 && (
            <section key={g.kind}>
              <h2 className="px-1 font-semibold">{g.title}</h2>
              <p className="mb-2 px-1 text-xs text-slate-500">{g.blurb}</p>
              <Card className="p-0">
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {items.map((f) => (
                    <Finding key={`${f.title}${f.quote}`} f={f} href={href} />
                  ))}
                </ul>
              </Card>
            </section>
          )
        );
      })}
      {r.findings.length === 0 && (
        <Card className="text-center text-sm text-slate-500">
          The model didn't point out anything in this contract.
        </Card>
      )}

      {r.questions.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 font-semibold">Questions to ask</h2>
          <Card className="text-sm">
            <ul className="list-disc space-y-1.5 pl-5">
              {r.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {r.terms.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 font-semibold">Key terms</h2>
          <Card className="p-0">
            <dl className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {r.terms.map((t) => (
                <div
                  key={t.label}
                  className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-2"
                >
                  <dt className="text-slate-500">{t.label}</dt>
                  <dd className="text-right">
                    {t.value}
                    {t.page !== null && (
                      <span className="ml-2 text-xs text-slate-500">p. {t.page}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </section>
      )}

      <p className="px-1 text-xs text-slate-500">
        This is a model's reading of your contract, not legal advice, and it can miss things or get
        them wrong. Before acting on it, check with a consumer attorney or your state attorney
        general's consumer office. Be wary of any company that wants money up front to get you out
        of a contract.
      </p>
    </div>
  );
}

function Running({ s }: { s: ContractReviewState }) {
  const parts = s.stepsTotal - 1;
  const step =
    s.stepsTotal === 0
      ? "Waiting its turn…"
      : s.stepsDone >= parts
        ? "Putting the review together…"
        : `Reading part ${s.stepsDone + 1} of ${parts}…`;
  return (
    <Card className="space-y-2 text-sm" aria-live="polite">
      <p className="font-medium">{step}</p>
      {s.stepsTotal > 0 && (
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div
            className="h-full rounded-full bg-brand-600 transition-all"
            style={{ width: `${Math.round((s.stepsDone / s.stepsTotal) * 100)}%` }}
          />
        </div>
      )}
      {s.waiting && <p className="text-xs text-slate-500">{s.waiting}</p>}
      <p className="text-xs text-slate-500">
        This can take a while with a long contract. You can leave this page: you'll get a
        notification when it's done.
      </p>
    </Card>
  );
}

export function ContractReviewPage() {
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const qc = useQueryClient();
  const key = ["contract-review", documentId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<ContractReviewState>(`/api/documents/${documentId}/review`),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });
  const [focus, setFocus] = useState("");
  const [again, setAgain] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      api.post<ContractReviewState>(`/api/documents/${documentId}/review`, {
        focus: focus.trim() || undefined,
      }),
    onSuccess: (s) => {
      qc.setQueryData(key, s);
      setAgain(false);
      void qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });
  const s = q.data;

  const startForm = s && (
    <Card className="space-y-3 text-sm">
      {s.sendsTo ? (
        <>
          <p>
            Muny reads this contract in parts and looks for ways out, ways to save, and anything
            that could cost you. All of its text goes to{" "}
            <span className="font-medium">
              {s.sendsTo.where} ({s.sendsTo.model})
            </span>
            {s.loanName ? `, with the figures for ${s.loanName}` : ""}. Long numbers are hidden, but
            names and addresses printed in it go too.
          </p>
          <label className="block">
            <span className="font-medium">Anything in particular to look for?</span>
            <span className="text-slate-500"> Optional</span>
            <textarea
              value={focus}
              maxLength={500}
              rows={2}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="e.g. Can I give this back? What happens if the yearly fee goes up?"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <div className="flex gap-2">
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              {start.isPending ? "Opening the contract…" : "Review this contract"}
            </Button>
            {again && (
              <Button variant="ghost" onClick={() => setAgain(false)}>
                Cancel
              </Button>
            )}
          </div>
        </>
      ) : (
        <p>
          {s.blockedBy}{" "}
          <Link to="/settings" hash="ai" className="text-brand-600 underline dark:text-brand-500">
            Open Settings → AI
          </Link>{" "}
          and turn on Contract review.
        </p>
      )}
      {start.isError && <Alert>{start.error.message}</Alert>}
    </Card>
  );

  return (
    <>
      <Link
        to="/documents"
        className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Documents
      </Link>
      <PageHeader
        title="Contract review"
        actions={
          s && (
            <span className="flex items-center gap-2">
              <a
                href={s.href}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-500"
              >
                Open the contract <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
              {s.result && s.status !== "running" && !again && (
                <Button variant="ghost" onClick={() => setAgain(true)}>
                  Review again
                </Button>
              )}
            </span>
          )
        }
      />
      {s && (
        <p className="-mt-3 mb-4 truncate text-sm text-slate-500">
          {s.name}
          {s.loanName ? ` · ${s.loanName}` : ""}
        </p>
      )}
      {q.isError && <Alert>{q.error.message}</Alert>}
      {s && (
        <div className="space-y-5">
          {s.status === "running" && <Running s={s} />}
          {s.status !== "running" && s.error && <Alert>{s.error}</Alert>}
          {s.status !== "running" && (!s.result || again) && startForm}
          {s.status !== "running" && s.result && <Result r={s.result} href={s.href} />}
        </div>
      )}
    </>
  );
}
