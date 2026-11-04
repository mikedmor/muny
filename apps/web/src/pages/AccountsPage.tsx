import {
  ACCOUNT_TYPE_LABELS,
  ACCOUNT_TYPES,
  type Account,
  type AccountType,
  formatMoney,
  LIABILITY_TYPES,
} from "@muny/shared";
import { type FormEvent, useState } from "react";
import { Checkbox, Modal, MoneyField, SelectField } from "../components/forms.js";
import { Alert, Button, Card, cx, Field, PageHeader } from "../components/ui.js";
import { ApiError } from "../lib/api.js";
import {
  useAccounts,
  useCreateAccount,
  useDeleteAccount,
  useUpdateAccount,
} from "../lib/queries.js";

const SECTIONS: { title: string; types: AccountType[] }[] = [
  { title: "Cash", types: ["checking", "savings", "cash"] },
  { title: "Credit cards", types: ["credit"] },
  { title: "Loans", types: ["loan"] },
  { title: "Investments", types: ["investment"] },
  { title: "Property & other", types: ["asset", "other"] },
];

const isLiability = (t: AccountType) => LIABILITY_TYPES.has(t);
/** Debts are shown as positive "owed" amounts, like most finance apps. */
const displayCents = (a: Pick<Account, "type" | "balanceCents">) =>
  isLiability(a.type) ? -a.balanceCents : a.balanceCents;

function Money({ cents, className }: { cents: number; className?: string }) {
  return <span className={cx("tabular-nums", className)}>{formatMoney(cents)}</span>;
}

function formatDate(iso: string | null) {
  if (!iso) return "No activity yet";
  const [y, m, d] = iso.split("-").map(Number);
  return `Last activity ${new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString()}`;
}

export function AccountsPage() {
  const accounts = useAccounts();
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const all = accounts.data ?? [];
  const visible = all.filter((a) => !a.hidden);
  const hiddenCount = all.length - visible.length;
  const shown = showHidden ? all : visible;

  const assets = visible.filter((a) => a.balanceCents > 0).reduce((s, a) => s + a.balanceCents, 0);
  const debts = visible.filter((a) => a.balanceCents < 0).reduce((s, a) => s + a.balanceCents, 0);

  return (
    <>
      <PageHeader
        title="Accounts"
        actions={<Button onClick={() => setEditing("new")}>Add account</Button>}
      />

      {accounts.isError && <Alert>Couldn't load accounts.</Alert>}

      {accounts.isSuccess && all.length === 0 && (
        <Card className="text-center">
          <p className="font-medium">No accounts yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add one manually, or import a file and Muny will create accounts for you.
          </p>
          <Button className="mt-4" onClick={() => setEditing("new")}>
            Add your first account
          </Button>
        </Card>
      )}

      {all.length > 0 && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Net worth
              </p>
              <Money cents={assets + debts} className="mt-1 block text-2xl font-semibold" />
            </Card>
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Assets</p>
              <Money cents={assets} className="mt-1 block text-xl font-semibold text-emerald-600" />
            </Card>
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Debts</p>
              <Money cents={-debts} className="mt-1 block text-xl font-semibold text-red-600" />
            </Card>
          </div>

          <div className="space-y-6">
            {SECTIONS.map((section) => {
              const items = shown.filter((a) => section.types.includes(a.type));
              if (items.length === 0) return null;
              const total = items.filter((a) => !a.hidden).reduce((s, a) => s + displayCents(a), 0);
              return (
                <section key={section.title}>
                  <div className="mb-2 flex items-baseline justify-between px-1">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                      {section.title}
                    </h2>
                    <Money cents={total} className="text-sm font-medium text-slate-500" />
                  </div>
                  <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                    {items.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => setEditing(a)}
                          className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          <div className="min-w-0">
                            <p className={cx("truncate font-medium", a.hidden && "text-slate-400")}>
                              {a.name}
                              {a.hidden && <span className="ml-2 text-xs">(hidden)</span>}
                            </p>
                            <p className="truncate text-xs text-slate-500">
                              {[a.institutionName, a.mask && `••${a.mask}`]
                                .filter(Boolean)
                                .join(" ")}
                              {(a.institutionName || a.mask) && " · "}
                              {formatDate(a.lastTransactionDate)}
                            </p>
                          </div>
                          <Money cents={displayCents(a)} className="shrink-0 font-medium" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((s) => !s)}
              className="mt-4 text-sm text-slate-500 underline"
            >
              {showHidden ? "Hide hidden accounts" : `Show ${hiddenCount} hidden`}
            </button>
          )}
        </>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add account" : "Edit account"}
      >
        {editing !== null && (
          <AccountForm
            key={editing === "new" ? "new" : editing.id}
            account={editing === "new" ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
    </>
  );
}

function AccountForm({ account, onDone }: { account: Account | null; onDone: () => void }) {
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const remove = useDeleteAccount();

  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "checking");
  const [institutionName, setInstitution] = useState(account?.institutionName ?? "");
  const [mask, setMask] = useState(account?.mask ?? "");
  const [balance, setBalance] = useState<number | null>(account ? displayCents(account) : null);
  const [balanceValid, setBalanceValid] = useState(true);
  const [hidden, setHidden] = useState(account?.hidden ?? false);
  const [excludeFromReports, setExclude] = useState(account?.excludeFromReports ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const mutation = account ? update : create;
  const err = mutation.error ?? remove.error;
  const fields = err instanceof ApiError ? err.fieldErrors() : {};
  const liability = isLiability(type);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!balanceValid) return;
    const signed = balance === null ? undefined : liability ? -balance : balance;
    const common = {
      name,
      type,
      institutionName: institutionName || null,
      mask: mask || null,
    };
    if (account) {
      update.mutate(
        { id: account.id, ...common, hidden, excludeFromReports, balanceCents: signed },
        { onSuccess: onDone },
      );
    } else {
      create.mutate({ ...common, balanceCents: signed ?? 0 }, { onSuccess: onDone });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {err && !Object.keys(fields).length && <Alert>{err.message}</Alert>}
      <Field
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={fields.name}
        placeholder="e.g. Everyday Checking"
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as AccountType)}
          error={fields.type}
        >
          {ACCOUNT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACCOUNT_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <Field
          label="Last 4 digits"
          value={mask}
          onChange={(e) => setMask(e.target.value.replace(/\D/g, "").slice(0, 4))}
          error={fields.mask}
          inputMode="numeric"
          placeholder="Optional"
        />
      </div>
      <Field
        label="Institution"
        value={institutionName}
        onChange={(e) => setInstitution(e.target.value)}
        error={fields.institutionName}
        placeholder="Optional, e.g. Example Bank"
      />
      <MoneyField
        label={liability ? "Amount owed" : "Current balance"}
        cents={balance}
        onChange={(c, valid) => {
          setBalance(c);
          setBalanceValid(valid);
        }}
        error={fields.balanceCents}
        hint={
          account?.balanceSource === "computed" && account.transactionCount > 0
            ? "Changing this adjusts the starting balance; transactions stay as they are."
            : undefined
        }
      />
      {account && (
        <div className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
          <Checkbox
            label="Hide account"
            description="Hidden accounts don't appear in lists or net worth."
            checked={hidden}
            onChange={setHidden}
          />
          <Checkbox
            label="Exclude from budgets & reports"
            description="Useful for business or shared accounts."
            checked={excludeFromReports}
            onChange={setExclude}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {account ? (
          confirmDelete ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-red-600">
                Delete
                {account.transactionCount ? ` with ${account.transactionCount} transactions` : ""}?
              </span>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(account.id, { onSuccess: onDone })}
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" className="text-red-600" onClick={() => setConfirmDelete(true)}>
              Delete account
            </Button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending || !balanceValid}>
            {mutation.isPending ? "Saving…" : account ? "Save" : "Add account"}
          </Button>
        </div>
      </div>
    </form>
  );
}
