/**
 * Small visual identifiers: merchant initials badges and category icons.
 * Muny never fetches logos (no outbound calls), so merchants get a colored
 * initials badge whose color is stable per name. Both are decorative: the
 * name is always shown next to them.
 */

const AVATAR_COLORS = [
  "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200",
  "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200",
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s&]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "&");
  const [first, second] = words;
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

export function MerchantAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const color = AVATAR_COLORS[hash(name.toLowerCase()) % AVATAR_COLORS.length];
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${color} ${
        size === "sm" ? "size-7 text-[0.65rem]" : "size-9 text-xs"
      }`}
    >
      {initials(name)}
    </span>
  );
}

/** Keyword → icon. First match wins, so more specific words come first. */
const CATEGORY_ICONS: [RegExp, string][] = [
  [/uncategori/i, "❔"],
  [/transfer|credit card payment/i, "🔄"],
  [/paycheck|salary|income|wage|bonus|dividend|interest/i, "💰"],
  [/grocer/i, "🛒"],
  [/coffee|cafe/i, "☕"],
  [/restaurant|dining|food|takeout|fast food|bar/i, "🍽️"],
  [/gas|fuel/i, "⛽"],
  [/parking|toll|auto|car|transport|ride|uber|lyft/i, "🚗"],
  [/travel|vacation|hotel|flight|airline/i, "🏖️"],
  [/rent|mortgage|housing|home/i, "🏠"],
  [/electric|utilit|water|sewer|trash|heating/i, "💡"],
  [/internet|phone|mobile|cable/i, "📶"],
  [/subscription|streaming/i, "🔁"],
  [/entertainment|movie|music|game|hobb/i, "🎬"],
  [/merchandise|shopping|clothing|electronics|amazon/i, "🛍️"],
  [/pharmacy|medical|doctor|health|dental|vision/i, "💊"],
  [/gym|fitness|sport/i, "🏋️"],
  [/insurance/i, "🛡️"],
  [/loan|debt/i, "🏦"],
  [/invest|savings|retirement/i, "📈"],
  [/education|tuition|school|book/i, "🎓"],
  [/child|kid|baby|daycare/i, "🧸"],
  [/pet|vet/i, "🐾"],
  [/gift|donation|charity/i, "🎁"],
  [/personal care|hair|beauty|spa/i, "💇"],
  [/tax/i, "🧾"],
  [/fee|charge/i, "💸"],
];

export function categoryIcon(name: string | null | undefined, group?: string | null): string {
  for (const text of [name, group]) {
    if (!text) continue;
    for (const [re, icon] of CATEGORY_ICONS) if (re.test(text)) return icon;
  }
  return name ? "🏷️" : "❔";
}

export function CategoryIcon({
  name,
  group,
  className = "",
}: {
  name: string | null | undefined;
  group?: string | null;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`inline-block w-5 shrink-0 text-center ${className}`}>
      {categoryIcon(name, group)}
    </span>
  );
}
