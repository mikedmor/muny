import { type CsvMapping, type CsvPreviewInfo, DATE_FORMATS, type DateFormat } from "@muny/shared";
import { useState } from "react";
import { Checkbox, SelectField } from "./forms.js";
import { Button, Card } from "./ui.js";

type AmountMode = "single" | "split";

const blankMapping = (headers: string[]): CsvMapping => ({
  date: headers[0] ?? "",
  dateFormat: "MM/DD/YYYY",
  description: headers[1] ?? "",
  amount: headers[2] ?? "",
});

/**
 * Lets the user check or fix how a bank CSV's columns are read. Opens
 * automatically when Muny couldn't guess the columns.
 */
export function CsvMappingCard({
  info,
  busy,
  onApply,
}: {
  info: CsvPreviewInfo;
  busy: boolean;
  onApply: (m: CsvMapping) => void;
}) {
  const [open, setOpen] = useState(info.mapping === null);
  const [m, setM] = useState<CsvMapping>(info.mapping ?? blankMapping(info.headers));
  const [mode, setMode] = useState<AmountMode>(m.amount ? "single" : "split");

  const set = (patch: Partial<CsvMapping>) => setM((cur) => ({ ...cur, ...patch }));
  const column = (
    label: string,
    value: string | undefined,
    onChange: (v: string | undefined) => void,
    optional = false,
  ) => (
    <SelectField
      label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      {optional && <option value="">(none)</option>}
      {info.headers.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </SelectField>
  );

  const apply = () => {
    const out: CsvMapping =
      mode === "single"
        ? { ...m, debit: undefined, credit: undefined }
        : { ...m, amount: undefined, negate: undefined };
    onApply(out);
    setOpen(false);
  };

  const summary = info.preset
    ? `Recognized as ${info.preset.label}.`
    : info.mapping
      ? "Columns were guessed from the header row."
      : "Muny couldn't tell which columns hold the date and amount. Pick them below.";

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">Bank CSV.</span>{" "}
          <span className="text-slate-600 dark:text-slate-400">{summary}</span>
        </p>
        {!open && (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Adjust columns
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {column("Date", m.date, (v) => set({ date: v ?? "" }))}
            <SelectField
              label="Date format"
              value={m.dateFormat}
              onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}
            >
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </SelectField>
            {column("Description", m.description, (v) => set({ description: v ?? "" }))}
            {column("Category (optional)", m.category, (v) => set({ category: v }), true)}
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Amount
            </legend>
            <div className="flex gap-4 text-sm">
              {(
                [
                  ["single", "One amount column"],
                  ["split", "Separate debit and credit columns"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="amount-mode"
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="accent-brand-600"
                  />
                  {label}
                </label>
              ))}
            </div>
            {mode === "single" ? (
              <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {column("Amount", m.amount, (v) => set({ amount: v }))}
                <div className="pb-2 sm:col-span-1 lg:col-span-3">
                  <Checkbox
                    label="Spending is positive in this file"
                    description="Flip the sign so money out is negative."
                    checked={!!m.negate}
                    onChange={(v) => set({ negate: v })}
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {column("Debit (money out)", m.debit, (v) => set({ debit: v }), true)}
                {column("Credit (money in)", m.credit, (v) => set({ credit: v }), true)}
              </div>
            )}
          </fieldset>

          {info.sample.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-left text-slate-500 dark:bg-slate-800/50">
                  <tr>
                    {info.headers.map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {info.sample.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static preview rows
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                      {info.headers.map((h, j) => (
                        <td key={h} className="max-w-48 truncate whitespace-nowrap px-2 py-1">
                          {row[j]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {info.mapping && (
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
            <Button onClick={apply} disabled={busy}>
              Apply columns
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
