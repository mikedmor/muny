import type { DocumentInfo } from "@muny/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, Image, Search, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Alert, Button, Card, cx, PageHeader } from "../components/ui.js";
import { api } from "../lib/api.js";

/**
 * Documents (Insights): loan statements saved when you import them, and files
 * you upload (titles, tax forms, receipts). Kept in Muny's database, encrypted
 * when MUNY_SECRET_KEY is set.
 */

const docsKey = ["documents"] as const;
const TYPES = ["application/pdf", "image/png", "image/jpeg"];
const KIND_LABEL: Record<DocumentInfo["kind"], string> = {
  loan_statement: "Loan statement",
  card_statement: "Card statement",
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
const size = (b: number) =>
  b < 1024 * 1024
    ? `${Math.max(1, Math.round(b / 1024))} KB`
    : `${(b / 1024 / 1024).toFixed(1)} MB`;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

export function DocumentsPage() {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: docsKey,
    queryFn: () => api.get<DocumentInfo[]>("/api/documents"),
  });
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | DocumentInfo["kind"]>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

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
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : `Couldn't upload ${file.name}`);
      }
    }
    setBusy(null);
    await qc.invalidateQueries({ queryKey: docsKey });
  };

  const remove = async (id: string) => {
    await api.delete(`/api/documents/${id}`);
    setConfirm(null);
    await qc.invalidateQueries({ queryKey: docsKey });
  };

  const needle = q.trim().toLowerCase();
  const list = (docs.data ?? []).filter(
    (d) =>
      (kind === "all" || d.kind === kind) &&
      (!needle ||
        [d.name, d.lender, d.notes, d.documentDate].some((x) => x?.toLowerCase().includes(needle))),
  );
  // Statements by lender; everything else together.
  const groups = new Map<string, DocumentInfo[]>();
  for (const d of list) {
    const k = d.kind === "loan_statement" ? `${d.lender ?? "Loan"} statements` : "Other documents";
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }

  return (
    <>
      <PageHeader
        title="Documents"
        actions={
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">
            <Upload aria-hidden="true" className="size-4" /> Upload
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
        }
      />
      <p className="-mt-3 mb-4 text-sm text-slate-500">
        Loan statements you import are kept here, and you can upload your own (titles, tax forms,
        receipts). They stay on your Muny server.
      </p>
      {error && <Alert>{error}</Alert>}
      {busy && <p className="mb-3 text-sm text-slate-500">{busy}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex min-w-60 flex-1 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950">
          <Search aria-hidden="true" className="size-4 text-slate-400" />
          <span className="sr-only">Search documents</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, lender or date"
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        </label>
        {(["all", "loan_statement", "other"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className={cx(
              "rounded-full px-3 py-1.5 text-sm",
              kind === k
                ? "bg-brand-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300",
            )}
          >
            {k === "all" ? "All" : k === "loan_statement" ? "Loan statements" : "Other"}
          </button>
        ))}
      </div>

      {docs.isError && <Alert>{docs.error.message}</Alert>}
      {docs.data && list.length === 0 && (
        <Card className="text-center text-sm text-slate-500">
          {docs.data.length === 0
            ? "No documents yet. Import a loan statement on the Loans page, or upload a file."
            : "Nothing matches."}
        </Card>
      )}
      <div className="space-y-6">
        {[...groups].map(([title, items]) => (
          <section key={title}>
            <h2 className="mb-2 px-1 text-sm font-semibold tracking-wide text-slate-500 uppercase">
              {title}
            </h2>
            <Card className="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((d) => {
                  const Icon = d.mime.startsWith("image/") ? Image : FileText;
                  return (
                    <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <Icon aria-hidden="true" className="size-5 shrink-0 text-brand-600" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{d.name}</p>
                        <p className="truncate text-xs text-slate-500">
                          {[
                            KIND_LABEL[d.kind],
                            d.documentDate && `Statement of ${day(d.documentDate)}`,
                            size(d.sizeBytes),
                            `Added ${new Date(d.createdAt).toLocaleDateString()}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <span className="flex items-center gap-1">
                        <a
                          href={`/api/documents/${d.id}/file`}
                          target="_blank"
                          rel="noopener"
                          title="Open"
                          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800"
                        >
                          <ExternalLink aria-hidden="true" className="size-4" />
                          <span className="sr-only">Open {d.name}</span>
                        </a>
                        <a
                          href={`/api/documents/${d.id}/file?download=1`}
                          title="Download"
                          className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800"
                        >
                          <Download aria-hidden="true" className="size-4" />
                          <span className="sr-only">Download {d.name}</span>
                        </a>
                        {confirm === d.id ? (
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
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>
        ))}
      </div>
    </>
  );
}
