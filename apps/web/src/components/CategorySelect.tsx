import type { SelectHTMLAttributes } from "react";
import { useCategories } from "../lib/queries.js";

/**
 * Grouped category <select>. Hidden categories are omitted unless currently
 * selected. Value "" means uncategorized.
 */
export function CategorySelect({
  value,
  onChange,
  emptyLabel = "Uncategorized",
  extraOptions,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  value: string | null;
  onChange: (id: string | null) => void;
  emptyLabel?: string;
  extraOptions?: { value: string; label: string }[];
}) {
  const categories = useCategories();
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} {...props}>
      <option value="">{emptyLabel}</option>
      {extraOptions?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {categories.data?.map((g) => (
        <optgroup key={g.id} label={g.name}>
          {g.categories
            .filter((c) => !c.hidden || c.id === value)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
