import type { AiAskResult, AiReview } from "@muny/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api.js";
import { monthName } from "../pages/reports/ReviewsTab.js";
import { useAiSettings } from "../pages/settings/AiSettings.js";
import { NoteText } from "./NoteText.js";
import { Alert, Button, Card } from "./ui.js";

/** Overview card: a quick question and the latest monthly review. Nothing while AI is off. */
export function AiOverviewCard() {
  const ai = useAiSettings().data;
  const enabled = !!ai?.enabled;
  const reviews = useQuery({
    queryKey: ["ai", "reviews"],
    queryFn: () => api.get<AiReview[]>("/api/ai/reviews"),
    enabled,
  });
  const [text, setText] = useState("");
  const ask = useMutation({
    mutationFn: (question: string) => api.post<AiAskResult>("/api/ai/ask", { question }),
  });
  if (!enabled) return null;

  const canAsk = ai.features.ask;
  const latest = reviews.data?.[0];
  const send = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q && !ask.isPending) ask.mutate(q);
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Muny AI</h2>
        {canAsk && (
          <Link to="/ask" className="text-sm text-brand-600 hover:underline">
            Open Ask Muny →
          </Link>
        )}
      </div>

      {canAsk && (
        <form onSubmit={send} className="flex items-center gap-2">
          <input
            value={text}
            maxLength={1000}
            aria-label="Ask Muny a question"
            placeholder="Ask about your money"
            onChange={(e) => setText(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <Button type="submit" variant="secondary" disabled={!text.trim() || ask.isPending}>
            Ask
          </Button>
        </form>
      )}
      {ask.isPending && (
        <p role="status" className="text-sm text-slate-500">
          Looking that up…
        </p>
      )}
      {ask.error && <Alert>{ask.error.message}</Alert>}
      {ask.data && !ask.isPending && (
        <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
          <p className="whitespace-pre-wrap text-sm">{ask.data.answer}</p>
          {ask.data.looked.length > 0 && (
            <p className="text-xs text-slate-500">Looked at {ask.data.looked.join(", ")}.</p>
          )}
        </div>
      )}

      {latest && (
        <div
          className={canAsk ? "border-t border-slate-100 pt-3 dark:border-slate-800" : undefined}
        >
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">{monthName(latest.month)} review</h3>
            <Link to="/reports" hash="reviews" className="text-xs text-brand-600 hover:underline">
              All reviews
            </Link>
          </div>
          <NoteText text={latest.body} />
        </div>
      )}

      {!canAsk && reviews.isSuccess && !latest && (
        <p className="text-sm text-slate-500">
          Nothing here yet. Your monthly review will show up here, or turn on Ask Muny in{" "}
          <Link to="/settings" hash="ai" className="text-brand-600 underline dark:text-brand-500">
            Settings → AI
          </Link>
          .
        </p>
      )}
    </Card>
  );
}
