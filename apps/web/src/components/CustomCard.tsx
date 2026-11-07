import {
  CARD_PERIOD_LABELS,
  CARD_PERIODS,
  CARD_SOURCE_INFO,
  CARD_SOURCES,
  type CardData,
  type CardParam,
  type CardPeriod,
  type CardSource,
  type CardSpec,
  type CardView,
  type CustomCard,
  formatMoney,
} from "@muny/shared";
import { useState } from "react";
import {
  useAccounts,
  useCardData,
  useCardPreview,
  useDashboardSchema,
  useDeleteCustomCard,
  useSaveCustomCard,
} from "../lib/queries.js";
import { CategorySelect } from "./CategorySelect.js";
import { ColumnChart, LineChart, RankedBars } from "./charts.js";
import { Modal, SelectField } from "./forms.js";
import { Alert, Button, Card, cx } from "./ui.js";

/**
 * Custom Overview cards are definitions, never code: a data source Muny knows
 * plus a way to show it. Everything shown is plain text and numbers from the
 * server, so a pasted definition can't run anything.
 */

const VIEW_LABELS: Record<CardView, string> = {
  stat: "One big number",
  list: "List",
  bars: "Ranked bars",
  columns: "Columns",
  line: "Line",
};

function CardBody({ data, spec, title }: { data: CardData; spec: CardSpec; title: string }) {
  if (spec.view === "stat")
    return (
      <div>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {formatMoney(data.totalCents)}
        </p>
        <p className="text-xs text-slate-500">{data.totalLabel}</p>
      </div>
    );
  if (data.rows.length === 0)
    return <p className="py-4 text-center text-sm text-slate-500">Nothing to show yet.</p>;
  if (spec.view === "bars")
    return (
      <RankedBars
        total={data.rows.reduce((s, r) => s + Math.max(0, r.values[0] ?? 0), 0)}
        items={data.rows.map((r) => ({
          key: r.key,
          label: r.label,
          sublabel: r.detail,
          cents: r.values[0] ?? 0,
        }))}
      />
    );
  if (spec.view === "columns")
    return (
      <ColumnChart
        ariaLabel={title}
        seriesNames={data.seriesNames}
        data={data.rows.map((r) => ({
          key: r.key,
          label: r.label,
          title: r.label,
          values: r.values,
        }))}
      />
    );
  if (spec.view === "line")
    return (
      <LineChart
        ariaLabel={title}
        points={data.rows.map((r) => ({
          date: r.key,
          label: r.label,
          value: r.values[0] ?? 0,
        }))}
      />
    );
  return (
    <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
      {data.rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-3 py-1.5">
          <span className="min-w-0">
            <span className="block truncate">{r.label}</span>
            {r.detail && <span className="block truncate text-xs text-slate-500">{r.detail}</span>}
          </span>
          <span className="shrink-0 tabular-nums">{formatMoney(r.values[0] ?? 0)}</span>
        </li>
      ))}
    </ul>
  );
}

export function CustomCardView({ card }: { card: CustomCard }) {
  const data = useCardData(card.id);
  return (
    <Card>
      <h2 className="mb-2 font-semibold">{card.title}</h2>
      {card.description && <p className="-mt-1 mb-2 text-xs text-slate-500">{card.description}</p>}
      {data.isError && <p className="text-sm text-red-600">Couldn't load this card.</p>}
      {data.data && <CardBody data={data.data} spec={card.spec} title={card.title} />}
    </Card>
  );
}

const DEFAULT_SPEC: CardSpec = {
  source: "spending_by_category",
  view: "bars",
  period: "this_month",
};

/** Keep a definition valid for its source: only its options, and a view it can show. */
function fitSpec(spec: CardSpec): CardSpec {
  const info = CARD_SOURCE_INFO[spec.source];
  const out: CardSpec = {
    source: spec.source,
    view: info.views.includes(spec.view) ? spec.view : (info.views[0] as CardView),
  };
  const keep = (p: CardParam) => info.params.includes(p);
  if (keep("period")) out.period = spec.period ?? "this_month";
  if (keep("months")) out.months = spec.months ?? 6;
  if (keep("days")) out.days = spec.days ?? 30;
  if (keep("limit")) out.limit = spec.limit ?? 10;
  if (keep("categoryId") && spec.categoryId) out.categoryId = spec.categoryId;
  if (keep("accountId") && spec.accountId) out.accountId = spec.accountId;
  if (keep("search") && spec.search) out.search = spec.search;
  return out;
}

function assistantPrompt(schema: unknown) {
  return `Write one card for the Overview page of Muny, a self-hosted personal finance app.
Reply with only a JSON object: { "title": ..., "description": ..., "spec": { ... } }.
A card is data, not code. It must use one of the sources and views below, and only the options that source lists.
Leave categoryId and accountId out; I'll choose those in Muny.

What I want on the card: <describe it here>

Definition of a card:
${JSON.stringify(schema, null, 2)}`;
}

export function CustomCardDialog({
  card,
  onClose,
  onCreated,
  onDeleted,
}: {
  /** The card to edit, or null to make one. */
  card: CustomCard | null;
  onClose: () => void;
  onCreated: (card: CustomCard) => void;
  onDeleted: (id: string) => void;
}) {
  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [spec, setSpec] = useState<CardSpec>(card?.spec ?? fitSpec(DEFAULT_SPEC));
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const save = useSaveCustomCard();
  const del = useDeleteCustomCard();
  const preview = useCardPreview(spec);
  const accounts = useAccounts();
  const schema = useDashboardSchema(advanced);
  const info = CARD_SOURCE_INFO[spec.source];
  const has = (p: CardParam) => info.params.includes(p);
  const set = (patch: Partial<CardSpec>) => setSpec((s) => fitSpec({ ...s, ...patch }));

  const applyJson = () => {
    setJsonError(null);
    try {
      const parsed = JSON.parse(json) as {
        title?: unknown;
        description?: unknown;
        spec?: Record<string, unknown>;
      };
      const s = parsed.spec;
      if (!s || !CARD_SOURCES.includes(s.source as CardSource))
        throw new Error("It needs a spec with one of the listed sources.");
      if (typeof parsed.title === "string") setTitle(parsed.title.slice(0, 60));
      if (typeof parsed.description === "string") setDescription(parsed.description.slice(0, 200));
      // As text and numbers only; the server checks the rest when it's previewed and saved.
      setSpec(s as unknown as CardSpec);
      setJson("");
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "That isn't valid JSON.");
    }
  };

  const submit = () => {
    const input = {
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      spec,
    };
    if (card) save.mutate({ id: card.id, ...input }, { onSuccess: onClose });
    // The grid places it, so it's part of the layout you're arranging.
    else save.mutate({ ...input, place: false }, { onSuccess: (c) => onCreated(c as CustomCard) });
  };

  const input =
    "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";
  const label = "block text-sm font-medium text-slate-700 dark:text-slate-300";

  return (
    <Modal open onClose={onClose} title={card ? `Edit ${card.title}` : "Create a card"} wide>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <label className="block">
            <span className={label}>Title</span>
            <input
              value={title}
              maxLength={60}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Dining this year"
              className={input}
            />
          </label>
          <SelectField
            label="Show"
            value={spec.source}
            onChange={(e) => set({ source: e.target.value as CardSource })}
          >
            {CARD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {CARD_SOURCE_INFO[s].label}
              </option>
            ))}
          </SelectField>
          <p className="-mt-2 text-xs text-slate-500">{info.description}</p>
          <SelectField
            label="As"
            value={spec.view}
            onChange={(e) => set({ view: e.target.value as CardView })}
          >
            {info.views.map((v) => (
              <option key={v} value={v}>
                {VIEW_LABELS[v]}
              </option>
            ))}
          </SelectField>
          {has("period") && (
            <SelectField
              label="Period"
              value={spec.period ?? "this_month"}
              onChange={(e) => set({ period: e.target.value as CardPeriod })}
            >
              {CARD_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {CARD_PERIOD_LABELS[p]}
                </option>
              ))}
            </SelectField>
          )}
          {(["months", "days", "limit"] as const).filter(has).map((p) => {
            const bounds = {
              months: { text: "Months", min: 2, max: 36 },
              days: { text: "Days ahead", min: 1, max: 90 },
              limit: { text: "Rows", min: 1, max: 50 },
            }[p];
            return (
              <label key={p} className="block">
                <span className={label}>{bounds.text}</span>
                <input
                  type="number"
                  min={bounds.min}
                  max={bounds.max}
                  value={spec[p] ?? ""}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isInteger(v) && v >= bounds.min && v <= bounds.max) set({ [p]: v });
                  }}
                  className={input}
                />
              </label>
            );
          })}
          {has("categoryId") && (
            <div>
              <span className={label}>Category</span>
              <CategorySelect
                value={spec.categoryId ?? null}
                emptyLabel="All categories"
                aria-label="Category"
                allowCreate={false}
                onChange={(id) => set({ categoryId: id ?? undefined })}
              />
            </div>
          )}
          {has("accountId") && (
            <SelectField
              label="Account"
              value={spec.accountId ?? ""}
              onChange={(e) => set({ accountId: e.target.value || undefined })}
            >
              <option value="">All accounts</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
          )}
          {has("search") && (
            <label className="block">
              <span className={label}>Text to find</span>
              <input
                value={spec.search ?? ""}
                maxLength={100}
                onChange={(e) => set({ search: e.target.value || undefined })}
                className={input}
              />
            </label>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <p className={label}>Preview</p>
          <div
            className={cx(
              "rounded-xl border border-slate-200 p-4 dark:border-slate-800",
              preview.isFetching && "opacity-60",
            )}
          >
            <p className="mb-2 font-semibold">{title || "Your card"}</p>
            {preview.error && <p className="text-sm text-red-600">{preview.error.message}</p>}
            {preview.data && !preview.error && (
              <div className="max-h-72 overflow-auto">
                <CardBody data={preview.data} spec={spec} title={title || "Preview"} />
              </div>
            )}
          </div>
          <label className="block">
            <span className={label}>Note (optional)</span>
            <input
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
              className={input}
            />
          </label>
        </div>
      </div>

      <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          aria-expanded={advanced}
          className="text-sm font-medium text-brand-600 hover:underline"
        >
          {advanced ? "▾" : "▸"} Use JSON or an AI assistant
        </button>
        {advanced && (
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <p className={label}>Paste a card</p>
              <p className="text-xs text-slate-500">
                From an assistant or someone else's Muny. It fills in the form above, so you see the
                preview before saving. Cards are data only and can't run code.
              </p>
              <textarea
                value={json}
                onChange={(e) => setJson(e.target.value)}
                rows={6}
                spellCheck={false}
                aria-label="Card JSON"
                placeholder='{ "title": "…", "spec": { "source": "…", "view": "…" } }'
                className={cx(input, "font-mono text-xs")}
              />
              {jsonError && <p className="mt-1 text-xs text-red-600">{jsonError}</p>}
              <Button
                variant="secondary"
                className="mt-2"
                disabled={!json.trim()}
                onClick={applyJson}
              >
                Use this
              </Button>
            </div>
            <div className="min-w-0">
              <p className={label}>Ask an assistant</p>
              <p className="text-xs text-slate-500">
                Copy this into any AI assistant and describe the card you want. It holds no
                financial data, only what a card can be.
              </p>
              <textarea
                readOnly
                rows={6}
                value={schema.data ? assistantPrompt(schema.data) : "Loading…"}
                onFocus={(e) => e.target.select()}
                aria-label="Prompt for an AI assistant"
                className={cx(input, "font-mono text-xs")}
              />
              <p className={cx(label, "mt-3")}>This card's JSON</p>
              <textarea
                readOnly
                rows={4}
                value={JSON.stringify(
                  { title, ...(description ? { description } : {}), spec },
                  null,
                  2,
                )}
                onFocus={(e) => e.target.select()}
                aria-label="This card as JSON"
                className={cx(input, "font-mono text-xs")}
              />
            </div>
          </div>
        )}
      </div>

      {(save.error ?? del.error) && (
        <div className="mt-3">
          <Alert>{(save.error ?? del.error)?.message}</Alert>
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        {card ? (
          <Button
            variant="ghost"
            className="text-red-600"
            disabled={del.isPending}
            onClick={() => {
              if (window.confirm(`Delete "${card.title}" for everyone in this household?`))
                del.mutate(card.id, { onSuccess: () => onDeleted(card.id) });
            }}
          >
            Delete card
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!title.trim() || save.isPending} onClick={submit}>
            {card ? "Save" : "Create card"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
