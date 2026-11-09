import { MoneyParseError, parseAmount, toDecimalString } from "@muny/shared";
import {
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cx } from "./ui.js";

const inputClass =
  "mt-1 block w-full rounded-lg border bg-surface px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30 dark:bg-slate-950 dark:text-slate-100";

export function SelectField({
  label,
  error,
  children,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <select
        id={id}
        className={cx(
          inputClass,
          error ? "border-red-500" : "border-slate-300 dark:border-slate-700",
        )}
        {...props}
      >
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * Money input that keeps the user's text and reports integer cents (or null
 * when empty/invalid). Parsing uses the shared string-based parser, no floats.
 */
export function MoneyField({
  label,
  cents,
  onChange,
  error,
  hint,
  currency = "USD",
}: {
  label: string;
  cents: number | null;
  onChange: (cents: number | null, valid: boolean) => void;
  error?: string;
  hint?: string;
  currency?: string;
}) {
  const id = useId();
  const [text, setText] = useState(cents === null ? "" : toDecimalString(cents, currency));
  const [invalid, setInvalid] = useState(false);

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center pt-1 text-sm text-slate-400">
          $
        </span>
        <input
          id={id}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            if (v.trim() === "") {
              setInvalid(false);
              onChange(null, true);
              return;
            }
            try {
              onChange(parseAmount(v, { currency }), true);
              setInvalid(false);
            } catch (err) {
              if (!(err instanceof MoneyParseError)) throw err;
              setInvalid(true);
              onChange(null, false);
            }
          }}
          className={cx(
            inputClass,
            "pl-7 tabular-nums",
            error || invalid ? "border-red-500" : "border-slate-300 dark:border-slate-700",
          )}
        />
      </div>
      {(error || invalid || hint) && (
        <p className={cx("mt-1 text-xs", error || invalid ? "text-red-600" : "text-slate-500")}>
          {error ?? (invalid ? "Enter an amount like 1234.56" : hint)}
        </p>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  description,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`flex items-start gap-3 ${disabled ? "opacity-50" : ""}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-slate-300 accent-brand-600"
      />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-slate-700 dark:text-slate-300">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </label>
    </div>
  );
}

/** Modal built on the native <dialog> element (focus trap + Esc for free). */
export function Modal({
  open,
  onClose,
  title,
  children,
  bare,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Wide, with no built-in title bar or padding: the content draws its own. */
  bare?: boolean;
  /** Wider, for forms with tables (keeps the title bar; scrolls when tall). */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse convenience; Esc closes natively
    <dialog
      ref={ref}
      onClose={(e) => {
        // A dialog opened from inside this one closing isn't this one closing.
        if (e.target === ref.current) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
      className={cx(
        "m-auto w-[calc(100%-2rem)] border border-slate-200 bg-surface p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100",
        bare
          ? // The content keeps inside the frame: its 2px of border included.
            "max-h-[calc(100dvh-2rem)] max-w-3xl overflow-hidden rounded-2xl *:max-h-[calc(100dvh-2rem-2px)]"
          : wide
            ? "max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto rounded-xl"
            : "max-w-lg rounded-xl",
      )}
    >
      {open && bare && children}
      {open && !bare && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md px-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
            >
              ✕
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
