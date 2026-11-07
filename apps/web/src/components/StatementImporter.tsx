import {
  ACCOUNT_TYPE_LABELS,
  type Account,
  type AccountType,
  formatMoney,
  type StatementPreview,
  type StatementStatus,
} from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FileUp } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.js";
import { useAccounts } from "../lib/queries.js";
import { Modal } from "./forms.js";
import { TeachButton } from "./TeachStatement.js";
import { Alert, Button, cx } from "./ui.js";

/**
 * Statements for any account: each PDF is read to suggest what it is and whose
 * it is (by the last 4 digits). Card and loan statements can be read into the
 * account; anything can just be kept in Documents with its statement date, so
 * you can see which months you have. New accounts can be made from them.
 */

const NEW_TYPES: AccountType[] = ["credit", "loan", "checking", "savings", "investment", "other"];

const KIND_LABEL: Record<StatementPreview["kind"], string> = {
  card: "Card statement",
  loan: "Loan statement",
  groups: "Several loans on one statement",
  unknown: "Muny can't read this one",
};

const money = (c: number | null) => (c === null ? "—" : formatMoney(c));
const day = (d: string | null) =>
  d
    ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

interface Item {
  /** Unique within the list. */
  id: string;
  name: string;
  base64: string;
  preview: StatementPreview | null;
  error: string | null;
  /** An account id, or "new". */
  accountId: string;
  newName: string;
  newType: AccountType;
  /** Read it into the account, or just keep it. */
  mode: "read" | "keep";
  date: string;
}

/** Can this statement be read into an account of this type? */
function readable(p: StatementPreview | null, type: AccountType | undefined) {
  if (!p || p.kind === "groups") return false;
  if (type === "credit")
    return p.card.newBalanceCents !== null || p.card.closingDate !== null || !!p.card.dueDate;
  if (type === "loan")
    return p.loan.balanceCents !== null || p.loan.statementDate !== null || !!p.loan.dueDate;
  return false;
}

const inputCls =
  "rounded-lg border border-slate-300 bg-surface px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";

export function StatementImporter({
  forAccount,
  defaultType,
  onDone,
}: {
  /** Opened from an account: statements go to it unless their last 4 say otherwise. */
  forAccount?: string;
  /** The type for new accounts when the statement doesn't say. */
  defaultType?: AccountType;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const accounts = (useAccounts().data ?? []).filter((a) => !a.hidden || a.id === forAccount);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const [items, setItems] = useState<Item[]>([]);
  const [addTxns, setAddTxns] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const typeOf = (it: Item) => (it.accountId === "new" ? it.newType : byId.get(it.accountId)?.type);
  const setItem = (k: number, patch: Partial<Item>) =>
    setItems((xs) =>
      xs.map((x, j) => {
        if (j !== k) return x;
        const next = { ...x, ...patch };
        // Switching accounts: read it when it can be, else keep it.
        if (("accountId" in patch || "newType" in patch) && !("mode" in patch))
          next.mode = readable(next.preview, typeOf(next)) ? "read" : "keep";
        return next;
      }),
    );

  const itemFor = (id: string, name: string, base64: string, preview: StatementPreview): Item => {
    const accountId = preview.accountId ?? forAccount ?? (preview.kind === "unknown" ? "" : "new");
    const newType: AccountType =
      preview.kind === "card"
        ? "credit"
        : preview.kind === "loan" || preview.kind === "groups"
          ? "loan"
          : (defaultType ?? "checking");
    const base = {
      id,
      name,
      base64,
      preview,
      error: null,
      accountId,
      newType,
      newName: `${ACCOUNT_TYPE_LABELS[newType]}${preview.mask ? ` ••${preview.mask}` : ""}`,
      date: preview.date ?? "",
    };
    const type = accountId === "new" ? newType : byId.get(accountId)?.type;
    return { ...base, mode: readable(preview, type) ? "read" : "keep" };
  };

  const preview = (base64: string) =>
    api.post<StatementPreview>("/api/statements/preview", { pdfBase64: base64 });

  const read = async (files: FileList | null) => {
    if (!files?.length) return;
    const out: Item[] = [];
    let i = 0;
    for (const file of [...files]) {
      setBusy(`Reading ${++i} of ${files.length}…`);
      try {
        const base64 = await toBase64(file);
        out.push(itemFor(`${i}-${file.name}`, file.name, base64, await preview(base64)));
      } catch (err) {
        out.push({
          id: `${i}-${file.name}`,
          name: file.name,
          base64: "",
          preview: null,
          error: err instanceof Error ? err.message : "Couldn't read it",
          accountId: forAccount ?? "",
          newName: "",
          newType: defaultType ?? "checking",
          mode: "keep",
          date: "",
        });
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    setItems(out);
    setBusy(null);
  };

  /** Read every statement again (after teaching Muny a layout); keeps your choices. */
  const reread = async () => {
    setBusy("Reading again…");
    const out: Item[] = [];
    for (const it of items) {
      try {
        if (!it.base64) throw new Error();
        const p = await preview(it.base64);
        const type = typeOf(it);
        out.push({
          ...it,
          preview: p,
          date: it.date || (p.date ?? ""),
          mode: readable(p, type) ? "read" : "keep",
        });
      } catch {
        out.push(it);
      }
    }
    setItems(out);
    setBusy(null);
  };

  const ready = (it: Item) =>
    !!it.base64 &&
    !!it.accountId &&
    (it.accountId !== "new" || !!it.newName.trim()) &&
    (it.mode === "read" ? readable(it.preview, typeOf(it)) : /^\d{4}-\d{2}-\d{2}$/.test(it.date));

  const apply = async () => {
    setError(null);
    const made = new Map<string, Account>();
    try {
      const todo = items.filter(ready);
      let i = 0;
      for (const it of todo) {
        setBusy(`Saving statement ${++i} of ${todo.length}…`);
        let acc = byId.get(it.accountId);
        if (it.accountId === "new") {
          const key = `${it.newType}|${it.newName.trim().toLowerCase()}`;
          acc = made.get(key);
          if (!acc) {
            acc = await api.post<Account>("/api/accounts", {
              name: it.newName.trim(),
              type: it.newType,
              mask: it.preview?.mask ?? null,
            });
            made.set(key, acc);
          }
        }
        if (!acc) continue;
        const p = it.preview;
        if (it.mode === "read" && p && acc.type === "credit")
          await api.post("/api/cards/statements/apply", {
            accountId: acc.id,
            statement: { ...p.card, closingDate: p.card.closingDate ?? (it.date || null) },
            pdfBase64: it.base64,
            fileName: it.name,
            cardName: acc.name,
            addTransactions: addTxns,
          });
        else if (it.mode === "read" && p && acc.type === "loan")
          await api.post(`/api/loans/${acc.id}/statement/apply`, {
            statement: { ...p.loan, statementDate: p.loan.statementDate ?? (it.date || null) },
            pdfBase64: it.base64,
            fileName: it.name,
            lender: acc.institutionName ?? acc.name,
          });
        else
          await api.post(`/api/accounts/${acc.id}/statements`, {
            pdfBase64: it.base64,
            fileName: it.name,
            statementDate: it.date,
          });
      }
      await qc.invalidateQueries();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save them");
      setBusy(null);
      if (made.size) await qc.invalidateQueries();
    }
  };

  const count = items.filter(ready).length;
  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Choose one or more statement PDFs. Muny reads card and loan statements (balance, minimum or
        payment, due date, rate) and picks the account by its last 4 digits. Anything else, or
        anything you'd rather not read, is just kept under Insights → Documents with its statement
        date, so you can see which months you have.
      </p>
      <input
        type="file"
        multiple
        accept="application/pdf,.pdf"
        disabled={!!busy}
        onChange={(e) => void read(e.target.files)}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-1.5 file:text-on-brand"
      />
      {busy && <p className="text-sm text-slate-500">{busy}</p>}
      <ul className="space-y-3">
        {items.map((it, k) => {
          const p = it.preview;
          const type = typeOf(it);
          const canRead = readable(p, type);
          const teachKind = type === "credit" ? "card" : type === "loan" ? "loan" : null;
          const missing =
            p && teachKind === "card"
              ? p.card.newBalanceCents === null ||
                p.card.dueDate === null ||
                p.card.minimumPaymentCents === null
              : p && teachKind === "loan"
                ? p.loan.balanceCents === null || p.loan.dueDate === null
                : false;
          return (
            <li
              key={it.id}
              className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <FileText aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
                  <span className="truncate">{it.name}</span>
                </span>
                <span className="text-xs text-slate-500">
                  {p ? KIND_LABEL[p.kind] : ""}
                  {p?.templates.length ? ` · read with ${p.templates.join(", ")}` : ""}
                  {p && teachKind && missing && p.kind !== "groups" && (
                    <>
                      {" · "}
                      <TeachButton kind={teachKind} lines={p.lines} onSaved={() => void reread()} />
                    </>
                  )}
                </span>
              </div>
              {it.error ? (
                <p className="text-sm text-red-600">{it.error}</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Account for ${it.name}`}
                      value={it.accountId}
                      onChange={(e) => setItem(k, { accountId: e.target.value })}
                      className={cx(inputCls, "min-w-0 max-w-full")}
                    >
                      {!it.accountId && <option value="">Choose an account…</option>}
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.mask ? ` ••${a.mask}` : ""} ({ACCOUNT_TYPE_LABELS[a.type]})
                        </option>
                      ))}
                      <option value="new">New account…</option>
                    </select>
                    {it.accountId === "new" && (
                      <>
                        <input
                          aria-label="New account name"
                          value={it.newName}
                          onChange={(e) => setItem(k, { newName: e.target.value })}
                          placeholder="Account name"
                          className={cx(inputCls, "w-44")}
                        />
                        <select
                          aria-label="New account type"
                          value={it.newType}
                          onChange={(e) => setItem(k, { newType: e.target.value as AccountType })}
                          className={inputCls}
                        >
                          {NEW_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {ACCOUNT_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`mode-${k}`}
                        checked={it.mode === "read"}
                        disabled={!canRead}
                        onChange={() => setItem(k, { mode: "read" })}
                        className="accent-brand-600"
                      />
                      <span className={cx(!canRead && "text-slate-400")}>
                        Read it into the account
                      </span>
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`mode-${k}`}
                        checked={it.mode === "keep"}
                        onChange={() => setItem(k, { mode: "keep" })}
                        className="accent-brand-600"
                      />
                      Just keep it
                    </label>
                    <label className="flex items-center gap-1.5">
                      <span className="text-slate-500">Statement date</span>
                      <input
                        type="date"
                        value={it.date}
                        onChange={(e) => setItem(k, { date: e.target.value })}
                        className={cx(
                          inputCls,
                          "py-1",
                          it.mode === "keep" && !it.date && "border-amber-500",
                        )}
                      />
                    </label>
                  </div>
                  {it.mode === "read" && p && type === "credit" && (
                    <p className="text-xs text-slate-500">
                      Balance {money(p.card.newBalanceCents)} · minimum{" "}
                      {money(p.card.minimumPaymentCents)} · due {day(p.card.dueDate)}
                      {p.card.transactions.length
                        ? ` · ${p.card.transactions.length} transactions`
                        : ""}
                    </p>
                  )}
                  {it.mode === "read" && p && type === "loan" && (
                    <p className="text-xs text-slate-500">
                      Balance {money(p.loan.balanceCents)} · payment {money(p.loan.paymentCents)} ·
                      due {day(p.loan.dueDate)}
                    </p>
                  )}
                  {p?.kind === "groups" && (
                    <p className="text-xs text-slate-500">
                      Covers {p.groups.join(", ")}. To read it, use Import statements on the
                      lender's card on Loans; here it can be kept.
                    </p>
                  )}
                  {it.mode === "keep" && !it.date && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Give the statement date to keep it.
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {items.some(
        (it) =>
          it.mode === "read" && typeOf(it) === "credit" && it.preview?.card.transactions.length,
      ) && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={addTxns}
            onChange={(e) => setAddTxns(e.target.checked)}
            className="mt-0.5 accent-brand-600"
          />
          <span>
            Add the card statements' transactions to the card
            <span className="block text-xs text-slate-500">
              Purchases, payments, interest and fees listed on them; ones already in Muny (same
              amount within a few days) are skipped. Your rules run on the new ones.
            </span>
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!count || !!busy} onClick={() => void apply()}>
          {count > 1 ? `Save ${count} statements` : "Save statement"}
        </Button>
      </div>
    </div>
  );
}

/** A button that opens the statement importer. */
export function ImportStatementsButton({
  forAccount,
  defaultType,
  variant = "button",
  title = "Import statements",
}: {
  forAccount?: Pick<Account, "id" | "name" | "type">;
  defaultType?: AccountType;
  /** button: a page action; link: a small text link; icon: an icon in a list row. */
  variant?: "button" | "link" | "icon";
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "button" ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <FileUp aria-hidden="true" className="mr-1 inline size-4" /> {title}
        </Button>
      ) : variant === "link" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-500"
        >
          <FileUp aria-hidden="true" className="size-3" /> {title}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={`Upload statements${forAccount ? ` for ${forAccount.name}` : ""}`}
          aria-label={`Upload statements${forAccount ? ` for ${forAccount.name}` : ""}`}
          className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <FileUp aria-hidden="true" className="size-4" />
        </button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={forAccount ? `${forAccount.name} statements` : "Import statements"}
        wide
      >
        {open && (
          <StatementImporter
            forAccount={forAccount?.id}
            defaultType={defaultType ?? forAccount?.type}
            onDone={() => setOpen(false)}
          />
        )}
      </Modal>
    </>
  );
}

export const statementStatusKey = ["statement-status"] as const;

export function useStatementStatus() {
  return useQuery({
    queryKey: statementStatusKey,
    queryFn: () => api.get<StatementStatus[]>("/api/statements/status"),
    select: (rows) => new Map(rows.map((r) => [r.accountId, r])),
  });
}

/** "Last statement Oct 13, 2026 · 2 missing": which statements an account has. */
export function StatementBadge({
  status,
  className,
}: {
  status: StatementStatus | undefined;
  className?: string;
}) {
  if (!status) return null;
  const missing = status.missingMonths.map(monthLabel).join(", ");
  return (
    <span className={cx("text-xs text-slate-500", className)}>
      Last statement {day(status.lastDate)}
      {status.missing > 0 ? (
        <span
          className="text-amber-700 dark:text-amber-400"
          title={`Missing: ${missing}${status.missing > status.missingMonths.length ? " and earlier" : ""}`}
        >
          {" "}
          · {status.missing} missing{status.missing <= 3 ? ` (${missing})` : ""}
        </span>
      ) : (
        <span title={`Next one closes about ${day(status.nextDate)}`}> · up to date</span>
      )}
    </span>
  );
}
