import type { AiReview } from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { NoteText } from "../../components/NoteText.js";
import { Alert, Button, Card } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAiSettings } from "../settings/AiSettings.js";

const monthName = (m: string) =>
  new Date(`${m}-15T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/** Reports → Reviews: every monthly review the built-in AI wrote, to look back over. */
export function ReviewsTab() {
  const qc = useQueryClient();
  const ai = useAiSettings().data;
  const q = useQuery({
    queryKey: ["ai", "reviews"],
    queryFn: () => api.get<AiReview[]>("/api/ai/reviews"),
  });
  const write = useMutation({
    mutationFn: () => api.post<{ month: string }>("/api/ai/review", {}),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const canWrite = !!ai?.enabled && ai.features.monthlyReview;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {canWrite
            ? "A short review of each month, written early the next. Budgets it suggests wait in the inbox."
            : "Monthly reviews come from the built-in AI. "}
          {!canWrite && (
            <Link to="/settings" hash="ai" className="text-brand-600 underline dark:text-brand-500">
              Turn it on in Settings → AI
            </Link>
          )}
        </p>
        {canWrite && (
          <Button variant="secondary" disabled={write.isPending} onClick={() => write.mutate()}>
            {write.isPending ? "Writing…" : "Write last month's again"}
          </Button>
        )}
      </div>
      {write.error && <Alert>{write.error.message}</Alert>}
      {q.isError && <Alert>Couldn't load the reviews.</Alert>}
      {q.data?.length === 0 && <Card className="text-sm text-slate-500">No reviews yet.</Card>}
      {q.data?.map((r) => (
        <Card key={r.month} className="space-y-1">
          <h3 className="font-semibold">{monthName(r.month)}</h3>
          <NoteText text={r.body} />
        </Card>
      ))}
    </div>
  );
}
