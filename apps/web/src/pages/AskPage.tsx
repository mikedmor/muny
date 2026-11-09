import type { AiAskResult, AiAskTurn } from "@muny/shared";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAiSettings } from "./settings/AiSettings.js";

const STARTERS = [
  "How much did we spend on dining in the last three months?",
  "Which recurring charges went up this year?",
  "What was our biggest expense last month?",
];

interface Exchange {
  question: string;
  answer: string;
  looked: string[];
}

/** Ask Muny: questions in plain words, answered from read-only lookups. Nothing is saved. */
export function AskPage() {
  const ai = useAiSettings().data;
  const [text, setText] = useState("");
  const [talk, setTalk] = useState<Exchange[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (question: string) => {
      // The last few turns, so a follow-up makes sense.
      const history: AiAskTurn[] = talk.slice(-6).flatMap((t) => [
        { role: "user" as const, text: t.question },
        { role: "assistant" as const, text: t.answer },
      ]);
      return api.post<AiAskResult>("/api/ai/ask", { question, history });
    },
    onSuccess: (r, question) => {
      setTalk((t) => [...t, { question, answer: r.answer, looked: r.looked }]);
      setText("");
    },
  });
  const count = talk.length;
  const pending = ask.isPending;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the conversation moves
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [count, pending]);

  if (!ai) return <PageHeader title="Ask Muny" />;
  if (!(ai.enabled && ai.features.ask))
    return (
      <>
        <PageHeader title="Ask Muny" />
        <Card className="text-sm text-slate-600 dark:text-slate-300">
          Ask Muny is off.{" "}
          <Link to="/settings" hash="ai" className="text-brand-600 underline dark:text-brand-500">
            Turn it on in Settings → AI
          </Link>{" "}
          to ask about your money in plain words.
        </Card>
      </>
    );

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (q && !pending) ask.mutate(q);
  };

  return (
    <>
      <PageHeader title="Ask Muny" />
      <div className="max-w-3xl space-y-4">
        {count === 0 && !pending && (
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask.mutate(s)}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {talk.map((t, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a list that only grows
          <div key={n} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-brand-600 px-4 py-2 text-sm text-on-brand">
              {t.question}
            </p>
            <Card className="space-y-2">
              <p className="whitespace-pre-wrap text-sm">{t.answer}</p>
              {t.looked.length > 0 && (
                <p className="text-xs text-slate-500">Looked at {t.looked.join(", ")}.</p>
              )}
            </Card>
          </div>
        ))}
        {pending && (
          <div className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-brand-600 px-4 py-2 text-sm text-on-brand">
              {ask.variables}
            </p>
            <p role="status" className="px-1 text-sm text-slate-500">
              Looking that up…
            </p>
          </div>
        )}
        {ask.error && <Alert>{ask.error.message}</Alert>}
        <div ref={end} />
        <form onSubmit={send} className="flex items-end gap-2">
          <textarea
            value={text}
            rows={2}
            maxLength={1000}
            aria-label="Your question"
            placeholder="Ask about your spending, budgets, bills or accounts"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e);
            }}
            className="min-w-0 flex-1 resize-y rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <Button type="submit" disabled={!text.trim() || pending}>
            Ask
          </Button>
        </form>
        <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
          <p>It can only read, and this conversation isn't saved. Check anything important.</p>
          {count > 0 && (
            <button type="button" className="shrink-0 underline" onClick={() => setTalk([])}>
              Start over
            </button>
          )}
        </div>
      </div>
    </>
  );
}
