import type { ImportFileKind } from "@muny/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bitcoin,
  ChartCandlestick,
  FileStack,
  FileText,
  FolderOpen,
  Landmark,
  type LucideIcon,
  Receipt,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Modal } from "../components/forms.js";
import { StatementImporter } from "../components/StatementImporter.js";
import { Alert, Button, Card, cx } from "../components/ui.js";
import { api } from "../lib/api.js";
import { ImportKoinly } from "./crypto/CryptoWallets.js";
import { ImportDialog } from "./StocksPage.js";

/**
 * Import's landing: one place for every file Muny reads. Drop anything and
 * Muny works out which importer it belongs to; each kind also has its own
 * button below, with what it reads.
 */

const ACCEPT =
  ".csv,.ofx,.qfx,.qbo,.txt,.pdf,.png,.jpg,.jpeg,text/csv,application/pdf,image/png,image/jpeg";

type Open =
  | { kind: "statements"; files: File[] }
  | { kind: "brokerage"; file?: File }
  | { kind: "crypto"; file?: File };

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImage = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g)$/i.test(f.name);
const isOfx = (f: File) => /\.(ofx|qfx|qbo)$/i.test(f.name);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

function Kind({
  icon: Icon,
  title,
  formats,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  formats: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-500"
        >
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-slate-500">{formats}</p>
        </div>
      </div>
      <p className="flex-1 text-sm text-slate-600 dark:text-slate-400">{children}</p>
      <div>{action}</div>
    </Card>
  );
}

const linkClass = "text-sm font-medium text-brand-600 hover:underline dark:text-brand-500";

export function ImportHub({
  onTransactions,
  chooseTransactions,
}: {
  /** A bank file: the transaction importer on this page takes it from here. */
  onTransactions: (f: File) => void;
  /** Open the file picker for bank files. */
  chooseTransactions: () => void;
}) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  /** Sort what was dropped and hand each kind to its importer. */
  const route = async (list: File[]) => {
    setError(null);
    setNotice(null);
    if (!list.length) return;
    const pdfs = list.filter(isPdf);
    const images = list.filter(isImage);
    const text = list.filter((f) => !isPdf(f) && !isImage(f));
    try {
      if (images.length) {
        let n = 0;
        for (const f of images) {
          setBusy(`Saving ${f.name}…`);
          await api.post("/api/documents", {
            name: f.name,
            mime: f.type || "image/jpeg",
            dataBase64: await toBase64(f),
            folder: "Uploads",
          });
          n++;
        }
        await qc.invalidateQueries({ queryKey: ["documents"] });
        setNotice(
          <>
            Saved {n} image{n === 1 ? "" : "s"} to{" "}
            <Link to="/documents" className="underline">
              Documents → Uploads
            </Link>
            .
          </>,
        );
      }
      if (pdfs.length) {
        if (text.length) setNotice("Statements open first; drop the other files again after.");
        setOpen({ kind: "statements", files: pdfs });
        return;
      }
      const f = text[0];
      if (!f) return;
      if (text.length > 1) setNotice(`Reading ${f.name}. Drop the others one at a time.`);
      if (isOfx(f)) return onTransactions(f);
      setBusy(`Looking at ${f.name}…`);
      const d = await api.post<ImportFileKind>("/api/import/detect", {
        content: await f.text(),
        filename: f.name,
      });
      if (d.kind === "brokerage") setOpen({ kind: "brokerage", file: f });
      else if (d.kind === "crypto") setOpen({ kind: "crypto", file: f });
      else onTransactions(f);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file");
    } finally {
      setBusy(null);
    }
  };

  const close = () => setOpen(null);
  const title =
    open?.kind === "statements"
      ? "Import statements"
      : open?.kind === "brokerage"
        ? "Import from your broker"
        : "Import crypto history (Koinly)";

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void route([...e.dataTransfer.files]);
            }}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
              dragging
                ? "border-brand-500 bg-brand-50 dark:bg-brand-700/10"
                : "border-slate-300 bg-surface hover:border-brand-500 dark:border-slate-700 dark:bg-slate-900",
            )}
          >
            <Upload aria-hidden="true" className="size-8 text-slate-400" />
            <span className="mt-3 font-medium">Drop any file here, or click to choose</span>
            <span className="mt-1 max-w-md text-sm text-slate-500">
              Bank and Rocket Money exports, PDF statements, brokerage and crypto exports, receipts.
              Muny works out what each one is, and you review it before anything is saved.
            </span>
            <input
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              disabled={!!busy}
              onChange={(e) => {
                void route([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </label>
          {busy && <p className="text-sm text-slate-500">{busy}</p>}
          {notice && <p className="text-sm text-slate-600 dark:text-slate-300">{notice}</p>}
          {error && <Alert>{error}</Alert>}
        </div>
        <Card>
          <h2 className="font-semibold">Moving from Rocket Money</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-400">
            <li>In Rocket Money on the web, open Transactions.</li>
            <li>Set the date range to all time.</li>
            <li>Click Export and save the CSV.</li>
            <li>Drop it here. You'll review everything before anything is saved.</li>
          </ol>
          <p className="mt-4 text-xs text-slate-500">
            Re-importing is always safe: anything already in Muny, including transactions from
            Rocket Money with the same date and amount, is skipped.
          </p>
        </Card>
      </div>

      <section>
        <h2 className="mb-3 font-semibold">What you can bring in</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Kind
            icon={Receipt}
            title="Bank and card transactions"
            formats="CSV · OFX · QFX · QBO · Rocket Money export"
            action={
              <Button variant="secondary" onClick={chooseTransactions}>
                Choose a file
              </Button>
            }
          >
            Download activity from your bank's website. OFX, QFX and QBO ("Quicken" or "Money")
            include the balance; CSV works too, with presets for Chase, Ally and PayPal.
          </Kind>
          <Kind
            icon={FileText}
            title="Statements"
            formats="PDF · several at once"
            action={
              <Button
                variant="secondary"
                onClick={() => setOpen({ kind: "statements", files: [] })}
              >
                Choose statements
              </Button>
            }
          >
            Card and loan statements are read for the balance, payment, due date and rate, and
            matched to the account by its last 4 digits. Any other statement is kept with its date.
          </Kind>
          <Kind
            icon={ChartCandlestick}
            title="Brokerage"
            formats="CSV · positions and history"
            action={
              <Button variant="secondary" onClick={() => setOpen({ kind: "brokerage" })}>
                Choose a file
              </Button>
            }
          >
            Holdings and trades from Fidelity, Schwab, Vanguard, Robinhood, Webull and most other
            brokers. Importing a file again only adds what's new.
          </Kind>
          <Kind
            icon={Bitcoin}
            title="Crypto"
            formats="Koinly transaction export (CSV)"
            action={
              <Button variant="secondary" onClick={() => setOpen({ kind: "crypto" })}>
                Choose a file
              </Button>
            }
          >
            Every wallet and exchange at once, with cost basis. Wallets can also sync straight from
            the blockchain under{" "}
            <Link to="/crypto/wallets" className="underline">
              Crypto
            </Link>
            .
          </Kind>
          <Kind
            icon={FileStack}
            title="Several loans on one statement"
            formats="PDF from a loan servicer"
            action={
              <Link to="/loans" className={linkClass}>
                Open Loans →
              </Link>
            }
          >
            Student loan servicers that list each loan on one statement. Loans → Import statements
            reads every loan on it and sets up the ones Muny doesn't have yet.
          </Kind>
          <Kind
            icon={FolderOpen}
            title="Documents and tax forms"
            formats="PDF · PNG · JPG"
            action={
              <span className="flex gap-4">
                <Link to="/documents" className={linkClass}>
                  Documents →
                </Link>
                <Link to="/taxes" className={linkClass}>
                  Taxes →
                </Link>
              </span>
            }
          >
            Receipts, titles and warranties, stored encrypted. Photos dropped above go to Documents
            → Uploads; crypto tax forms belong under Taxes for their year.
          </Kind>
        </div>
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <Landmark aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
          <span>
            Rather not import files? Connect banks through Plaid or Teller on the{" "}
            <Link to="/accounts" className="underline">
              Accounts
            </Link>{" "}
            page and they stay up to date on their own.
          </span>
        </p>
      </section>

      <Modal open={open !== null} onClose={close} title={title} wide={open?.kind === "statements"}>
        {open?.kind === "statements" && (
          <StatementImporter initialFiles={open.files} onDone={close} />
        )}
        {open?.kind === "brokerage" && <ImportDialog onClose={close} initialFile={open.file} />}
        {open?.kind === "crypto" && <ImportKoinly onDone={close} initialFile={open.file} />}
      </Modal>
    </div>
  );
}
