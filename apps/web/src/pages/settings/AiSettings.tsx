import {
  AI_DEFAULT_BASE_URLS,
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  type AiCategorizeResult,
  type AiFeatures,
  type AiProvider,
  type AiSettingsInput,
  type AiSettings as Settings,
} from "@muny/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Checkbox, SelectField } from "../../components/forms.js";
import { Alert, Button, Card, Field } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { useAuthStatus } from "../../lib/auth.js";

/**
 * Settings → AI: the optional built-in AI. Off by default. When it's on, Muny
 * sends the chosen provider only what each feature needs, and nothing it
 * suggests changes your data until you approve it in the inbox.
 */

export const aiKey = ["ai-settings"] as const;

export const useAiSettings = () =>
  useQuery({ queryKey: aiKey, queryFn: () => api.get<Settings>("/api/ai") });

const FEATURES: { key: keyof AiFeatures; label: string; sends: string }[] = [
  {
    key: "categorize",
    label: "Suggest categories",
    sends:
      "Sends up to 60 recent uncategorized transactions (merchant or description, with long numbers hidden, and amount) and your category names. Suggestions go to Alerts → Inbox.",
  },
  {
    key: "monthlyReview",
    label: "Monthly money review",
    sends:
      "Early each month, sends last month's totals, biggest categories, budgets gone over and Ways to save (no transactions or accounts). The review arrives as a notification.",
  },
  {
    key: "statementTemplates",
    label: "Fill in Teach Muny",
    sends:
      "When you press the button, sends that statement's text with long numbers hidden. You still check and save the template.",
  },
];

export function AiSettings() {
  const qc = useQueryClient();
  const s = useAiSettings();
  const owner = useAuthStatus().data?.user?.role === "owner";
  const [draft, setDraft] = useState<AiSettingsInput>({});
  const [key, setKey] = useState("");
  useEffect(() => {
    if (s.data) setDraft({});
  }, [s.data]);
  const save = useMutation({
    mutationFn: (body: AiSettingsInput) => api.put<Settings>("/api/ai", body),
    onSuccess: (data) => {
      qc.setQueryData(aiKey, data);
      setKey("");
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; reply: string }>("/api/ai/test", {}),
  });
  const categorize = useMutation({
    mutationFn: () => api.post<AiCategorizeResult>("/api/ai/categorize", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proposals"] }),
  });
  const review = useMutation({
    mutationFn: () => api.post<{ month: string; text: string }>("/api/ai/review", {}),
    onSuccess: () => qc.invalidateQueries(),
  });
  if (!s.data) return s.isError ? <Alert>Couldn't load AI settings.</Alert> : null;
  const v = { ...s.data, ...draft, features: { ...s.data.features, ...draft.features } };
  const provider = v.provider as AiProvider;
  const set = (patch: AiSettingsInput) => setDraft((d) => ({ ...d, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...draft, ...(key.trim() ? { key: key.trim() } : {}) });
  };
  const dirty = Object.keys(draft).length > 0 || key.trim() !== "";

  return (
    <div className="max-w-3xl space-y-6">
      <Card className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
        <p>
          Muny works without AI. Turning this on lets it use a model you choose for a few jobs:
          suggesting categories, a short monthly review, and filling in Teach Muny for a new
          statement. It's off until you turn it on, and only what's listed under each feature is
          sent. Anything that would change your data waits in Alerts → Inbox for you to approve.
        </p>
        <p>
          Using Ollama or another server on your own network keeps everything at home. With
          Anthropic or another hosted service, what's sent goes to that company under its terms.
        </p>
      </Card>

      <form onSubmit={submit}>
        <Card className="space-y-4">
          <Checkbox
            label="Use AI"
            description="Off: Muny never contacts an AI provider."
            checked={v.enabled}
            onChange={(on) => set({ enabled: on })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Provider"
              value={provider}
              disabled={!owner}
              onChange={(e) => set({ provider: e.target.value as AiProvider, model: undefined })}
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {AI_PROVIDER_LABELS[p]}
                </option>
              ))}
            </SelectField>
            <Field
              label="Model"
              value={draft.model ?? (draft.provider ? "" : v.model)}
              placeholder={provider === "anthropic" ? "claude-opus-5-5" : "Model name"}
              disabled={!owner}
              onChange={(e) => set({ model: e.target.value })}
              hint={
                provider === "anthropic"
                  ? "Claude Opus 5.5 is the default. A smaller model (like claude-haiku-5-5) costs less."
                  : undefined
              }
            />
          </div>
          {provider !== "anthropic" && (
            <Field
              label="Server address"
              value={draft.baseUrl ?? v.baseUrl ?? ""}
              placeholder={AI_DEFAULT_BASE_URLS[provider] ?? ""}
              disabled={!owner}
              onChange={(e) => set({ baseUrl: e.target.value || null })}
              hint={
                provider === "ollama"
                  ? "Where Ollama runs, e.g. http://192.168.1.20:11434."
                  : "The /v1 address of the OpenAI-compatible server."
              }
            />
          )}
          <Field
            label={provider === "ollama" ? "API key (if your server needs one)" : "API key"}
            type="password"
            autoComplete="off"
            value={key}
            disabled={!owner || !s.data.canStoreKey}
            placeholder={s.data.hasKey ? "Saved. Type a new one to replace it." : ""}
            onChange={(e) => setKey(e.target.value)}
            hint={
              s.data.canStoreKey
                ? "Stored encrypted on your server. It's never shown again."
                : "Set MUNY_SECRET_KEY to store a key: it's kept encrypted."
            }
          />
          {s.data.hasKey && owner && (
            <button
              type="button"
              className="text-xs text-slate-500 hover:underline"
              onClick={() => save.mutate({ key: null })}
            >
              Remove the saved key
            </button>
          )}

          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">What it does</legend>
            {FEATURES.map((f) => (
              <Checkbox
                key={f.key}
                label={f.label}
                description={f.sends}
                checked={v.features[f.key]}
                onChange={(on) => set({ features: { ...draft.features, [f.key]: on } })}
              />
            ))}
          </fieldset>

          {save.error && <Alert>{save.error.message}</Alert>}
          {owner ? (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!dirty || save.isPending}>
                Save
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!s.data.enabled || dirty || test.isPending}
                onClick={() => test.mutate()}
              >
                {test.isPending ? "Checking…" : "Check it works"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Only the household owner can change these.</p>
          )}
          {test.data && <p className="text-sm text-emerald-700 dark:text-emerald-400">It works.</p>}
          {test.error && <Alert>{test.error.message}</Alert>}
        </Card>
      </form>

      {s.data.enabled && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Run it now</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!s.data.features.categorize || categorize.isPending}
              onClick={() => categorize.mutate()}
            >
              {categorize.isPending ? "Thinking…" : "Suggest categories"}
            </Button>
            <Button
              variant="secondary"
              disabled={!s.data.features.monthlyReview || review.isPending}
              onClick={() => review.mutate()}
            >
              {review.isPending ? "Writing…" : "Write last month's review"}
            </Button>
          </div>
          {categorize.data && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {categorize.data.considered === 0
                ? "There's nothing uncategorized from the last three months."
                : `Looked at ${categorize.data.considered}, suggested a category for ${categorize.data.suggested}. `}
              {categorize.data.filed > 0 && (
                <a href="/alerts#inbox" className="text-brand-600 underline dark:text-brand-500">
                  Review them in the inbox
                </a>
              )}
            </p>
          )}
          {review.data && (
            <p className="whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">
              {review.data.text}
            </p>
          )}
          {(categorize.error ?? review.error) && (
            <Alert>{(categorize.error ?? review.error)?.message}</Alert>
          )}
        </Card>
      )}
    </div>
  );
}
