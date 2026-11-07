import {
  BUILTIN_THEMES,
  CHART_COLOR_KEYS,
  findTheme,
  HEX_COLOR,
  THEME_COLOR_KEYS,
  THEME_COLOR_LABELS,
  type Theme,
  type ThemeColorKey,
  type ThemeColors,
  type ThemeMode,
  themeWarnings,
} from "@muny/shared";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SelectField } from "../components/forms.js";
import { ThemeSample } from "../components/ThemeSample.js";
import { Alert, Button, buttonClass, Card, cx, Field, PageHeader } from "../components/ui.js";
import {
  useDeleteTheme,
  useSaveTheme,
  useSelectTheme,
  useThemePreview,
  useThemeState,
} from "../lib/theme.js";

const GROUPS: { title: string; keys: readonly ThemeColorKey[] }[] = [
  { title: "Page", keys: ["background", "surface", "border"] },
  { title: "Text", keys: ["text", "muted"] },
  { title: "Accent and meaning", keys: ["primary", "positive", "negative", "warning"] },
  { title: "Charts, in the order series use them", keys: CHART_COLOR_KEYS },
];

function ColorRow({
  id,
  value,
  flagged,
  onChange,
}: {
  id: ThemeColorKey;
  value: string;
  flagged: boolean;
  onChange: (v: string) => void;
}) {
  // What you're typing can be half a color; only a whole one reaches the theme.
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const info = THEME_COLOR_LABELS[id];
  return (
    <div className="flex items-center gap-3 py-1.5">
      <input
        type="color"
        value={value}
        aria-label={`${info.label} color picker`}
        onChange={(e) => onChange(e.target.value)}
        className="size-8 shrink-0 cursor-pointer rounded border border-slate-300 bg-transparent p-0.5 dark:border-slate-700"
      />
      <div className="min-w-0 flex-1">
        <p className={cx("text-sm font-medium", flagged && "text-amber-700 dark:text-amber-400")}>
          {info.label}
          {flagged && " ⚠"}
        </p>
        {info.hint && <p className="truncate text-xs text-slate-500">{info.hint}</p>}
      </div>
      <input
        value={text}
        aria-label={`${info.label} hex value`}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.trim().toLowerCase();
          setText(v);
          if (HEX_COLOR.test(v)) onChange(v);
        }}
        onBlur={() => setText(value)}
        className="w-24 shrink-0 rounded-lg border border-slate-300 bg-surface px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
      />
    </div>
  );
}

/** Read a pasted theme. Whatever's wrong with it, the server checks it again on save. */
function themeFromJson(raw: string): { name?: string; mode: ThemeMode; colors: ThemeColors } {
  const parsed = JSON.parse(raw) as Partial<Theme>;
  if (parsed.mode !== "light" && parsed.mode !== "dark")
    throw new Error('It needs "mode": "light" or "dark".');
  const colors = {} as ThemeColors;
  for (const key of THEME_COLOR_KEYS) {
    const v = parsed.colors?.[key]?.trim().toLowerCase();
    if (!v || !HEX_COLOR.test(v)) throw new Error(`"${key}" should be a color like #1a2b3c.`);
    colors[key] = v;
  }
  return { name: parsed.name, mode: parsed.mode, colors };
}

export function ThemeEditorPage() {
  const { themeId } = useParams({ from: "/settings/themes/$themeId" });
  const { from } = useSearch({ from: "/settings/themes/$themeId" });
  const state = useThemeState();
  if (!state.data) return <p className="text-slate-500">Loading…</p>;
  const custom = state.data.custom;
  const existing = themeId === "new" ? null : (custom.find((t) => t.id === themeId) ?? null);
  if (themeId !== "new" && !existing)
    return (
      <>
        <PageHeader title="Theme" />
        <p className="text-sm text-slate-500">
          That theme is gone.{" "}
          <Link to="/settings" hash="display" className="text-brand-600 underline">
            Back to themes
          </Link>
        </p>
      </>
    );
  const start = existing ?? findTheme(from ?? "", custom) ?? (BUILTIN_THEMES[1] as Theme);
  return <ThemeEditor key={themeId} existing={existing} start={start} />;
}

function ThemeEditor({ existing, start }: { existing: Theme | null; start: Theme }) {
  const navigate = useNavigate();
  const state = useThemeState();
  const save = useSaveTheme();
  const del = useDeleteTheme();
  const select = useSelectTheme();
  const { tryTheme, trying } = useThemePreview();
  const [name, setName] = useState(existing?.name ?? `My ${start.name}`);
  const [mode, setMode] = useState<ThemeMode>(start.mode);
  const [colors, setColors] = useState<ThemeColors>(start.colors);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const draft: Theme = { id: existing?.id ?? "draft", name: name || "Untitled", mode, colors };
  const warnings = themeWarnings(draft);
  const flagged = new Set(warnings.flatMap((w) => w.colors));
  const isTrying = trying?.id === draft.id;

  // Trying follows your edits; leaving the page goes back to your saved theme.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the draft's colors only while it's being tried.
  useEffect(() => {
    if (isTrying) tryTheme(draft);
  }, [mode, colors, name]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on leaving only.
  useEffect(() => () => tryTheme(null), []);

  const done = () => void navigate({ to: "/settings", hash: "display" });

  const submit = (apply: boolean) =>
    save.mutate(
      { ...(existing ? { id: existing.id } : {}), name: name.trim(), mode, colors },
      {
        onSuccess: (saved) => {
          if (apply) select.mutate(saved.id, { onSuccess: done });
          else done();
        },
      },
    );

  const applyJson = () => {
    setJsonError(null);
    try {
      const t = themeFromJson(json);
      if (t.name) setName(t.name.slice(0, 40));
      setMode(t.mode);
      setColors(t.colors);
      setJson("");
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "That isn't valid JSON.");
    }
  };

  return (
    <>
      <PageHeader
        title={existing ? `Edit ${existing.name}` : "New theme"}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/settings" hash="display" className={buttonClass("secondary")}>
              Cancel
            </Link>
            <Button
              variant="secondary"
              onClick={() => tryTheme(isTrying ? null : draft)}
              aria-pressed={isTrying}
            >
              {isTrying ? "Stop trying" : "Try across the app"}
            </Button>
            <Button
              variant="secondary"
              disabled={!name.trim() || save.isPending}
              onClick={() => submit(false)}
            >
              Save
            </Button>
            <Button disabled={!name.trim() || save.isPending} onClick={() => submit(true)}>
              Save and use
            </Button>
          </div>
        }
      />
      {(save.error ?? del.error ?? select.error) && (
        <div className="mb-4">
          <Alert>{(save.error ?? del.error ?? select.error)?.message}</Alert>
        </div>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[24rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="space-y-3">
            <Field
              label="Name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <SelectField
              label="Type"
              value={mode}
              onChange={(e) => setMode(e.target.value as ThemeMode)}
            >
              <option value="light">Light: dark text on light backgrounds</option>
              <option value="dark">Dark: light text on dark backgrounds</option>
            </SelectField>
            <SelectField
              label="Copy colors from"
              value=""
              onChange={(e) => {
                const t = findTheme(e.target.value, state.data?.custom ?? []);
                if (t) {
                  setMode(t.mode);
                  setColors(t.colors);
                }
              }}
            >
              <option value="">Choose a theme…</option>
              {[...BUILTIN_THEMES, ...(state.data?.custom ?? [])].map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectField>
          </Card>

          {GROUPS.map((g) => (
            <Card key={g.title}>
              <h2 className="mb-1 text-sm font-semibold">{g.title}</h2>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {g.keys.map((key) => (
                  <ColorRow
                    key={key}
                    id={key}
                    value={colors[key]}
                    flagged={flagged.has(key)}
                    onChange={(v) => setColors((c) => ({ ...c, [key]: v }))}
                  />
                ))}
              </div>
            </Card>
          ))}

          <Card>
            <details>
              <summary className="cursor-pointer text-sm font-semibold">
                Share, paste, or ask an AI assistant
              </summary>
              <p className="mt-2 text-xs text-slate-500">
                A theme is only names and colors, so it's safe to paste. Ask any assistant for "a
                Muny theme as JSON" with the same fields as the one below.
              </p>
              <textarea
                readOnly
                rows={6}
                aria-label="This theme as JSON"
                value={JSON.stringify({ name, mode, colors }, null, 2)}
                onFocus={(e) => e.target.select()}
                className="mt-2 w-full rounded-lg border border-slate-300 bg-surface p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <textarea
                rows={4}
                aria-label="Paste a theme"
                placeholder="Paste a theme here"
                spellCheck={false}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-300 bg-surface p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              {jsonError && <p className="text-xs text-red-600">{jsonError}</p>}
              <Button
                variant="secondary"
                className="mt-2"
                disabled={!json.trim()}
                onClick={applyJson}
              >
                Use pasted theme
              </Button>
            </details>
          </Card>

          {existing && (
            <Button
              variant="ghost"
              className="text-red-600"
              disabled={del.isPending}
              onClick={() => {
                if (window.confirm(`Delete "${existing.name}" for everyone in this household?`))
                  del.mutate(existing.id, { onSuccess: done });
              }}
            >
              Delete theme
            </Button>
          )}
        </div>

        <div className="min-w-0 space-y-3 xl:sticky xl:top-4">
          <p className="text-sm font-medium text-slate-500">Live preview</p>
          {warnings.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {warnings.map((w) => (
                <li key={w.message}>{w.message}</li>
              ))}
            </ul>
          )}
          <ThemeSample theme={draft} />
        </div>
      </div>
    </>
  );
}
