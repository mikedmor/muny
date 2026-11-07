/** Showing a card's values. Money arrives as integer cents and percents as fractions. */
import { formatMoney } from "../money.js";
import type { FieldType } from "./catalog.js";
import type { CardCell, DateBucket } from "./doc.js";

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

export function formatDate(iso: string): string {
  return utc(iso.slice(0, 10)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shortDate(iso: string): string {
  return utc(iso.slice(0, 10)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatMonth(key: string, short = false): string {
  return utc(`${key.slice(0, 7)}-15`).toLocaleDateString("en-US", {
    month: "short",
    ...(short ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatBucket(value: CardCell, bucket: DateBucket): string {
  switch (bucket) {
    case "day":
    case "week":
      return shortDate(String(value));
    case "month":
      return formatMonth(String(value));
    case "quarter": {
      const [y, q] = String(value).split("-");
      return `${q} ${y}`;
    }
    case "year":
    case "day_of_month":
      return String(value);
    case "weekday":
      return WEEKDAYS[Number(value) - 1] ?? String(value);
    case "month_of_year":
      return MONTHS[Number(value) - 1] ?? String(value);
  }
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 });
}

export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: Math.abs(pct) < 10 ? 1 : 0 })}%`;
}

/** A value, ready to read. No value at all shows as a dash. */
export function formatCell(value: CardCell, type: FieldType, bucket?: DateBucket): string {
  if (value === null || value === undefined) return "—";
  if (bucket) return formatBucket(value, bucket);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (type === "money") return formatMoney(Math.round(value));
    if (type === "percent") return formatPercent(value);
    return formatNumber(value);
  }
  if (type === "date" && /^\d{4}-\d{2}-\d{2}/.test(value)) return formatDate(value);
  if (type === "month" && /^\d{4}-\d{2}/.test(value)) return formatMonth(value);
  return value;
}

/** Short money and numbers for chart axes: "$1.2k". */
export function formatCompact(value: number, type: FieldType): string {
  const sign = value < 0 ? "−" : "";
  if (type === "percent") return `${sign}${Math.round(Math.abs(value) * 100)}%`;
  const v = type === "money" ? Math.abs(value) / 100 : Math.abs(value);
  const unit = type === "money" ? "$" : "";
  if (v >= 1_000_000) return `${sign}${unit}${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${sign}${unit}${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  if (type !== "money" && v < 10 && v !== Math.round(v)) return `${sign}${v.toFixed(1)}`;
  return `${sign}${unit}${Math.round(v)}`;
}
