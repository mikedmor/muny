import type { Category, CategoryGroup } from "@muny/shared";
import { type FormEvent, useEffect, useState } from "react";
import { Modal, SelectField } from "../components/forms.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import {
  useCategories,
  useCreateCategory,
  useCreateGroup,
  useDeleteCategory,
  useDeleteGroup,
  useSetUiPrefs,
  useUiPrefs,
  useUpdateCategory,
  useUpdateGroup,
} from "../lib/queries.js";
import { DataSettings } from "./settings/DataSettings.js";
import { HouseholdSettings } from "./settings/HouseholdSettings.js";
import { PayeesSettings } from "./settings/PayeesSettings.js";
import { RulesSettings } from "./settings/RulesSettings.js";

const KIND_LABEL = { expense: "Spending", income: "Income", transfer: "Transfers" } as const;

const TABS = [
  ["categories", "Categories"],
  ["rules", "Rules"],
  ["merchants", "Merchants"],
  ["display", "Display"],
  ["data", "Data & backups"],
  ["household", "Household & account"],
] as const;
type Tab = (typeof TABS)[number][0];

const tabFromHash = (): Tab => {
  const h = window.location.hash.slice(1);
  return (TABS.find(([k]) => k === h)?.[0] ?? "categories") as Tab;
};

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <>
      <PageHeader title="Settings" />
      <div
        role="tablist"
        className="mb-6 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-slate-200 dark:border-slate-800"
      >
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              window.history.replaceState(null, "", `#${key}`);
            }}
            className={cx(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              tab === key
                ? "border-brand-600 text-brand-700 dark:text-brand-500"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "categories" && <CategoriesSettings />}
      {tab === "rules" && <RulesSettings />}
      {tab === "merchants" && <PayeesSettings />}
      {tab === "data" && <DataSettings />}
      {tab === "display" && <DisplaySettings />}
      {tab === "household" && <HouseholdSettings />}
    </>
  );
}

function InlineText({
  value,
  onSave,
  className,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        title="Rename"
        onClick={() => {
          setText(value);
          setEditing(true);
        }}
        className={cx("truncate text-left hover:underline", className)}
      >
        {value}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    const v = text.trim();
    if (v && v !== value) onSave(v);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: inline rename should focus immediately
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className={cx(
        "w-full rounded border border-brand-500 bg-white px-2 py-0.5 outline-none dark:bg-slate-950",
        className,
      )}
    />
  );
}

function CategoriesSettings() {
  const categories = useCategories();
  const createGroup = useCreateGroup();
  const [newGroup, setNewGroup] = useState("");
  const [deleting, setDeleting] = useState<Category | null>(null);

  const addGroup = (e: FormEvent) => {
    e.preventDefault();
    if (!newGroup.trim()) return;
    createGroup.mutate({ name: newGroup.trim() }, { onSuccess: () => setNewGroup("") });
  };

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">Categories</h2>
      <p className="mb-4 text-sm text-slate-500">
        Click a name to rename it. Hidden categories stay on existing transactions but aren't
        offered for new ones.
      </p>
      {categories.isError && <Alert>Couldn't load categories.</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        {categories.data?.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            allGroups={categories.data ?? []}
            onDelete={setDeleting}
          />
        ))}
      </div>

      <form onSubmit={addGroup} className="mt-4 flex max-w-md gap-2">
        <input
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          placeholder="New group name"
          aria-label="New group name"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        <Button type="submit" variant="secondary" disabled={createGroup.isPending}>
          Add group
        </Button>
      </form>
      {createGroup.error && (
        <p className="mt-2 text-sm text-red-600">{createGroup.error.message}</p>
      )}

      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Delete category">
        {deleting && (
          <DeleteCategoryForm
            category={deleting}
            groups={categories.data ?? []}
            onDone={() => setDeleting(null)}
          />
        )}
      </Modal>
    </section>
  );
}

function GroupCard({
  group,
  allGroups,
  onDelete,
}: {
  group: CategoryGroup;
  allGroups: CategoryGroup[];
  onDelete: (c: Category) => void;
}) {
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const [newName, setNewName] = useState("");
  const error =
    updateGroup.error ?? deleteGroup.error ?? createCategory.error ?? updateCategory.error;

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createCategory.mutate(
      { groupId: group.id, name: newName.trim() },
      { onSuccess: () => setNewName("") },
    );
  };

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <InlineText
          value={group.name}
          onSave={(name) => updateGroup.mutate({ id: group.id, name })}
          className="font-semibold"
        />
        <div className="flex shrink-0 items-center gap-2">
          <select
            aria-label={`${group.name} type`}
            value={group.kind}
            onChange={(e) => updateGroup.mutate({ id: group.id, kind: e.target.value })}
            className="rounded border border-slate-200 bg-transparent px-1 py-0.5 text-xs text-slate-500 dark:border-slate-700"
          >
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          {group.categories.length === 0 && (
            <button
              type="button"
              onClick={() => deleteGroup.mutate(group.id)}
              className="text-xs text-red-600 hover:underline"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {group.categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
            <InlineText
              value={c.name}
              onSave={(name) => updateCategory.mutate({ id: c.id, name })}
              className={cx(c.hidden && "text-slate-400 line-through")}
            />
            <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
              <span className="tabular-nums">{c.transactionCount || ""}</span>
              {allGroups.length > 1 && (
                <select
                  aria-label={`Move ${c.name} to group`}
                  value=""
                  onChange={(e) =>
                    e.target.value && updateCategory.mutate({ id: c.id, groupId: e.target.value })
                  }
                  className="w-16 rounded border border-transparent bg-transparent text-xs hover:border-slate-300 dark:hover:border-slate-700"
                >
                  <option value="">Move…</option>
                  {allGroups
                    .filter((g) => g.id !== group.id)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => updateCategory.mutate({ id: c.id, hidden: !c.hidden })}
                className="hover:underline"
              >
                {c.hidden ? "Unhide" : "Hide"}
              </button>
              <button
                type="button"
                onClick={() => onDelete(c)}
                className="text-red-600 hover:underline"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        onSubmit={add}
        className="flex gap-2 border-t border-slate-100 px-4 py-2 dark:border-slate-800"
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Add category"
          aria-label={`Add category to ${group.name}`}
          className="flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-slate-400"
        />
        {newName && (
          <button type="submit" className="text-sm font-medium text-brand-600">
            Add
          </button>
        )}
      </form>
      {error && <p className="px-4 pb-2 text-xs text-red-600">{error.message}</p>}
    </Card>
  );
}

function DeleteCategoryForm({
  category,
  groups,
  onDone,
}: {
  category: Category;
  groups: CategoryGroup[];
  onDone: () => void;
}) {
  const del = useDeleteCategory();
  const [reassignTo, setReassignTo] = useState("");
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Delete <strong>{category.name}</strong>?
        {category.transactionCount > 0 &&
          ` It's used by ${category.transactionCount} transaction${category.transactionCount === 1 ? "" : "s"}.`}
      </p>
      {category.transactionCount > 0 && (
        <SelectField
          label="Move its transactions to"
          value={reassignTo}
          onChange={(e) => setReassignTo(e.target.value)}
        >
          <option value="">Uncategorized</option>
          {groups.map((g) => (
            <optgroup key={g.id} label={g.name}>
              {g.categories
                .filter((c) => c.id !== category.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </SelectField>
      )}
      {del.error && <Alert>{del.error.message}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={del.isPending}
          onClick={() =>
            del.mutate(
              { id: category.id, reassignTo: reassignTo || undefined },
              { onSuccess: onDone },
            )
          }
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function DisplaySettings() {
  const prefs = useUiPrefs();
  const set = useSetUiPrefs();
  const split = prefs.data?.splitCharts ?? true;
  return (
    <Card className="max-w-2xl">
      <h2 className="font-semibold">Charts</h2>
      <label className="mt-3 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={split}
          disabled={!prefs.data || set.isPending}
          onChange={(e) => set.mutate({ splitCharts: e.target.checked })}
          className="mt-0.5 size-4 accent-brand-600"
        />
        <span>
          <span className="font-medium">Split totals into colored parts</span>
          <span className="block text-xs text-slate-500">
            Spending this month by category, crypto by coin, stocks by holding, and savings by money
            added and interest. Off: one line per chart. Applies to everyone in the household.
          </span>
        </span>
      </label>
    </Card>
  );
}
