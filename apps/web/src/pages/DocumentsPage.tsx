import type { DocumentInfo, LoansReport } from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  Image,
  ScrollText,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { SelectField } from "../components/forms.js";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Documents (Insights), in folders by where they come from: loan and card
 * statements you import, tax forms and the tax reports Muny makes, and your
 * own uploads in folders you choose. Kept in Muny's database, encrypted when
 * MUNY_SECRET_KEY is set; reports are made when you open them.
 */

const docsKey = ["documents"] as const;
const TYPES = ["application/pdf", "image/png", "image/jpeg"];
const KIND_LABEL: Record<DocumentInfo["kind"], string> = {
  loan_statement: "Loan statement",
  card_statement: "Card statement",
  contract: "Contract",
  tax_form: "Tax form",
  report: "Report",
  other: "Document",
};

const day = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
const REVIEW_LABEL: Record<NonNullable<DocumentInfo["review"]>, string> = {
  running: "Reviewing…",
  done: "See review",
  failed: "Review",
};
const size = (b: number) =>
  b <= 0
    ? null
    : b < 1024 * 1024
      ? `${Math.max(1, Math.round(b / 1024))} KB`
      : `${(b / 1024 / 1024).toFixed(1)} MB`;
const parts = (folder: string) =>
  folder
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
const join = (p: string[]) => p.join(" / ");

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

interface FolderNode {
  path: string;
  name: string;
  depth: number;
  count: number;
}

/** Every folder and its parents, in order, with how many documents are inside. */
function folderTree(docs: DocumentInfo[]): FolderNode[] {
  const counts = new Map<string, number>();
  for (const d of docs) {
    const p = parts(d.folder);
    for (let i = 1; i <= p.length; i++) {
      const k = join(p.slice(0, i));
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  // Years newest first; everything else alphabetical.
  const keys = [...counts.keys()].sort((a, b) => {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      const na = Number(pa[i]);
      const nb = Number(pb[i]);
      if (Number.isInteger(na) && Number.isInteger(nb)) return nb - na;
      return (pa[i] ?? "").localeCompare(pb[i] ?? "");
    }
    return pa.length - pb.length;
  });
  return keys.map((k) => {
    const p = parts(k);
    return { path: k, name: p.at(-1) ?? k, depth: p.length - 1, count: counts.get(k) ?? 0 };
  });
}

export function DocumentsPage() {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: docsKey,
    queryFn: () => api.get<DocumentInfo[]>("/api/documents"),
    refetchInterval: (q) => (q.state.data?.some((d) => d.review === "running") ? 5000 : false),
  });
  const [folder, setFolder] = useState<string | null>(null);
  // Folders start closed; opening one shows what's inside.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const go = (path: string | null) => {
    setFolder(path);
    if (!path) return;
    const p = parts(path);
    setOpen((o) => {
      const next = new Set(o);
      // Its parents open; itself toggles when clicked again.
      for (let i = 1; i < p.length; i++) next.add(join(p.slice(0, i)));
      if (folder === path && next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; folder: string } | null>(null);

  const [addingContract, setAddingContract] = useState(false);
  const [loanId, setLoanId] = useState("");
  const loans = useQuery({
    queryKey: ["documents", "loans"],
    queryFn: () => api.get<LoansReport>("/api/loans"),
    enabled: addingContract,
  });

  const all = docs.data ?? [];
  const tree = folderTree(all);
  const uploadFolder =
    folder && !/^(Loans|Credit cards|Taxes|Contracts)\b/.test(folder) ? folder : "Uploads";
  const userFolders = [
    ...new Set(all.filter((d) => d.stored && d.kind === "other").map((d) => d.folder)),
  ];

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    let i = 0;
    for (const file of [...files]) {
      setBusy(`Uploading ${++i} of ${files.length}…`);
      if (!TYPES.includes(file.type)) {
        setError(`${file.name}: only PDF, PNG and JPEG files.`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(`${file.name} is over 10 MB.`);
        continue;
      }
      try {
        await api.post("/api/documents", {
          name: file.name,
          mime: file.type,
          dataBase64: await toBase64(file),
          folder: uploadFolder,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't upload ${file.name}`);
      }
    }
    setBusy(null);
    await qc.invalidateQueries({ queryKey: docsKey });
  };

  const uploadContracts = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    let filed: string | null = null;
    let i = 0;
    for (const file of [...files]) {
      setBusy(`Uploading ${++i} of ${files.length}…`);
      if (file.type !== "application/pdf") {
        setError(`${file.name}: contracts have to be PDFs, so their text can be read.`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError(`${file.name} is over 10 MB.`);
        continue;
      }
      try {
        const doc = await api.post<DocumentInfo>("/api/documents", {
          name: file.name,
          mime: file.type,
          dataBase64: await toBase64(file),
          kind: "contract",
          accountId: loanId || null,
        });
        filed = doc.folder;
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't upload ${file.name}`);
      }
    }
    setBusy(null);
    await qc.invalidateQueries({ queryKey: docsKey });
    if (filed) {
      setAddingContract(false);
      setLoanId("");
      go(filed);
    }
  };

  const remove = async (id: string) => {
    await api.delete(`/api/documents/${id}`);
    setConfirm(null);
    await qc.invalidateQueries({ queryKey: docsKey });
  };
  const move = async () => {
    if (!moving) return;
    await api.patch(`/api/documents/${moving.id}`, { folder: moving.folder.trim() || null });
    setMoving(null);
    await qc.invalidateQueries({ queryKey: docsKey });
  };

  const hasKids = (path: string) => tree.some((n) => n.path.startsWith(`${path} /`));
  const sub = tree.filter((n) =>
    folder === null
      ? n.depth === 0
      : n.path.startsWith(`${folder} /`) && n.depth === parts(folder).length,
  );
  const needle = q.trim().toLowerCase();
  const list = all.filter(
    (d) =>
      (needle
        ? !folder || d.folder === folder || d.folder.startsWith(`${folder} /`)
        : folder !== null && d.folder === folder) &&
      (!needle ||
        [d.name, d.lender, d.notes, d.documentDate, d.folder].some((x) =>
          x?.toLowerCase().includes(needle),
        )),
  );
  const groups = new Map<string, DocumentInfo[]>();
  for (const d of list) groups.set(d.folder, [...(groups.get(d.folder) ?? []), d]);
  const ordered = tree.filter((n) => groups.has(n.path)).map((n) => n.path);

  return (
    <>
      <PageHeader
        title="Documents"
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setAddingContract((v) => !v)}>
              <ScrollText aria-hidden="true" className="mr-1.5 inline size-4" />
              Add a contract
            </Button>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-on-brand hover:bg-brand-700">
              <Upload aria-hidden="true" className="size-4" /> Upload to {uploadFolder}
              <input
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                className="sr-only"
                disabled={!!busy}
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </span>
        }
      />
      <p className="-mt-3 mb-4 text-sm text-slate-500">
        Statements you import file themselves by lender and card; tax forms and the tax reports Muny
        makes are under Taxes by year. Your own uploads (titles, receipts) go into the folder you
        pick on the left, or move them after.
      </p>
      {addingContract && (
        <Card className="mb-4 space-y-3">
          <h2 className="font-semibold">Add a contract</h2>
          <SelectField
            label="Which loan is it for?"
            className="max-w-md"
            value={loanId}
            onChange={(e) => setLoanId(e.target.value)}
          >
            <option value="">Not tied to a loan</option>
            {(loans.data?.loans ?? []).map((l) => (
              <option key={l.accountId} value={l.accountId}>
                {l.name}
                {l.mask ? ` ····${l.mask}` : ""}
              </option>
            ))}
          </SelectField>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-on-brand hover:bg-brand-700">
              <Upload aria-hidden="true" className="size-4" /> Choose PDF
              <input
                type="file"
                multiple
                accept=".pdf,application/pdf"
                className="sr-only"
                disabled={!!busy}
                onChange={(e) => {
                  void uploadContracts(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <Button variant="ghost" onClick={() => setAddingContract(false)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Kept encrypted under Contracts, by loan. Once it's here, Review can have your AI model
            read it.
          </p>
        </Card>
      )}
      {error && <Alert>{error}</Alert>}
      {busy && <p className="mb-3 text-sm text-slate-500">{busy}</p>}

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Folders" className="space-y-0.5 text-sm">
          <button
            type="button"
            onClick={() => go(null)}
            className={cx(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left",
              folder === null
                ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                : "hover:bg-slate-100 dark:hover:bg-slate-800",
            )}
          >
            <FolderOpen aria-hidden="true" className="size-4" />
            <span className="flex-1">All documents</span>
            <span className="text-xs text-slate-500">{all.length}</span>
          </button>
          {tree
            // Shown only when every folder above it is open.
            .filter((n) =>
              parts(n.path)
                .slice(0, -1)
                .every((_, i, p) => open.has(join(p.slice(0, i + 1)))),
            )
            .map((n) => (
              <button
                key={n.path}
                type="button"
                aria-expanded={hasKids(n.path) ? open.has(n.path) : undefined}
                onClick={() => go(n.path)}
                style={{ paddingLeft: `${0.5 + n.depth}rem` }}
                className={cx(
                  "flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left",
                  folder === n.path
                    ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "w-2 text-[9px] text-slate-400 transition-transform",
                    open.has(n.path) && "rotate-90",
                    !hasKids(n.path) && "invisible",
                  )}
                >
                  ▶
                </span>
                {folder === n.path ? (
                  <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <Folder aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
                )}
                <span className="min-w-0 flex-1 truncate">{n.name}</span>
                <span className="text-xs text-slate-500">{n.count}</span>
              </button>
            ))}
        </nav>

        <div className="min-w-0 space-y-4">
          <label className="flex items-center gap-2 rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
            <Search aria-hidden="true" className="size-4 text-slate-400" />
            <span className="sr-only">Search documents</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={
                folder ? `Search in ${folder}` : "Search by name, lender, year or folder"
              }
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
          </label>
          {docs.isError && <Alert>{docs.error.message}</Alert>}
          {!needle && sub.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {sub.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  onClick={() => go(n.path)}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 bg-surface px-4 py-3 text-left hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900"
                >
                  <Folder aria-hidden="true" className="size-5 shrink-0 text-brand-600" />
                  <span className="min-w-0 flex-1 truncate font-medium">{n.name}</span>
                  <span className="text-xs text-slate-500">{n.count}</span>
                </button>
              ))}
            </div>
          )}
          {docs.data && list.length === 0 && sub.length === 0 && (
            <Card className="text-center text-sm text-slate-500">
              {all.length === 0
                ? "No documents yet. Import a statement on Loans or Credit cards, or upload a file."
                : "Nothing here."}
            </Card>
          )}
          {ordered.map((path) => (
            <section key={path}>
              <h2 className="mb-2 px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                {path}
              </h2>
              <Card className="p-0">
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(groups.get(path) ?? []).map((d) => {
                    const Icon = d.mime.startsWith("image/")
                      ? Image
                      : d.mime === "text/csv"
                        ? FileSpreadsheet
                        : FileText;
                    return (
                      <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <Icon aria-hidden="true" className="size-5 shrink-0 text-brand-600" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{d.name}</p>
                          <p className="truncate text-xs text-slate-500">
                            {[
                              KIND_LABEL[d.kind],
                              d.kind !== "report" && d.documentDate && day(d.documentDate),
                              d.notes,
                              size(d.sizeBytes),
                              d.stored && `Added ${new Date(d.createdAt).toLocaleDateString()}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          {moving?.id === d.id && (
                            <form
                              className="mt-2 flex flex-wrap items-center gap-2"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void move();
                              }}
                            >
                              <input
                                aria-label="Folder"
                                list="doc-folders"
                                value={moving.folder}
                                onChange={(e) => setMoving({ id: d.id, folder: e.target.value })}
                                placeholder="e.g. Car or Home / Insurance"
                                className="w-64 rounded-lg border border-slate-300 bg-surface px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                              />
                              <datalist id="doc-folders">
                                {userFolders.map((f) => (
                                  <option key={f} value={f} />
                                ))}
                              </datalist>
                              <Button type="submit" className="px-2.5 py-1 text-xs">
                                Move
                              </Button>
                              <Button
                                variant="ghost"
                                className="px-2 py-1 text-xs"
                                onClick={() => setMoving(null)}
                              >
                                Cancel
                              </Button>
                            </form>
                          )}
                        </div>
                        <span className="flex items-center gap-1">
                          {d.kind === "contract" && d.mime === "application/pdf" && (
                            <Link
                              to="/documents/$documentId/review"
                              params={{ documentId: d.id }}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-brand-600 hover:bg-slate-100 dark:text-brand-500 dark:hover:bg-slate-800"
                            >
                              <Sparkles aria-hidden="true" className="size-4" />
                              {d.review ? REVIEW_LABEL[d.review] : "Review"}
                            </Link>
                          )}
                          <a
                            href={d.href}
                            target="_blank"
                            rel="noopener"
                            title="Open"
                            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800"
                          >
                            <ExternalLink aria-hidden="true" className="size-4" />
                            <span className="sr-only">Open {d.name}</span>
                          </a>
                          <a
                            href={d.downloadHref}
                            download
                            title="Download"
                            className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800"
                          >
                            <Download aria-hidden="true" className="size-4" />
                            <span className="sr-only">Download {d.name}</span>
                          </a>
                          {d.stored && d.kind === "other" && (
                            <button
                              type="button"
                              title="Move to a folder"
                              onClick={() => setMoving({ id: d.id, folder: d.folder })}
                              className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800"
                            >
                              <FolderInput aria-hidden="true" className="size-4" />
                              <span className="sr-only">Move {d.name}</span>
                            </button>
                          )}
                          {d.stored &&
                            (confirm === d.id ? (
                              <span className="flex items-center gap-1 text-xs">
                                <Button
                                  variant="danger"
                                  className="px-2 py-1 text-xs"
                                  onClick={() => void remove(d.id)}
                                >
                                  Delete
                                </Button>
                                <Button
                                  variant="ghost"
                                  className="px-2 py-1 text-xs"
                                  onClick={() => setConfirm(null)}
                                >
                                  Cancel
                                </Button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                title="Delete"
                                onClick={() => setConfirm(d.id)}
                                className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
                              >
                                <Trash2 aria-hidden="true" className="size-4" />
                                <span className="sr-only">Delete {d.name}</span>
                              </button>
                            ))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
